use std::sync::Mutex;
use tauri::AppHandle;
use tauri_plugin_store::StoreBuilder;

use super::types::{ExchangeAuthState, ExchangeCred};

const STORE_FILE: &str = "exchange_creds.json";
const CREDS_KEY: &str = "exchange_credentials";

pub struct ExchangeStore {
    creds: Mutex<Vec<ExchangeCred>>,
}

impl ExchangeStore {
    pub fn new() -> Self {
        Self {
            creds: Mutex::new(Vec::new()),
        }
    }

    pub fn load(&self, app: &AppHandle) {
        if let Ok(store) = StoreBuilder::new(app, STORE_FILE).build() {
            if let Some(val) = store.get(CREDS_KEY) {
                if let Ok(creds) = serde_json::from_value::<Vec<ExchangeCred>>(val.clone()) {
                    *self.creds.lock().unwrap() = creds;
                }
            }
        }
    }

    fn persist(&self, app: &AppHandle) {
        if let Ok(store) = StoreBuilder::new(app, STORE_FILE).build() {
            let guard = self.creds.lock().unwrap();
            let val = serde_json::to_value(&*guard).unwrap_or_default();
            let _ = store.set(CREDS_KEY, val);
            let _ = store.save();
        }
    }

    pub fn save_cred(&self, app: &AppHandle, cred: ExchangeCred) {
        let mut guard = self.creds.lock().unwrap();
        guard.clear();
        guard.push(cred);
        drop(guard);
        self.persist(app);
    }

    pub fn delete_cred(&self, app: &AppHandle, exchange_id: &str) {
        let mut guard = self.creds.lock().unwrap();
        guard.retain(|c| c.exchange_id != exchange_id);
        drop(guard);
        self.persist(app);
    }

    pub fn get_cred(&self, exchange_id: &str) -> Option<ExchangeCred> {
        self.creds
            .lock()
            .unwrap()
            .iter()
            .find(|c| c.exchange_id == exchange_id)
            .cloned()
    }

    pub fn get_auth_state(&self, exchange_id: &str) -> ExchangeAuthState {
        let guard = self.creds.lock().unwrap();
        if let Some(cred) = guard.iter().find(|c| c.exchange_id == exchange_id) {
            ExchangeAuthState {
                exchange_id: exchange_id.to_string(),
                connected: true,
                masked_key: Some(mask_key(&cred.api_key)),
                error: None,
            }
        } else {
            ExchangeAuthState {
                exchange_id: exchange_id.to_string(),
                connected: false,
                masked_key: None,
                error: None,
            }
        }
    }

    pub fn get_all_auth_states(&self) -> Vec<ExchangeAuthState> {
        ["binance", "okx", "bitget"]
            .iter()
            .map(|id| self.get_auth_state(id))
            .collect()
    }

    pub fn get_active(&self) -> Option<ExchangeCred> {
        self.creds.lock().unwrap().first().cloned()
    }
}

fn mask_key(key: &str) -> String {
    if key.len() <= 8 {
        return "••••••••".to_string();
    }
    format!("{}••••••••{}", &key[..4], &key[key.len() - 4..])
}
