/**
 * OAuth lifecycle manager — handles OpenAI Codex OAuth flow,
 * credential persistence, prompt waiting, and log buffering.
 */

import fs from "node:fs";
import path from "node:path";
import { loginOpenAICodex } from "@mariozechner/pi-ai";
import {
  normalizeProviderKey,
  SUPPORTED_OAUTH_PROVIDERS,
} from "../domain/model-provider.js";

function stripAnsi(textLike) {
  return String(textLike || "").replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, "");
}

function extractUrlFromText(textLike) {
  const text = stripAnsi(textLike);
  const m = text.match(/https?:\/\/[^\s"'<>]+/i);
  return m ? String(m[0] || "").trim() : "";
}

function readJsonFileSafe(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonFileSafe(filePath, payloadLike) {
  const payload = payloadLike && typeof payloadLike === "object" ? payloadLike : {};
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
}

export function createOAuthManager({ resolveOpenClawConfigPath, resolveOpenClawAuthStorePath }) {
  const oauthState = {
    proc: null,
    active: false,
    provider: null,
    startedAt: null,
    attemptId: 0,
    attemptSeq: 0,
    last: null,
    logs: [],
    url: "",
    commandHint: "",
    prompt: null,
    promptWaiter: null,
  };

  function clearOauthPromptWaiter() {
    if (!oauthState.promptWaiter) { oauthState.prompt = null; return; }
    const waiter = oauthState.promptWaiter;
    if (waiter && waiter.timer) clearTimeout(waiter.timer);
    oauthState.promptWaiter = null;
    oauthState.prompt = null;
  }

  function pushOauthLog(stream, chunkLike) {
    const raw = String(chunkLike || "");
    const lines = stripAnsi(raw).replace(/\r\n/g, "\n").split("\n")
      .map((line) => String(line || "").trim()).filter(Boolean);
    for (const line of lines) {
      oauthState.logs.push({ ts: new Date().toISOString(), stream, line });
      const u = extractUrlFromText(line);
      if (u) oauthState.url = u;
    }
    if (oauthState.logs.length > 500) oauthState.logs.splice(0, oauthState.logs.length - 500);
  }

  function oauthIsRunning() {
    return Boolean(oauthState.active || (oauthState.proc && oauthState.proc.exitCode === null));
  }

  function getOauthStatus() {
    return {
      running: oauthIsRunning(),
      provider: oauthState.provider,
      startedAt: oauthState.startedAt,
      attemptId: Number(oauthState.attemptId || 0),
      last: oauthState.last,
      url: String(oauthState.url || ""),
      commandHint: String(oauthState.commandHint || ""),
      prompt: oauthState.prompt && typeof oauthState.prompt === "object" ? oauthState.prompt : null,
      logsTail: Array.isArray(oauthState.logs) ? oauthState.logs.slice(-80) : [],
      interactiveSupported: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    };
  }

  function waitForOauthPromptInput(attemptId, promptLike) {
    const prompt = promptLike && typeof promptLike === "object" ? promptLike : {};
    const message = String(prompt.message || "请粘贴 OAuth 回调 URL 或验证码").trim();
    const placeholder = String(prompt.placeholder || "").trim();
    clearOauthPromptWaiter();
    oauthState.prompt = { attemptId, message, placeholder, allowEmpty: Boolean(prompt.allowEmpty) };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (oauthState.promptWaiter && oauthState.promptWaiter.attemptId === attemptId) {
          oauthState.promptWaiter = null;
          oauthState.prompt = null;
        }
        reject(new Error("OAuth 等待输入超时，请重新发起登录并完成授权。"));
      }, 10 * 60 * 1000);
      oauthState.promptWaiter = {
        attemptId, timer,
        resolve: (v) => { clearTimeout(timer); oauthState.promptWaiter = null; oauthState.prompt = null; resolve(String(v ?? "")); },
        reject: (e) => { clearTimeout(timer); oauthState.promptWaiter = null; oauthState.prompt = null; reject(e instanceof Error ? e : new Error(String(e || "OAuth 输入失败"))); },
      };
    });
  }

  function submitOauthPromptInput(inputLike, attemptIdLike) {
    const input = String(inputLike ?? "");
    const waiter = oauthState.promptWaiter;
    if (!waiter) return { ok: false, error: "当前没有等待输入的 OAuth 流程。" };
    const attemptId = Number.isFinite(Number(attemptIdLike)) ? Number(attemptIdLike) : 0;
    if (attemptId > 0 && waiter.attemptId !== attemptId) return { ok: false, error: "OAuth 流程已变化，请刷新状态后重试。" };
    waiter.resolve(input);
    return { ok: true };
  }

  function persistOpenAICodexCredentials(credsLike) {
    const creds = credsLike && typeof credsLike === "object" ? credsLike : {};
    const access = String(creds.access || "").trim();
    const refresh = String(creds.refresh || "").trim();
    const expires = Number.isFinite(Number(creds.expires)) ? Number(creds.expires) : 0;
    if (!access || !refresh || !expires) return { ok: false, error: "OAuth 凭证不完整（缺少 access/refresh/expires）" };
    const configPath = resolveOpenClawConfigPath();
    const config = readJsonFileSafe(configPath, {});
    const authStorePath = resolveOpenClawAuthStorePath(config);
    const authStore = readJsonFileSafe(authStorePath, { version: 1, profiles: {} });
    authStore.version = 1;
    authStore.profiles = authStore.profiles && typeof authStore.profiles === "object" ? authStore.profiles : {};
    const email = String(creds.email || "").trim();
    const profileId = `openai-codex:${email || "default"}`;
    authStore.profiles[profileId] = {
      type: "oauth", provider: "openai-codex", access, refresh, expires,
      ...(email ? { email } : {}),
      ...(creds.accountId ? { accountId: String(creds.accountId) } : {}),
    };
    const existingOrder = Array.isArray(authStore?.order?.["openai-codex"]) ? authStore.order["openai-codex"] : [];
    authStore.order = authStore.order && typeof authStore.order === "object" ? authStore.order : {};
    authStore.order["openai-codex"] = [profileId, ...existingOrder.filter((id) => id !== profileId)];
    writeJsonFileSafe(authStorePath, authStore);
    const nextConfig = config && typeof config === "object" ? config : {};
    nextConfig.auth = nextConfig.auth && typeof nextConfig.auth === "object" ? nextConfig.auth : {};
    nextConfig.auth.profiles = nextConfig.auth.profiles && typeof nextConfig.auth.profiles === "object" ? nextConfig.auth.profiles : {};
    nextConfig.auth.profiles[profileId] = { provider: "openai-codex", mode: "oauth", ...(email ? { email } : {}) };
    nextConfig.auth.order = nextConfig.auth.order && typeof nextConfig.auth.order === "object" ? nextConfig.auth.order : {};
    const cfgOrder = Array.isArray(nextConfig.auth.order["openai-codex"]) ? nextConfig.auth.order["openai-codex"] : [];
    nextConfig.auth.order["openai-codex"] = [profileId, ...cfgOrder.filter((id) => id !== profileId)];
    writeJsonFileSafe(configPath, nextConfig);
    return { ok: true, profileId, authStorePath, configPath };
  }

  function startOAuthLogin(providerIdRaw) {
    const providerId = String(providerIdRaw ?? "").trim().toLowerCase();
    if (!SUPPORTED_OAUTH_PROVIDERS.has(providerId)) {
      return { ok: false, error: `Unsupported oauth provider: ${providerId || "(empty)"}`, supportedProviders: Array.from(SUPPORTED_OAUTH_PROVIDERS) };
    }
    if (oauthIsRunning()) {
      const state = getOauthStatus();
      return { ok: true, started: false, message: "OAuth login is already running", state, attemptId: Number(state?.attemptId || 0), startedAt: state?.startedAt || null };
    }
    const attemptId = Number(oauthState.attemptSeq || 0) + 1;
    oauthState.attemptSeq = attemptId;
    oauthState.attemptId = attemptId;
    oauthState.proc = null;
    oauthState.active = true;
    oauthState.provider = providerId;
    oauthState.startedAt = new Date().toISOString();
    oauthState.last = null;
    oauthState.url = "";
    oauthState.commandHint = "完成授权后若未自动回跳，请粘贴授权回调 URL 到页面输入框。";
    oauthState.logs = [];
    clearOauthPromptWaiter();
    const startedAt = String(oauthState.startedAt);
    const commandHint = "在网页中完成 OpenAI 授权后，若提示需要手动输入，请粘贴回调 URL。";
    pushOauthLog("system", "oauth start mode=native-openai-codex");
    pushOauthLog("system", commandHint);
    void (async () => {
      try {
        const creds = await loginOpenAICodex({
          onAuth: (info) => {
            const url = String(info?.url || "").trim();
            if (url) { oauthState.url = url; pushOauthLog("system", `oauth url: ${url}`); }
            const instructions = String(info?.instructions || "").trim();
            if (instructions) pushOauthLog("system", instructions);
          },
          onPrompt: async (prompt) => {
            const message = String(prompt?.message || "请粘贴 OAuth 回调 URL").trim();
            pushOauthLog("system", `oauth prompt: ${message}`);
            const input = await waitForOauthPromptInput(attemptId, prompt);
            return String(input || "").trim();
          },
          onProgress: (message) => { const text = String(message || "").trim(); if (text) pushOauthLog("stdout", text); },
        });
        const persisted = persistOpenAICodexCredentials(creds);
        if (!persisted.ok) throw new Error(String(persisted.error || "OAuth 凭证保存失败"));
        pushOauthLog("system", `oauth credentials saved: ${persisted.profileId}`);
        oauthState.last = { attemptId, provider: providerId, code: 0, signal: null, error: null, commandHint, url: String(oauthState.url || ""), profileId: persisted.profileId, finishedAt: new Date().toISOString() };
      } catch (error) {
        const errText = String(error?.message || error || "OAuth failed");
        pushOauthLog("system", `oauth error: ${errText}`);
        oauthState.last = { attemptId, provider: providerId, code: 1, signal: null, error: errText, commandHint, url: String(oauthState.url || ""), finishedAt: new Date().toISOString() };
      } finally {
        clearOauthPromptWaiter();
        oauthState.proc = null;
        oauthState.active = false;
        oauthState.provider = null;
        oauthState.startedAt = null;
        oauthState.attemptId = 0;
      }
    })();
    return { ok: true, started: true, message: "OAuth 已发起。正在等待浏览器授权…", provider: providerId, command: "native-openai-codex", launchMode: "native-openai-codex", commandHint, attemptId, startedAt };
  }

  return {
    oauthState,
    oauthIsRunning,
    getOauthStatus,
    startOAuthLogin,
    submitOauthPromptInput,
    persistOpenAICodexCredentials,
    pushOauthLog,
    clearOauthPromptWaiter,
  };
}
