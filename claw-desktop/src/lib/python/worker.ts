// Pyodide WebWorker. Loads the runtime once at startup, then executes
// arbitrary Python on demand. Lives off the main thread so heavy compute
// (factor execution, future backtests) never freezes the Tauri webview.
//
// Protocol — main ↔ worker JSON messages:
//   main → worker:
//     { type: "init" }                                  → { type: "ready" }
//     { type: "exec", id, code, globals? }              → { type: "result", id, value }
//     { type: "host_response", id, ok, value, error }   ← reply to a host call
//   worker → main:
//     { type: "ready" } | { type: "error", id?, error }
//     { type: "result", id, value }
//     { type: "host_call", id, fn, args }               → ask main to run a host fn
//
// Host calls let Python in the sandbox reach back into the JS host (Binance
// data, memory store, notify). Python sees them as regular function calls
// behind a `thunderclaw.market.price(...)` package; under the hood the worker
// awaits a host_call/host_response round-trip.

/// <reference lib="webworker" />

interface PyodideAPI {
  runPythonAsync: (code: string, options?: { globals?: unknown }) => Promise<unknown>;
  toPy: (val: unknown) => unknown;
  globals: { set: (k: string, v: unknown) => void };
  registerJsModule: (name: string, mod: unknown) => void;
  version: string;
}

// Pull loadPyodide from the npm package — Vite resolves and bundles this
// into the worker chunk. The wasm + python_stdlib still get fetched at
// runtime from `/pyodide/` (synced into public/ by scripts/sync-pyodide.mjs)
// because Pyodide loads its assets via its own indexURL fetcher.
import { loadPyodide } from "pyodide";

let pyodide: PyodideAPI | null = null;
let initPromise: Promise<void> | null = null;

// Pending host calls: id → { resolve, reject }. The Python side awaits
// these via JS Promise interop (Pyodide automatically awaits returned JS
// Promises when the call is `await`ed in Python).
let nextHostId = 0;
const hostPending = new Map<
  number,
  { resolve: (v: unknown) => void; reject: (e: Error) => void }
>();

function callHost(fn: string, args: unknown): Promise<unknown> {
  const id = ++nextHostId;
  return new Promise((resolve, reject) => {
    hostPending.set(id, { resolve, reject });
    (self as unknown as Worker).postMessage({
      type: "host_call",
      id,
      fn,
      args,
    });
  });
}

async function init(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    pyodide = (await loadPyodide({ indexURL: "/pyodide/" })) as PyodideAPI;

    // Register a JS module the Python side can import as `_thunderclaw_host`.
    // Each method returns a JS Promise; Python `await`s it via Pyodide's
    // JsProxy auto-await. The names here are flat (`market_price`) — the
    // pretty `thunderclaw.market.price` shape is built in Python below.
    pyodide.registerJsModule("_thunderclaw_host", {
      market_price: (symbol: string) =>
        callHost("market_price", { symbol }),
      market_klines: (symbol: string, interval?: string, limit?: number) =>
        callHost("market_klines", { symbol, interval, limit }),
      market_funding_rate: (symbol: string, limit?: number) =>
        callHost("market_funding_rate", { symbol, limit }),
      market_open_interest: (symbol: string, period?: string, limit?: number) =>
        callHost("market_open_interest", { symbol, period, limit }),
      market_long_short_ratio: (
        symbol: string,
        period?: string,
        limit?: number
      ) =>
        callHost("market_long_short_ratio", { symbol, period, limit }),
      account_balance: () => callHost("account_balance", {}),
      account_positions: (symbol?: string) =>
        callHost("account_positions", { symbol }),
      news_search: (query: string, max_results?: number) =>
        callHost("news_search", { query, max_results }),
      memory_read: (path: string) => callHost("memory_read", { path }),
      memory_write: (path: string, content: string) =>
        callHost("memory_write", { path, content }),
      log: (msg: string, level?: string) =>
        callHost("log", { msg, level }),
    });

    // Build the user-facing `thunderclaw` package on top of the flat host.
    // Python users import it as:
    //   from thunderclaw import market, account, news, memory, log
    //   data = await market.funding_rate("BTCUSDT")
    //   data["history"]   # ← native Python dict, NOT a JsProxy
    //
    // The host returns JS objects; without `.to_py()` Pyodide gives users
    // a JsProxy and `.get()` / dict syntax blow up. We centralize the
    // conversion here so user code looks like idiomatic Python.
    await pyodide.runPythonAsync(`
import sys
import types
import _thunderclaw_host as _h

def _conv(v):
    """JsProxy → native Python (dict/list); pass through scalars."""
    if v is None:
        return None
    to_py = getattr(v, "to_py", None)
    if callable(to_py):
        # default_converter=None ensures nested dicts/lists become real
        # python dicts/lists rather than staying as JsProxy children.
        return to_py()
    return v

_pkg = types.ModuleType("thunderclaw")

class _Market:
    async def price(self, symbol):
        return _conv(await _h.market_price(symbol))
    async def klines(self, symbol, interval="1h", limit=100):
        return _conv(await _h.market_klines(symbol, interval, limit))
    async def funding_rate(self, symbol, limit=24):
        return _conv(await _h.market_funding_rate(symbol, limit))
    async def open_interest(self, symbol, period="1h", limit=24):
        return _conv(await _h.market_open_interest(symbol, period, limit))
    async def long_short_ratio(self, symbol, period="1h", limit=24):
        return _conv(await _h.market_long_short_ratio(symbol, period, limit))

class _Account:
    async def balance(self):
        return _conv(await _h.account_balance())
    async def positions(self, symbol=None):
        return _conv(await _h.account_positions(symbol))

class _News:
    async def search(self, query, max_results=5):
        return _conv(await _h.news_search(query, max_results))

class _Memory:
    async def read(self, path):
        return _conv(await _h.memory_read(path))
    async def write(self, path, content):
        return _conv(await _h.memory_write(path, content))

async def _log(msg, level="info"):
    return await _h.log(msg, level)

_pkg.market = _Market()
_pkg.account = _Account()
_pkg.news = _News()
_pkg.memory = _Memory()
_pkg.log = _log

sys.modules["thunderclaw"] = _pkg
`);
  })();
  return initPromise;
}

interface ExecMsg {
  type: "exec";
  id: string;
  code: string;
  globals?: Record<string, unknown>;
}
interface InitMsg {
  type: "init";
}
interface HostResponseMsg {
  type: "host_response";
  id: number;
  ok: boolean;
  value?: unknown;
  error?: string;
}
type IncomingMsg = InitMsg | ExecMsg | HostResponseMsg;

self.addEventListener("message", async (ev: MessageEvent<IncomingMsg>) => {
  const msg = ev.data;

  if (msg.type === "host_response") {
    const slot = hostPending.get(msg.id);
    if (slot) {
      hostPending.delete(msg.id);
      if (msg.ok) slot.resolve(msg.value);
      else slot.reject(new Error(msg.error ?? "host call failed"));
    }
    return;
  }

  if (msg.type === "init") {
    try {
      await init();
      (self as unknown as Worker).postMessage({
        type: "ready",
        version: pyodide?.version,
      });
    } catch (e) {
      (self as unknown as Worker).postMessage({
        type: "error",
        error: String(e),
      });
    }
    return;
  }

  if (msg.type === "exec") {
    try {
      await init();
      if (!pyodide) throw new Error("pyodide failed to initialize");
      if (msg.globals) {
        for (const [k, v] of Object.entries(msg.globals)) {
          pyodide.globals.set(k, pyodide.toPy(v));
        }
      }
      const raw = await pyodide.runPythonAsync(msg.code);
      let value: unknown;
      if (raw && typeof (raw as { toJs?: unknown }).toJs === "function") {
        const js = (raw as { toJs: (opts?: unknown) => unknown }).toJs({
          dict_converter: Object.fromEntries,
        });
        value = JSON.parse(JSON.stringify(js));
        const destroy = (raw as { destroy?: () => void }).destroy;
        if (typeof destroy === "function") destroy.call(raw);
      } else {
        value = raw === undefined ? null : JSON.parse(JSON.stringify(raw));
      }
      (self as unknown as Worker).postMessage({
        type: "result",
        id: msg.id,
        value,
      });
    } catch (e) {
      (self as unknown as Worker).postMessage({
        type: "error",
        id: msg.id,
        error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
      });
    }
    return;
  }
});
