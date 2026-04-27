use futures_util::StreamExt;
use reqwest::Client;
use std::process::Command;

use super::types::{ChatMessage, StreamChunk, TestResult, ToolDef, WorkflowChunk, ToolCallDelta, WorkflowMessage};

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

    /// Stream chat completions with optional tool/function calling support.
    /// Parses both delta.content and delta.tool_calls from SSE.
    ///
    /// `tool_choice` is passed through verbatim to the OpenAI-compatible API.
    /// Accepted values:
    ///   - None (default)               — server decides; equivalent to "auto"
    ///   - Some("auto")                 — model may call zero or one tool
    ///   - Some("required") / "any"     — force at least one tool call
    ///   - Some({"type":"function","function":{"name":"…"}}) — force a specific tool
    /// Passing a JSON object via this param keeps us provider-agnostic.
    pub async fn chat_stream_with_tools<F>(
        &self,
        base_url: &str,
        bearer_token: &str,
        model: &str,
        messages: &[WorkflowMessage],
        tools: Option<&[ToolDef]>,
        tool_choice: Option<&serde_json::Value>,
        mut on_chunk: F,
    ) where
        F: FnMut(WorkflowChunk),
    {
        let url = format!("{}/chat/completions", base_url);
        let mut body = serde_json::json!({
            "model": model,
            "messages": messages,
            "stream": true,
        });
        if let Some(tool_defs) = tools {
            if !tool_defs.is_empty() {
                body["tools"] = serde_json::to_value(tool_defs).unwrap_or_default();
                // Only attach tool_choice when the caller provided one AND
                // we actually have tools to constrain.
                if let Some(tc) = tool_choice {
                    body["tool_choice"] = normalize_tool_choice(base_url, tc);
                }
            }
        }

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
                on_chunk(WorkflowChunk {
                    thinking_delta: None,
                    content_delta: None,
                    tool_call_delta: None,
                    done: true,
                    error: Some(format!("HTTP {} — {}", status, truncate(&text, 300))),
                });
                return;
            }
            Err(e) => {
                on_chunk(WorkflowChunk {
                    thinking_delta: None,
                    content_delta: None,
                    tool_call_delta: None,
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
                    on_chunk(WorkflowChunk {
                        thinking_delta: None,
                        content_delta: None,
                        tool_call_delta: None,
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
                        on_chunk(WorkflowChunk {
                            thinking_delta: None,
                            content_delta: None,
                            tool_call_delta: None,
                            done: true,
                            error: None,
                        });
                        return;
                    }

                    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(data) {
                        let delta = &parsed["choices"][0]["delta"];

                        // Thinking delta (DeepSeek R1: reasoning_content)
                        if let Some(reasoning) = delta["reasoning_content"].as_str() {
                            if !reasoning.is_empty() {
                                on_chunk(WorkflowChunk {
                                    thinking_delta: Some(reasoning.to_string()),
                                    content_delta: None,
                                    tool_call_delta: None,
                                    done: false,
                                    error: None,
                                });
                            }
                        }

                        // Content delta
                        if let Some(content) = delta["content"].as_str() {
                            if !content.is_empty() {
                                on_chunk(WorkflowChunk {
                                    thinking_delta: None,
                                    content_delta: Some(content.to_string()),
                                    tool_call_delta: None,
                                    done: false,
                                    error: None,
                                });
                            }
                        }

                        // Tool call deltas
                        if let Some(tool_calls) = delta["tool_calls"].as_array() {
                            for tc in tool_calls {
                                let index = tc["index"].as_u64().unwrap_or(0) as usize;
                                let id = tc["id"].as_str().map(|s| s.to_string());
                                let name = tc["function"]["name"].as_str().map(|s| s.to_string());
                                let args_frag = tc["function"]["arguments"]
                                    .as_str()
                                    .unwrap_or("")
                                    .to_string();

                                on_chunk(WorkflowChunk {
                                    thinking_delta: None,
                                    content_delta: None,
                                    tool_call_delta: Some(ToolCallDelta {
                                        index,
                                        id,
                                        name,
                                        arguments_fragment: args_frag,
                                    }),
                                    done: false,
                                    error: None,
                                });
                            }
                        }
                    }
                }
            }
        }

        on_chunk(WorkflowChunk {
            thinking_delta: None,
            content_delta: None,
            tool_call_delta: None,
            done: true,
            error: None,
        });
    }

    /// Stream Codex Responses API (chatgpt.com) with optional function calling.
    /// Handles OpenAI Responses-style SSE events and maps them to WorkflowChunk.
    pub async fn chat_codex_stream_with_tools<F>(
        &self,
        access_token: &str,
        account_id: &str,
        model: &str,
        messages: &[WorkflowMessage],
        tools: Option<&[ToolDef]>,
        tool_choice: Option<&serde_json::Value>,
        mut on_chunk: F,
    ) where
        F: FnMut(WorkflowChunk),
    {
        let url = "https://chatgpt.com/backend-api/codex/responses";

        // Map WorkflowMessage → Responses API input items.
        // Special cases:
        //   - assistant with tool_calls → one `function_call` item per tool call
        //   - tool role with tool_call_id → `function_call_output` item
        //   - assistant/user/system with plain text → role item
        let mut input: Vec<serde_json::Value> = Vec::new();
        for m in messages {
            match m.role.as_str() {
                "assistant" => {
                    if let Some(calls) = &m.tool_calls {
                        for c in calls {
                            input.push(serde_json::json!({
                                "type": "function_call",
                                "call_id": c.id,
                                "name": c.function.name,
                                "arguments": c.function.arguments,
                            }));
                        }
                    }
                    if let Some(text) = m.content.as_deref() {
                        let trimmed = text.trim();
                        if !trimmed.is_empty() {
                            input.push(serde_json::json!({
                                "role": "assistant",
                                "content": [{ "type": "output_text", "text": trimmed }],
                            }));
                        }
                    }
                }
                "tool" => {
                    let call_id = m.tool_call_id.clone().unwrap_or_default();
                    let output = m.content.clone().unwrap_or_default();
                    input.push(serde_json::json!({
                        "type": "function_call_output",
                        "call_id": call_id,
                        "output": output,
                    }));
                }
                "system" | "developer" => {
                    if let Some(text) = m.content.as_deref() {
                        let trimmed = text.trim();
                        if !trimmed.is_empty() {
                            input.push(serde_json::json!({
                                "role": "system",
                                "content": [{ "type": "input_text", "text": trimmed }],
                            }));
                        }
                    }
                }
                _ => {
                    if let Some(text) = m.content.as_deref() {
                        let trimmed = text.trim();
                        if !trimmed.is_empty() {
                            input.push(serde_json::json!({
                                "role": "user",
                                "content": [{ "type": "input_text", "text": trimmed }],
                            }));
                        }
                    }
                }
            }
        }

        // Map ToolDef (OpenAI Chat-Completions shape) → Responses-API shape:
        //   { type: "function", function: { name, description, parameters } }
        //     ↓
        //   { type: "function", name, description, parameters }
        let tools_json: Vec<serde_json::Value> = tools
            .map(|ts| {
                ts.iter()
                    .map(|t| {
                        serde_json::json!({
                            "type": "function",
                            "name": t.function.name,
                            "description": t.function.description,
                            "parameters": t.function.parameters,
                            "strict": false,
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();

        let mut body = serde_json::json!({
            "model": model,
            "input": input,
            "instructions": "",
            "store": false,
            "stream": true,
        });
        if !tools_json.is_empty() {
            body["tools"] = serde_json::Value::Array(tools_json);
            // Caller-supplied tool_choice takes priority; default to "auto".
            body["tool_choice"] = tool_choice
                .cloned()
                .unwrap_or_else(|| serde_json::Value::String("auto".into()));
            body["parallel_tool_calls"] = serde_json::Value::Bool(true);
        }

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
                on_chunk(WorkflowChunk {
                    thinking_delta: None,
                    content_delta: None,
                    tool_call_delta: None,
                    done: true,
                    error: Some(format!("HTTP {} — {}", status, truncate(&text, 300))),
                });
                return;
            }
            Err(e) => {
                on_chunk(WorkflowChunk {
                    thinking_delta: None,
                    content_delta: None,
                    tool_call_delta: None,
                    done: true,
                    error: Some(format!("网络错误: {}", e)),
                });
                return;
            }
        };

        let mut stream = response.bytes_stream();
        let mut buffer = String::new();

        // Track which `item_id` (Responses API) maps to which tool-call `index`
        // (Chat-Completions-style) so downstream delta accumulation works.
        let mut item_id_to_index: std::collections::HashMap<String, usize> =
            std::collections::HashMap::new();
        let mut next_index: usize = 0;

        while let Some(chunk) = stream.next().await {
            let bytes = match chunk {
                Ok(b) => b,
                Err(e) => {
                    on_chunk(WorkflowChunk {
                        thinking_delta: None,
                        content_delta: None,
                        tool_call_delta: None,
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

                let Some(data) = line.strip_prefix("data: ") else {
                    continue;
                };

                let Ok(parsed) = serde_json::from_str::<serde_json::Value>(data) else {
                    continue;
                };

                let event_type = parsed["type"].as_str().unwrap_or("");

                match event_type {
                    // Plain text streaming
                    "response.output_text.delta" => {
                        let delta = parsed["delta"].as_str().unwrap_or("");
                        if !delta.is_empty() {
                            on_chunk(WorkflowChunk {
                                thinking_delta: None,
                                content_delta: Some(delta.to_string()),
                                tool_call_delta: None,
                                done: false,
                                error: None,
                            });
                        }
                    }

                    // Reasoning summary (some Codex models stream these)
                    "response.reasoning_summary_text.delta"
                    | "response.reasoning_text.delta" => {
                        let delta = parsed["delta"].as_str().unwrap_or("");
                        if !delta.is_empty() {
                            on_chunk(WorkflowChunk {
                                thinking_delta: Some(delta.to_string()),
                                content_delta: None,
                                tool_call_delta: None,
                                done: false,
                                error: None,
                            });
                        }
                    }

                    // New output item — if it's a function_call, register id+name
                    "response.output_item.added" => {
                        let item = &parsed["item"];
                        if item["type"].as_str() == Some("function_call") {
                            let item_id = item["id"].as_str().unwrap_or("").to_string();
                            let call_id = item["call_id"]
                                .as_str()
                                .map(|s| s.to_string())
                                .unwrap_or_else(|| item_id.clone());
                            let name = item["name"].as_str().map(|s| s.to_string());

                            let idx = *item_id_to_index
                                .entry(item_id.clone())
                                .or_insert_with(|| {
                                    let i = next_index;
                                    next_index += 1;
                                    i
                                });

                            on_chunk(WorkflowChunk {
                                thinking_delta: None,
                                content_delta: None,
                                tool_call_delta: Some(ToolCallDelta {
                                    index: idx,
                                    id: Some(call_id),
                                    name,
                                    arguments_fragment: String::new(),
                                }),
                                done: false,
                                error: None,
                            });
                        }
                    }

                    // Streamed function arguments
                    "response.function_call_arguments.delta" => {
                        let item_id = parsed["item_id"].as_str().unwrap_or("").to_string();
                        let delta = parsed["delta"].as_str().unwrap_or("").to_string();
                        if delta.is_empty() {
                            continue;
                        }
                        let idx = *item_id_to_index
                            .entry(item_id.clone())
                            .or_insert_with(|| {
                                let i = next_index;
                                next_index += 1;
                                i
                            });
                        on_chunk(WorkflowChunk {
                            thinking_delta: None,
                            content_delta: None,
                            tool_call_delta: Some(ToolCallDelta {
                                index: idx,
                                id: None,
                                name: None,
                                arguments_fragment: delta,
                            }),
                            done: false,
                            error: None,
                        });
                    }

                    // Function arguments finalized — usually redundant with deltas,
                    // but some servers only emit the .done event with the full string.
                    // We ignore it to avoid double-counting; the delta stream already
                    // carried the full payload.
                    "response.function_call_arguments.done" => { /* no-op */ }

                    "response.failed" | "error" => {
                        let message = parsed["response"]["error"]["message"]
                            .as_str()
                            .or_else(|| parsed["error"]["message"].as_str())
                            .or_else(|| parsed["message"].as_str())
                            .unwrap_or("Codex 对话失败")
                            .to_string();
                        on_chunk(WorkflowChunk {
                            thinking_delta: None,
                            content_delta: None,
                            tool_call_delta: None,
                            done: true,
                            error: Some(message),
                        });
                        return;
                    }

                    "response.completed" => {
                        on_chunk(WorkflowChunk {
                            thinking_delta: None,
                            content_delta: None,
                            tool_call_delta: None,
                            done: true,
                            error: None,
                        });
                        return;
                    }

                    _ => {}
                }
            }
        }

        on_chunk(WorkflowChunk {
            thinking_delta: None,
            content_delta: None,
            tool_call_delta: None,
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

/// Some OpenAI-compat providers don't accept the nested
/// `{type:"function", function:{name:"x"}}` shape and reject the request with
/// `Unknown parameter: tool_choice.function`. Gemini's v1beta/openai endpoint
/// is the known offender (as of 2026 Q1). Downgrade to "required" so the
/// model still must call a tool — caller is expected to pass a single-tool
/// definition when it forces a specific name, so "required" achieves the
/// same effective behavior.
fn normalize_tool_choice(base_url: &str, tc: &serde_json::Value) -> serde_json::Value {
    let is_gemini = base_url.contains("generativelanguage.googleapis.com");
    if is_gemini && tc.is_object() && tc.get("type").and_then(|v| v.as_str()) == Some("function") {
        return serde_json::Value::String("required".into());
    }
    tc.clone()
}
