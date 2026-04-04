mod commands;
mod llm;

use llm::client::LlmClient;
use llm::store::CredentialStore;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .manage(CredentialStore::new())
        .manage(LlmClient::new())
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
