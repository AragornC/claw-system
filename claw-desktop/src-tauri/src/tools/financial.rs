// Public Binance Futures data — no auth required.
//
// All endpoints under fapi.binance.com:
//   /fapi/v1/premiumIndex        — current funding rate + mark price
//   /fapi/v1/fundingRate         — funding rate history (8h cycle)
//   /fapi/v1/openInterest        — current OI
//   /futures/data/openInterestHist            — OI history
//   /futures/data/globalLongShortAccountRatio — global L/S account ratio
//   /futures/data/topLongShortAccountRatio    — top trader account ratio
//   /futures/data/topLongShortPositionRatio   — top trader position ratio
//   /futures/data/takerlongshortRatio         — taker buy/sell volume ratio
//   /futures/data/basis                       — futures premium vs spot index
//
// Region-locked: 451 from a blocked IP bubbles up as a clear error.

use reqwest::Client;
use serde_json::{json, Value};

const FAPI: &str = "https://fapi.binance.com";

const METRICS: &[&str] = &[
    "funding_rate",
    "open_interest",
    "long_short_ratio",
    "taker_buy_sell_ratio",
    "basis",
];

const VALID_PERIODS: &[&str] = &["5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d"];

pub async fn get_financial_data(args: Value) -> Result<Value, String> {
    let metric = args
        .get("metric")
        .and_then(|v| v.as_str())
        .ok_or("get_financial_data: 缺少 metric 参数")?;

    let symbol = args
        .get("symbol")
        .and_then(|v| v.as_str())
        .ok_or("get_financial_data: 缺少 symbol 参数（如 BTCUSDT）")?
        .replace('/', "")
        .to_uppercase();

    let limit = args
        .get("limit")
        .and_then(|v| v.as_u64())
        .unwrap_or(24)
        .clamp(1, 500);

    let period_raw = args.get("period").and_then(|v| v.as_str()).unwrap_or("1h");
    let period = if VALID_PERIODS.contains(&period_raw) {
        period_raw
    } else {
        return Err(format!(
            "get_financial_data: period \"{}\" 无效 — 支持 {}",
            period_raw,
            VALID_PERIODS.join(" / ")
        ));
    };

    let http = Client::new();

    match metric {
        "funding_rate" => fetch_funding_rate(&http, &symbol, limit).await,
        "open_interest" => fetch_open_interest(&http, &symbol, period, limit).await,
        "long_short_ratio" => fetch_long_short_ratio(&http, &symbol, period, limit).await,
        "taker_buy_sell_ratio" => fetch_taker_ratio(&http, &symbol, period, limit).await,
        "basis" => fetch_basis(&http, &symbol, period, limit).await,
        other => Err(format!(
            "get_financial_data: 不支持的 metric \"{}\" — 支持 {}",
            other,
            METRICS.join(" / ")
        )),
    }
}

/* ─── helpers ─── */

async fn get_json(http: &Client, url: &str) -> Result<Value, String> {
    let resp = http
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Binance 请求失败: {}", e))?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        let trimmed = if body.len() > 200 { &body[..200] } else { &body };
        return Err(format!("Binance HTTP {}: {}", status, trimmed));
    }
    resp.json::<Value>()
        .await
        .map_err(|e| format!("Binance 响应解析失败: {}", e))
}

fn parse_f64(v: &Value) -> f64 {
    v.as_str()
        .and_then(|s| s.parse().ok())
        .or_else(|| v.as_f64())
        .unwrap_or(0.0)
}

fn fmt_pct(rate: f64) -> String {
    format!("{:.4}%", rate * 100.0)
}

/* ─── funding_rate ─── */

async fn fetch_funding_rate(http: &Client, symbol: &str, limit: u64) -> Result<Value, String> {
    let cur_url = format!("{}/fapi/v1/premiumIndex?symbol={}", FAPI, symbol);
    let cur = get_json(http, &cur_url).await?;
    let rate = parse_f64(&cur["lastFundingRate"]);
    let next_funding_time = cur["nextFundingTime"].as_i64().unwrap_or(0);
    let mark_price = parse_f64(&cur["markPrice"]);
    let index_price = parse_f64(&cur["indexPrice"]);

    let hist_url = format!(
        "{}/fapi/v1/fundingRate?symbol={}&limit={}",
        FAPI, symbol, limit
    );
    let hist_raw = get_json(http, &hist_url).await?;
    let history: Vec<Value> = hist_raw
        .as_array()
        .map(|arr| {
            arr.iter()
                .map(|e| {
                    let r = parse_f64(&e["fundingRate"]);
                    json!({
                        "time": e["fundingTime"].as_i64().unwrap_or(0),
                        "rate": r,
                        "rate_pct": fmt_pct(r),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    Ok(json!({
        "metric": "funding_rate",
        "symbol": symbol,
        "current": {
            "rate": rate,
            "rate_pct": fmt_pct(rate),
            "next_funding_time": next_funding_time,
            "mark_price": mark_price,
            "index_price": index_price,
        },
        "history": history,
        "note": "Binance 永续合约资金费率，每 8h 结算一次",
    }))
}

/* ─── open_interest ─── */

async fn fetch_open_interest(
    http: &Client,
    symbol: &str,
    period: &str,
    limit: u64,
) -> Result<Value, String> {
    let cur_url = format!("{}/fapi/v1/openInterest?symbol={}", FAPI, symbol);
    let cur = get_json(http, &cur_url).await?;
    let oi_contracts = parse_f64(&cur["openInterest"]);

    let hist_url = format!(
        "{}/futures/data/openInterestHist?symbol={}&period={}&limit={}",
        FAPI, symbol, period, limit
    );
    let hist_raw = get_json(http, &hist_url).await?;
    let history: Vec<Value> = hist_raw
        .as_array()
        .map(|arr| {
            arr.iter()
                .map(|e| {
                    json!({
                        "time": e["timestamp"].as_i64().unwrap_or(0),
                        "oi": parse_f64(&e["sumOpenInterest"]),
                        "oi_value_usd": parse_f64(&e["sumOpenInterestValue"]),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    // Latest historical row carries the USD value (the snapshot endpoint doesn't).
    let oi_value_usd = history
        .last()
        .and_then(|e| e.get("oi_value_usd"))
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);

    Ok(json!({
        "metric": "open_interest",
        "symbol": symbol,
        "period": period,
        "current": {
            "oi_contracts": oi_contracts,
            "oi_value_usd": oi_value_usd,
        },
        "history": history,
    }))
}

/* ─── long_short_ratio ─── */

async fn fetch_long_short_ratio(
    http: &Client,
    symbol: &str,
    period: &str,
    limit: u64,
) -> Result<Value, String> {
    // Three perspectives in parallel — each is the same shape.
    let (global, top_acct, top_pos) = tokio::try_join!(
        fetch_lsr_series(http, "globalLongShortAccountRatio", symbol, period, limit),
        fetch_lsr_series(http, "topLongShortAccountRatio", symbol, period, limit),
        fetch_lsr_series(http, "topLongShortPositionRatio", symbol, period, limit),
    )?;

    fn latest(series: &[Value]) -> Value {
        series
            .last()
            .cloned()
            .unwrap_or_else(|| json!({ "ratio": 0.0, "long_pct": 0.0, "short_pct": 0.0 }))
    }

    Ok(json!({
        "metric": "long_short_ratio",
        "symbol": symbol,
        "period": period,
        "global_account": latest(&global),
        "top_account":    latest(&top_acct),
        "top_position":   latest(&top_pos),
        "history": {
            "global_account": global,
            "top_account":    top_acct,
            "top_position":   top_pos,
        },
        "note": "global=全部账户(看散户), top_account=持仓 top 账户数比, top_position=持仓 top 仓位比 (看大户)",
    }))
}

async fn fetch_lsr_series(
    http: &Client,
    endpoint: &str,
    symbol: &str,
    period: &str,
    limit: u64,
) -> Result<Vec<Value>, String> {
    let url = format!(
        "{}/futures/data/{}?symbol={}&period={}&limit={}",
        FAPI, endpoint, symbol, period, limit
    );
    let raw = get_json(http, &url).await?;
    Ok(raw
        .as_array()
        .map(|arr| {
            arr.iter()
                .map(|e| {
                    json!({
                        "time": e["timestamp"].as_i64().unwrap_or(0),
                        "ratio": parse_f64(&e["longShortRatio"]),
                        "long_pct": parse_f64(&e["longAccount"]),
                        "short_pct": parse_f64(&e["shortAccount"]),
                    })
                })
                .collect()
        })
        .unwrap_or_default())
}

/* ─── taker_buy_sell_ratio ─── */

async fn fetch_taker_ratio(
    http: &Client,
    symbol: &str,
    period: &str,
    limit: u64,
) -> Result<Value, String> {
    let url = format!(
        "{}/futures/data/takerlongshortRatio?symbol={}&period={}&limit={}",
        FAPI, symbol, period, limit
    );
    let raw = get_json(http, &url).await?;
    let history: Vec<Value> = raw
        .as_array()
        .map(|arr| {
            arr.iter()
                .map(|e| {
                    json!({
                        "time": e["timestamp"].as_i64().unwrap_or(0),
                        "ratio": parse_f64(&e["buySellRatio"]),
                        "buy_vol": parse_f64(&e["buyVol"]),
                        "sell_vol": parse_f64(&e["sellVol"]),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let current = history
        .last()
        .cloned()
        .unwrap_or_else(|| json!({ "ratio": 0.0, "buy_vol": 0.0, "sell_vol": 0.0 }));

    Ok(json!({
        "metric": "taker_buy_sell_ratio",
        "symbol": symbol,
        "period": period,
        "current": current,
        "history": history,
        "note": "buyVol / sellVol；>1 代表主动买盘强于主动卖盘",
    }))
}

/* ─── basis ─── */

async fn fetch_basis(
    http: &Client,
    symbol: &str,
    period: &str,
    limit: u64,
) -> Result<Value, String> {
    // basis 端点用 pair + contractType，pair 不带 USDT 之类后缀但 Binance 接受完整 symbol。
    let url = format!(
        "{}/futures/data/basis?pair={}&contractType=PERPETUAL&period={}&limit={}",
        FAPI, symbol, period, limit
    );
    let raw = get_json(http, &url).await?;
    let history: Vec<Value> = raw
        .as_array()
        .map(|arr| {
            arr.iter()
                .map(|e| {
                    let basis = parse_f64(&e["basis"]);
                    let basis_rate = parse_f64(&e["basisRate"]);
                    json!({
                        "time": e["timestamp"].as_i64().unwrap_or(0),
                        "basis": basis,
                        "basis_rate": basis_rate,
                        "basis_rate_pct": format!("{:.4}%", basis_rate * 100.0),
                        "futures_price": parse_f64(&e["futuresPrice"]),
                        "index_price": parse_f64(&e["indexPrice"]),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let current = history
        .last()
        .cloned()
        .unwrap_or_else(|| json!({ "basis": 0.0, "basis_rate": 0.0 }));

    Ok(json!({
        "metric": "basis",
        "symbol": symbol,
        "period": period,
        "current": current,
        "history": history,
        "note": "basis = 永续 - 现货指数；正值贴水/升水视情况，结合 funding 看市场情绪",
    }))
}
