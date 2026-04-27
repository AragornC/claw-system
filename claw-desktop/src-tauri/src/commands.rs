use tauri::{AppHandle, State, ipc::Channel};

use crate::llm::client::LlmClient;
use crate::llm::codex;
use crate::llm::oauth;
use crate::llm::store::CredentialStore;
use crate::llm::types::{
    AuthState, ChatMessage, StreamChunk, TestResult, built_in_providers,
};

pub(crate) const CODEX_PROVIDER: &str = "openai";

pub(crate) struct OpenAiAuth {
    pub access_token: String,
    pub account_id: String,
}

pub(crate) async fn resolve_openai_auth(
    app: &AppHandle,
    store: &CredentialStore,
) -> Result<OpenAiAuth, String> {
    if let Some(token) = store.get_bearer_token(CODEX_PROVIDER) {
        if let Some(account_id) = codex::extract_account_id(Some(&token)) {
            return Ok(OpenAiAuth { access_token: token, account_id });
        }
    }

    let auth = codex::load_and_refresh_codex_auth().await?;
    store.save_oauth_tokens(
        app,
        CODEX_PROVIDER,
        &auth.access_token,
        auth.refresh_token.as_deref(),
        auth.expires_at,
        auth.email.as_deref(),
    );
    Ok(OpenAiAuth {
        access_token: auth.access_token,
        account_id: auth.account_id,
    })
}

#[tauri::command]
pub async fn save_api_key(
    app: AppHandle,
    store: State<'_, CredentialStore>,
    provider_id: String,
    api_key: String,
) -> Result<AuthState, String> {
    store.save_api_key(&app, &provider_id, &api_key);
    Ok(store.get_auth_state(&provider_id))
}

#[tauri::command]
pub async fn get_api_key(
    store: State<'_, CredentialStore>,
    provider_id: String,
) -> Result<AuthState, String> {
    Ok(store.get_auth_state(&provider_id))
}

#[tauri::command]
pub async fn delete_api_key(
    app: AppHandle,
    store: State<'_, CredentialStore>,
    provider_id: String,
) -> Result<AuthState, String> {
    store.delete_credential(&app, &provider_id);
    Ok(store.get_auth_state(&provider_id))
}

#[tauri::command]
pub async fn get_all_auth_states(
    store: State<'_, CredentialStore>,
) -> Result<Vec<AuthState>, String> {
    Ok(store.get_all_auth_states())
}

#[tauri::command]
pub async fn test_connection(
    app: AppHandle,
    store: State<'_, CredentialStore>,
    client: State<'_, LlmClient>,
    provider_id: String,
) -> Result<TestResult, String> {
    if provider_id == CODEX_PROVIDER {
        let auth = resolve_openai_auth(&app, &store).await?;
        return Ok(client
            .test_codex_connection(&auth.access_token, &auth.account_id)
            .await);
    }

    let providers = built_in_providers();
    let provider = providers
        .iter()
        .find(|p| p.id == provider_id)
        .ok_or_else(|| format!("未知服务商: {}", provider_id))?;

    let token = store
        .get_bearer_token(&provider_id)
        .ok_or("未配置凭据，请先保存 API Key 或完成 OAuth 登录")?;

    Ok(client.test_connection(&provider.base_url, &token).await)
}

#[tauri::command]
pub async fn start_oauth(
    app: AppHandle,
    store: State<'_, CredentialStore>,
    provider_id: String,
) -> Result<AuthState, String> {
    if provider_id == CODEX_PROVIDER {
        if let Ok(auth) = codex::load_and_refresh_codex_auth().await {
            store.save_oauth_tokens(
                &app,
                &provider_id,
                &auth.access_token,
                auth.refresh_token.as_deref(),
                auth.expires_at,
                auth.email.as_deref(),
            );
            return Ok(store.get_auth_state(&provider_id));
        }
    }

    let providers = built_in_providers();
    let provider = providers
        .iter()
        .find(|p| p.id == provider_id)
        .ok_or_else(|| format!("未知服务商: {}", provider_id))?;

    if !provider.supports_oauth {
        return Err("该服务商不支持 OAuth 登录".into());
    }

    let result = oauth::start_oauth_flow(provider).await?;

    let expires_at = result.expires_in.map(|secs| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            + secs
    });

    store.save_oauth_tokens(
        &app,
        &provider_id,
        &result.access_token,
        result.refresh_token.as_deref(),
        expires_at,
        None,
    );

    Ok(store.get_auth_state(&provider_id))
}

/// 静默刷新 OAuth 状态：从 Codex 文件更新凭据（含邮件），绝不打开浏览器。
/// 适合"刷新状态"按钮和应用启动时的初始化。
#[tauri::command]
pub async fn refresh_oauth_status(
    app: AppHandle,
    store: State<'_, CredentialStore>,
    provider_id: String,
) -> Result<AuthState, String> {
    if provider_id == CODEX_PROVIDER {
        if let Ok(auth) = codex::load_and_refresh_codex_auth().await {
            store.save_oauth_tokens(
                &app,
                &provider_id,
                &auth.access_token,
                auth.refresh_token.as_deref(),
                auth.expires_at,
                auth.email.as_deref(),
            );
        }
        return Ok(store.get_auth_state(&provider_id));
    }
    Ok(store.get_auth_state(&provider_id))
}

#[tauri::command]
pub async fn oauth_disconnect(
    app: AppHandle,
    store: State<'_, CredentialStore>,
    provider_id: String,
) -> Result<AuthState, String> {
    store.delete_credential(&app, &provider_id);
    Ok(store.get_auth_state(&provider_id))
}

#[tauri::command]
pub async fn get_provider_models(
    app: AppHandle,
    store: State<'_, CredentialStore>,
    client: State<'_, LlmClient>,
    provider_id: String,
) -> Result<Vec<String>, String> {
    if provider_id == CODEX_PROVIDER {
        let auth = resolve_openai_auth(&app, &store).await?;
        return client.fetch_codex_models(&auth.access_token, &auth.account_id).await;
    }

    Err("该服务商暂未实现动态模型列表".into())
}

#[tauri::command]
pub async fn chat_stream(
    app: AppHandle,
    store: State<'_, CredentialStore>,
    client: State<'_, LlmClient>,
    provider_id: String,
    model: String,
    messages: Vec<ChatMessage>,
    channel: Channel<StreamChunk>,
) -> Result<(), String> {
    if provider_id == CODEX_PROVIDER {
        let auth = resolve_openai_auth(&app, &store).await?;
        client
            .chat_codex_stream(
                &auth.access_token,
                &auth.account_id,
                &model,
                &messages,
                |chunk| {
                    let _ = channel.send(chunk);
                },
            )
            .await;
        return Ok(());
    }

    let providers = built_in_providers();
    let provider = providers
        .iter()
        .find(|p| p.id == provider_id)
        .ok_or_else(|| format!("未知服务商: {}", provider_id))?;

    let token = store
        .get_bearer_token(&provider_id)
        .ok_or("未配置凭据")?;

    client
        .chat_stream(&provider.base_url, &token, &model, &messages, |chunk| {
            let _ = channel.send(chunk);
        })
        .await;

    Ok(())
}
