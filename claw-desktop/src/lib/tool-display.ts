// Per-tool display mapping for the Coordinator's agent-card.
//
// The demo (docs/demos/ui-anim-coordinator.html) shows each tool row as:
//
//   [verb] [arg] → [result]  ›
//
// where verb is a human label ("Searched", "Read", "Fetched positions"),
// arg is the primary input ("BTC", filename, symbol), and result is a
// one-line summary. Clicking expands a preview card with the full query
// + structured result.
//
// This module takes our internal ToolCallRecord (name + args + result)
// and produces the display-layer shape the UI needs.

import type { ToolCallRecord } from "../types/workflow";

export interface ToolDisplay {
  kind: "read" | "search" | "fetch" | "write" | "calc" | "call";
  verbRunning: string;        // "Searching", "Reading", "Fetching price"
  verbDone: string;           // "Searched",  "Read",    "Fetched price"
  arg: string;                // what goes in the .tv slot
  result?: string;            // what goes after " → "
  preview: PreviewBody;       // rendered inside the expandable card
}

export type PreviewBody =
  | { type: "call-json"; signature: string; resultJson: string }
  | { type: "search-hits"; signature: string; hits: SearchHit[] }
  | { type: "memory-file"; signature: string; content: string; lines: number }
  | { type: "error"; signature: string; message: string };

export interface SearchHit {
  path: string;
  score?: number;
  snippet?: string;
}

// Given a tool name + args + optional result, produce the display shape.
// Used by CoordThinkingBlock (and any future "AgentBlock" that wants the
// same card styling).
export function toolDisplay(tc: ToolCallRecord): ToolDisplay {
  const name = tc.name;
  const args = tc.args || {};
  const result = tc.result;
  const isError =
    tc.brief?.startsWith("error") ||
    (result && typeof result === "object" && "error" in (result as object));

  // Memory tools ───────────────────────────────────────────
  if (name === "search_memory") {
    const query = String(args.query ?? "");
    const scope = Array.isArray(args.scope)
      ? (args.scope as string[])
      : args.scope
        ? [String(args.scope)]
        : [];
    const signature = `search_memory({ query: "${query}"${scope.length ? `, scope: ${JSON.stringify(scope)}` : ""} })`;
    const hits = extractSearchHits(result);
    return {
      kind: "search",
      verbRunning: "Searching",
      verbDone: "Searched",
      arg: `"${query}"`,
      result: result == null ? undefined : `${hits.length} hits`,
      preview: isError
        ? { type: "error", signature, message: String((result as any)?.error ?? tc.brief ?? "unknown error") }
        : { type: "search-hits", signature, hits },
    };
  }

  if (name === "read_memory") {
    const path = String(args.path ?? args.file ?? "");
    const short = basename(path);
    const content = typeof result === "string"
      ? result
      : typeof (result as any)?.content === "string"
        ? (result as any).content
        : JSON.stringify(result ?? "", null, 2);
    const lineCount = content ? content.split("\n").length : 0;
    const signature = `read_memory("${path}")`;
    return {
      kind: "read",
      verbRunning: "Reading",
      verbDone: "Read",
      arg: short,
      result: result == null ? undefined : `${lineCount} lines`,
      preview: isError
        ? { type: "error", signature, message: String((result as any)?.error ?? tc.brief ?? "unknown error") }
        : { type: "memory-file", signature, content, lines: lineCount },
    };
  }

  if (name === "list_memory") {
    const scope = String(args.scope ?? "");
    const signature = `list_memory("${scope}")`;
    const files = Array.isArray((result as any)?.files) ? (result as any).files : [];
    return {
      kind: "read",
      verbRunning: "Listing",
      verbDone: "Listed",
      arg: scope || "(all)",
      result: result == null ? undefined : `${files.length} files`,
      preview: { type: "call-json", signature, resultJson: json(result) },
    };
  }

  if (name === "write_memory") {
    const path = String(args.path ?? args.file ?? "");
    const signature = `write_memory("${path}", ${json(args.content).slice(0, 60)}…)`;
    return {
      kind: "write",
      verbRunning: "Writing",
      verbDone: "Wrote",
      arg: basename(path),
      result: result == null ? undefined : "ok",
      preview: { type: "call-json", signature, resultJson: json(result) },
    };
  }

  if (name === "update_index") {
    return {
      kind: "write",
      verbRunning: "Updating",
      verbDone: "Updated",
      arg: "MEMORY.md",
      result: result == null ? undefined : "ok",
      preview: {
        type: "call-json",
        signature: `update_index(${json(args).slice(0, 80)})`,
        resultJson: json(result),
      },
    };
  }

  // Web search (Tavily) ────────────────────────────────────
  if (name === "web_search") {
    const query = String(args.query ?? "");
    const r = result as any;
    const results = Array.isArray(r?.results) ? r.results : [];
    const hits: SearchHit[] = results.map((h: any) => ({
      path: String(h.title || h.url || "(untitled)"),
      score: typeof h.score === "number" ? h.score : undefined,
      snippet: typeof h.snippet === "string" ? h.snippet : undefined,
    }));
    const signature = `web_search({ query: "${query}" })`;
    return {
      kind: "search",
      verbRunning: "Searching web",
      verbDone: "Searched web",
      arg: `"${query}"`,
      result: result == null ? undefined : `${hits.length} results`,
      preview: isError
        ? { type: "error", signature, message: String((result as any)?.error ?? tc.brief ?? "unknown error") }
        : { type: "search-hits", signature, hits },
    };
  }

  // Market tools ───────────────────────────────────────────
  if (name === "get_price") {
    const symbol = String(args.symbol ?? "");
    const r = result as any;
    const briefResult = r
      ? typeof r.price === "number"
        ? `$${fmtNum(r.price)}${typeof r.change_24h === "number" ? ` (${r.change_24h > 0 ? "+" : ""}${r.change_24h.toFixed(2)}%)` : ""}`
        : tc.brief
      : undefined;
    return {
      kind: "fetch",
      verbRunning: "Fetching price",
      verbDone: "Fetched price",
      arg: symbol,
      result: briefResult,
      preview: {
        type: "call-json",
        signature: `get_price({ symbol: "${symbol}" })`,
        resultJson: json(result),
      },
    };
  }

  if (name === "get_positions") {
    const symbol = args.symbol ? String(args.symbol) : "";
    const r = result as any;
    let briefResult: string | undefined;
    if (r != null) {
      if (Array.isArray(r) && r.length === 0) briefResult = "无持仓";
      else if (Array.isArray(r)) briefResult = `${r.length} positions`;
      else if (typeof r.count === "number") {
        if (r.count === 0) briefResult = "无持仓";
        else {
          const pnl = typeof r.total_unrealized_pnl === "number"
            ? ` · uPnL $${fmtNum(r.total_unrealized_pnl)}`
            : "";
          briefResult = `${r.count} positions${pnl}`;
        }
      }
      else if (r?.side && r?.qty) briefResult = `${r.qty} ${r.symbol ?? symbol} @ ${fmtNum(r.avg_price)}`;
      else briefResult = tc.brief;
    }
    return {
      kind: "fetch",
      verbRunning: "Fetching positions",
      verbDone: "Fetched positions",
      arg: symbol || "all",
      result: briefResult,
      preview: {
        type: "call-json",
        signature: symbol ? `get_positions({ symbol: "${symbol}" })` : `get_positions()`,
        resultJson: json(result),
      },
    };
  }

  if (name === "check_balance") {
    const r = result as any;
    let briefResult: string | undefined;
    if (r) {
      if (typeof r.total_usd === "number") {
        const ex = r.exchange ? ` @ ${String(r.exchange).toUpperCase()}` : "";
        briefResult = `$${fmtNum(r.total_usd)} total${ex}`;
      } else if (typeof r.available === "number") {
        briefResult = `$${fmtNum(r.available)} available`;
      } else {
        briefResult = tc.brief;
      }
    }
    return {
      kind: "fetch",
      verbRunning: "Fetching balance",
      verbDone: "Fetched balance",
      arg: "",
      result: briefResult,
      preview: {
        type: "call-json",
        signature: `check_balance()`,
        resultJson: json(result),
      },
    };
  }

  if (name === "get_klines") {
    const symbol = String(args.symbol ?? "");
    const interval = String(args.interval ?? "");
    const r = result as any;
    const bars = Array.isArray(r) ? r.length : Array.isArray(r?.klines) ? r.klines.length : undefined;
    return {
      kind: "fetch",
      verbRunning: "Fetching klines",
      verbDone: "Fetched klines",
      arg: `${symbol} ${interval}`.trim(),
      result: bars != null ? `${bars} bars` : tc.brief,
      preview: {
        type: "call-json",
        signature: `get_klines({ symbol: "${symbol}", interval: "${interval}" })`,
        resultJson: json(result),
      },
    };
  }

  if (name === "get_financial_data") {
    const metric = String(args.metric ?? "");
    const symbol = String(args.symbol ?? "");
    const r = result as any;
    let briefResult: string | undefined;
    if (r) {
      switch (metric) {
        case "funding_rate":
          if (r.current?.rate_pct) briefResult = `funding ${r.current.rate_pct} / 8h`;
          break;
        case "open_interest":
          if (typeof r.current?.oi_value_usd === "number")
            briefResult = `OI $${fmtNum(r.current.oi_value_usd)}`;
          else if (typeof r.current?.oi_contracts === "number")
            briefResult = `OI ${fmtNum(r.current.oi_contracts)}`;
          break;
        case "long_short_ratio":
          if (r.global_account?.ratio)
            briefResult = `L/S global ${r.global_account.ratio.toFixed(2)} · top-pos ${(r.top_position?.ratio ?? 0).toFixed(2)}`;
          break;
        case "taker_buy_sell_ratio":
          if (r.current?.ratio)
            briefResult = `taker B/S ${r.current.ratio.toFixed(2)}`;
          break;
        case "basis":
          if (r.current?.basis_rate_pct)
            briefResult = `basis ${r.current.basis_rate_pct}`;
          break;
      }
      if (!briefResult && r.error) briefResult = String(r.error);
      if (!briefResult) briefResult = tc.brief;
    }
    const verbMap: Record<string, string> = {
      funding_rate: "funding",
      open_interest: "OI",
      long_short_ratio: "L/S ratio",
      taker_buy_sell_ratio: "taker B/S",
      basis: "basis",
    };
    const label = verbMap[metric] ?? metric;
    return {
      kind: "fetch",
      verbRunning: `Fetching ${label}`,
      verbDone: `Fetched ${label}`,
      arg: symbol,
      result: briefResult,
      preview: {
        type: "call-json",
        signature: `get_financial_data({ metric: "${metric}", symbol: "${symbol}" })`,
        resultJson: json(result),
      },
    };
  }

  if (name === "create_feature") {
    const slug = String(args.slug ?? "");
    const displayName = String(args.display_name ?? slug);
    const r = result as any;
    return {
      kind: "write",
      verbRunning: "Creating feature",
      verbDone: r?.ok ? "Created feature" : "Create feature failed",
      arg: displayName,
      result: r?.ok ? `slug=${slug}` : r?.error ? `error: ${String(r.error).slice(0, 80)}` : tc.brief,
      preview: {
        type: "call-json",
        signature: `create_feature({ slug: "${slug}", display_name: "${displayName}" })`,
        resultJson: json(result),
      },
    };
  }

  if (name === "list_features") {
    const r = result as any;
    return {
      kind: "read",
      verbRunning: "Listing features",
      verbDone: "Listed features",
      arg: "",
      result: typeof r?.count === "number" ? `${r.count} 个特征` : tc.brief,
      preview: {
        type: "call-json",
        signature: `list_features()`,
        resultJson: json(result),
      },
    };
  }

  if (name === "run_feature") {
    const slug = String(args.slug ?? "");
    const r = result as any;
    let briefResult: string | undefined;
    if (r?.ok === false) briefResult = `error: ${String(r.error ?? "").slice(0, 80)}`;
    else if (r?.value && typeof r.value === "object") {
      const v = r.value as Record<string, unknown>;
      const sig = v.signal ?? v.z_score ?? v.value;
      briefResult = sig != null
        ? `${typeof sig === "object" ? JSON.stringify(sig) : String(sig)} · ${r.duration_ms}ms`
        : `ok · ${r.duration_ms}ms`;
    }
    return {
      kind: "calc",
      verbRunning: `Running ${slug}`,
      verbDone: `Ran ${slug}`,
      arg: "",
      result: briefResult ?? tc.brief,
      preview: {
        type: "call-json",
        signature: `run_feature({ slug: "${slug}" })`,
        resultJson: json(result),
      },
    };
  }

  if (name === "delete_feature") {
    const slug = String(args.slug ?? "");
    const r = result as any;
    return {
      kind: "write",
      verbRunning: "Deleting feature",
      verbDone: r?.ok ? "Deleted feature" : "Delete failed",
      arg: slug,
      result: r?.error ? `error: ${r.error}` : "ok",
      preview: {
        type: "call-json",
        signature: `delete_feature({ slug: "${slug}" })`,
        resultJson: json(result),
      },
    };
  }

  if (name === "calculate_indicator") {
    const ind = String(args.indicator ?? "");
    return {
      kind: "calc",
      verbRunning: `Computing ${ind}`,
      verbDone: `Computed ${ind}`,
      arg: "",
      result: tc.brief,
      preview: {
        type: "call-json",
        signature: `calculate_indicator(${json(args)})`,
        resultJson: json(result),
      },
    };
  }

  // Default — unknown tool.
  return {
    kind: "call",
    verbRunning: `Calling ${name}`,
    verbDone: `Called ${name}`,
    arg: "",
    result: tc.brief,
    preview: {
      type: "call-json",
      signature: `${name}(${json(args).slice(0, 120)})`,
      resultJson: json(result),
    },
  };
}

// Demo-style header counter: "3 reads · 1 search · 1 fetch"
// Only counts families that have rows; plural via -s when >1.
export function coordCounter(rows: ToolDisplay[]): string {
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.kind] = (counts[r.kind] ?? 0) + 1;
  const parts: string[] = [];
  const order: Array<[string, string, string]> = [
    ["read", "read", "reads"],
    ["search", "search", "searches"],
    ["fetch", "fetch", "fetches"],
    ["write", "write", "writes"],
    ["calc", "calc", "calcs"],
    ["call", "call", "calls"],
  ];
  for (const [k, singular, plural] of order) {
    const n = counts[k];
    if (n) parts.push(`${n} ${n > 1 ? plural : singular}`);
  }
  return parts.join(" · ");
}

// ── helpers ─────────────────────────────────────────────

function basename(path: string): string {
  if (!path) return "";
  const stripExt = path.replace(/\.md$/i, "");
  const parts = stripExt.split("/");
  return parts[parts.length - 1] || stripExt;
}

function json(v: unknown): string {
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function extractSearchHits(result: unknown): SearchHit[] {
  if (!result) return [];
  const r = result as any;
  const raw = Array.isArray(r) ? r : Array.isArray(r?.hits) ? r.hits : Array.isArray(r?.matches) ? r.matches : [];
  return raw.map((h: any) => ({
    path: String(h.path ?? h.file ?? h.id ?? ""),
    score: typeof h.score === "number" ? h.score : undefined,
    snippet: typeof h.snippet === "string" ? h.snippet : typeof h.preview === "string" ? h.preview : undefined,
  }));
}
