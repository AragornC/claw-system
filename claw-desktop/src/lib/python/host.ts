// Host-side handlers for Python `thunderclaw.*` calls.
//
// Each Python `await thunderclaw.market.price(s)` becomes a worker → main
// `host_call` message; this dispatcher translates the call into either an
// existing Tauri `exec_tool` invocation (so we reuse the Binance HMAC
// plumbing already in Rust) or a memory-store action.
//
// Capability surface is intentionally narrow — only the functions listed
// in HOSTS exist. Python can't open arbitrary URLs, read the filesystem,
// or run subprocess; the wasm sandbox blocks all that, and the only
// "escape hatch" is this dispatcher.

import { execTool } from "../tools";

type HostHandler = (args: Record<string, unknown>) => Promise<unknown>;

function asString(v: unknown, name: string): string {
  if (typeof v !== "string" || !v) {
    throw new Error(`host: missing string arg "${name}"`);
  }
  return v;
}

const HOSTS: Record<string, HostHandler> = {
  // ── Market data ── (all backed by Rust execTool)
  market_price: async (a) =>
    execTool("get_price", { symbol: asString(a.symbol, "symbol") }),

  market_klines: async (a) =>
    execTool("get_klines", {
      symbol: asString(a.symbol, "symbol"),
      interval: a.interval ?? "1h",
      limit: a.limit ?? 100,
    }),

  market_funding_rate: async (a) =>
    execTool("get_financial_data", {
      metric: "funding_rate",
      symbol: asString(a.symbol, "symbol"),
      limit: a.limit ?? 24,
    }),

  market_open_interest: async (a) =>
    execTool("get_financial_data", {
      metric: "open_interest",
      symbol: asString(a.symbol, "symbol"),
      period: a.period ?? "1h",
      limit: a.limit ?? 24,
    }),

  market_long_short_ratio: async (a) =>
    execTool("get_financial_data", {
      metric: "long_short_ratio",
      symbol: asString(a.symbol, "symbol"),
      period: a.period ?? "1h",
      limit: a.limit ?? 24,
    }),

  // ── Account ──
  account_balance: async () => execTool("check_balance", {}),

  account_positions: async (a) =>
    execTool("get_positions", a.symbol ? { symbol: a.symbol } : {}),

  // ── News ──
  news_search: async (a) =>
    execTool("web_search", {
      query: asString(a.query, "query"),
      max_results: a.max_results ?? 5,
    }),

  // ── Memory (stubs for now — wire to memoryStore in Phase 2) ──
  memory_read: async (_a) => {
    throw new Error("memory.read 暂未接入，下个阶段实现");
  },
  memory_write: async (_a) => {
    throw new Error("memory.write 暂未接入，下个阶段实现");
  },

  // ── Logging — surfaces in the host devtools console ──
  log: async (a) => {
    const level = String(a.level ?? "info");
    const msg = `[python] ${a.msg}`;
    if (level === "error") console.error(msg);
    else if (level === "warn") console.warn(msg);
    else console.info(msg);
    return null;
  },
};

export async function dispatchHostCall(
  fn: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const handler = HOSTS[fn];
  if (!handler) throw new Error(`unknown host fn: ${fn}`);
  return handler(args);
}

export const HOST_FN_NAMES = Object.keys(HOSTS);
