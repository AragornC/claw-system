// Single source of truth for tool implementation status.
//
// Displayed in Settings → Agent → Functions so the user can see at a
// glance which tools actually hit a real backend vs. return mocks
// vs. have no executor branch at all.
//
// When a tool graduates (mock → real, or missing → real), update the
// entry here AND its branch in src-tauri/src/tools/.

export type ImplStatus = "real" | "mock" | "missing";

export interface StatusMeta {
  label: string;      // short Chinese label shown in the badge
  tone: string;       // color tone — matches CSS class suffix
  desc: string;       // one-line explanation for the detail view
}

export const STATUS_META: Record<ImplStatus, StatusMeta> = {
  real: {
    label: "可用",
    tone: "ok",
    desc: "已接入真实数据源，可直接使用（账户类工具需先在 设置 → Exchange 连接交易所）",
  },
  mock: {
    label: "模拟",
    tone: "warn",
    desc: "返回固定 mock 数据，用于 UI 联调；接真实交易所需要完成 Phase 2 鉴权",
  },
  missing: {
    label: "未实现",
    tone: "off",
    desc: "Schema 已定义，但后端还没有对应的 executor 分支；调用会返回 unknown tool 错误",
  },
};

// NOTE: keep in sync with src-tauri/src/tools/mod.rs dispatcher
// and src/lib/toolCatalog.ts schema definitions.
const TOOL_STATUS: Record<string, ImplStatus> = {
  // Market data — real Binance API
  get_price: "real",
  get_klines: "real",
  calculate_indicator: "real",

  // Web search — real Tavily API
  web_search: "real",

  // Account — check_balance hits the connected exchange (Binance/OKX/Bitget)
  // via HMAC-signed REST calls; returns an error if no exchange is connected.
  check_balance: "real",
  get_positions: "real",

  // Research — Binance public futures data (funding/OI/LSR/taker/basis)
  get_financial_data: "real",

  // Compute — needs sandbox infra
  code_exec: "missing",
  backtest: "missing",

  // Notification — no backend yet
  notify: "missing",

  // Trading — deny-by-default, requires user confirmation flow
  place_order: "missing",
  cancel_order: "missing",

  // Feature library — frontend tools, run in Pyodide sandbox + Rust file store
  list_features: "real",
  create_feature: "real",
  run_feature: "real",
  delete_feature: "real",
};

export function getToolStatus(id: string): ImplStatus {
  return TOOL_STATUS[id] ?? "missing";
}

// For sorting: real first, mock next, missing last. Within a tier
// preserve input order.
export const STATUS_RANK: Record<ImplStatus, number> = {
  real: 0,
  mock: 1,
  missing: 2,
};
