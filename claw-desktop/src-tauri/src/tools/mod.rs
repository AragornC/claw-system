pub mod financial;
pub mod market;
pub mod search;

use reqwest::Client;
use serde_json::Value;

use crate::exchange::types::ExchangeCred;

/// Per-call context injected by the Tauri command layer. Tools that need
/// credentials pluck what they need out of here; most tools ignore it.
#[derive(Default, Clone)]
pub struct ToolCtx {
    pub tavily_key: Option<String>,
    /// Active exchange credentials + shared HTTP client. Present when the
    /// user has connected at least one exchange; consumed by account tools
    /// like `check_balance` / `get_positions`.
    pub exchange: Option<ExchangeBinding>,
}

#[derive(Clone)]
pub struct ExchangeBinding {
    pub cred: ExchangeCred,
    pub http: Client,
}

/// Execute a tool by name with JSON arguments, return JSON result.
///
/// Three failure modes:
///   - Implemented but errored at runtime → tool-specific error string
///   - Schema declared but no executor yet → `not_implemented: <reason>`
///   - Tool name not in catalog at all → `unknown tool: <name>`
pub async fn exec_tool(tool_name: &str, args: Value, ctx: ToolCtx) -> Result<Value, String> {
    match tool_name {
        "get_price" => market::get_price(args).await,
        "get_klines" => market::get_klines(args).await,
        "calculate_indicator" => market::calculate_indicator(args).await,
        "web_search" => search::web_search(args, ctx.tavily_key).await,
        "check_balance" => check_balance(ctx.exchange).await,
        "get_positions" => get_positions(args, ctx.exchange).await,
        "get_financial_data" => financial::get_financial_data(args).await,

        // Known schema, executor pending — fail with a clear "not_implemented".
        "code_exec" => Err(
            "not_implemented: code_exec 需要 Python 沙箱（计划：pyo3 / 子进程隔离）".to_string(),
        ),
        "backtest" => Err(
            "not_implemented: backtest 需要回测引擎（计划：本地撮合 + 历史 K 线）".to_string(),
        ),
        "notify" => Err(
            "not_implemented: notify 还没接入通知通道（计划：tauri 系统托盘 / 桌面通知）"
                .to_string(),
        ),
        "place_order" => Err(
            "not_implemented: place_order 需要用户确认流程，下单逻辑尚未启用".to_string(),
        ),
        "cancel_order" => Err(
            "not_implemented: cancel_order 需要用户确认流程，撤单逻辑尚未启用".to_string(),
        ),

        _ => Err(format!("unknown tool: {}", tool_name)),
    }
}

async fn check_balance(binding: Option<ExchangeBinding>) -> Result<Value, String> {
    let Some(ExchangeBinding { cred, http }) = binding else {
        return Err(
            "未连接任何交易所。请先在 设置 → Exchange 中配置 API Key。".to_string(),
        );
    };

    let balance = crate::exchange::client::fetch_account_balance(
        &http,
        &cred.exchange_id,
        &cred.api_key,
        &cred.api_secret,
        cred.passphrase.as_deref(),
    )
    .await?;

    // Top assets (non-zero only) for LLM readability
    let top_spot: Vec<_> = balance
        .spot
        .assets
        .iter()
        .filter(|a| a.free + a.locked > 0.0)
        .take(10)
        .map(|a| {
            serde_json::json!({
                "asset": a.asset,
                "free": a.free,
                "locked": a.locked,
            })
        })
        .collect();
    let top_futures: Vec<_> = balance
        .futures
        .assets
        .iter()
        .filter(|a| a.free + a.locked > 0.0)
        .take(10)
        .map(|a| {
            serde_json::json!({
                "asset": a.asset,
                "free": a.free,
                "locked": a.locked,
            })
        })
        .collect();

    Ok(serde_json::json!({
        "exchange": cred.exchange_id,
        "total_usd": balance.spot.total_usd + balance.futures.total_usd,
        "spot": {
            "total_usd": balance.spot.total_usd,
            "available_usd": balance.spot.available_usd,
            "assets": top_spot,
        },
        "futures": {
            "total_usd": balance.futures.total_usd,
            "available_usd": balance.futures.available_usd,
            "assets": top_futures,
        },
    }))
}

async fn get_positions(args: Value, binding: Option<ExchangeBinding>) -> Result<Value, String> {
    let Some(ExchangeBinding { cred, http }) = binding else {
        return Err(
            "未连接任何交易所。请先在 设置 → Exchange 中配置 API Key。".to_string(),
        );
    };

    let mut positions = crate::exchange::client::fetch_positions(
        &http,
        &cred.exchange_id,
        &cred.api_key,
        &cred.api_secret,
        cred.passphrase.as_deref(),
    )
    .await?;

    // Optional symbol filter — case-insensitive, loose match (BTCUSDT vs BTC-USDT-SWAP).
    if let Some(sym) = args.get("symbol").and_then(|v| v.as_str()) {
        let needle = sym.to_uppercase().replace(['-', '/', '_'], "");
        positions.retain(|p| {
            let hay = p.symbol.to_uppercase().replace(['-', '/', '_'], "");
            hay.contains(&needle) || needle.contains(&hay)
        });
    }

    let total_pnl: f64 = positions.iter().map(|p| p.unrealized_pnl).sum();

    Ok(serde_json::json!({
        "exchange": cred.exchange_id,
        "positions": positions,
        "count": positions.len(),
        "total_unrealized_pnl": total_pnl,
    }))
}
