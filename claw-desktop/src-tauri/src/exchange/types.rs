use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExchangeCred {
    pub exchange_id: String,
    pub api_key: String,
    pub api_secret: String,
    pub passphrase: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExchangeAuthState {
    pub exchange_id: String,
    pub connected: bool,
    pub masked_key: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExchangeBalance {
    pub total_usd: f64,
    pub available_usd: f64,
    pub assets: Vec<AssetBalance>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssetBalance {
    pub asset: String,
    pub free: f64,
    pub locked: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountBalance {
    pub spot: ExchangeBalance,
    pub futures: ExchangeBalance,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExchangeTestResult {
    pub success: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Position {
    pub symbol: String,
    pub side: String,         // "long" | "short"
    pub qty: f64,             // signed/unsigned contracts or coin amount
    pub entry_price: f64,
    pub mark_price: f64,
    pub unrealized_pnl: f64,
    pub leverage: Option<f64>,
    pub margin_mode: Option<String>, // "cross" | "isolated"
}
