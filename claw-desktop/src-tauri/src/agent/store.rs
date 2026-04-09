use std::sync::Mutex;
use tauri::AppHandle;
use tauri_plugin_store::StoreBuilder;

use super::types::AgentConfig;

const STORE_FILE: &str = "agent_config.json";
const CONFIG_KEY: &str = "agent_config";

pub struct AgentConfigStore {
    config: Mutex<Option<AgentConfig>>,
}

impl AgentConfigStore {
    pub fn new() -> Self {
        Self {
            config: Mutex::new(None),
        }
    }

    pub fn load(&self, app: &AppHandle) {
        if let Ok(store) = StoreBuilder::new(app, STORE_FILE).build() {
            if let Some(val) = store.get(CONFIG_KEY) {
                if let Ok(cfg) = serde_json::from_value::<AgentConfig>(val.clone()) {
                    *self.config.lock().unwrap() = Some(cfg);
                }
            }
        }
    }

    fn persist(&self, app: &AppHandle) {
        if let Ok(store) = StoreBuilder::new(app, STORE_FILE).build() {
            let guard = self.config.lock().unwrap();
            if let Some(ref cfg) = *guard {
                let val = serde_json::to_value(cfg).unwrap_or_default();
                let _ = store.set(CONFIG_KEY, val);
                let _ = store.save();
            }
        }
    }

    pub fn get_config(&self) -> Option<AgentConfig> {
        self.config.lock().unwrap().clone()
    }

    pub fn save_config(&self, app: &AppHandle, config: AgentConfig) {
        *self.config.lock().unwrap() = Some(config);
        self.persist(app);
    }
}
