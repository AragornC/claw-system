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
pub struct ExchangeTestResult {
    pub success: bool,
    pub message: String,
}
