use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{env, fs, path::PathBuf, time::{SystemTime, UNIX_EPOCH}};

const OPENAI_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
const OPENAI_SCOPE: &str = "openid profile email offline_access";

#[derive(Debug)]
pub struct CodexAuthState {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub account_id: String,
    pub email: Option<String>,
    pub expires_at: Option<u64>,
}

#[derive(Debug, Deserialize, Serialize, Default)]
struct CodexAuthFile {
    auth_mode: Option<String>,
    #[serde(rename = "OPENAI_API_KEY")]
    openai_api_key: Option<String>,
    tokens: Option<CodexTokens>,
    last_refresh: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, Default)]
struct CodexTokens {
    id_token: Option<String>,
    access_token: Option<String>,
    refresh_token: Option<String>,
    account_id: Option<String>,
}

/// Read ~/.codex/auth.json, use existing access_token if still valid,
/// otherwise try to refresh. Returns Err if both paths fail — never hangs.
pub async fn load_and_refresh_codex_auth() -> Result<CodexAuthState, String> {
    let (_path, auth_file) = read_auth_file()?;
    let tokens = auth_file
        .tokens
        .ok_or("Codex auth.json 中没有 tokens 字段")?;

    let account_id_from_tokens = tokens.account_id.clone();

    if let Some(ref at) = tokens.access_token {
        if let Some(exp) = extract_exp(Some(at)) {
            let account_id = account_id_from_tokens
                .clone()
                .or_else(|| extract_account_id(Some(at)))
                .ok_or("无法解析 account_id")?;
            let email = extract_email(tokens.id_token.as_deref())
                .or_else(|| extract_email(Some(at)));
            return Ok(CodexAuthState {
                access_token: at.clone(),
                refresh_token: tokens.refresh_token.clone(),
                account_id,
                email,
                expires_at: Some(exp),
            });
        }
    }

    let refresh_token = tokens
        .refresh_token
        .clone()
        .ok_or("access_token 已过期且没有 refresh_token，请重新执行 codex login")?;

    let refreshed = refresh_codex_tokens(&refresh_token).await?;

    let access_token = refreshed["access_token"]
        .as_str()
        .map(|s| s.to_string())
        .or(tokens.access_token.clone())
        .ok_or("刷新后仍未获得 access_token")?;

    let id_token = refreshed["id_token"]
        .as_str()
        .map(|s| s.to_string())
        .or(tokens.id_token.clone());

    let next_refresh_token = refreshed["refresh_token"]
        .as_str()
        .map(|s| s.to_string())
        .unwrap_or(refresh_token);

    let account_id = account_id_from_tokens
        .or_else(|| extract_account_id(id_token.as_deref()))
        .or_else(|| extract_account_id(Some(&access_token)))
        .ok_or("无法从 Codex 登录态解析 account_id，请重新执行 codex login")?;

    let email = extract_email(id_token.as_deref())
        .or_else(|| extract_email(Some(&access_token)));
    let expires_at = extract_exp(Some(&access_token));

    Ok(CodexAuthState {
        access_token,
        refresh_token: Some(next_refresh_token),
        account_id,
        email,
        expires_at,
    })
}

async fn refresh_codex_tokens(refresh_token: &str) -> Result<Value, String> {
    let body = serde_json::json!({
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "client_id": OPENAI_CLIENT_ID,
        "scope": OPENAI_SCOPE,
    });

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let resp = client
        .post(OPENAI_TOKEN_URL)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("刷新 Codex 登录态失败: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!(
            "刷新失败 HTTP {} — {}",
            status,
            truncate(&text, 200)
        ));
    }

    resp.json::<Value>()
        .await
        .map_err(|e| format!("解析刷新响应失败: {}", e))
}

fn read_auth_file() -> Result<(PathBuf, CodexAuthFile), String> {
    let candidates = auth_file_candidates();
    for path in &candidates {
        let text = match fs::read_to_string(path) {
            Ok(text) => text,
            Err(_) => continue,
        };

        if let Ok(parsed) = serde_json::from_str::<CodexAuthFile>(&text) {
            return Ok((path.clone(), parsed));
        }
    }

    Err(format!(
        "未找到 Codex 登录凭据（已检查 {}）",
        candidates
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join(", ")
    ))
}

fn auth_file_candidates() -> Vec<PathBuf> {
    let mut paths = Vec::new();

    if let Ok(home) = env::var("CHATGPT_LOCAL_HOME") {
        paths.push(PathBuf::from(home).join("auth.json"));
    }
    if let Ok(home) = env::var("CODEX_HOME") {
        paths.push(PathBuf::from(home).join("auth.json"));
    }
    if let Ok(home) = env::var("HOME") {
        paths.push(PathBuf::from(&home).join(".chatgpt-local").join("auth.json"));
        paths.push(PathBuf::from(home).join(".codex").join("auth.json"));
    }

    paths
}

fn decode_jwt_payload(token: Option<&str>) -> Option<Value> {
    let token = token?;
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 {
        return None;
    }
    let payload = parts[1];
    let padded = match payload.len() % 4 {
        2 => format!("{}==", payload),
        3 => format!("{}=", payload),
        _ => payload.to_string(),
    };
    let decoded = URL_SAFE_NO_PAD.decode(&padded).ok()?;
    serde_json::from_slice::<Value>(&decoded).ok()
}

pub fn extract_account_id(token: Option<&str>) -> Option<String> {
    let payload = decode_jwt_payload(token)?;
    payload["https://api.openai.com/auth"]["chatgpt_account_id"]
        .as_str()
        .map(|s| s.to_string())
}

pub fn extract_email(token: Option<&str>) -> Option<String> {
    let payload = decode_jwt_payload(token)?;
    payload["email"]
        .as_str()
        .map(|s| s.to_string())
        .or_else(|| {
            payload["https://api.openai.com/profile"]["email"]
                .as_str()
                .map(|s| s.to_string())
        })
}

fn extract_exp(token: Option<&str>) -> Option<u64> {
    let payload = decode_jwt_payload(token)?;
    let exp = payload["exp"].as_u64()?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_secs();
    if exp > now { Some(exp) } else { None }
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}…", &s[..max])
    }
}
