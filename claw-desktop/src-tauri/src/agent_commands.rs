use tauri::{AppHandle, State};

use crate::agent::{
    store::AgentConfigStore,
    types::AgentConfig,
};

#[tauri::command]
pub fn load_agent_config(
    store: State<'_, AgentConfigStore>,
) -> Result<Option<AgentConfig>, String> {
    Ok(store.get_config())
}

#[tauri::command]
pub fn save_agent_config(
    app: AppHandle,
    store: State<'_, AgentConfigStore>,
    config: AgentConfig,
) -> Result<(), String> {
    store.save_config(&app, config);
    Ok(())
}
