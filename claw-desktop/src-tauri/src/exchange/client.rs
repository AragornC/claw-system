use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use hmac::{Hmac, Mac};
use reqwest::Client;
use sha2::Sha256;
use std::time::{SystemTime, UNIX_EPOCH};

use super::types::{AssetBalance, ExchangeBalance, ExchangeTestResult};

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

/* ═══ Dispatch helpers ═══ */

pub async fn fetch_balance(
    http: &Client,
    exchange_id: &str,
    api_key: &str,
    api_secret: &str,
    passphrase: Option<&str>,
) -> Result<ExchangeBalance, String> {
    match exchange_id {
        "binance" => binance_fetch_balance(http, api_key, api_secret).await,
        "okx" => {
            okx_fetch_balance(http, api_key, api_secret, passphrase.unwrap_or("")).await
        }
        "bitget" => {
            bitget_fetch_balance(http, api_key, api_secret, passphrase.unwrap_or("")).await
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
    match fetch_balance(http, exchange_id, api_key, api_secret, passphrase).await {
        Ok(bal) => ExchangeTestResult {
            success: true,
            message: format!("连接成功，账户余额 ${:.2}", bal.total_usd),
        },
        Err(e) => ExchangeTestResult {
            success: false,
            message: e,
        },
    }
}
