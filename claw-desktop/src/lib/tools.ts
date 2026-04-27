import { invoke } from "@tauri-apps/api/core";
import { handleFeatureTool, FEATURE_TOOL_NAMES } from "./feature-tools";

/**
 * Execute a tool via Tauri backend (or a frontend tool when the tool needs
 * Pyodide / DOM / store access). Frontend tools are intercepted here before
 * the Rust dispatcher sees them.
 *
 * Currently frontend-only tools:
 *   create_feature / list_features_tool / run_feature_tool / delete_feature_tool
 *
 * Returns parsed JSON result.
 */
export async function execTool(
  name: string,
  args: Record<string, unknown>
): Promise<unknown> {
  // Feature management tools live in the frontend because dry-run
  // validation needs Pyodide and persistence needs the Rust file commands —
  // bouncing through the workflow_commands::exec_tool dispatcher buys
  // nothing and would force us to call Pyodide from Rust (impossible).
  if ((FEATURE_TOOL_NAMES as readonly string[]).includes(name)) {
    return handleFeatureTool(name, args);
  }

  const resultJson: string = await invoke("exec_tool", {
    toolName: name,
    argsJson: JSON.stringify(args),
  });
  return JSON.parse(resultJson);
}

/**
 * One-line human-readable summary of a tool result.
 */
export function toolBrief(name: string, result: unknown): string {
  const r = result as Record<string, unknown>;
  if (r?.error) return `error: ${r.error}`;

  switch (name) {
    case "get_price": {
      const price = Number(r.price);
      return `${r.symbol} $${price.toLocaleString()} (${r.change_24h})`;
    }
    case "get_klines":
      return `${r.symbol} ${r.interval} ${r.count} bars`;
    case "calculate_indicator": {
      const ind = r.indicator as string;
      if (ind === "RSI") return `RSI(${r.period}) = ${r.value} (${r.signal})`;
      if (ind === "MACD") return `MACD = ${r.macd}, ${r.trend}`;
      if (ind === "BOLL")
        return `BOLL ${r.upper}/${r.middle}/${r.lower}`;
      return JSON.stringify(r);
    }
    case "check_balance":
      return `$${Number(r.total_usd).toLocaleString()} available`;
    case "get_positions": {
      const positions = r.positions as unknown[];
      return positions?.length
        ? `${positions.length} positions`
        : "无持仓";
    }
    case "web_search": {
      const results = r.results as unknown[];
      return `${results?.length || 0} results`;
    }
    default:
      return JSON.stringify(r).slice(0, 60);
  }
}
