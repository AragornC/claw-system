use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderConfig {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub supports_oauth: bool,
    pub oauth_authorize_url: Option<String>,
    pub oauth_token_url: Option<String>,
    pub oauth_client_id: Option<String>,
    pub oauth_scope: Option<String>,
    pub oauth_audience: Option<String>,
}

pub fn built_in_providers() -> Vec<ProviderConfig> {
    vec![
        ProviderConfig {
            id: "openai".into(),
            name: "OpenAI".into(),
            base_url: "https://api.openai.com/v1".into(),
            supports_oauth: true,
            oauth_authorize_url: Some("https://auth.openai.com/oauth/authorize".into()),
            oauth_token_url: Some("https://auth.openai.com/oauth/token".into()),
            oauth_client_id: Some("app_EMoamEEZ73f0CkXaXp7hrann".into()),
            oauth_scope: Some("openid profile email offline_access".into()),
            oauth_audience: None,
        },
        ProviderConfig {
            id: "anthropic".into(),
            name: "Anthropic".into(),
            base_url: "https://api.anthropic.com/v1".into(),
            supports_oauth: false,
            oauth_authorize_url: None,
            oauth_token_url: None,
            oauth_client_id: None,
            oauth_scope: None,
            oauth_audience: None,
        },
        ProviderConfig {
            id: "deepseek".into(),
            name: "DeepSeek".into(),
            base_url: "https://api.deepseek.com/v1".into(),
            supports_oauth: false,
            oauth_authorize_url: None,
            oauth_token_url: None,
            oauth_client_id: None,
            oauth_scope: None,
            oauth_audience: None,
        },
        ProviderConfig {
            id: "google".into(),
            name: "Google Gemini".into(),
            base_url: "https://generativelanguage.googleapis.com/v1beta/openai".into(),
            supports_oauth: false,
            oauth_authorize_url: None,
            oauth_token_url: None,
            oauth_client_id: None,
            oauth_scope: None,
            oauth_audience: None,
        },
        ProviderConfig {
            id: "xai".into(),
            name: "xAI Grok".into(),
            base_url: "https://api.x.ai/v1".into(),
            supports_oauth: false,
            oauth_authorize_url: None,
            oauth_token_url: None,
            oauth_client_id: None,
            oauth_scope: None,
            oauth_audience: None,
        },
    ]
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthState {
    pub provider_id: String,
    pub method: AuthMethod,
    pub connected: bool,
    pub masked_key: Option<String>,
    pub email: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum AuthMethod {
    ApiKey,
    #[serde(rename = "oauth", alias = "o_auth")]
    OAuth,
    None,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredCredential {
    pub provider_id: String,
    pub method: AuthMethod,
    pub api_key: Option<String>,
    pub oauth_access_token: Option<String>,
    pub oauth_refresh_token: Option<String>,
    pub oauth_expires_at: Option<u64>,
    pub oauth_email: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamChunk {
    pub delta: String,
    pub done: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestResult {
    pub success: bool,
    pub message: String,
    pub model: Option<String>,
}

// ── Workflow types (tool calling support) ───────────────────

/// Tool definition passed from frontend (OpenAI function calling format)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDef {
    #[serde(rename = "type")]
    pub tool_type: String,
    pub function: ToolFnDef,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolFnDef {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}

/// Flexible message for workflow (supports tool role + tool_calls)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowMessage {
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<WorkflowToolCall>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowToolCall {
    pub id: String,
    #[serde(rename = "type")]
    pub call_type: String,
    pub function: WorkflowFnCall,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowFnCall {
    pub name: String,
    pub arguments: String,
}

/// Rich stream chunk for workflow — provider-normalized
/// Different providers map to the same fields:
///   DeepSeek Chat:     content → content_delta
///   DeepSeek R1:       reasoning_content → thinking_delta, content → content_delta
///   OpenAI:            content → content_delta
///   Anthropic Claude:  thinking block → thinking_delta, text block → content_delta
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowChunk {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_delta: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_delta: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_delta: Option<ToolCallDelta>,
    pub done: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCallDelta {
    pub index: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub arguments_fragment: String,
}
