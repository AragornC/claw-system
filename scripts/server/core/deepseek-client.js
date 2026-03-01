/**
 * Direct DeepSeek API client for ThunderClaw.
 *
 * Replaces the slow `openclaw agent` CLI invocations with direct HTTP API calls
 * using the OpenAI-compatible chat completions endpoint.
 * ~10x faster than spawning a child process per request.
 */

import { toText, parseJsonLoose } from "../lib/utils.js";

const DEEPSEEK_API_BASE = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-chat";

/**
 * Create a DeepSeek client bound to an API key source.
 * @param {{ getApiKey: () => string }} deps
 */
export function createDeepSeekClient(deps = {}) {
  const getApiKey = typeof deps.getApiKey === "function"
    ? deps.getApiKey
    : () => toText(process.env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_KEY || "");

  /**
   * Send a chat completion request.
   * @param {Object} params
   * @param {Array<{role:string, content:string}>} params.messages
   * @param {string} [params.model]
   * @param {number} [params.temperature]
   * @param {number} [params.maxTokens]
   * @param {number} [params.timeoutMs]
   * @param {boolean} [params.jsonMode] - Request JSON response format
   * @returns {Promise<{ok:boolean, content:string, usage:Object, error:string}>}
   */
  async function chatCompletion(params = {}) {
    const apiKey = getApiKey();
    if (!apiKey) {
      return { ok: false, content: "", usage: {}, error: "DEEPSEEK_API_KEY not configured" };
    }
    const model = toText(params.model, DEFAULT_MODEL);
    const messages = Array.isArray(params.messages) ? params.messages : [];
    const temperature = Number.isFinite(params.temperature) ? params.temperature : 0.3;
    const maxTokens = Number.isFinite(params.maxTokens) ? params.maxTokens : 4096;
    const timeoutMs = Number.isFinite(params.timeoutMs) ? params.timeoutMs : 90_000;

    const body = {
      model,
      messages: messages.map((m) => ({
        role: toText(m.role, "user"),
        content: toText(m.content, ""),
      })),
      temperature,
      max_tokens: maxTokens,
      stream: false,
    };
    if (params.jsonMode) {
      body.response_format = { type: "json_object" };
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const resp = await fetch(`${DEEPSEEK_API_BASE}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      const json = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        const errMsg = toText(json?.error?.message || json?.error || `HTTP ${resp.status}`);
        return { ok: false, content: "", usage: {}, error: errMsg };
      }
      const choice = Array.isArray(json.choices) && json.choices[0]
        ? json.choices[0]
        : {};
      const content = toText(choice.message?.content || "");
      const usage = json.usage && typeof json.usage === "object" ? json.usage : {};
      return { ok: true, content, usage, error: "" };
    } catch (err) {
      const errMsg = err?.name === "AbortError"
        ? `DeepSeek API timeout (${timeoutMs}ms)`
        : toText(err?.message || err || "DeepSeek API request failed");
      return { ok: false, content: "", usage: {}, error: errMsg };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Send a chat completion and parse the response as JSON.
   * Retries once with json_mode if initial parse fails.
   */
  async function chatCompletionJson(params = {}) {
    const result = await chatCompletion({ ...params, jsonMode: true });
    if (!result.ok) return { ok: false, data: null, raw: "", error: result.error };
    const parsed = parseJsonLoose(result.content);
    if (parsed !== null) {
      return { ok: true, data: parsed, raw: result.content, error: "" };
    }
    // Retry without json_mode in case the model struggles with it
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
   * Simple health check / connectivity test.
   */
  async function ping() {
    const result = await chatCompletion({
      messages: [{ role: "user", content: "Reply with exactly: ok" }],
      temperature: 0,
      maxTokens: 8,
      timeoutMs: 15_000,
    });
    return { ok: result.ok, error: result.error };
  }

  return {
    chatCompletion,
    chatCompletionJson,
    ping,
  };
}
