use axum::{Router, extract::Query, response::Html, routing::get};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::RngCore;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::oneshot;

use super::types::ProviderConfig;

#[derive(Debug)]
pub struct OAuthResult {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_in: Option<u64>,
}

struct CallbackState {
    tx: std::sync::Mutex<Option<oneshot::Sender<String>>>,
}

pub async fn start_oauth_flow(
    provider: &ProviderConfig,
) -> Result<OAuthResult, String> {
    let authorize_url = provider
        .oauth_authorize_url
        .as_deref()
        .ok_or("该服务商不支持 OAuth")?;
    let token_url = provider
        .oauth_token_url
        .as_deref()
        .ok_or("该服务商缺少 token URL")?;
    let client_id = provider
        .oauth_client_id
        .as_deref()
        .ok_or("该服务商缺少 client_id")?;

    let code_verifier = generate_code_verifier();
    let code_challenge = generate_code_challenge(&code_verifier);
    let state = uuid::Uuid::new_v4().to_string();

    let (tx, rx) = oneshot::channel::<String>();
    let callback_state = Arc::new(CallbackState {
        tx: std::sync::Mutex::new(Some(tx)),
    });

    let expected_state = state.clone();
    let cb_state = callback_state.clone();

    let app = Router::new().route(
        "/auth/callback",
        get(move |Query(params): Query<HashMap<String, String>>| {
            let cb = cb_state.clone();
            let exp_state = expected_state.clone();
            async move {
                if let Some(error) = params.get("error") {
                    let desc = params
                        .get("error_description")
                        .cloned()
                        .unwrap_or_default();
                    if let Some(tx) = cb.tx.lock().unwrap().take() {
                        let _ = tx.send(format!("ERROR:{}:{}", error, desc));
                    }
                    return Html("<html><body><h2>授权失败</h2><p>请关闭此页面返回应用</p></body></html>".to_string());
                }

                let code = params.get("code").cloned().unwrap_or_default();
                let ret_state = params.get("state").cloned().unwrap_or_default();

                if ret_state != exp_state {
                    if let Some(tx) = cb.tx.lock().unwrap().take() {
                        let _ = tx.send("ERROR:state_mismatch:CSRF state 不匹配".into());
                    }
                    return Html("<html><body><h2>安全验证失败</h2></body></html>".to_string());
                }

                if let Some(tx) = cb.tx.lock().unwrap().take() {
                    let _ = tx.send(code);
                }
                Html("<html><body><h2>授权成功</h2><p>请关闭此页面返回 ThunderClaw</p></body></html>".to_string())
            }
        }),
    );

    let port: u16 = if provider.id == "openai" { 1455 } else { 0 };
    let listener = tokio::net::TcpListener::bind(format!("127.0.0.1:{}", port))
        .await
        .map_err(|e| {
            if port != 0 {
                format!("无法绑定端口 {} (可能被 Codex CLI 占用，请先关闭): {}", port, e)
            } else {
                format!("无法绑定本地端口: {}", e)
            }
        })?;
    let actual_port = listener
        .local_addr()
        .map_err(|e| format!("无法获取端口: {}", e))?
        .port();

    let redirect_uri = format!("http://localhost:{}/auth/callback", actual_port);

    let scope = provider
        .oauth_scope
        .as_deref()
        .unwrap_or("openid profile email offline_access");

    let auth_url = if provider.id == "openai" {
        format!(
            "{}?response_type=code&client_id={}&redirect_uri={}&scope={}&code_challenge={}&code_challenge_method=S256&id_token_add_organizations=true&codex_cli_simplified_flow=true&state={}&originator=codex_cli_rs",
            authorize_url,
            urlencoding_encode(client_id),
            urlencoding_encode(&redirect_uri),
            urlencoding_encode(scope),
            urlencoding_encode(&code_challenge),
            urlencoding_encode(&state),
        )
    } else {
        let mut url = format!(
            "{}?response_type=code&client_id={}&redirect_uri={}&scope={}&code_challenge={}&code_challenge_method=S256&state={}",
            authorize_url,
            urlencoding_encode(client_id),
            urlencoding_encode(&redirect_uri),
            urlencoding_encode(scope),
            urlencoding_encode(&code_challenge),
            urlencoding_encode(&state),
        );
        if let Some(audience) = &provider.oauth_audience {
            url.push_str(&format!("&audience={}", urlencoding_encode(audience)));
        }
        url
    };

    let server_handle = tokio::spawn(async move {
        axum::serve(listener, app)
            .await
            .ok();
    });

    if let Err(e) = open::that(&auth_url) {
        server_handle.abort();
        return Err(format!("无法打开浏览器: {}", e));
    }

    let code = tokio::time::timeout(std::time::Duration::from_secs(300), rx)
        .await
        .map_err(|_| "OAuth 登录超时（5分钟）".to_string())?
        .map_err(|_| "回调通道关闭".to_string())?;

    server_handle.abort();

    if code.starts_with("ERROR:") {
        return Err(code[6..].to_string());
    }

    exchange_code(token_url, client_id, &code, &code_verifier, &redirect_uri).await
}

async fn exchange_code(
    token_url: &str,
    client_id: &str,
    code: &str,
    code_verifier: &str,
    redirect_uri: &str,
) -> Result<OAuthResult, String> {
    let params = [
        ("grant_type", "authorization_code"),
        ("client_id", client_id),
        ("code", code),
        ("code_verifier", code_verifier),
        ("redirect_uri", redirect_uri),
    ];

    let client = reqwest::Client::new();
    let resp = client
        .post(token_url)
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("Token 交换请求失败: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Token 交换失败 HTTP {}: {}", status, body));
    }

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Token 响应解析失败: {}", e))?;

    let access_token = body["access_token"]
        .as_str()
        .ok_or("响应中缺少 access_token")?
        .to_string();
    let refresh_token = body["refresh_token"].as_str().map(|s| s.to_string());
    let expires_in = body["expires_in"].as_u64();

    Ok(OAuthResult {
        access_token,
        refresh_token,
        expires_in,
    })
}

fn generate_code_verifier() -> String {
    let mut buf = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut buf);
    URL_SAFE_NO_PAD.encode(buf)
}

fn generate_code_challenge(verifier: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(verifier.as_bytes());
    let hash = hasher.finalize();
    URL_SAFE_NO_PAD.encode(hash)
}

fn urlencoding_encode(s: &str) -> String {
    let mut result = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                result.push(b as char);
            }
            _ => {
                result.push_str(&format!("%{:02X}", b));
            }
        }
    }
    result
}
