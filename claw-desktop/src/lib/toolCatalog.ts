/**
 * Tool catalog — authoritative registry of OpenAI function-calling ToolDefs
 * for every function id an agent may reference in its `fns` list.
 *
 * Resolving `agent.fns` (string[]) → ToolDef[] happens here. If the backend
 * hasn't implemented a tool yet, the LLM can still see it in the schema; it
 * will just get an "unknown tool" error at runtime, which we surface in the
 * tool_group as a visible failure.
 *
 * Memory tools are NOT in this catalog — they're injected separately by the
 * agent loop (scoped to the agent's namespace).
 */
import type { ToolDef } from "../types/workflow";

/** Market / exchange data — implemented in src-tauri/src/tools/market.rs */
const MARKET_TOOLS: Record<string, ToolDef> = {
  get_price: {
    type: "function",
    function: {
      name: "get_price",
      description: "获取加密货币实时价格和 24h 变化",
      parameters: {
        type: "object",
        properties: {
          symbol: {
            type: "string",
            description: "交易对如 BTC/USDT，或单符号 BTC（默认对 USDT）",
          },
        },
        required: ["symbol"],
      },
    },
  },
  get_klines: {
    type: "function",
    function: {
      name: "get_klines",
      description: "获取 K 线历史数据",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string" },
          interval: {
            type: "string",
            description: "1m/5m/15m/1h/4h/1d",
          },
          limit: {
            type: "number",
            description: "返回 K 线数量，默认 100",
          },
        },
        required: ["symbol"],
      },
    },
  },
  calculate_indicator: {
    type: "function",
    function: {
      name: "calculate_indicator",
      description: "计算技术指标（RSI / MACD / BOLL 等）",
      parameters: {
        type: "object",
        properties: {
          indicator: {
            type: "string",
            enum: ["RSI", "MACD", "BOLL", "MA", "EMA"],
          },
          symbol: { type: "string" },
          period: { type: "number", description: "周期，如 RSI 14" },
          interval: {
            type: "string",
            description: "K 线级别 1h/4h/1d",
          },
        },
        required: ["indicator"],
      },
    },
  },
};

/** Account & positions */
const ACCOUNT_TOOLS: Record<string, ToolDef> = {
  check_balance: {
    type: "function",
    function: {
      name: "check_balance",
      description: "查询连接交易所的账户余额",
      parameters: { type: "object", properties: {} },
    },
  },
  get_positions: {
    type: "function",
    function: {
      name: "get_positions",
      description: "查询当前合约持仓（含方向、入场价、标记价、未实现盈亏、杠杆）。可选 symbol 过滤。",
      parameters: {
        type: "object",
        properties: {
          symbol: {
            type: "string",
            description: "可选：按交易对过滤（如 BTCUSDT / BTC-USDT-SWAP，大小写与分隔符不敏感）",
          },
        },
      },
    },
  },
};

/** Research / external data — not yet implemented in backend,
 *  but declared so Analyst can attempt them (will fail gracefully). */
const RESEARCH_TOOLS: Record<string, ToolDef> = {
  web_search: {
    type: "function",
    function: {
      name: "web_search",
      description: "通用网络搜索（Tavily API），用于抓新闻、研报、消息面",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "搜索关键词" },
          max_results: {
            type: "number",
            description: "最大结果数，默认 5",
          },
        },
        required: ["query"],
      },
    },
  },
  get_financial_data: {
    type: "function",
    function: {
      name: "get_financial_data",
      description:
        "获取 Binance 永续合约衍生数据：资金费率/持仓量/多空比/主动买卖比/基差。返回当前值 + 历史序列。",
      parameters: {
        type: "object",
        properties: {
          metric: {
            type: "string",
            enum: [
              "funding_rate",
              "open_interest",
              "long_short_ratio",
              "taker_buy_sell_ratio",
              "basis",
            ],
            description:
              "funding_rate(资金费率,8h) / open_interest(持仓量) / long_short_ratio(多空比) / taker_buy_sell_ratio(主动买卖) / basis(基差)",
          },
          symbol: {
            type: "string",
            description: "交易对，必填，如 BTCUSDT / ETHUSDT",
          },
          limit: {
            type: "number",
            description: "历史点数，默认 24，封顶 500",
          },
          period: {
            type: "string",
            enum: ["5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d"],
            description:
              "历史粒度，默认 1h（仅对非 funding_rate 生效；funding 固定 8h 周期）",
          },
        },
        required: ["metric", "symbol"],
      },
    },
  },
};

/** Computation / backtest — not yet implemented */
const COMPUTE_TOOLS: Record<string, ToolDef> = {
  code_exec: {
    type: "function",
    function: {
      name: "code_exec",
      description: "在隔离沙箱里执行 Python 代码（用于因子计算、快速分析）",
      parameters: {
        type: "object",
        properties: {
          code: { type: "string", description: "要执行的 Python 代码" },
          timeout: { type: "number", description: "超时秒数，默认 30" },
        },
        required: ["code"],
      },
    },
  },
  backtest: {
    type: "function",
    function: {
      name: "backtest",
      description: "回测给定策略在历史区间的表现",
      parameters: {
        type: "object",
        properties: {
          strategy_code: { type: "string", description: "策略代码" },
          symbol: { type: "string" },
          start: { type: "string", description: "YYYY-MM-DD" },
          end: { type: "string", description: "YYYY-MM-DD（可选，默认今天）" },
        },
        required: ["strategy_code", "start"],
      },
    },
  },
};

/** Notification — not yet implemented */
const NOTIFY_TOOLS: Record<string, ToolDef> = {
  notify: {
    type: "function",
    function: {
      name: "notify",
      description: "向用户推送通知消息（系统托盘 / 桌面通知）",
      parameters: {
        type: "object",
        properties: {
          message: { type: "string", description: "通知正文" },
          level: {
            type: "string",
            enum: ["info", "warn", "alert"],
            description: "级别，影响样式与是否需要确认",
          },
        },
        required: ["message"],
      },
    },
  },
};

/** Trading — deny-by-default; will only execute after explicit user confirm.
 *  Schemas exposed so agents can *propose* orders for confirmation flow,
 *  but the Rust dispatcher will refuse to execute without a confirmation token. */
const TRADING_TOOLS: Record<string, ToolDef> = {
  place_order: {
    type: "function",
    function: {
      name: "place_order",
      description:
        "提交交易订单。注意：此调用不会立即下单，会先弹出用户确认；用户拒绝则失败。",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "交易对，如 BTCUSDT" },
          side: { type: "string", enum: ["buy", "sell"] },
          amount: { type: "number", description: "数量（基础币）" },
          order_type: {
            type: "string",
            enum: ["market", "limit"],
            description: "默认 market",
          },
          price: { type: "number", description: "limit 单必填" },
        },
        required: ["symbol", "side", "amount"],
      },
    },
  },
  cancel_order: {
    type: "function",
    function: {
      name: "cancel_order",
      description: "撤销订单。同样需用户确认。",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string" },
          order_id: { type: "string", description: "交易所返回的订单 ID" },
        },
        required: ["order_id"],
      },
    },
  },
};

/** Feature library (Pyodide 沙箱里的 Python 因子) — frontend-handled tools.
 *  Implementation lives in src/lib/feature-tools.ts (intercepted in tools.ts
 *  before the Rust dispatcher sees them). */
const FEATURE_TOOLS: Record<string, ToolDef> = {
  list_features: {
    type: "function",
    function: {
      name: "list_features",
      description: "列出所有用户特征及其状态、最近运行结果",
      parameters: { type: "object", properties: {} },
    },
  },
  create_feature: {
    type: "function",
    function: {
      name: "create_feature",
      description:
        "创建新特征。code 必须 async def compute(...) 并通过 thunderclaw 包访问外部数据（market/account/news/log）。沙箱禁止 requests/urllib/os/subprocess。",
      parameters: {
        type: "object",
        properties: {
          slug: {
            type: "string",
            description: "唯一 ID，[a-z][a-z0-9_]{0,63}",
          },
          display_name: { type: "string", description: "中文展示名" },
          category: { type: "string", description: "情绪/动量/波动/风控等" },
          description: { type: "string", description: "一两句解释做什么" },
          code: { type: "string", description: "完整 Python 源码" },
        },
        required: ["slug", "display_name", "code"],
      },
    },
  },
  run_feature: {
    type: "function",
    function: {
      name: "run_feature",
      description: "运行已存在的特征，返回 compute() 输出",
      parameters: {
        type: "object",
        properties: {
          slug: { type: "string" },
          args: { type: "object", description: "传给 compute 的关键字参数（可选）" },
        },
        required: ["slug"],
      },
    },
  },
  delete_feature: {
    type: "function",
    function: {
      name: "delete_feature",
      description: "删除特征。仅在用户明确要求时使用",
      parameters: {
        type: "object",
        properties: { slug: { type: "string" } },
        required: ["slug"],
      },
    },
  },
};

/** Single source of truth */
const CATALOG: Record<string, ToolDef> = {
  ...MARKET_TOOLS,
  ...ACCOUNT_TOOLS,
  ...RESEARCH_TOOLS,
  ...COMPUTE_TOOLS,
  ...NOTIFY_TOOLS,
  ...TRADING_TOOLS,
  ...FEATURE_TOOLS,
};

/**
 * Resolve a list of function ids → ToolDef[].
 * Unknown ids are silently dropped (with a warning) so a stale agent config
 * doesn't crash the loop.
 */
export function resolveTools(fnIds: string[]): ToolDef[] {
  const out: ToolDef[] = [];
  for (const id of fnIds) {
    const def = CATALOG[id];
    if (def) {
      out.push(def);
    } else {
      console.warn(`[toolCatalog] unknown function id: ${id}`);
    }
  }
  return out;
}

/** Test hook — expose the full catalog (read-only) */
export function getAllTools(): Record<string, ToolDef> {
  return CATALOG;
}
