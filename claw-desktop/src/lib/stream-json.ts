// Streaming helpers for tool-call arguments.
//
// Problem: OpenAI-compatible APIs stream function-call arguments token-by-
// token, but the fragments aren't valid JSON mid-flight — which means we
// can't JSON.parse until the whole call finishes. The user sits watching
// a blank block while the model writes its reasoning into an argument.
//
// These helpers let us reveal structured output progressively:
//
//   StringFieldStreamer   — emits chars of a specific JSON string field
//                           ("thinking", etc.) as they arrive.
//   tryParsePartialJSON   — best-effort parser that closes dangling braces /
//                           brackets / quotes so we can inspect a partial
//                           object for keys that have already landed.
//
// Neither is robust for adversarial input — they exist to make a streaming
// UX feel alive, not to replace JSON.parse for final commits.

// ─── Streaming string-field extractor ────────────────────────
//
// Tracks position inside an accumulated JSON-ish string. When it enters
// the value of the target field (e.g. `"thinking":"…`), each subsequent
// character is passed to `onChar` until the closing unescaped quote.
//
// Handles:
//   • whitespace between key/colon/value
//   • escape sequences inside the value (\", \\, \n, \t, unicode \uXXXX
//     — we pass them through *decoded* for prose display)
//   • the field appearing anywhere in the stream (we scan each incoming
//     fragment until matched; after that we're in "inside" mode)
//
// Does NOT handle:
//   • the field appearing multiple times (first hit wins)
//   • nested objects where the same field name lives deeper
//
// Usage:
//   const s = new StringFieldStreamer("thinking", (c) => out += c);
//   // on every tool-args delta:
//   s.feed(fragment);

export class StringFieldStreamer {
  private mode:
    | "searching"      // scanning for `"field":`
    | "awaiting_quote" // saw `"field":` + optional ws, waiting for opening `"`
    | "inside"         // inside the string value
    | "done" = "searching";
  private escapeNext = false;
  private unicodeBuf: string | null = null;
  private readonly needle: string;

  constructor(
    field: string,
    private readonly onChar: (c: string) => void,
  ) {
    this.needle = `"${field}"`;
  }

  feed(accumulatedSoFar: string, fragment: string): void {
    if (this.mode === "done") return;

    // Find starting point in the accumulated string.
    // For "searching" we scan the whole accumulated buffer each call — it's
    // O(N) per fragment but N is small (plan args ≤ ~4KB).
    if (this.mode === "searching") {
      const hit = accumulatedSoFar.indexOf(this.needle);
      if (hit === -1) return;
      // Seek past `"field"`, then past optional ws + `:`, then optional ws + `"`.
      let i = hit + this.needle.length;
      while (i < accumulatedSoFar.length && /\s/.test(accumulatedSoFar[i])) i++;
      if (i >= accumulatedSoFar.length) { this.mode = "awaiting_quote"; return; }
      if (accumulatedSoFar[i] !== ":") return; // not our field (weird — bail)
      i++;
      while (i < accumulatedSoFar.length && /\s/.test(accumulatedSoFar[i])) i++;
      if (i >= accumulatedSoFar.length) { this.mode = "awaiting_quote"; return; }
      if (accumulatedSoFar[i] !== '"') {
        // Not a string value (could be null / number). Abort streaming.
        this.mode = "done";
        return;
      }
      i++;
      this.mode = "inside";
      // Emit everything from i onwards (what we've already received for this value).
      this.consume(accumulatedSoFar.slice(i));
      return;
    }

    if (this.mode === "awaiting_quote") {
      // Walk backwards from the start of this fragment in the full buffer.
      // Easier: re-run the searching logic on the full accumulated buffer.
      this.mode = "searching";
      this.feed(accumulatedSoFar, fragment);
      return;
    }

    if (this.mode === "inside") {
      this.consume(fragment);
    }
  }

  private consume(chunk: string): void {
    for (const ch of chunk) {
      if (this.mode !== "inside") return;

      if (this.unicodeBuf !== null) {
        this.unicodeBuf += ch;
        if (this.unicodeBuf.length === 4) {
          try {
            this.onChar(String.fromCharCode(parseInt(this.unicodeBuf, 16)));
          } catch { /* skip */ }
          this.unicodeBuf = null;
        }
        continue;
      }

      if (this.escapeNext) {
        this.escapeNext = false;
        switch (ch) {
          case '"': this.onChar('"'); break;
          case "\\": this.onChar("\\"); break;
          case "/": this.onChar("/"); break;
          case "n": this.onChar("\n"); break;
          case "r": this.onChar("\r"); break;
          case "t": this.onChar("\t"); break;
          case "b": this.onChar("\b"); break;
          case "f": this.onChar("\f"); break;
          case "u": this.unicodeBuf = ""; break;
          default: this.onChar(ch); break;
        }
        continue;
      }

      if (ch === "\\") { this.escapeNext = true; continue; }
      if (ch === '"') { this.mode = "done"; return; }
      this.onChar(ch);
    }
  }
}

// ─── Partial-JSON parser ─────────────────────────────────────
//
// Given a potentially truncated JSON string, try to repair and parse.
// We append matching closers for any unclosed strings/arrays/objects
// based on a simple depth scan, then JSON.parse. Returns undefined if
// even the repaired form doesn't parse.
//
// Use this to peek at structure WIP (e.g. "has approach landed yet?")
// — never to commit final structured state.

export function tryParsePartialJSON(raw: string): unknown | undefined {
  const s = raw.trim();
  if (!s) return undefined;

  // Fast path.
  try { return JSON.parse(s); } catch { /* repair */ }

  const stack: string[] = []; // "]" or "}"
  let inStr = false;
  let esc = false;
  let lastNonWs = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (esc) { esc = false; continue; }
    if (inStr) {
      if (ch === "\\") { esc = true; continue; }
      if (ch === '"') { inStr = false; }
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") stack.pop();
    if (!/\s/.test(ch)) lastNonWs = ch;
  }

  let repaired = s;
  // Close an unterminated string.
  if (inStr) repaired += '"';
  // Strip trailing partial tokens like `"key":` or `,` that would corrupt JSON.
  // e.g. `{"a":1,"b":` → drop the `,"b":`.
  repaired = repaired.replace(/,\s*"[^"]*"\s*:?\s*$/s, "");
  repaired = repaired.replace(/,\s*$/s, "");
  repaired = repaired.replace(/:\s*$/s, ": null");
  // Close open brackets/braces.
  while (stack.length > 0) repaired += stack.pop();

  try { return JSON.parse(repaired); } catch { /* give up */ }
  void lastNonWs;
  return undefined;
}
