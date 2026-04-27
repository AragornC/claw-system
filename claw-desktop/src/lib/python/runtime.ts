// Main-thread façade for the Pyodide worker.
//
// One worker for the whole app. Spawned eagerly at app startup (see App.tsx)
// so the first feature execution doesn't pay the ~1-2s init cost.
//
// `exec()` returns a promise that resolves with whatever the last expression
// in the Python code evaluated to (JSON-cleaned), or rejects with the Python
// stack trace as an Error.
//
// Also services `host_call` messages from Python (Binance fetches, memory
// reads, etc) by dispatching through `host.ts`.

import { dispatchHostCall } from "./host";

let worker: Worker | null = null;
let readyPromise: Promise<void> | null = null;
const pending = new Map<
  string,
  { resolve: (v: unknown) => void; reject: (e: Error) => void }
>();

export interface PythonRuntime {
  ready: Promise<void>;
  exec: (code: string, globals?: Record<string, unknown>) => Promise<unknown>;
  isReady: () => boolean;
  status: () => "idle" | "loading" | "ready" | "error";
}

let status: "idle" | "loading" | "ready" | "error" = "idle";

function ensureWorker(): Worker {
  if (worker) return worker;
  // Vite resolves this with `?worker` semantics into a real Worker bundle.
  worker = new Worker(
    new URL("./worker.ts", import.meta.url),
    { type: "module" }
  );
  worker.addEventListener("message", (ev: MessageEvent) => {
    const msg = ev.data as
      | { type: "ready"; version?: string }
      | { type: "error"; id?: string; error: string }
      | { type: "result"; id: string; value: unknown }
      | { type: "host_call"; id: number; fn: string; args: Record<string, unknown> };

    if (msg.type === "ready") return; // handled by readyPromise resolver

    if (msg.type === "result") {
      const slot = pending.get(msg.id);
      if (slot) {
        pending.delete(msg.id);
        slot.resolve(msg.value);
      }
      return;
    }

    if (msg.type === "host_call") {
      const w = ensureWorker();
      dispatchHostCall(msg.fn, msg.args ?? {})
        .then((value) => {
          w.postMessage({ type: "host_response", id: msg.id, ok: true, value });
        })
        .catch((e: unknown) => {
          w.postMessage({
            type: "host_response",
            id: msg.id,
            ok: false,
            error: e instanceof Error ? e.message : String(e),
          });
        });
      return;
    }

    if (msg.type === "error") {
      if (msg.id) {
        const slot = pending.get(msg.id);
        if (slot) {
          pending.delete(msg.id);
          slot.reject(new Error(msg.error));
        }
      }
      // unscoped errors fall through to the readyPromise rejector below
    }
  });
  return worker;
}

export function initRuntime(): Promise<void> {
  if (readyPromise) return readyPromise;
  status = "loading";
  const w = ensureWorker();
  readyPromise = new Promise((resolve, reject) => {
    const onMsg = (ev: MessageEvent) => {
      const msg = ev.data as
        | { type: "ready"; version?: string }
        | { type: "error"; error: string };
      if (msg.type === "ready") {
        status = "ready";
        w.removeEventListener("message", onMsg);
        console.info("[python] pyodide ready", msg.version ?? "");
        resolve();
      } else if (msg.type === "error" && !("id" in msg)) {
        status = "error";
        w.removeEventListener("message", onMsg);
        reject(new Error(msg.error));
      }
    };
    w.addEventListener("message", onMsg);
    w.postMessage({ type: "init" });
  });
  return readyPromise;
}

let nextId = 0;

export async function exec(
  code: string,
  globals?: Record<string, unknown>
): Promise<unknown> {
  await initRuntime();
  const w = ensureWorker();
  const id = `${++nextId}`;
  return new Promise<unknown>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ type: "exec", id, code, globals });
  });
}

export function getStatus() {
  return status;
}
