use tauri::{AppHandle, State, ipc::Channel};

use crate::commands::{CODEX_PROVIDER, resolve_openai_auth};
use crate::exchange::store::ExchangeStore;
use crate::exchange_commands::ExchangeClient;
use crate::llm::client::LlmClient;
use crate::llm::codex;
use crate::llm::store::CredentialStore;
use crate::llm::types::{ToolDef, WorkflowChunk, WorkflowMessage};

use crate::tools;
use crate::tools::ExchangeBinding;

/// Stream chat completions with optional tool calling support.
/// Returns WorkflowChunk events containing content deltas and/or tool call deltas.
///
/// Routing:
///   - OpenAI provider + OAuth token (ChatGPT Plus / Codex) → Codex Responses API
///     at chatgpt.com/backend-api/codex/responses (tool calling supported)
///   - Anything else → standard Chat Completions at the provider's base_url
#[tauri::command]
// `tool_choice` is passed through to the OpenAI-compatible API. Accepts:
//   "auto" | "required" | "none"
//   { type: "function", function: { name: "…" } }
pub async fn chat_stream_with_tools(
    app: AppHandle,
    store: State<'_, CredentialStore>,
    client: State<'_, LlmClient>,
    provider_id: String,
    model: String,
    messages: Vec<WorkflowMessage>,
    tools: Option<Vec<ToolDef>>,
    tool_choice: Option<serde_json::Value>,
    channel: Channel<WorkflowChunk>,
) -> Result<(), String> {
    let tool_choice_ref = tool_choice.as_ref();
    // OAuth (ChatGPT Plus) branch — route to Codex Responses API with function calling.
    if provider_id == CODEX_PROVIDER {
        let bearer_preview = store.get_bearer_token(CODEX_PROVIDER);
        let is_oauth = bearer_preview
            .as_deref()
            .and_then(|t| codex::extract_account_id(Some(t)))
            .is_some();

        if is_oauth {
            let auth = match resolve_openai_auth(&app, &store).await {
                Ok(a) => a,
                Err(e) => {
                    let _ = channel.send(WorkflowChunk {
                        thinking_delta: None,
                        content_delta: None,
                        tool_call_delta: None,
                        done: true,
                        error: Some(format!("Codex 登录态解析失败: {}", e)),
                    });
                    return Ok(());
                }
            };

            let tools_ref = tools.as_deref();
            client
                .chat_codex_stream_with_tools(
                    &auth.access_token,
                    &auth.account_id,
                    &model,
                    &messages,
                    tools_ref,
                    tool_choice_ref,
                    |chunk| {
                        let _ = channel.send(chunk);
                    },
                )
                .await;
            return Ok(());
        }
    }

    // Standard Chat Completions branch (OpenAI API key, DeepSeek, Anthropic-compat, etc).
    let providers = crate::llm::types::built_in_providers();
    let provider = providers
        .iter()
        .find(|p| p.id == provider_id)
        .ok_or_else(|| format!("未知 provider: {}", provider_id))?;

    let bearer = store
        .get_bearer_token(&provider_id)
        .ok_or_else(|| format!("{} 未连接", provider.name))?;

    let tools_ref = tools.as_deref();

    client
        .chat_stream_with_tools(
            &provider.base_url,
            &bearer,
            &model,
            &messages,
            tools_ref,
            tool_choice_ref,
            |chunk| {
                let _ = channel.send(chunk);
            },
        )
        .await;

    Ok(())
}

/// Execute a tool by name with JSON arguments.
/// Returns JSON result string.
///
/// We pull whichever credentials the tool might need out of the store
/// up-front (currently only Tavily for web_search) and hand them in via
/// ToolCtx. Tools without a credential dependency ignore the ctx.
#[tauri::command]
pub async fn exec_tool(
    store: State<'_, CredentialStore>,
    exchange_store: State<'_, ExchangeStore>,
    exchange_client: State<'_, ExchangeClient>,
    tool_name: String,
    args_json: String,
) -> Result<String, String> {
    let args: serde_json::Value =
        serde_json::from_str(&args_json).map_err(|e| format!("Invalid args JSON: {}", e))?;

    let exchange = exchange_store.get_active().map(|cred| ExchangeBinding {
        cred,
        http: exchange_client.http.clone(),
    });

    let ctx = tools::ToolCtx {
        tavily_key: store.get_bearer_token("tavily"),
        exchange,
    };

    let result = tools::exec_tool(&tool_name, args, ctx).await?;

    serde_json::to_string(&result).map_err(|e| format!("Serialize error: {}", e))
}
