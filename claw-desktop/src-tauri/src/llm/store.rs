use std::sync::Mutex;
use tauri::AppHandle;
use tauri_plugin_store::StoreBuilder;

use super::codex;
use super::types::{AuthMethod, AuthState, StoredCredential};

const STORE_FILE: &str = "credentials.json";
const CREDS_KEY: &str = "credentials";

pub struct CredentialStore {
    credentials: Mutex<Vec<StoredCredential>>,
}

impl CredentialStore {
    pub fn new() -> Self {
        Self {
            credentials: Mutex::new(Vec::new()),
        }
    }

    pub fn load(&self, app: &AppHandle) {
        let store = StoreBuilder::new(app, STORE_FILE).build();
        if let Ok(store) = store {
            if let Some(val) = store.get(CREDS_KEY) {
                if let Ok(creds) = serde_json::from_value::<Vec<StoredCredential>>(val.clone()) {
                    let mut guard = self.credentials.lock().unwrap();
                    *guard = creds;
                }
            }
        }
    }

    fn persist(&self, app: &AppHandle) {
        if let Ok(store) = StoreBuilder::new(app, STORE_FILE).build() {
            let guard = self.credentials.lock().unwrap();
            let val = serde_json::to_value(&*guard).unwrap_or_default();
            let _ = store.set(CREDS_KEY, val);
            let _ = store.save();
        }
    }

    pub fn save_api_key(&self, app: &AppHandle, provider_id: &str, api_key: &str) {
        let mut guard = self.credentials.lock().unwrap();
        if let Some(cred) = guard.iter_mut().find(|c| c.provider_id == provider_id) {
            cred.method = AuthMethod::ApiKey;
            cred.api_key = Some(api_key.to_string());
        } else {
            guard.push(StoredCredential {
                provider_id: provider_id.to_string(),
                method: AuthMethod::ApiKey,
                api_key: Some(api_key.to_string()),
                oauth_access_token: None,
                oauth_refresh_token: None,
                oauth_expires_at: None,
                oauth_email: None,
            });
        }
        drop(guard);
        self.persist(app);
    }

    pub fn save_oauth_tokens(
        &self,
        app: &AppHandle,
        provider_id: &str,
        access_token: &str,
        refresh_token: Option<&str>,
        expires_at: Option<u64>,
        email: Option<&str>,
    ) {
        let mut guard = self.credentials.lock().unwrap();
        if let Some(cred) = guard.iter_mut().find(|c| c.provider_id == provider_id) {
            cred.method = AuthMethod::OAuth;
            cred.oauth_access_token = Some(access_token.to_string());
            cred.oauth_refresh_token = refresh_token.map(|s| s.to_string());
            cred.oauth_expires_at = expires_at;
            cred.oauth_email = email.map(|s| s.to_string());
        } else {
            guard.push(StoredCredential {
                provider_id: provider_id.to_string(),
                method: AuthMethod::OAuth,
                api_key: None,
                oauth_access_token: Some(access_token.to_string()),
                oauth_refresh_token: refresh_token.map(|s| s.to_string()),
                oauth_expires_at: expires_at,
                oauth_email: email.map(|s| s.to_string()),
            });
        }
        drop(guard);
        self.persist(app);
    }

    pub fn delete_credential(&self, app: &AppHandle, provider_id: &str) {
        let mut guard = self.credentials.lock().unwrap();
        guard.retain(|c| c.provider_id != provider_id);
        drop(guard);
        self.persist(app);
    }

    pub fn get_auth_state(&self, provider_id: &str) -> AuthState {
        let guard = self.credentials.lock().unwrap();
        if let Some(cred) = guard.iter().find(|c| c.provider_id == provider_id) {
            let connected = match cred.method {
                AuthMethod::ApiKey => cred.api_key.is_some(),
                AuthMethod::OAuth => cred.oauth_access_token.is_some(),
                AuthMethod::None => false,
            };
            let masked_key = cred.api_key.as_ref().map(|k| mask_key(k));
            let email = cred.oauth_email.clone().or_else(|| {
                codex::extract_email(cred.oauth_access_token.as_deref())
            });
            AuthState {
                provider_id: provider_id.to_string(),
                method: cred.method.clone(),
                connected,
                masked_key,
                email,
                error: None,
            }
        } else {
            AuthState {
                provider_id: provider_id.to_string(),
                method: AuthMethod::None,
                connected: false,
                masked_key: None,
                email: None,
                error: None,
            }
        }
    }

    pub fn get_bearer_token(&self, provider_id: &str) -> Option<String> {
        let guard = self.credentials.lock().unwrap();
        guard.iter().find(|c| c.provider_id == provider_id).and_then(|cred| {
            match cred.method {
                AuthMethod::ApiKey => cred.api_key.clone(),
                AuthMethod::OAuth => cred.oauth_access_token.clone(),
                AuthMethod::None => None,
            }
        })
    }

    pub fn get_all_auth_states(&self) -> Vec<AuthState> {
        let provider_ids = ["openai", "anthropic", "deepseek", "google", "xai"];
        provider_ids.iter().map(|id| self.get_auth_state(id)).collect()
    }
}

fn mask_key(key: &str) -> String {
    if key.len() <= 8 {
        return "••••••••".to_string();
    }
    let prefix = &key[..4];
    let suffix = &key[key.len() - 4..];
    format!("{}••••••••{}", prefix, suffix)
}
