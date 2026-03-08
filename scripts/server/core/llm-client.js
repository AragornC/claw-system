/**
 * Universal LLM client for ThunderClaw.
 *
 * Supports multiple providers via OpenAI-compatible chat completions API.
 * Automatically resolves the current model from xbrainStore so that when
 * the user switches models in 虾脑, the pipeline follows.
 *
 * Supported providers:
 *   - DeepSeek  (api.deepseek.com)
 *   - OpenAI    (api.openai.com)
 *   - Anthropic (via OpenAI-compat proxy or native Messages API)
 *   - OpenRouter (openrouter.ai)
 *   - Gemini    (generativelanguage.googleapis.com — OpenAI compat)
 *   - ZAI/GLM   (open.bigmodel.cn)
 *   - Any OpenAI-compatible endpoint
 */

import { toText, parseJsonLoose } from "../lib/utils.js";

/** Provider → API base URL mapping (OpenAI-compatible endpoints) */
const PROVIDER_API_BASE = {
  deepseek:    "https://api.deepseek.com",
  chatgpt:     "https://api.openai.com",
  openai:      "https://api.openai.com",
  anthropic:   "https://api.anthropic.com",
  openrouter:  "https://openrouter.ai/api",
  gemini:      "https://generativelanguage.googleapis.com/v1beta/openai",
  zai:         "https://open.bigmodel.cn/api/paas",
};

/** Provider → env var name for API key */
const PROVIDER_ENV_KEYS = {
  deepseek:   ["DEEPSEEK_API_KEY", "DEEPSEEK_KEY"],
  chatgpt:    ["OPENAI_API_KEY"],
  openai:     ["OPENAI_API_KEY"],
  anthropic:  ["ANTHROPIC_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  gemini:     ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  zai:        ["ZAI_API_KEY", "GLM_API_KEY"],
};

function resolveApiKeyFromEnv(provider) {
  const keys = PROVIDER_ENV_KEYS[provider] || [];
  for (const k of keys) {
    const val = toText(process.env[k] || "");
    if (val) return val;
  }
  return "";
}

/**
 * Create a universal LLM client.
 *
 * @param {Object} deps
 * @param {() => {provider:string, model:string, apiKey:string, apiBase?:string}} deps.getModelConfig
 *   Called on every request to get the current model configuration.
 *   Typically reads from xbrainStore to follow model switching.
 */
export function createLlmClient(deps = {}) {
  const getModelConfig = typeof deps.getModelConfig === "function"
    ? deps.getModelConfig
    : () => ({
        provider: "deepseek",
        model: "deepseek-chat",
        apiKey: toText(process.env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_KEY || ""),
        apiBase: "",
      });

  /**
   * Resolve the effective configuration for a request.
   */
  function resolveConfig(overrides = {}) {
    const base = getModelConfig();
    const provider = toText(overrides.provider || base.provider, "deepseek").toLowerCase();
    const model = toText(overrides.model || base.model, "deepseek-chat");
    // API key priority: override → config → env
    let apiKey = toText(overrides.apiKey || base.apiKey, "");
    if (!apiKey) apiKey = resolveApiKeyFromEnv(provider);
    const apiBase = toText(overrides.apiBase || base.apiBase || PROVIDER_API_BASE[provider] || "", "");
    return { provider, model, apiKey, apiBase };
  }

  /**
   * Check if Anthropic native Messages API should be used.
   * Anthropic's API is NOT OpenAI-compatible by default.
   */
  function isAnthropicNative(provider, apiBase) {
    return provider === "anthropic" && apiBase.includes("api.anthropic.com");
  }

  /**
   * Call Anthropic Messages API (non-OpenAI format).
   */
  async function callAnthropicMessages(config, params) {
    const body = {
      model: config.model,
      max_tokens: params.maxTokens || 4096,
      messages: (params.messages || []).filter((m) => m.role !== "system").map((m) => ({
        role: toText(m.role, "user"),
        content: toText(m.content, ""),
      })),
    };
    const systemMsg = (params.messages || []).find((m) => m.role === "system");
    if (systemMsg) body.system = toText(systemMsg.content, "");
    if (Number.isFinite(params.temperature)) body.temperature = params.temperature;

    const resp = await fetch(`${config.apiBase}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal: params._signal,
    });
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return { ok: false, content: "", usage: {}, error: toText(json?.error?.message || `HTTP ${resp.status}`) };
    }
    const textBlock = (json.content || []).find((b) => b.type === "text");
    return {
      ok: true,
      content: toText(textBlock?.text || ""),
      usage: json.usage || {},
      error: "",
    };
  }

  /**
   * Call OpenAI-compatible chat completions endpoint.
   */
  async function callOpenAICompat(config, params) {
    const body = {
      model: config.model,
      messages: (params.messages || []).map((m) => ({
        role: toText(m.role, "user"),
        content: toText(m.content, ""),
      })),
      temperature: Number.isFinite(params.temperature) ? params.temperature : 0.3,
      max_tokens: params.maxTokens || 4096,
      stream: false,
    };
    if (params.jsonMode) {
      body.response_format = { type: "json_object" };
    }
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    };
    // OpenRouter needs extra headers
    if (config.provider === "openrouter") {
      headers["HTTP-Referer"] = "https://thunderclaw.dev";
      headers["X-Title"] = "ThunderClaw";
    }
    const endpoint = config.apiBase.endsWith("/chat/completions")
      ? config.apiBase
      : `${config.apiBase}/chat/completions`;
    // Gemini and some providers use /v1/ path
    const url = endpoint.includes("/v1/") || endpoint.includes("/v1beta/")
      ? endpoint
      : endpoint.replace(/\/chat\/completions$/, "/v1/chat/completions");

    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: params._signal,
    });
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return { ok: false, content: "", usage: {}, error: toText(json?.error?.message || json?.error || `HTTP ${resp.status}`) };
    }
    const choice = Array.isArray(json.choices) && json.choices[0] ? json.choices[0] : {};
    return {
      ok: true,
      content: toText(choice.message?.content || ""),
      usage: json.usage || {},
      error: "",
    };
  }

  /**
   * Streaming chat completion — yields tokens as they arrive.
   * Works with OpenAI-compatible SSE streaming endpoints.
   *
   * @param {Object} params - Same as chatCompletion, plus onToken callback
   * @returns {AsyncGenerator<{type: string, text?: string, done?: boolean}>}
   */
  async function* chatCompletionStream(params = {}) {
    const config = resolveConfig(params);
    if (!config.apiKey) {
      yield { type: "error", error: `No API key for provider: ${config.provider}` };
      return;
    }
    if (!config.apiBase) {
      yield { type: "error", error: `No API base URL for provider: ${config.provider}` };
      return;
    }

    const timeoutMs = Number.isFinite(params.timeoutMs) ? params.timeoutMs : 90_000;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);

    try {
      const body = {
        model: config.model,
        messages: (params.messages || []).map((m) => ({
          role: toText(m.role, "user"),
          content: toText(m.content, ""),
        })),
        temperature: Number.isFinite(params.temperature) ? params.temperature : 0.3,
        max_tokens: params.maxTokens || 4096,
        stream: true,
      };
      const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      };
      if (config.provider === "openrouter") {
        headers["HTTP-Referer"] = "https://thunderclaw.dev";
        headers["X-Title"] = "ThunderClaw";
      }
      const endpoint = config.apiBase.endsWith("/chat/completions")
        ? config.apiBase
        : `${config.apiBase}/chat/completions`;
      const url = endpoint.includes("/v1/") || endpoint.includes("/v1beta/")
        ? endpoint
        : endpoint.replace(/\/chat\/completions$/, "/v1/chat/completions");

      // Anthropic native streaming uses different format
      const isAnthropic = isAnthropicNative(config.provider, config.apiBase);
      if (isAnthropic) {
        const anthBody = {
          model: config.model,
          max_tokens: params.maxTokens || 4096,
          stream: true,
          messages: (params.messages || []).filter((m) => m.role !== "system").map((m) => ({
            role: toText(m.role, "user"),
            content: toText(m.content, ""),
          })),
        };
        const sysMsg = (params.messages || []).find((m) => m.role === "system");
        if (sysMsg) anthBody.system = toText(sysMsg.content, "");
        if (Number.isFinite(params.temperature)) anthBody.temperature = params.temperature;

        const resp = await fetch(`${config.apiBase}/v1/messages`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": config.apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify(anthBody),
          signal: ac.signal,
        });
        if (!resp.ok) {
          const errJson = await resp.json().catch(() => ({}));
          yield { type: "error", error: toText(errJson?.error?.message || `HTTP ${resp.status}`) };
          return;
        }
        yield* parseSSEStream(resp.body, "anthropic");
        return;
      }

      // OpenAI-compatible streaming
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      if (!resp.ok) {
        const errJson = await resp.json().catch(() => ({}));
        yield { type: "error", error: toText(errJson?.error?.message || errJson?.error || `HTTP ${resp.status}`) };
        return;
      }
      yield* parseSSEStream(resp.body, "openai");
    } catch (err) {
      const errMsg = err?.name === "AbortError"
        ? `LLM API timeout (${timeoutMs}ms)`
        : toText(err?.message || err || "stream failed");
      yield { type: "error", error: errMsg };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Parse SSE stream from provider response body.
   */
  async function* parseSSEStream(body, format = "openai") {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) continue;
        if (trimmed === "data: [DONE]") {
          yield { type: "done" };
          return;
        }
        if (trimmed.startsWith("data: ")) {
          try {
            const json = JSON.parse(trimmed.slice(6));
            if (format === "openai") {
              const delta = json.choices?.[0]?.delta;
              const content = delta?.content || "";
              if (content) yield { type: "token", text: content };
              if (json.choices?.[0]?.finish_reason) {
                yield { type: "done" };
                return;
              }
            } else if (format === "anthropic") {
              if (json.type === "content_block_delta" && json.delta?.text) {
                yield { type: "token", text: json.delta.text };
              }
              if (json.type === "message_stop") {
                yield { type: "done" };
                return;
              }
            }
          } catch {}
        }
      }
    }
    yield { type: "done" };
  }

  /**
   * Send a chat completion request using the current model.
   */
  async function chatCompletion(params = {}) {
    const config = resolveConfig(params);
    if (!config.apiKey) {
      return { ok: false, content: "", usage: {}, error: `No API key for provider: ${config.provider}` };
    }
    if (!config.apiBase) {
      return { ok: false, content: "", usage: {}, error: `No API base URL for provider: ${config.provider}` };
    }

    const timeoutMs = Number.isFinite(params.timeoutMs) ? params.timeoutMs : 90_000;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const callParams = { ...params, _signal: ac.signal };
      if (isAnthropicNative(config.provider, config.apiBase)) {
        return await callAnthropicMessages(config, callParams);
      }
      return await callOpenAICompat(config, callParams);
    } catch (err) {
      const errMsg = err?.name === "AbortError"
        ? `LLM API timeout (${timeoutMs}ms) [${config.provider}]`
        : toText(err?.message || err || "LLM API request failed");
      return { ok: false, content: "", usage: {}, error: errMsg };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Send a chat completion and parse the response as JSON.
   */
  async function chatCompletionJson(params = {}) {
    const result = await chatCompletion({ ...params, jsonMode: true });
    if (!result.ok) return { ok: false, data: null, raw: "", error: result.error };
    const parsed = parseJsonLoose(result.content);
    if (parsed !== null) {
      return { ok: true, data: parsed, raw: result.content, error: "" };
    }
    // Retry without json_mode
    const retry = await chatCompletion({ ...params, jsonMode: false });
    if (!retry.ok) return { ok: false, data: null, raw: result.content, error: "JSON parse failed" };
    const retryParsed = parseJsonLoose(retry.content);
    return {
      ok: retryParsed !== null,
      data: retryParsed,
      raw: retry.content,
      error: retryParsed !== null ? "" : "JSON parse failed after retry",
    };
  }

  /**
   * Health check for the current model.
   */
  async function ping() {
    const result = await chatCompletion({
      messages: [{ role: "user", content: "Reply with exactly: ok" }],
      temperature: 0,
      maxTokens: 8,
      timeoutMs: 15_000,
    });
    const config = resolveConfig();
    return { ok: result.ok, error: result.error, provider: config.provider, model: config.model };
  }

  /**
   * Get current resolved configuration (for debugging).
   */
  function getCurrentConfig() {
    const c = resolveConfig();
    return { provider: c.provider, model: c.model, apiBase: c.apiBase, hasKey: Boolean(c.apiKey) };
  }

  return {
    chatCompletion,
    chatCompletionStream,
    chatCompletionJson,
    ping,
    getCurrentConfig,
  };
}

// Backward compatibility: createDeepSeekClient wraps createLlmClient
export function createDeepSeekClient(deps = {}) {
  const getApiKey = typeof deps.getApiKey === "function"
    ? deps.getApiKey
    : () => toText(process.env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_KEY || "");
  return createLlmClient({
    getModelConfig: () => ({
      provider: "deepseek",
      model: "deepseek-chat",
      apiKey: getApiKey(),
      apiBase: PROVIDER_API_BASE.deepseek,
    }),
  });
}
