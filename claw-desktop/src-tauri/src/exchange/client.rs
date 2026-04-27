use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use hmac::{Hmac, Mac};
use reqwest::Client;
use sha2::Sha256;
use std::time::{SystemTime, UNIX_EPOCH};

use super::types::{AccountBalance, AssetBalance, ExchangeBalance, ExchangeTestResult, Position};

type HmacSha256 = Hmac<Sha256>;

fn timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Formats Unix ms as ISO 8601 (e.g. "2024-04-05T12:00:00.000Z") required by OKX.
/// Uses Howard Hinnant's civil-from-days algorithm — no external date crate needed.
fn iso_timestamp() -> String {
    let ms = timestamp_ms() as i64;
    let secs = ms / 1000;
    let millis = ms % 1000;
    let s = secs % 60;
    let m = (secs / 60) % 60;
    let h = (secs / 3600) % 24;
    let days = secs / 86400;
    let (y, mo, d) = civil_from_days(days);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        y, mo, d, h, m, s, millis
    )
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

fn hmac_hex(secret: &str, data: &str) -> String {
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC key");
    mac.update(data.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

fn hmac_base64(secret: &str, data: &str) -> String {
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC key");
    mac.update(data.as_bytes());
    BASE64.encode(mac.finalize().into_bytes())
}

fn truncate_body(s: String) -> String {
    if s.len() > 300 {
        format!("{}…", &s[..300])
    } else {
        s
    }
}

/* ═══ Binance ═══ */

pub async fn binance_fetch_balance(
    http: &Client,
    api_key: &str,
    api_secret: &str,
) -> Result<ExchangeBalance, String> {
    let ts = timestamp_ms();
    let query = format!("timestamp={}&recvWindow=10000", ts);
    let sig = hmac_hex(api_secret, &query);
    let url = format!(
        "https://api.binance.com/api/v3/account?{}&signature={}",
        query, sig
    );

    let resp = http
        .get(&url)
        .header("X-MBX-APIKEY", api_key)
        .send()
        .await
        .map_err(|e| format!("网络错误: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = truncate_body(resp.text().await.unwrap_or_default());
        return Err(format!("Binance HTTP {}: {}", status, body));
    }

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Binance 解析失败: {}", e))?;

    let balances = body["balances"]
        .as_array()
        .ok_or("无法解析 Binance 余额")?;

    let stables = ["USDT", "USDC", "BUSD", "FDUSD"];
    let mut total_usd = 0.0f64;
    let mut available_usd = 0.0f64;
    let mut assets: Vec<AssetBalance> = Vec::new();

    for b in balances {
        let asset = b["asset"].as_str().unwrap_or("").to_string();
        let free: f64 = b["free"].as_str().unwrap_or("0").parse().unwrap_or(0.0);
        let locked: f64 = b["locked"].as_str().unwrap_or("0").parse().unwrap_or(0.0);
        if free + locked < 1e-8 {
            continue;
        }
        if stables.contains(&asset.as_str()) {
            total_usd += free + locked;
            available_usd += free;
        }
        assets.push(AssetBalance { asset, free, locked });
    }

    assets.sort_by(|a, b| {
        (b.free + b.locked)
            .partial_cmp(&(a.free + a.locked))
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    Ok(ExchangeBalance {
        total_usd,
        available_usd,
        assets,
    })
}

pub async fn binance_fetch_futures_balance(
    http: &Client,
    api_key: &str,
    api_secret: &str,
) -> Result<ExchangeBalance, String> {
    let ts = timestamp_ms();
    let query = format!("timestamp={}&recvWindow=10000", ts);
    let sig = hmac_hex(api_secret, &query);
    let url = format!(
        "https://fapi.binance.com/fapi/v2/balance?{}&signature={}",
        query, sig
    );

    let resp = http
        .get(&url)
        .header("X-MBX-APIKEY", api_key)
        .send()
        .await
        .map_err(|e| format!("网络错误: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = truncate_body(resp.text().await.unwrap_or_default());
        return Err(format!("Binance Futures HTTP {}: {}", status, body));
    }

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Binance Futures 解析失败: {}", e))?;

    let items = body
        .as_array()
        .ok_or("无法解析 Binance 合约余额")?;

    let stables = ["USDT", "USDC", "BUSD"];
    let mut total_usd = 0.0f64;
    let mut available_usd = 0.0f64;
    let mut assets: Vec<AssetBalance> = Vec::new();

    for item in items {
        let asset = item["asset"].as_str().unwrap_or("").to_string();
        let balance: f64 = item["balance"]
            .as_str()
            .unwrap_or("0")
            .parse()
            .unwrap_or(0.0);
        let available: f64 = item["availableBalance"]
            .as_str()
            .unwrap_or("0")
            .parse()
            .unwrap_or(0.0);
        if balance.abs() < 1e-8 {
            continue;
        }
        let locked = balance - available;
        if stables.contains(&asset.as_str()) {
            total_usd += balance;
            available_usd += available;
        }
        assets.push(AssetBalance {
            asset,
            free: available,
            locked: if locked > 0.0 { locked } else { 0.0 },
        });
    }

    assets.sort_by(|a, b| {
        (b.free + b.locked)
            .partial_cmp(&(a.free + a.locked))
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    Ok(ExchangeBalance {
        total_usd,
        available_usd,
        assets,
    })
}

/* ═══ OKX ═══ */

pub async fn okx_fetch_balance(
    http: &Client,
    api_key: &str,
    api_secret: &str,
    passphrase: &str,
) -> Result<ExchangeBalance, String> {
    let ts = iso_timestamp();
    let path = "/api/v5/account/balance";
    let prehash = format!("{}GET{}{}", ts, path, "");
    let sig = hmac_base64(api_secret, &prehash);
    let url = format!("https://www.okx.com{}", path);

    let resp = http
        .get(&url)
        .header("OK-ACCESS-KEY", api_key)
        .header("OK-ACCESS-SIGN", &sig)
        .header("OK-ACCESS-TIMESTAMP", &ts)
        .header("OK-ACCESS-PASSPHRASE", passphrase)
        .send()
        .await
        .map_err(|e| format!("网络错误: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = truncate_body(resp.text().await.unwrap_or_default());
        return Err(format!("OKX HTTP {}: {}", status, body));
    }

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("OKX 解析失败: {}", e))?;

    if body["code"].as_str() != Some("0") {
        let msg = body["msg"].as_str().unwrap_or("未知错误");
        return Err(format!("OKX API 错误: {}", msg));
    }

    let data = &body["data"][0];
    let total_usd: f64 = data["totalEq"]
        .as_str()
        .unwrap_or("0")
        .parse()
        .unwrap_or(0.0);
    let available_usd: f64 = data["availEq"]
        .as_str()
        .unwrap_or("0")
        .parse()
        .unwrap_or(0.0);

    let mut assets: Vec<AssetBalance> = Vec::new();
    if let Some(details) = data["details"].as_array() {
        for d in details {
            let asset = d["ccy"].as_str().unwrap_or("").to_string();
            let free: f64 = d["availBal"].as_str().unwrap_or("0").parse().unwrap_or(0.0);
            let locked: f64 = d["frozenBal"]
                .as_str()
                .unwrap_or("0")
                .parse()
                .unwrap_or(0.0);
            if free + locked < 1e-8 {
                continue;
            }
            assets.push(AssetBalance { asset, free, locked });
        }
    }

    Ok(ExchangeBalance {
        total_usd,
        available_usd,
        assets,
    })
}

/* ═══ Bitget ═══ */

pub async fn bitget_fetch_balance(
    http: &Client,
    api_key: &str,
    api_secret: &str,
    passphrase: &str,
) -> Result<ExchangeBalance, String> {
    let ts = timestamp_ms().to_string();
    let path = "/api/v2/spot/account/assets";
    let prehash = format!("{}GET{}{}", ts, path, "");
    let sig = hmac_base64(api_secret, &prehash);
    let url = format!("https://api.bitget.com{}", path);

    let resp = http
        .get(&url)
        .header("ACCESS-KEY", api_key)
        .header("ACCESS-SIGN", &sig)
        .header("ACCESS-TIMESTAMP", &ts)
        .header("ACCESS-PASSPHRASE", passphrase)
        .header("Content-Type", "application/json")
        .send()
        .await
        .map_err(|e| format!("网络错误: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = truncate_body(resp.text().await.unwrap_or_default());
        return Err(format!("Bitget HTTP {}: {}", status, body));
    }

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Bitget 解析失败: {}", e))?;

    if body["code"].as_str() != Some("00000") {
        let msg = body["msg"].as_str().unwrap_or("未知错误");
        return Err(format!("Bitget API 错误: {}", msg));
    }

    let stables = ["USDT", "USDC", "BUSD"];
    let mut total_usd = 0.0f64;
    let mut available_usd = 0.0f64;
    let mut assets: Vec<AssetBalance> = Vec::new();

    if let Some(data) = body["data"].as_array() {
        for item in data {
            let asset = item["coin"]
                .as_str()
                .or_else(|| item["coinName"].as_str())
                .unwrap_or("")
                .to_string();
            let free: f64 = item["available"]
                .as_str()
                .unwrap_or("0")
                .parse()
                .unwrap_or(0.0);
            let locked: f64 = item["frozen"]
                .as_str()
                .or_else(|| item["locked"].as_str())
                .unwrap_or("0")
                .parse()
                .unwrap_or(0.0);
            if free + locked < 1e-8 {
                continue;
            }
            if stables.contains(&asset.as_str()) {
                total_usd += free + locked;
                available_usd += free;
            }
            assets.push(AssetBalance { asset, free, locked });
        }
    }

    assets.sort_by(|a, b| {
        (b.free + b.locked)
            .partial_cmp(&(a.free + a.locked))
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    Ok(ExchangeBalance {
        total_usd,
        available_usd,
        assets,
    })
}

pub async fn bitget_fetch_futures_balance(
    http: &Client,
    api_key: &str,
    api_secret: &str,
    passphrase: &str,
) -> Result<ExchangeBalance, String> {
    let ts = timestamp_ms().to_string();
    let query = "productType=USDT-FUTURES";
    let path = "/api/v2/mix/account/accounts";
    let prehash = format!("{}GET{}?{}{}", ts, path, query, "");
    let sig = hmac_base64(api_secret, &prehash);
    let url = format!("https://api.bitget.com{}?{}", path, query);

    let resp = http
        .get(&url)
        .header("ACCESS-KEY", api_key)
        .header("ACCESS-SIGN", &sig)
        .header("ACCESS-TIMESTAMP", &ts)
        .header("ACCESS-PASSPHRASE", passphrase)
        .header("Content-Type", "application/json")
        .send()
        .await
        .map_err(|e| format!("网络错误: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = truncate_body(resp.text().await.unwrap_or_default());
        return Err(format!("Bitget Futures HTTP {}: {}", status, body));
    }

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Bitget Futures 解析失败: {}", e))?;

    if body["code"].as_str() != Some("00000") {
        let msg = body["msg"].as_str().unwrap_or("未知错误");
        return Err(format!("Bitget Futures API 错误: {}", msg));
    }

    let mut total_usd = 0.0f64;
    let mut available_usd = 0.0f64;
    let mut assets: Vec<AssetBalance> = Vec::new();

    if let Some(data) = body["data"].as_array() {
        for item in data {
            let margin_coin = item["marginCoin"]
                .as_str()
                .unwrap_or("")
                .to_string();
            let equity: f64 = item["usdtEquity"]
                .as_str()
                .or_else(|| item["accountEquity"].as_str())
                .unwrap_or("0")
                .parse()
                .unwrap_or(0.0);
            let available: f64 = item["available"]
                .as_str()
                .unwrap_or("0")
                .parse()
                .unwrap_or(0.0);
            let locked: f64 = item["locked"]
                .as_str()
                .unwrap_or("0")
                .parse()
                .unwrap_or(0.0);
            if equity.abs() < 1e-8 && available.abs() < 1e-8 {
                continue;
            }
            total_usd += equity;
            available_usd += available;
            assets.push(AssetBalance {
                asset: margin_coin,
                free: available,
                locked,
            });
        }
    }

    assets.sort_by(|a, b| {
        (b.free + b.locked)
            .partial_cmp(&(a.free + a.locked))
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    Ok(ExchangeBalance {
        total_usd,
        available_usd,
        assets,
    })
}

/* ═══ Dispatch helpers ═══ */

fn empty_balance() -> ExchangeBalance {
    ExchangeBalance {
        total_usd: 0.0,
        available_usd: 0.0,
        assets: Vec::new(),
    }
}

pub async fn fetch_account_balance(
    http: &Client,
    exchange_id: &str,
    api_key: &str,
    api_secret: &str,
    passphrase: Option<&str>,
) -> Result<AccountBalance, String> {
    match exchange_id {
        "binance" => {
            let spot = binance_fetch_balance(http, api_key, api_secret).await?;
            let futures = binance_fetch_futures_balance(http, api_key, api_secret)
                .await
                .unwrap_or_else(|_| empty_balance());
            Ok(AccountBalance { spot, futures })
        }
        "okx" => {
            // OKX unified account — balance endpoint covers both spot & futures
            let bal = okx_fetch_balance(http, api_key, api_secret, passphrase.unwrap_or("")).await?;
            Ok(AccountBalance {
                spot: bal.clone(),
                futures: bal,
            })
        }
        "bitget" => {
            let spot = bitget_fetch_balance(http, api_key, api_secret, passphrase.unwrap_or("")).await?;
            let futures = bitget_fetch_futures_balance(http, api_key, api_secret, passphrase.unwrap_or(""))
                .await
                .unwrap_or_else(|_| empty_balance());
            Ok(AccountBalance { spot, futures })
        }
        other => Err(format!("未知交易所: {}", other)),
    }
}

/* ═══ Positions ═══ */

pub async fn binance_fetch_positions(
    http: &Client,
    api_key: &str,
    api_secret: &str,
) -> Result<Vec<Position>, String> {
    let ts = timestamp_ms();
    let query = format!("timestamp={}&recvWindow=10000", ts);
    let sig = hmac_hex(api_secret, &query);
    let url = format!(
        "https://fapi.binance.com/fapi/v2/positionRisk?{}&signature={}",
        query, sig
    );

    let resp = http
        .get(&url)
        .header("X-MBX-APIKEY", api_key)
        .send()
        .await
        .map_err(|e| format!("网络错误: {}", e))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = truncate_body(resp.text().await.unwrap_or_default());
        return Err(format!("Binance Positions HTTP {}: {}", status, body));
    }
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Binance Positions 解析失败: {}", e))?;
    let items = body.as_array().ok_or("无法解析 Binance 持仓")?;

    let mut out = Vec::new();
    for it in items {
        let amt: f64 = it["positionAmt"]
            .as_str()
            .unwrap_or("0")
            .parse()
            .unwrap_or(0.0);
        if amt.abs() < 1e-10 {
            continue;
        }
        let entry: f64 = it["entryPrice"].as_str().unwrap_or("0").parse().unwrap_or(0.0);
        let mark: f64 = it["markPrice"].as_str().unwrap_or("0").parse().unwrap_or(0.0);
        let upnl: f64 = it["unRealizedProfit"]
            .as_str()
            .unwrap_or("0")
            .parse()
            .unwrap_or(0.0);
        let lev: f64 = it["leverage"].as_str().unwrap_or("0").parse().unwrap_or(0.0);
        let margin = it["marginType"].as_str().unwrap_or("").to_lowercase();
        out.push(Position {
            symbol: it["symbol"].as_str().unwrap_or("").to_string(),
            side: if amt > 0.0 { "long".into() } else { "short".into() },
            qty: amt.abs(),
            entry_price: entry,
            mark_price: mark,
            unrealized_pnl: upnl,
            leverage: if lev > 0.0 { Some(lev) } else { None },
            margin_mode: if margin.is_empty() { None } else { Some(margin) },
        });
    }
    Ok(out)
}

pub async fn okx_fetch_positions(
    http: &Client,
    api_key: &str,
    api_secret: &str,
    passphrase: &str,
) -> Result<Vec<Position>, String> {
    let ts = iso_timestamp();
    let path = "/api/v5/account/positions";
    let prehash = format!("{}GET{}{}", ts, path, "");
    let sig = hmac_base64(api_secret, &prehash);
    let url = format!("https://www.okx.com{}", path);

    let resp = http
        .get(&url)
        .header("OK-ACCESS-KEY", api_key)
        .header("OK-ACCESS-SIGN", &sig)
        .header("OK-ACCESS-TIMESTAMP", &ts)
        .header("OK-ACCESS-PASSPHRASE", passphrase)
        .send()
        .await
        .map_err(|e| format!("网络错误: {}", e))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = truncate_body(resp.text().await.unwrap_or_default());
        return Err(format!("OKX Positions HTTP {}: {}", status, body));
    }
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("OKX Positions 解析失败: {}", e))?;
    if body["code"].as_str() != Some("0") {
        return Err(format!(
            "OKX Positions API 错误: {}",
            body["msg"].as_str().unwrap_or("未知错误")
        ));
    }

    let data = body["data"].as_array().cloned().unwrap_or_default();
    let mut out = Vec::new();
    for d in data {
        let pos: f64 = d["pos"].as_str().unwrap_or("0").parse().unwrap_or(0.0);
        if pos.abs() < 1e-10 {
            continue;
        }
        let side_raw = d["posSide"].as_str().unwrap_or("net");
        let side = match side_raw {
            "long" => "long",
            "short" => "short",
            _ => {
                if pos > 0.0 {
                    "long"
                } else {
                    "short"
                }
            }
        };
        out.push(Position {
            symbol: d["instId"].as_str().unwrap_or("").to_string(),
            side: side.to_string(),
            qty: pos.abs(),
            entry_price: d["avgPx"].as_str().unwrap_or("0").parse().unwrap_or(0.0),
            mark_price: d["markPx"].as_str().unwrap_or("0").parse().unwrap_or(0.0),
            unrealized_pnl: d["upl"].as_str().unwrap_or("0").parse().unwrap_or(0.0),
            leverage: d["lever"].as_str().and_then(|s| s.parse().ok()),
            margin_mode: d["mgnMode"].as_str().map(|s| s.to_string()),
        });
    }
    Ok(out)
}

pub async fn bitget_fetch_positions(
    http: &Client,
    api_key: &str,
    api_secret: &str,
    passphrase: &str,
) -> Result<Vec<Position>, String> {
    let ts = timestamp_ms().to_string();
    let query = "productType=USDT-FUTURES";
    let path = "/api/v2/mix/position/all-position";
    let prehash = format!("{}GET{}?{}{}", ts, path, query, "");
    let sig = hmac_base64(api_secret, &prehash);
    let url = format!("https://api.bitget.com{}?{}", path, query);

    let resp = http
        .get(&url)
        .header("ACCESS-KEY", api_key)
        .header("ACCESS-SIGN", &sig)
        .header("ACCESS-TIMESTAMP", &ts)
        .header("ACCESS-PASSPHRASE", passphrase)
        .header("Content-Type", "application/json")
        .send()
        .await
        .map_err(|e| format!("网络错误: {}", e))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = truncate_body(resp.text().await.unwrap_or_default());
        return Err(format!("Bitget Positions HTTP {}: {}", status, body));
    }
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Bitget Positions 解析失败: {}", e))?;
    if body["code"].as_str() != Some("00000") {
        return Err(format!(
            "Bitget Positions API 错误: {}",
            body["msg"].as_str().unwrap_or("未知错误")
        ));
    }

    let data = body["data"].as_array().cloned().unwrap_or_default();
    let mut out = Vec::new();
    for d in data {
        let total: f64 = d["total"].as_str().unwrap_or("0").parse().unwrap_or(0.0);
        if total.abs() < 1e-10 {
            continue;
        }
        let hold_side = d["holdSide"].as_str().unwrap_or("long");
        out.push(Position {
            symbol: d["symbol"].as_str().unwrap_or("").to_string(),
            side: hold_side.to_string(),
            qty: total.abs(),
            entry_price: d["openPriceAvg"]
                .as_str()
                .or_else(|| d["averageOpenPrice"].as_str())
                .unwrap_or("0")
                .parse()
                .unwrap_or(0.0),
            mark_price: d["markPrice"].as_str().unwrap_or("0").parse().unwrap_or(0.0),
            unrealized_pnl: d["unrealizedPL"]
                .as_str()
                .unwrap_or("0")
                .parse()
                .unwrap_or(0.0),
            leverage: d["leverage"].as_str().and_then(|s| s.parse().ok()),
            margin_mode: d["marginMode"].as_str().map(|s| s.to_string()),
        });
    }
    Ok(out)
}

pub async fn fetch_positions(
    http: &Client,
    exchange_id: &str,
    api_key: &str,
    api_secret: &str,
    passphrase: Option<&str>,
) -> Result<Vec<Position>, String> {
    match exchange_id {
        "binance" => binance_fetch_positions(http, api_key, api_secret).await,
        "okx" => okx_fetch_positions(http, api_key, api_secret, passphrase.unwrap_or("")).await,
        "bitget" => {
            bitget_fetch_positions(http, api_key, api_secret, passphrase.unwrap_or("")).await
        }
        other => Err(format!("未知交易所: {}", other)),
    }
}

pub async fn test_exchange(
    http: &Client,
    exchange_id: &str,
    api_key: &str,
    api_secret: &str,
    passphrase: Option<&str>,
) -> ExchangeTestResult {
    match fetch_account_balance(http, exchange_id, api_key, api_secret, passphrase).await {
        Ok(bal) => {
            let spot_usd = bal.spot.total_usd;
            let futures_usd = bal.futures.total_usd;
            ExchangeTestResult {
                success: true,
                message: format!(
                    "连接成功 · 现货 ${:.2} · 合约 ${:.2}",
                    spot_usd, futures_usd
                ),
            }
        }
        Err(e) => ExchangeTestResult {
            success: false,
            message: e,
        },
    }
}
