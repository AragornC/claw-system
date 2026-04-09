mod agent;
mod agent_commands;
mod commands;
mod exchange;
mod exchange_commands;
mod llm;

use agent::store::AgentConfigStore;
use exchange::store::ExchangeStore;
use exchange_commands::ExchangeClient;
use llm::client::LlmClient;
use llm::store::CredentialStore;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .manage(AgentConfigStore::new())
        .manage(CredentialStore::new())
        .manage(LlmClient::new())
        .manage(ExchangeStore::new())
        .manage(ExchangeClient::new())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            let store: &CredentialStore = app.state::<CredentialStore>().inner();
            store.load(app.handle());
            let ex_store: &ExchangeStore = app.state::<ExchangeStore>().inner();
            ex_store.load(app.handle());
            let ag_store: &AgentConfigStore = app.state::<AgentConfigStore>().inner();
            ag_store.load(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::save_api_key,
            commands::get_api_key,
            commands::delete_api_key,
            commands::get_all_auth_states,
            commands::test_connection,
            commands::start_oauth,
            commands::refresh_oauth_status,
            commands::oauth_disconnect,
            commands::get_provider_models,
            commands::chat_stream,
            exchange_commands::save_exchange_key,
            exchange_commands::delete_exchange_key,
            exchange_commands::get_all_exchange_auth_states,
            exchange_commands::test_exchange_connection,
            exchange_commands::fetch_exchange_balance,
            exchange_commands::get_active_exchange,
            agent_commands::load_agent_config,
            agent_commands::save_agent_config,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
