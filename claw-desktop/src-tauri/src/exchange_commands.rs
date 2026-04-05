use reqwest::Client;
use tauri::{AppHandle, State};

use crate::exchange::{
    client::{fetch_balance, test_exchange},
    store::ExchangeStore,
    types::{ExchangeAuthState, ExchangeBalance, ExchangeCred, ExchangeTestResult},
};

pub struct ExchangeClient {
    pub http: Client,
}

impl ExchangeClient {
    pub fn new() -> Self {
        Self {
            http: Client::new(),
        }
    }
}

#[tauri::command]
pub async fn save_exchange_key(
    app: AppHandle,
    store: State<'_, ExchangeStore>,
    exchange_id: String,
    api_key: String,
    api_secret: String,
    passphrase: Option<String>,
) -> Result<ExchangeAuthState, String> {
    let cred = ExchangeCred {
        exchange_id: exchange_id.clone(),
        api_key,
        api_secret,
        passphrase,
    };
    store.save_cred(&app, cred);
    Ok(store.get_auth_state(&exchange_id))
}

#[tauri::command]
pub async fn delete_exchange_key(
    app: AppHandle,
    store: State<'_, ExchangeStore>,
    exchange_id: String,
) -> Result<ExchangeAuthState, String> {
    store.delete_cred(&app, &exchange_id);
    Ok(store.get_auth_state(&exchange_id))
}

#[tauri::command]
pub async fn get_all_exchange_auth_states(
    store: State<'_, ExchangeStore>,
) -> Result<Vec<ExchangeAuthState>, String> {
    Ok(store.get_all_auth_states())
}

#[tauri::command]
pub async fn test_exchange_connection(
    store: State<'_, ExchangeStore>,
    client: State<'_, ExchangeClient>,
    exchange_id: String,
) -> Result<ExchangeTestResult, String> {
    let cred = store
        .get_cred(&exchange_id)
        .ok_or("未配置凭据，请先保存 API Key")?;
    let result = test_exchange(
        &client.http,
        &exchange_id,
        &cred.api_key,
        &cred.api_secret,
        cred.passphrase.as_deref(),
    )
    .await;
    Ok(result)
}

#[tauri::command]
pub async fn fetch_exchange_balance(
    store: State<'_, ExchangeStore>,
    client: State<'_, ExchangeClient>,
    exchange_id: String,
) -> Result<ExchangeBalance, String> {
    let cred = store
        .get_cred(&exchange_id)
        .ok_or("未配置凭据")?;
    fetch_balance(
        &client.http,
        &exchange_id,
        &cred.api_key,
        &cred.api_secret,
        cred.passphrase.as_deref(),
    )
    .await
}
