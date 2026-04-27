// Web search tool — Tavily API.
//
// Tavily is an LLM-optimized search API: it returns a ranked list of
// {title, url, content, score} plus an optional one-line `answer`.
// Docs: https://docs.tavily.com/docs/rest-api/api-reference
//
// Key is pulled from the CredentialStore under provider_id "tavily"
// (reuse of the same kv bag we use for LLM keys — see llm/store.rs).

use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

const TAVILY_ENDPOINT: &str = "https://api.tavily.com/search";

#[derive(Serialize)]
struct TavilyRequest<'a> {
    api_key: &'a str,
    query: &'a str,
    search_depth: &'a str,
    include_answer: bool,
    max_results: u32,
}

#[derive(Deserialize)]
struct TavilyResponse {
    #[serde(default)]
    query: Option<String>,
    #[serde(default)]
    answer: Option<String>,
    #[serde(default)]
    results: Vec<TavilyHit>,
}

#[derive(Deserialize)]
struct TavilyHit {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    score: Option<f64>,
    #[serde(default)]
    published_date: Option<String>,
}

/// Run a web search via Tavily.
///
/// args: { query: string, max_results?: number, depth?: "basic" | "advanced" }
/// returns normalized JSON:
///   { query, answer, results: [{ title, url, snippet, score, published_date }] }
pub async fn web_search(args: Value, api_key: Option<String>) -> Result<Value, String> {
    let key = api_key.ok_or_else(|| {
        "Tavily API key 未配置。请在 Settings 里保存 provider_id=\"tavily\" 的 key，或在 devtools 执行 invoke(\"save_api_key\",{providerId:\"tavily\",apiKey:\"tvly-...\"})".to_string()
    })?;

    let query = args["query"]
        .as_str()
        .ok_or_else(|| "web_search 缺少 query 参数".to_string())?;
    let max_results = args["max_results"].as_u64().unwrap_or(5).min(20) as u32;
    let depth = args["depth"].as_str().unwrap_or("basic");

    let body = TavilyRequest {
        api_key: &key,
        query,
        search_depth: depth,
        include_answer: true,
        max_results,
    };

    let resp = Client::new()
        .post(TAVILY_ENDPOINT)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Tavily request failed: {}", e))?;

    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Tavily HTTP {}: {}", status, text));
    }

    let parsed: TavilyResponse = resp
        .json()
        .await
        .map_err(|e| format!("Tavily parse error: {}", e))?;

    let results: Vec<Value> = parsed
        .results
        .into_iter()
        .map(|h| {
            json!({
                "title": h.title.unwrap_or_default(),
                "url": h.url.unwrap_or_default(),
                "snippet": h.content.unwrap_or_default(),
                "score": h.score,
                "published_date": h.published_date,
            })
        })
        .collect();

    Ok(json!({
        "query": parsed.query.unwrap_or_else(|| query.to_string()),
        "answer": parsed.answer.unwrap_or_default(),
        "results": results,
    }))
}
