use reqwest::Client;
use serde_json::Value;

const BINANCE_API: &str = "https://api.binance.com/api/v3";

fn sym(args: &Value) -> String {
    args["symbol"]
        .as_str()
        .unwrap_or("BTC/USDT")
        .replace('/', "")
        .to_uppercase()
}

/// Get real-time price from Binance
pub async fn get_price(args: Value) -> Result<Value, String> {
    let symbol = sym(&args);
    let url = format!("{}/ticker/24hr?symbol={}", BINANCE_API, symbol);
    let client = Client::new();
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Binance request failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Binance HTTP {}", resp.status()));
    }

    let data: Value = resp
        .json()
        .await
        .map_err(|e| format!("Parse error: {}", e))?;

    let display_symbol = args["symbol"].as_str().unwrap_or("BTC/USDT");
    let price: f64 = data["lastPrice"]
        .as_str()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0.0);
    let change_pct: f64 = data["priceChangePercent"]
        .as_str()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0.0);
    let high: f64 = data["highPrice"]
        .as_str()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0.0);
    let low: f64 = data["lowPrice"]
        .as_str()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0.0);
    let volume: f64 = data["quoteVolume"]
        .as_str()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0.0);

    Ok(serde_json::json!({
        "symbol": display_symbol,
        "price": price,
        "change_24h": format!("{:.2}%", change_pct),
        "high_24h": high,
        "low_24h": low,
        "volume_24h": format!("${:.2}B", volume / 1e9),
    }))
}

/// Get K-line (OHLCV) data from Binance
pub async fn get_klines(args: Value) -> Result<Value, String> {
    let symbol = sym(&args);
    let interval = args["interval"].as_str().unwrap_or("1h");
    let limit = args["limit"].as_u64().unwrap_or(100);
    let url = format!(
        "{}/klines?symbol={}&interval={}&limit={}",
        BINANCE_API, symbol, interval, limit
    );

    let client = Client::new();
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Binance request failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Binance HTTP {}", resp.status()));
    }

    let data: Vec<Value> = resp
        .json()
        .await
        .map_err(|e| format!("Parse error: {}", e))?;

    let closes: Vec<f64> = data
        .iter()
        .filter_map(|c| c[4].as_str().and_then(|s| s.parse().ok()))
        .collect();

    let latest = data.last().cloned().unwrap_or(Value::Null);
    let display_symbol = args["symbol"].as_str().unwrap_or("BTC/USDT");

    Ok(serde_json::json!({
        "symbol": display_symbol,
        "interval": interval,
        "count": data.len(),
        "latest": {
            "open": latest[1].as_str().and_then(|s| s.parse::<f64>().ok()),
            "high": latest[2].as_str().and_then(|s| s.parse::<f64>().ok()),
            "low": latest[3].as_str().and_then(|s| s.parse::<f64>().ok()),
            "close": latest[4].as_str().and_then(|s| s.parse::<f64>().ok()),
        },
        "closes": closes,
    }))
}

/// Calculate technical indicator from Binance kline data
pub async fn calculate_indicator(args: Value) -> Result<Value, String> {
    let symbol = sym(&args);
    let indicator = args["indicator"]
        .as_str()
        .unwrap_or("RSI")
        .to_uppercase();
    let period = args["period"].as_u64().unwrap_or(14) as usize;
    let limit = std::cmp::max(period * 3, 50);

    let interval = args["interval"].as_str().unwrap_or("1d");
    let url = format!(
        "{}/klines?symbol={}&interval={}&limit={}",
        BINANCE_API, symbol, interval, limit
    );

    let client = Client::new();
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Binance request failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Binance HTTP {}", resp.status()));
    }

    let data: Vec<Value> = resp
        .json()
        .await
        .map_err(|e| format!("Parse error: {}", e))?;

    let closes: Vec<f64> = data
        .iter()
        .filter_map(|c| c[4].as_str().and_then(|s| s.parse().ok()))
        .collect();

    if closes.len() < period + 1 {
        return Err("Not enough data for indicator calculation".into());
    }

    match indicator.as_str() {
        "RSI" => {
            let rsi = calc_rsi(&closes, period);
            let signal = if rsi < 30.0 {
                "超卖"
            } else if rsi > 70.0 {
                "超买"
            } else {
                "中性"
            };
            Ok(serde_json::json!({
                "indicator": "RSI",
                "period": period,
                "value": (rsi * 10.0).round() / 10.0,
                "signal": signal,
            }))
        }
        "MACD" => {
            let (macd, signal, histogram) = calc_macd(&closes);
            let trend = if macd < 0.0 {
                if histogram > 0.0 { "空头收敛" } else { "空头延续" }
            } else {
                if histogram < 0.0 { "多头收敛" } else { "多头延续" }
            };
            Ok(serde_json::json!({
                "indicator": "MACD",
                "macd": (macd * 100.0).round() / 100.0,
                "signal": (signal * 100.0).round() / 100.0,
                "histogram": (histogram * 100.0).round() / 100.0,
                "trend": trend,
            }))
        }
        "BOLL" => {
            let p = args["period"].as_u64().unwrap_or(20) as usize;
            let slice = &closes[closes.len().saturating_sub(p)..];
            let mean = slice.iter().sum::<f64>() / slice.len() as f64;
            let variance = slice.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / slice.len() as f64;
            let std = variance.sqrt();
            Ok(serde_json::json!({
                "indicator": "BOLL",
                "upper": ((mean + 2.0 * std) * 1.0).round(),
                "middle": mean.round(),
                "lower": ((mean - 2.0 * std) * 1.0).round(),
            }))
        }
        _ => Err(format!("Unknown indicator: {}", indicator)),
    }
}

// ── RSI calculation (Wilder's smoothing) ────────────────────

fn calc_rsi(closes: &[f64], period: usize) -> f64 {
    let start = closes.len() - period - 1;
    let mut gains = 0.0_f64;
    let mut losses = 0.0_f64;

    for i in 1..=period {
        let diff = closes[start + i] - closes[start + i - 1];
        if diff > 0.0 {
            gains += diff;
        } else {
            losses -= diff;
        }
    }

    let mut avg_gain = gains / period as f64;
    let mut avg_loss = losses / period as f64;

    for i in (start + period + 1)..closes.len() {
        let diff = closes[i] - closes[i - 1];
        avg_gain = (avg_gain * (period as f64 - 1.0) + if diff > 0.0 { diff } else { 0.0 }) / period as f64;
        avg_loss = (avg_loss * (period as f64 - 1.0) + if diff < 0.0 { -diff } else { 0.0 }) / period as f64;
    }

    if avg_loss == 0.0 {
        return 100.0;
    }
    100.0 - 100.0 / (1.0 + avg_gain / avg_loss)
}

// ── MACD calculation (EMA 12/26/9) ──────────────────────────

fn calc_macd(closes: &[f64]) -> (f64, f64, f64) {
    let fast = 12;
    let slow = 26;
    let sig = 9;

    let kf = 2.0 / (fast as f64 + 1.0);
    let ks = 2.0 / (slow as f64 + 1.0);

    let mut ema_fast = closes[0];
    let mut ema_slow = closes[0];
    let mut macd_line = Vec::with_capacity(closes.len());

    for &close in closes {
        ema_fast = close * kf + ema_fast * (1.0 - kf);
        ema_slow = close * ks + ema_slow * (1.0 - ks);
        macd_line.push(ema_fast - ema_slow);
    }

    let ks2 = 2.0 / (sig as f64 + 1.0);
    let mut signal_line = macd_line[0];
    for &m in &macd_line[1..] {
        signal_line = m * ks2 + signal_line * (1.0 - ks2);
    }

    let macd = *macd_line.last().unwrap_or(&0.0);
    (macd, signal_line, macd - signal_line)
}
