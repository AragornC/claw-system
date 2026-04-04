use futures_util::StreamExt;
use reqwest::Client;
use std::process::Command;

use super::types::{ChatMessage, StreamChunk, TestResult};

pub struct LlmClient {
    http: Client,
}

impl LlmClient {
    pub fn new() -> Self {
        Self {
            http: Client::new(),
        }
    }

    pub async fn test_connection(
        &self,
        base_url: &str,
        bearer_token: &str,
    ) -> TestResult {
        let url = format!("{}/models", base_url);
        let resp = self
            .http
            .get(&url)
            .header("Authorization", format!("Bearer {}", bearer_token))
            .send()
            .await;

        match resp {
            Ok(r) if r.status().is_success() => {
                let body: serde_json::Value = r.json().await.unwrap_or_default();
                let first_model = body["data"]
                    .as_array()
                    .and_then(|arr| arr.first())
                    .and_then(|m| m["id"].as_str())
                    .map(|s| s.to_string());
                TestResult {
                    success: true,
                    message: "连接成功".into(),
                    model: first_model,
                }
            }
            Ok(r) => {
                let status = r.status();
                let body = r.text().await.unwrap_or_default();
                TestResult {
                    success: false,
                    message: format!("HTTP {} — {}", status, truncate(&body, 200)),
                    model: None,
                }
            }
            Err(e) => TestResult {
                success: false,
                message: format!("网络错误: {}", e),
                model: None,
            },
        }
    }

    pub async fn chat_stream<F>(
        &self,
        base_url: &str,
        bearer_token: &str,
        model: &str,
        messages: &[ChatMessage],
        mut on_chunk: F,
    ) where
        F: FnMut(StreamChunk),
    {
        let url = format!("{}/chat/completions", base_url);
        let body = serde_json::json!({
            "model": model,
            "messages": messages,
            "stream": true,
        });

        let resp = self
            .http
            .post(&url)
            .header("Authorization", format!("Bearer {}", bearer_token))
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await;

        let response = match resp {
            Ok(r) if r.status().is_success() => r,
            Ok(r) => {
                let status = r.status();
                let text = r.text().await.unwrap_or_default();
                on_chunk(StreamChunk {
                    delta: String::new(),
                    done: true,
                    error: Some(format!("HTTP {} — {}", status, truncate(&text, 300))),
                });
                return;
            }
            Err(e) => {
                on_chunk(StreamChunk {
                    delta: String::new(),
                    done: true,
                    error: Some(format!("网络错误: {}", e)),
                });
                return;
            }
        };

        let mut stream = response.bytes_stream();
        let mut buffer = String::new();

        while let Some(chunk) = stream.next().await {
            let bytes = match chunk {
                Ok(b) => b,
                Err(e) => {
                    on_chunk(StreamChunk {
                        delta: String::new(),
                        done: true,
                        error: Some(format!("流读取错误: {}", e)),
                    });
                    return;
                }
            };

            buffer.push_str(&String::from_utf8_lossy(&bytes));

            while let Some(line_end) = buffer.find('\n') {
                let line = buffer[..line_end].trim().to_string();
                buffer = buffer[line_end + 1..].to_string();

                if line.is_empty() || line.starts_with(':') {
                    continue;
                }

                if let Some(data) = line.strip_prefix("data: ") {
                    if data.trim() == "[DONE]" {
                        on_chunk(StreamChunk {
                            delta: String::new(),
                            done: true,
                            error: None,
                        });
                        return;
                    }

                    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(data) {
                        let delta = parsed["choices"][0]["delta"]["content"]
                            .as_str()
                            .unwrap_or("")
                            .to_string();
                        if !delta.is_empty() {
                            on_chunk(StreamChunk {
                                delta,
                                done: false,
                                error: None,
                            });
                        }
                    }
                }
            }
        }

        on_chunk(StreamChunk {
            delta: String::new(),
            done: true,
            error: None,
        });
    }

    pub async fn fetch_codex_models(
        &self,
        access_token: &str,
        account_id: &str,
    ) -> Result<Vec<String>, String> {
        let version = resolve_codex_version();
        let url = format!(
            "https://chatgpt.com/backend-api/codex/models?client_version={}",
            version
        );
        let resp = self
            .http
            .get(&url)
            .header("Authorization", format!("Bearer {}", access_token))
            .header("chatgpt-account-id", account_id)
            .header("OpenAI-Beta", "responses=experimental")
            .send()
            .await
            .map_err(|e| format!("请求 Codex 模型列表失败: {}", e))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("HTTP {} — {}", status, truncate(&text, 300)));
        }

        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("解析 Codex 模型列表失败: {}", e))?;

        let models = body["models"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|item| item["slug"].as_str().map(|s| s.to_string()))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        if models.is_empty() {
            return Err("Codex 未返回可用模型".into());
        }

        Ok(models)
    }

    pub async fn test_codex_connection(
        &self,
        access_token: &str,
        account_id: &str,
    ) -> TestResult {
        match self.fetch_codex_models(access_token, account_id).await {
            Ok(models) => TestResult {
                success: true,
                message: "连接成功".into(),
                model: models.first().cloned(),
            },
            Err(message) => TestResult {
                success: false,
                message,
                model: None,
            },
        }
    }

    pub async fn chat_codex_stream<F>(
        &self,
        access_token: &str,
        account_id: &str,
        model: &str,
        messages: &[ChatMessage],
        mut on_chunk: F,
    ) where
        F: FnMut(StreamChunk),
    {
        let url = "https://chatgpt.com/backend-api/codex/responses";
        let input = messages
            .iter()
            .filter_map(|message| {
                let text = message.content.trim();
                if text.is_empty() {
                    return None;
                }
                match message.role.as_str() {
                    "assistant" => Some(serde_json::json!({
                        "role": "assistant",
                        "content": [{
                            "type": "output_text",
                            "text": text,
                        }]
                    })),
                    "system" | "developer" => Some(serde_json::json!({
                        "role": "system",
                        "content": [{
                            "type": "input_text",
                            "text": text,
                        }]
                    })),
                    _ => Some(serde_json::json!({
                        "role": "user",
                        "content": [{
                            "type": "input_text",
                            "text": text,
                        }]
                    })),
                }
            })
            .collect::<Vec<_>>();

        let body = serde_json::json!({
            "model": model,
            "input": input,
            "instructions": "",
            "store": false,
            "stream": true,
        });

        let resp = self
            .http
            .post(url)
            .header("Authorization", format!("Bearer {}", access_token))
            .header("chatgpt-account-id", account_id)
            .header("OpenAI-Beta", "responses=experimental")
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await;

        let response = match resp {
            Ok(r) if r.status().is_success() => r,
            Ok(r) => {
                let status = r.status();
                let text = r.text().await.unwrap_or_default();
                on_chunk(StreamChunk {
                    delta: String::new(),
                    done: true,
                    error: Some(format!("HTTP {} — {}", status, truncate(&text, 300))),
                });
                return;
            }
            Err(e) => {
                on_chunk(StreamChunk {
                    delta: String::new(),
                    done: true,
                    error: Some(format!("网络错误: {}", e)),
                });
                return;
            }
        };

        let mut stream = response.bytes_stream();
        let mut buffer = String::new();

        while let Some(chunk) = stream.next().await {
            let bytes = match chunk {
                Ok(b) => b,
                Err(e) => {
                    on_chunk(StreamChunk {
                        delta: String::new(),
                        done: true,
                        error: Some(format!("流读取错误: {}", e)),
                    });
                    return;
                }
            };

            buffer.push_str(&String::from_utf8_lossy(&bytes));

            while let Some(line_end) = buffer.find('\n') {
                let line = buffer[..line_end].trim().to_string();
                buffer = buffer[line_end + 1..].to_string();

                if line.is_empty() || line.starts_with(':') || line.starts_with("event: ") {
                    continue;
                }

                if let Some(data) = line.strip_prefix("data: ") {
                    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(data) {
                        let event_type = parsed["type"].as_str().unwrap_or("");
                        match event_type {
                            "response.output_text.delta" => {
                                let delta = parsed["delta"].as_str().unwrap_or("").to_string();
                                if !delta.is_empty() {
                                    on_chunk(StreamChunk {
                                        delta,
                                        done: false,
                                        error: None,
                                    });
                                }
                            }
                            "response.failed" | "error" => {
                                let message = parsed["response"]["error"]["message"]
                                    .as_str()
                                    .or_else(|| parsed["message"].as_str())
                                    .unwrap_or("Codex 对话失败")
                                    .to_string();
                                on_chunk(StreamChunk {
                                    delta: String::new(),
                                    done: true,
                                    error: Some(message),
                                });
                                return;
                            }
                            "response.completed" => {
                                on_chunk(StreamChunk {
                                    delta: String::new(),
                                    done: true,
                                    error: None,
                                });
                                return;
                            }
                            _ => {}
                        }
                    }
                }
            }
        }

        on_chunk(StreamChunk {
            delta: String::new(),
            done: true,
            error: None,
        });
    }
}

fn resolve_codex_version() -> String {
    if let Ok(output) = Command::new("codex").arg("--version").output() {
        let joined = format!(
            "{} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        for part in joined.split(|c: char| !(c.is_ascii_digit() || c == '.')) {
            if part.split('.').count() == 3 && part.chars().all(|c| c.is_ascii_digit() || c == '.') {
                return part.to_string();
            }
        }
    }
    "0.111.0".into()
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}…", &s[..max])
    }
}
