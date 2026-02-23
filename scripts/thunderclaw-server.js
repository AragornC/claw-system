#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const WEB_DIR = path.resolve(ROOT_DIR, "web");
const REPORT_DIR = path.resolve(ROOT_DIR, "memory", "report");
const MEMORY_DIR = path.resolve(ROOT_DIR, "memory");
const XBRAIN_STATE_PATH = path.join(MEMORY_DIR, "xbrain-state.json");
const CHAT_HISTORY_PATH = path.join(MEMORY_DIR, "chat-history.json");
const DEFAULT_PORT = Number.parseInt(process.env.THUNDERCLAW_PORT ?? "3456", 10) || 3456;
const MAX_BODY_BYTES = 1_000_000;
const MAX_GATEWAY_LOG_LINES = 500;
const MAX_CHAT_EVENTS = 2_000;

const gatewayState = {
  proc: null,
  pid: null,
  startedAt: null,
  logs: [],
};

const oauthState = {
  proc: null,
  provider: null,
  startedAt: null,
  last: null,
};

const SUPPORTED_OAUTH_PROVIDERS = new Set(["openai-codex"]);
const PROVIDER_DEFAULT_MODEL_REFS = {
  deepseek: "deepseek/deepseek-chat",
  chatgpt: "openai-codex/gpt-5.3-codex",
  anthropic: "anthropic/claude-3-5-sonnet",
  openrouter: "openrouter/openai/gpt-4o-mini",
  gemini: "google/gemini-2.5-flash",
  zai: "zai/glm-4.5",
};
const PROVIDER_TO_SETUP_PROVIDER = {
  deepseek: "deepseek-api-key",
  chatgpt: "openai-api-key",
  anthropic: "anthropic-api-key",
  openrouter: "openrouter-api-key",
  gemini: "gemini-api-key",
  zai: "zai-api-key",
};
const PROVIDER_TO_OAUTH_PROVIDER = {
  chatgpt: "openai-codex",
};
const MODEL_CATALOG_CACHE_TTL_MS = 60_000;
const modelCatalogCache = {
  all: null,
  configured: null,
  at: 0,
};

function normalizeProviderKey(providerRaw) {
  const value = String(providerRaw ?? "")
    .trim()
    .toLowerCase();
  if (!value) return "deepseek";
  if (value === "openai" || value === "openai-codex" || value === "chatgpt" || value === "codex") {
    return "chatgpt";
  }
  if (value === "claude") return "anthropic";
  if (value === "google" || value.startsWith("gemini")) return "gemini";
  if (value.startsWith("deepseek")) return "deepseek";
  if (value.startsWith("anthropic")) return "anthropic";
  return value;
}

function inferProviderFromModelRef(modelRefRaw) {
  const modelRef = String(modelRefRaw ?? "").trim();
  if (!modelRef) {
    return { provider: "deepseek", modelId: "deepseek-chat", modelRef: "deepseek/deepseek-chat" };
  }
  if (!modelRef.includes("/")) {
    const maybeProvider = normalizeProviderKey(modelRef);
    const defaultRef = PROVIDER_DEFAULT_MODEL_REFS[maybeProvider];
    if (defaultRef) {
      return inferProviderFromModelRef(defaultRef);
    }
    return {
      provider: "deepseek",
      modelId: modelRef,
      modelRef: `deepseek/${modelRef}`,
    };
  }
  const [prefix, ...rest] = modelRef.split("/");
  const provider = normalizeProviderKey(prefix);
  let modelId = rest.join("/");
  if (!modelId) {
    const fallbackRef = PROVIDER_DEFAULT_MODEL_REFS[provider] || PROVIDER_DEFAULT_MODEL_REFS.deepseek;
    modelId = String(fallbackRef).split("/").slice(1).join("/");
  }
  return { provider, modelId, modelRef };
}

function toModelRef(providerRaw, modelIdRaw) {
  const provider = normalizeProviderKey(providerRaw);
  const modelId = String(modelIdRaw ?? "").trim();
  if (!modelId) {
    return PROVIDER_DEFAULT_MODEL_REFS[provider] || PROVIDER_DEFAULT_MODEL_REFS.deepseek;
  }
  if (modelId.includes("/")) {
    return modelId;
  }
  if (provider === "chatgpt") return `openai-codex/${modelId}`;
  if (provider === "anthropic") return `anthropic/${modelId}`;
  if (provider === "gemini") return `google/${modelId}`;
  return `${provider || "deepseek"}/${modelId}`;
}

function uniqStrings(items) {
  return Array.from(
    new Set(
      (Array.isArray(items) ? items : [])
        .map((v) => String(v ?? "").trim())
        .filter(Boolean),
    ),
  );
}

function maskSecret(valueRaw) {
  const value = String(valueRaw ?? "").trim();
  if (!value) return "(未设置)";
  if (value.length <= 8) return `${value.slice(0, 2)}***`;
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function providerSupportsApiKey(providerRaw) {
  const provider = normalizeProviderKey(providerRaw);
  return Boolean(PROVIDER_TO_SETUP_PROVIDER[provider]);
}

function providerSupportsOAuth(providerRaw) {
  const provider = normalizeProviderKey(providerRaw);
  return Boolean(PROVIDER_TO_OAUTH_PROVIDER[provider]);
}

function providerAuthType(providerRaw) {
  const provider = normalizeProviderKey(providerRaw);
  if (providerSupportsOAuth(provider) && !providerSupportsApiKey(provider)) return "oauth";
  return providerSupportsApiKey(provider) ? "apiKey" : "external";
}

function ensureProviderAuthEntry(providerRaw, patchLike = {}) {
  const provider = normalizeProviderKey(providerRaw);
  xbrainStore.base.providerAuth = xbrainStore.base.providerAuth && typeof xbrainStore.base.providerAuth === "object"
    ? xbrainStore.base.providerAuth
    : {};
  const current = xbrainStore.base.providerAuth[provider] && typeof xbrainStore.base.providerAuth[provider] === "object"
    ? xbrainStore.base.providerAuth[provider]
    : {
        configured: false,
        masked: "(未设置)",
        plain: "",
        source: "-",
        error: "",
        type: providerAuthType(provider),
      };
  const patch = patchLike && typeof patchLike === "object" ? patchLike : {};
  const next = {
    ...current,
    ...patch,
    type: String(patch.type || current.type || providerAuthType(provider)),
  };
  xbrainStore.base.providerAuth[provider] = next;
  return next;
}

function createInitialXbrainStore() {
  return {
    base: {
      modelProvider: "deepseek",
      modelId: "deepseek-chat",
      runtimeModelProvider: "deepseek",
      runtimeModelId: "deepseek-chat",
      providerCatalog: ["deepseek", "chatgpt", "anthropic"],
      modelRegistry: ["deepseek/deepseek-chat"],
      deepseekApiKey: "",
      providerAuth: {
        deepseek: { configured: false, type: "apiKey", source: "-", error: "" },
        chatgpt: { configured: false, type: "oauth", source: "-", error: "" },
        anthropic: { configured: false, type: "oauth", source: "-", error: "" },
      },
      telegramTokenValue: "",
      telegramRelayEnabled: false,
      chatChannel: "dashboard",
    },
    exchange: {
      apiKeyValue: "",
      apiSecretValue: "",
      passphraseValue: "",
    },
    strategy: {
      profileName: "default",
      symbol: "BTC/USDT:USDT",
      leverage: 10,
      sizeMode: "risk",
      orderSize: 8,
      riskPct: 0.015,
      minNotional: 5,
      maxNotional: 80,
      runtimeMode: "dryrun",
      activeStrategy: "default",
    },
    locks: {
      base: { locked: false, hasPassword: false, password: "" },
      channel: { locked: false, hasPassword: false, password: "" },
      exchange: { locked: false, hasPassword: false, password: "" },
      strategy: { locked: false, hasPassword: false, password: "" },
    },
  };
}

function loadXbrainStore() {
  const store = createInitialXbrainStore();
  try {
    if (!fs.existsSync(XBRAIN_STATE_PATH)) {
      return store;
    }
    const raw = fs.readFileSync(XBRAIN_STATE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      store.base = { ...store.base, ...(parsed.base || {}) };
      store.exchange = { ...store.exchange, ...(parsed.exchange || {}) };
      store.strategy = { ...store.strategy, ...(parsed.strategy || {}) };
      for (const section of ["base", "channel", "exchange", "strategy"]) {
        const lockInfo = parsed?.locks?.[section];
        if (lockInfo && typeof lockInfo === "object") {
          store.locks[section] = { ...store.locks[section], ...lockInfo };
        }
      }
    }
  } catch {}
  return store;
}

const xbrainStore = loadXbrainStore();

function saveXbrainStore() {
  try {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
    fs.writeFileSync(XBRAIN_STATE_PATH, JSON.stringify(xbrainStore, null, 2), "utf8");
  } catch {}
}

function createInitialChatHistory() {
  return { nextId: 1, events: [] };
}

function loadChatHistory() {
  try {
    if (!fs.existsSync(CHAT_HISTORY_PATH)) {
      return createInitialChatHistory();
    }
    const raw = fs.readFileSync(CHAT_HISTORY_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const events = Array.isArray(parsed?.events)
      ? parsed.events
          .filter((ev) => ev && typeof ev === "object")
          .map((ev) => ({
            id: Number(ev.id) || 0,
            ts: String(ev.ts || new Date().toISOString()),
            role: ev.role === "user" ? "user" : "bot",
            source: String(ev.source || "dashboard"),
            text: String(ev.text || ""),
            from: typeof ev.from === "string" ? ev.from : undefined,
            chatId: ev.chatId != null ? String(ev.chatId) : undefined,
          }))
      : [];
    const maxId = events.reduce((m, ev) => Math.max(m, Number(ev.id) || 0), 0);
    return {
      nextId: Number(parsed?.nextId) > maxId ? Number(parsed.nextId) : maxId + 1,
      events: events.slice(-MAX_CHAT_EVENTS),
    };
  } catch {
    return createInitialChatHistory();
  }
}

const chatHistory = loadChatHistory();

function saveChatHistory() {
  try {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
    fs.writeFileSync(CHAT_HISTORY_PATH, JSON.stringify(chatHistory, null, 2), "utf8");
  } catch {}
}

function appendChatEvent(eventLike) {
  const item = eventLike && typeof eventLike === "object" ? eventLike : {};
  const event = {
    id: chatHistory.nextId,
    ts: String(item.ts || new Date().toISOString()),
    role: item.role === "user" ? "user" : "bot",
    source: String(item.source || "dashboard"),
    text: String(item.text || "").trim(),
  };
  if (!event.text) return null;
  if (item.from != null) event.from = String(item.from);
  if (item.chatId != null) event.chatId = String(item.chatId);
  chatHistory.nextId += 1;
  chatHistory.events.push(event);
  if (chatHistory.events.length > MAX_CHAT_EVENTS) {
    chatHistory.events.splice(0, chatHistory.events.length - MAX_CHAT_EVENTS);
  }
  saveChatHistory();
  return event;
}

function resolveOpenClawCommand() {
  const localBinName = process.platform === "win32" ? "openclaw.cmd" : "openclaw";
  const localBin = path.join(ROOT_DIR, "node_modules", ".bin", localBinName);
  if (fs.existsSync(localBin)) {
    return {
      command: localBin,
      prefixArgs: [],
      source: "local",
    };
  }
  return {
    command: "npx",
    prefixArgs: ["--yes", "openclaw@latest"],
    source: "npx",
  };
}

function parseJsonSafe(text) {
  if (typeof text !== "string") {
    return null;
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      const maybeJson = trimmed.slice(start, end + 1);
      try {
        return JSON.parse(maybeJson);
      } catch {
        return null;
      }
    }
    return null;
  }
}

function pushGatewayLog(stream, line) {
  const parts = String(line)
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter(Boolean);
  for (const part of parts) {
    gatewayState.logs.push({
      ts: new Date().toISOString(),
      stream,
      line: part,
    });
  }
  if (gatewayState.logs.length > MAX_GATEWAY_LOG_LINES) {
    gatewayState.logs.splice(0, gatewayState.logs.length - MAX_GATEWAY_LOG_LINES);
  }
}

async function runOpenClawCommand(args, options = {}) {
  const resolved = resolveOpenClawCommand();
  const finalArgs = [...resolved.prefixArgs, ...args];
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 120_000;
  const env = {
    ...process.env,
    ...options.env,
  };

  return await new Promise((resolve) => {
    const child = spawn(resolved.command, finalArgs, {
      cwd: ROOT_DIR,
      env,
      stdio: "pipe",
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      }, 1_000).unref();
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        code: null,
        timedOut,
        stdout,
        stderr: `${stderr}\n${String(error)}`.trim(),
        source: resolved.source,
      });
    });

    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0 && !timedOut,
        code,
        timedOut,
        stdout,
        stderr,
        source: resolved.source,
      });
    });
  });
}

function extractAgentReply(payload) {
  if (!payload || typeof payload !== "object") {
    return "";
  }
  const containers = [];
  if (payload.result && typeof payload.result === "object") {
    containers.push(payload.result);
  }
  containers.push(payload);

  const texts = [];
  for (const container of containers) {
    const payloads = Array.isArray(container?.payloads) ? container.payloads : [];
    for (const item of payloads) {
      if (!item || typeof item !== "object") {
        continue;
      }
      if (typeof item.text === "string" && item.text.trim()) {
        texts.push(item.text.trim());
        continue;
      }
      const content = item.content;
      if (typeof content === "string" && content.trim()) {
        texts.push(content.trim());
        continue;
      }
      if (Array.isArray(content)) {
        const joined = content
          .map((part) => {
            if (typeof part === "string") return part.trim();
            if (part && typeof part === "object" && typeof part.text === "string") return part.text.trim();
            return "";
          })
          .filter(Boolean)
          .join("\n");
        if (joined) {
          texts.push(joined);
        }
      }
    }
  }
  if (texts.length > 0) {
    return texts.join("\n\n");
  }
  if (typeof payload.summary === "string") {
    return payload.summary;
  }
  const nestedError = payload?.error;
  if (typeof nestedError === "string" && nestedError.trim()) {
    return nestedError.trim();
  }
  if (nestedError && typeof nestedError === "object" && typeof nestedError.message === "string") {
    return nestedError.message.trim();
  }
  return "";
}

function resolveGatewayLockDirPath() {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const suffix = uid != null ? `openclaw-${uid}` : "openclaw";
  return path.join(os.tmpdir(), suffix);
}

function readProcState(pid) {
  const statPath = `/proc/${pid}/stat`;
  const raw = fs.readFileSync(statPath, "utf8");
  const closeIdx = raw.lastIndexOf(")");
  if (closeIdx < 0) return "";
  const rest = raw.slice(closeIdx + 2).trim();
  if (!rest) return "";
  return String(rest.split(" ")[0] || "").trim();
}

function cleanupStaleGatewayLocks() {
  const lockDir = resolveGatewayLockDirPath();
  const removed = [];
  const kept = [];
  const errors = [];

  let entries = [];
  try {
    entries = fs.readdirSync(lockDir, { withFileTypes: true });
  } catch {
    return { lockDir, removed, kept, errors };
  }

  for (const entry of entries) {
    if (!entry || !entry.isFile()) continue;
    const name = String(entry.name || "");
    if (!/^gateway\..+\.lock$/i.test(name)) continue;
    const lockPath = path.join(lockDir, name);
    let stale = false;
    let pid = null;

    try {
      const raw = fs.readFileSync(lockPath, "utf8");
      const parsed = JSON.parse(raw);
      const pidNum = Number(parsed?.pid);
      if (Number.isFinite(pidNum) && pidNum > 1) {
        pid = pidNum;
        let state = "";
        try {
          state = readProcState(pidNum);
        } catch {
          state = "";
        }
        if (!state || state === "Z") {
          stale = true;
        } else {
          try {
            process.kill(pidNum, 0);
            stale = false;
          } catch {
            stale = true;
          }
        }
      } else {
        stale = true;
      }
    } catch {
      stale = true;
    }

    if (!stale) {
      kept.push({ path: lockPath, pid });
      continue;
    }

    try {
      fs.unlinkSync(lockPath);
      removed.push({ path: lockPath, pid });
    } catch (error) {
      errors.push({ path: lockPath, error: String(error) });
    }
  }

  return { lockDir, removed, kept, errors };
}

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function guessContentType(filePath) {
  if (filePath.endsWith(".html")) {
    return "text/html; charset=utf-8";
  }
  if (filePath.endsWith(".js")) {
    return "application/javascript; charset=utf-8";
  }
  if (filePath.endsWith(".css")) {
    return "text/css; charset=utf-8";
  }
  if (filePath.endsWith(".svg")) {
    return "image/svg+xml";
  }
  if (filePath.endsWith(".json")) {
    return "application/json; charset=utf-8";
  }
  return "application/octet-stream";
}

async function serveStatic(req, res) {
  const rawUrl = new URL(req.url ?? "/", "http://localhost");
  let pathname = decodeURIComponent(rawUrl.pathname);
  const candidates = [];
  if (pathname === "/") {
    candidates.push(path.join(REPORT_DIR, "index.html"));
  } else {
    const safePath = path
      .normalize(pathname)
      .replace(/^([/\\])+/, "")
      .replace(/^(\.\.[/\\])+/, "");
    const reportPath = path.join(REPORT_DIR, safePath);
    const webPath = path.join(WEB_DIR, safePath);
    candidates.push(reportPath, webPath);
  }

  for (const targetPath of candidates) {
    const isInReport = targetPath.startsWith(REPORT_DIR);
    const isInWeb = targetPath.startsWith(WEB_DIR);
    if (!isInReport && !isInWeb) {
      continue;
    }
    try {
      const stat = await fsp.stat(targetPath);
      if (!stat.isFile()) continue;
      const content = await fsp.readFile(targetPath);
      res.writeHead(200, {
        "Content-Type": guessContentType(targetPath),
        "Cache-Control": "no-store",
      });
      res.end(content);
      return;
    } catch {}
  }

  sendJson(res, 404, { ok: false, error: "Not found" });
}

async function readJsonBody(req) {
  return await new Promise((resolve, reject) => {
    let raw = "";
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      raw += String(chunk);
    });
    req.on("end", () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", (error) => {
      reject(error);
    });
  });
}

function gatewayIsRunning() {
  return Boolean(gatewayState.proc && gatewayState.proc.exitCode === null);
}

function oauthIsRunning() {
  return Boolean(oauthState.proc && oauthState.proc.exitCode === null);
}

function getOauthStatus() {
  return {
    running: oauthIsRunning(),
    provider: oauthState.provider,
    startedAt: oauthState.startedAt,
    last: oauthState.last,
    interactiveSupported: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  };
}

function startOAuthLogin(providerIdRaw) {
  const providerId = String(providerIdRaw ?? "").trim().toLowerCase();
  if (!SUPPORTED_OAUTH_PROVIDERS.has(providerId)) {
    return {
      ok: false,
      error: `Unsupported oauth provider: ${providerId || "(empty)"}`,
      supportedProviders: Array.from(SUPPORTED_OAUTH_PROVIDERS),
    };
  }

  if (oauthIsRunning()) {
    return {
      ok: true,
      started: false,
      message: "OAuth login is already running",
      state: getOauthStatus(),
    };
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return {
      ok: false,
      error: "OAuth login requires an interactive terminal (TTY).",
      commandHint: `openclaw models auth login --provider ${providerId} --set-default`,
    };
  }

  const resolved = resolveOpenClawCommand();
  const args = [...resolved.prefixArgs, "models", "auth", "login", "--provider", providerId, "--set-default"];
  const child = spawn(resolved.command, args, {
    cwd: ROOT_DIR,
    env: process.env,
    stdio: "inherit",
  });

  oauthState.proc = child;
  oauthState.provider = providerId;
  oauthState.startedAt = new Date().toISOString();
  oauthState.last = null;

  child.on("error", (error) => {
    oauthState.last = {
      provider: providerId,
      code: null,
      signal: null,
      error: String(error),
      finishedAt: new Date().toISOString(),
    };
    oauthState.proc = null;
    oauthState.provider = null;
    oauthState.startedAt = null;
  });

  child.on("close", (code, signal) => {
    oauthState.last = {
      provider: providerId,
      code,
      signal: signal ?? null,
      error: null,
      finishedAt: new Date().toISOString(),
    };
    oauthState.proc = null;
    oauthState.provider = null;
    oauthState.startedAt = null;
  });

  return {
    ok: true,
    started: true,
    message: "OAuth login started. Continue in terminal prompts.",
    provider: providerId,
    command: ["openclaw", "models", "auth", "login", "--provider", providerId, "--set-default"].join(" "),
  };
}

function startGateway() {
  if (gatewayIsRunning()) {
    return {
      started: false,
      message: "Gateway is already running",
      pid: gatewayState.pid,
    };
  }

  const lockCleanup = cleanupStaleGatewayLocks();
  if (lockCleanup.removed.length > 0) {
    pushGatewayLog(
      "system",
      `removed stale gateway locks: ${lockCleanup.removed.map((x) => path.basename(x.path)).join(", ")}`,
    );
  }
  if (lockCleanup.errors.length > 0) {
    pushGatewayLog(
      "system",
      `failed to cleanup stale locks: ${lockCleanup.errors.map((x) => `${path.basename(x.path)} ${x.error}`).join("; ")}`,
    );
  }

  const resolved = resolveOpenClawCommand();
  const args = [...resolved.prefixArgs, "gateway", "run", "--allow-unconfigured", "--ws-log", "compact", "--force"];
  const child = spawn(resolved.command, args, {
    cwd: ROOT_DIR,
    env: process.env,
    stdio: "pipe",
  });

  gatewayState.proc = child;
  gatewayState.pid = child.pid ?? null;
  gatewayState.startedAt = new Date().toISOString();
  pushGatewayLog("system", `gateway start requested (pid=${gatewayState.pid ?? "unknown"})`);

  child.stdout.on("data", (chunk) => {
    pushGatewayLog("stdout", String(chunk));
  });

  child.stderr.on("data", (chunk) => {
    pushGatewayLog("stderr", String(chunk));
  });

  child.on("error", (error) => {
    pushGatewayLog("system", `gateway process error: ${String(error)}`);
  });

  child.on("close", (code, signal) => {
    pushGatewayLog("system", `gateway exited code=${code ?? "null"} signal=${signal ?? "none"}`);
    gatewayState.proc = null;
    gatewayState.pid = null;
    gatewayState.startedAt = null;
  });

  return {
    started: true,
    message: "Gateway started",
    pid: gatewayState.pid,
  };
}

function stopGateway() {
  if (!gatewayIsRunning()) {
    return {
      stopped: false,
      message: "Gateway is not running",
    };
  }
  gatewayState.proc.kill("SIGTERM");
  pushGatewayLog("system", "gateway stop requested");
  return {
    stopped: true,
    message: "Gateway stop signal sent",
  };
}

async function handleStatus(req, res) {
  const versionRes = await runOpenClawCommand(["--version"], { timeoutMs: 20_000 });
  const versionText = versionRes.stdout.trim() || versionRes.stderr.trim();

  const stateDir = path.join(os.homedir(), ".openclaw");
  const defaultConfigPath = path.join(stateDir, "openclaw.json");
  const legacyConfigPath = path.join(stateDir, "config.json");

  const healthRes = await runOpenClawCommand(["gateway", "health", "--json"], { timeoutMs: 8_000 });
  const healthJson = parseJsonSafe(healthRes.stdout);

  const modelsRes = await runOpenClawCommand(["models", "status", "--json"], {
    timeoutMs: 15_000,
  });
  const modelsJson = parseJsonSafe(modelsRes.stdout);
  const configPath =
    typeof modelsJson?.configPath === "string" && modelsJson.configPath.trim()
      ? modelsJson.configPath
      : fs.existsSync(defaultConfigPath)
        ? defaultConfigPath
        : legacyConfigPath;
  const configExists =
    fs.existsSync(configPath) || fs.existsSync(defaultConfigPath) || fs.existsSync(legacyConfigPath);

  sendJson(res, 200, {
    ok: true,
    openclaw: {
      available: versionRes.ok,
      version: versionText,
      source: versionRes.source,
    },
    config: {
      path: configPath,
      exists: configExists,
    },
    gateway: {
      managedByThunderClaw: gatewayIsRunning(),
      pid: gatewayState.pid,
      startedAt: gatewayState.startedAt,
      healthy: healthRes.ok,
      health: healthJson,
      healthError: healthRes.ok ? null : (healthRes.stderr || healthRes.stdout || "").trim() || null,
      logsTail: gatewayState.logs.slice(-60),
    },
    models: {
      ok: modelsRes.ok,
      status: modelsJson,
      error: modelsRes.ok ? null : (modelsRes.stderr || modelsRes.stdout || "").trim() || null,
    },
    oauth: getOauthStatus(),
    onboarding: {
      simpleReady: Boolean(versionRes.ok && configExists && healthRes.ok),
      recommendedProvider: "deepseek-api-key",
      tip: "推荐先用 DeepSeek API Key 一键完成基础配置。",
    },
  });
}

function providerToAuthConfig(provider) {
  const map = {
    "openai-api-key": {
      authChoice: "openai-api-key",
      flag: "--openai-api-key",
      mode: "single-flag",
    },
    "anthropic-api-key": {
      authChoice: "apiKey",
      flag: "--anthropic-api-key",
      mode: "single-flag",
    },
    "openrouter-api-key": {
      authChoice: "openrouter-api-key",
      flag: "--openrouter-api-key",
      mode: "single-flag",
    },
    "gemini-api-key": {
      authChoice: "gemini-api-key",
      flag: "--gemini-api-key",
      mode: "single-flag",
    },
    "zai-api-key": {
      authChoice: "zai-api-key",
      flag: "--zai-api-key",
      mode: "single-flag",
    },
    "deepseek-api-key": {
      authChoice: "custom-api-key",
      mode: "custom-api-key",
      customBaseUrl: "https://api.deepseek.com/v1",
      customModelId: "deepseek-chat",
      customProviderId: "deepseek",
      customCompatibility: "openai",
    },
  };
  return map[provider] ?? null;
}

function buildOnboardArgs(params) {
  const { providerConfig, apiKey, gatewayPort, gatewayAuth } = params;
  const args = [
    "onboard",
    "--non-interactive",
    "--accept-risk",
    "--mode",
    "local",
    "--flow",
    "quickstart",
    "--skip-channels",
    "--skip-skills",
    "--skip-health",
    "--skip-ui",
    "--gateway-bind",
    "loopback",
    "--gateway-auth",
    gatewayAuth,
    "--gateway-port",
    String(gatewayPort),
    "--auth-choice",
    providerConfig.authChoice,
  ];
  if (providerConfig.mode === "custom-api-key") {
    args.push(
      "--custom-base-url",
      providerConfig.customBaseUrl,
      "--custom-model-id",
      providerConfig.customModelId,
      "--custom-provider-id",
      providerConfig.customProviderId,
      "--custom-compatibility",
      providerConfig.customCompatibility,
      "--custom-api-key",
      apiKey,
    );
  } else {
    args.push(providerConfig.flag, apiKey);
  }
  return args;
}

async function runSetupFromInput(input) {
  const provider = String(input.provider ?? "").trim();
  const apiKey = String(input.apiKey ?? "").trim();
  const gatewayPort = Number.parseInt(String(input.gatewayPort ?? "18789"), 10) || 18789;
  const gatewayAuth = String(input.gatewayAuth ?? "token").trim() === "password" ? "password" : "token";
  const providerConfig = providerToAuthConfig(provider);
  if (!providerConfig) {
    return {
      ok: false,
      statusCode: 400,
      error: "Unsupported provider",
    };
  }
  if (!apiKey) {
    return {
      ok: false,
      statusCode: 400,
      error: "API Key is required",
    };
  }
  const args = buildOnboardArgs({ providerConfig, apiKey, gatewayPort, gatewayAuth });
  const result = await runOpenClawCommand(args, { timeoutMs: 240_000 });
  return {
    ok: result.ok,
    statusCode: result.ok ? 200 : 500,
    provider,
    gatewayPort,
    gatewayAuth,
    command: ["openclaw", ...args.slice(0, -1), "***"].join(" "),
    exitCode: result.code,
    timedOut: result.timedOut,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function waitGatewayHealthy(params = {}) {
  const timeoutMs = Number.isFinite(params.timeoutMs) ? params.timeoutMs : 20_000;
  const pollMs = Number.isFinite(params.pollMs) ? params.pollMs : 1_200;
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    const healthRes = await runOpenClawCommand(["gateway", "health", "--json"], { timeoutMs: 5_000 });
    if (healthRes.ok) {
      return { ok: true, payload: parseJsonSafe(healthRes.stdout) };
    }
    lastError = (healthRes.stderr || healthRes.stdout || "").trim() || "gateway health check failed";
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return { ok: false, error: lastError || "gateway health check timeout" };
}

function sanitizeProviderCatalog(items) {
  const out = uniqStrings(items)
    .map((p) => normalizeProviderKey(p))
    .filter(Boolean);
  if (!out.length) {
    return ["deepseek", "chatgpt", "anthropic"];
  }
  return out;
}

function getAuthProviderEntry(modelsJson, provider) {
  const providers = Array.isArray(modelsJson?.auth?.providers) ? modelsJson.auth.providers : [];
  return providers.find((item) => normalizeProviderKey(item?.provider) === provider) ?? null;
}

function normalizeModelCatalogEntry(itemLike) {
  const item = itemLike && typeof itemLike === "object" ? itemLike : {};
  const key = String(item.key || item.model || "").trim();
  if (!key || !key.includes("/")) return null;
  const inferred = inferProviderFromModelRef(key);
  return {
    key,
    name: String(item.name || inferred.modelId || key),
    provider: inferred.provider,
    input: String(item.input || "text"),
    contextWindow: Number.isFinite(Number(item.contextWindow)) ? Number(item.contextWindow) : null,
    local: Boolean(item.local),
    available: item.available === true,
    missing: item.missing === true,
    tags: uniqStrings(item.tags || []),
  };
}

async function listOpenClawModelsCatalog(force = false) {
  const now = Date.now();
  const cacheValid = !force
    && Array.isArray(modelCatalogCache.all)
    && Array.isArray(modelCatalogCache.configured)
    && (now - modelCatalogCache.at) < MODEL_CATALOG_CACHE_TTL_MS;
  if (cacheValid) {
    return {
      ok: true,
      all: modelCatalogCache.all,
      configured: modelCatalogCache.configured,
      cached: true,
      updatedAt: modelCatalogCache.at,
    };
  }

  const allRes = await runOpenClawCommand(["models", "list", "--all", "--json"], { timeoutMs: 90_000 });
  if (!allRes.ok) {
    return { ok: false, error: (allRes.stderr || allRes.stdout || "").trim() || "models list --all failed" };
  }
  const allJson = parseJsonSafe(allRes.stdout);
  const allModels = Array.isArray(allJson?.models)
    ? allJson.models.map((item) => normalizeModelCatalogEntry(item)).filter(Boolean)
    : [];
  allModels.sort((a, b) => {
    const p = String(a.provider || "").localeCompare(String(b.provider || ""));
    if (p !== 0) return p;
    return String(a.key || "").localeCompare(String(b.key || ""));
  });

  const configuredRes = await runOpenClawCommand(["models", "list", "--json"], { timeoutMs: 25_000 });
  const configuredJson = parseJsonSafe(configuredRes.stdout);
  const configuredModels = Array.isArray(configuredJson?.models)
    ? configuredJson.models.map((item) => normalizeModelCatalogEntry(item)).filter(Boolean)
    : [];
  configuredModels.sort((a, b) => String(a.key || "").localeCompare(String(b.key || "")));

  modelCatalogCache.all = allModels;
  modelCatalogCache.configured = configuredModels;
  modelCatalogCache.at = now;
  return {
    ok: true,
    all: allModels,
    configured: configuredModels,
    cached: false,
    updatedAt: now,
  };
}

async function tuneDeepseekDefaults() {
  const tuneContext = await runOpenClawCommand(
    ["config", "set", "models.providers.deepseek.models[0].contextWindow", "128000", "--strict-json"],
    { timeoutMs: 30_000 },
  );
  const tuneMaxTokens = await runOpenClawCommand(
    ["config", "set", "models.providers.deepseek.models[0].maxTokens", "8192", "--strict-json"],
    { timeoutMs: 30_000 },
  );
  return {
    contextWindowOk: tuneContext.ok,
    maxTokensOk: tuneMaxTokens.ok,
    error: [
      tuneContext.ok ? "" : (tuneContext.stderr || tuneContext.stdout || "").trim(),
      tuneMaxTokens.ok ? "" : (tuneMaxTokens.stderr || tuneMaxTokens.stdout || "").trim(),
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

async function syncXbrainFromOpenClaw() {
  const modelsRes = await runOpenClawCommand(["models", "status", "--json"], {
    timeoutMs: 20_000,
  });
  if (!modelsRes.ok) {
    return {
      ok: false,
      error: (modelsRes.stderr || modelsRes.stdout || "").trim() || "models status failed",
    };
  }
  const modelsJson = parseJsonSafe(modelsRes.stdout);
  if (!modelsJson || typeof modelsJson !== "object") {
    return { ok: false, error: "invalid models status payload" };
  }

  const defaultModelRef = String(modelsJson.defaultModel || modelsJson.resolvedDefault || "").trim();
  if (defaultModelRef) {
    const inferred = inferProviderFromModelRef(defaultModelRef);
    xbrainStore.base.modelProvider = inferred.provider;
    xbrainStore.base.modelId = inferred.modelId;
    xbrainStore.base.runtimeModelProvider = inferred.provider;
    xbrainStore.base.runtimeModelId = inferred.modelId;
  }

  const allowed = uniqStrings(modelsJson.allowed);
  if (allowed.length) {
    xbrainStore.base.modelRegistry = uniqStrings([...(xbrainStore.base.modelRegistry || []), ...allowed]);
  }

  const providerCatalog = new Set(sanitizeProviderCatalog(xbrainStore.base.providerCatalog));
  for (const modelRef of xbrainStore.base.modelRegistry || []) {
    providerCatalog.add(inferProviderFromModelRef(modelRef).provider);
  }
  providerCatalog.add(normalizeProviderKey(xbrainStore.base.modelProvider));
  xbrainStore.base.providerCatalog = sanitizeProviderCatalog(Array.from(providerCatalog));

  const baseAuth = xbrainStore.base.providerAuth && typeof xbrainStore.base.providerAuth === "object"
    ? xbrainStore.base.providerAuth
    : {};
  const deepseekEntry = getAuthProviderEntry(modelsJson, "deepseek");
  const openaiEntry = getAuthProviderEntry(modelsJson, "chatgpt");
  const anthropicEntry = getAuthProviderEntry(modelsJson, "anthropic");

  const deepseekKey = String(xbrainStore.base.deepseekApiKey || "").trim();
  const deepseekDetail = String(deepseekEntry?.effective?.detail || "").trim();
  const deepseekConfigured = Boolean(
    deepseekKey || deepseekDetail || (deepseekEntry?.effective && deepseekEntry.effective.kind !== "none"),
  );
  const providerAuth = {
    ...(baseAuth || {}),
    deepseek: {
      configured: deepseekConfigured,
      masked: deepseekKey ? maskSecret(deepseekKey) : deepseekDetail || "(未设置)",
      plain: deepseekKey,
      source: String(deepseekEntry?.effective?.kind || (deepseekConfigured ? "xbrain" : "-")),
      error: "",
      type: "apiKey",
    },
    chatgpt: {
      configured: Boolean(openaiEntry?.effective && openaiEntry.effective.kind !== "none")
        || Boolean(baseAuth?.chatgpt?.configured),
      masked: Boolean(openaiEntry?.effective && openaiEntry.effective.kind !== "none") || Boolean(baseAuth?.chatgpt?.configured)
        ? "oauth-connected"
        : "(未设置)",
      plain: "",
      source: String(openaiEntry?.effective?.kind || (baseAuth?.chatgpt?.configured ? "oauth" : "-")),
      error: "",
      type: "oauth",
    },
    anthropic: {
      configured: Boolean(anthropicEntry?.effective && anthropicEntry.effective.kind !== "none")
        || Boolean(baseAuth?.anthropic?.configured),
      masked: Boolean(anthropicEntry?.effective && anthropicEntry.effective.kind !== "none")
        || Boolean(baseAuth?.anthropic?.configured)
        ? "oauth-connected"
        : "(未设置)",
      plain: "",
      source: String(anthropicEntry?.effective?.kind || (baseAuth?.anthropic?.configured ? "oauth" : "-")),
      error: "",
      type: "oauth",
    },
  };
  for (const provider of xbrainStore.base.providerCatalog || []) {
    const key = normalizeProviderKey(provider);
    if (!providerAuth[key]) {
      const entry = getAuthProviderEntry(modelsJson, key);
      const configured = Boolean(entry?.effective && entry.effective.kind !== "none");
      providerAuth[key] = {
        configured,
        masked: configured ? String(entry?.effective?.detail || "configured") : "(未设置)",
        plain: "",
        source: String(entry?.effective?.kind || "-"),
        error: "",
        type: providerAuthType(key),
      };
    } else {
      providerAuth[key] = {
        configured: Boolean(providerAuth[key].configured),
        masked: String(providerAuth[key].masked || "(未设置)"),
        plain: String(providerAuth[key].plain || ""),
        source: String(providerAuth[key].source || "-"),
        error: String(providerAuth[key].error || ""),
        type: String(providerAuth[key].type || providerAuthType(key)),
      };
    }
  }
  xbrainStore.base.providerAuth = providerAuth;
  xbrainStore.base.telegramRelayEnabled = Boolean(xbrainStore.base.telegramRelayEnabled);
  xbrainStore.base.chatChannel = String(xbrainStore.base.chatChannel || "dashboard");
  saveXbrainStore();
  return { ok: true, modelsJson };
}

function getLocksSnapshot() {
  const out = {};
  for (const section of ["base", "channel", "exchange", "strategy"]) {
    const lockInfo = xbrainStore?.locks?.[section] || {};
    out[section] = {
      locked: Boolean(lockInfo.locked),
      hasPassword: Boolean(lockInfo.hasPassword),
    };
  }
  return out;
}

function getXbrainStateSnapshot() {
  const base = xbrainStore.base || {};
  const exchange = xbrainStore.exchange || {};
  const strategy = xbrainStore.strategy || {};
  const locks = getLocksSnapshot();
  const providerCatalog = sanitizeProviderCatalog(base.providerCatalog);
  const providerAuthRaw = base.providerAuth && typeof base.providerAuth === "object" ? base.providerAuth : {};
  const providerAuth = {};
  for (const [providerLike, metaLike] of Object.entries(providerAuthRaw)) {
    const providerKey = normalizeProviderKey(providerLike);
    const meta = metaLike && typeof metaLike === "object" ? metaLike : {};
    providerAuth[providerKey] = {
      configured: Boolean(meta.configured),
      masked: String(meta.masked || "(未设置)"),
      plain: String(meta.plain || ""),
      source: String(meta.source || "-"),
      error: String(meta.error || ""),
      type: String(meta.type || providerAuthType(providerKey)),
    };
  }
  const modelProvider = normalizeProviderKey(base.modelProvider || "deepseek");
  const modelId = String(base.modelId || "deepseek-chat");
  const runtimeProvider = normalizeProviderKey(base.runtimeModelProvider || modelProvider);
  const runtimeModelId = String(base.runtimeModelId || modelId);
  const configuredModelRef = toModelRef(modelProvider, modelId);
  const runtimeModelRef = toModelRef(runtimeProvider, runtimeModelId);
  const modelRegistry = uniqStrings(base.modelRegistry || [toModelRef(modelProvider, modelId)]);
  const telegramToken = String(base.telegramTokenValue || "").trim();
  const telegramConfigured = Boolean(telegramToken);
  if (!providerAuth.deepseek) {
    providerAuth.deepseek = {
      configured: Boolean(base.deepseekApiKey),
      masked: maskSecret(base.deepseekApiKey),
      plain: String(base.deepseekApiKey || ""),
      source: base.deepseekApiKey ? "xbrain" : "-",
      error: "",
      type: "apiKey",
    };
  }
  if (!providerAuth.chatgpt) {
    providerAuth.chatgpt = {
      configured: false,
      masked: "(未设置)",
      plain: "",
      source: "-",
      error: "",
      type: "oauth",
    };
  }
  if (!providerAuth.anthropic) {
    providerAuth.anthropic = {
      configured: false,
      masked: "(未设置)",
      plain: "",
      source: "-",
      error: "",
      type: "oauth",
    };
  }
  providerAuth.deepseek.masked = String(providerAuth.deepseek.masked || maskSecret(base.deepseekApiKey));
  providerAuth.deepseek.plain = String(providerAuth.deepseek.plain || base.deepseekApiKey || "");

  return {
    base: {
      modelProvider,
      modelId,
      modelRef: configuredModelRef,
      runtimeModelProvider: runtimeProvider,
      runtimeModelId,
      runtimeModelRef,
      providerCatalog,
      modelRegistry,
      providerAuth,
      modelAuthConfigured: Boolean(providerAuth?.[modelProvider]?.configured),
      modelAuthMasked: String(providerAuth?.[modelProvider]?.masked || "(未设置)"),
      modelAuthSource: String(providerAuth?.[modelProvider]?.source || "-"),
      modelAuthError: String(providerAuth?.[modelProvider]?.error || ""),
      telegramTokenValue: telegramToken,
      telegramTokenMasked: maskSecret(telegramToken),
      telegramConfigured,
      telegramRelayEnabled: Boolean(base.telegramRelayEnabled),
      chatChannel: String(base.chatChannel || "dashboard"),
    },
    exchange: {
      apiKeyMasked: maskSecret(exchange.apiKeyValue),
      apiSecretMasked: maskSecret(exchange.apiSecretValue),
      passphraseMasked: maskSecret(exchange.passphraseValue),
    },
    strategy: {
      profileName: String(strategy.profileName || "default"),
      activeStrategy: String(strategy.activeStrategy || strategy.profileName || "default"),
      symbol: String(strategy.symbol || "BTC/USDT:USDT"),
      leverage: Number.isFinite(Number(strategy.leverage)) ? Number(strategy.leverage) : 10,
      sizeMode: String(strategy.sizeMode || "risk"),
      orderSize: Number.isFinite(Number(strategy.orderSize)) ? Number(strategy.orderSize) : 8,
      riskPct: Number.isFinite(Number(strategy.riskPct)) ? Number(strategy.riskPct) : 0.015,
      minNotional: Number.isFinite(Number(strategy.minNotional)) ? Number(strategy.minNotional) : 5,
      maxNotional: Number.isFinite(Number(strategy.maxNotional)) ? Number(strategy.maxNotional) : 80,
      runtimeMode: String(strategy.runtimeMode || "dryrun") === "live" ? "live" : "dryrun",
    },
    locks,
  };
}

async function buildXbrainState(forceRefresh = false) {
  if (forceRefresh) {
    await syncXbrainFromOpenClaw();
  }
  return getXbrainStateSnapshot();
}

function getCurrentRuntimeModelRefFromStore() {
  const base = xbrainStore.base || {};
  const provider = base.runtimeModelProvider || base.modelProvider || "deepseek";
  const modelId = base.runtimeModelId || base.modelId || "";
  return toModelRef(provider, modelId);
}

function pickProviderModelRef(providerRaw) {
  const provider = normalizeProviderKey(providerRaw);
  const registry = uniqStrings(xbrainStore.base?.modelRegistry || []);
  const fromRegistry = registry.find((ref) => inferProviderFromModelRef(ref).provider === provider);
  if (fromRegistry) return fromRegistry;
  return toModelRef(provider, "");
}

function parseSlashCommandMessage(messageRaw) {
  const message = String(messageRaw || "").trim();
  if (!message.startsWith("/")) return { command: "", args: "", message };
  const firstSpace = message.indexOf(" ");
  if (firstSpace <= 0) {
    return { command: message.toLowerCase(), args: "", message };
  }
  return {
    command: message.slice(0, firstSpace).toLowerCase(),
    args: message.slice(firstSpace + 1).trim(),
    message,
  };
}

function isDigitsOnly(valueRaw) {
  const value = String(valueRaw || "").trim();
  if (!value) return false;
  for (const ch of value) {
    if (ch < "0" || ch > "9") return false;
  }
  return true;
}

function resolveModelRefCandidate(inputRaw, providerHintRaw = "") {
  const input = String(inputRaw || "").trim();
  if (!input) {
    if (providerHintRaw) return toModelRef(providerHintRaw, "");
    return "";
  }
  if (input.includes("/")) {
    return input.toLowerCase();
  }
  const normalized = input.toLowerCase();
  if (providerHintRaw) {
    const providerHint = normalizeProviderKey(providerHintRaw);
    if (normalized === providerHint) return pickProviderModelRef(providerHint);
    return toModelRef(providerHint, normalized);
  }
  for (const refRaw of uniqStrings([...(xbrainStore.base?.modelRegistry || []), ...Object.values(PROVIDER_DEFAULT_MODEL_REFS)])) {
    const ref = String(refRaw || "").trim();
    if (!ref) continue;
    const lower = ref.toLowerCase();
    const modelPart = lower.split("/").slice(1).join("/");
    if (normalized === lower || normalized === modelPart) return lower;
  }
  if (normalized === "deepseek") return pickProviderModelRef("deepseek");
  if (["chatgpt", "openai", "codex", "gpt"].includes(normalized)) return pickProviderModelRef("chatgpt");
  if (["anthropic", "claude"].includes(normalized)) return pickProviderModelRef("anthropic");
  if (normalized === "openrouter") return pickProviderModelRef("openrouter");
  if (["gemini", "google"].includes(normalized)) return pickProviderModelRef("gemini");
  if (["zai", "glm"].includes(normalized)) return pickProviderModelRef("zai");
  return "";
}

function parseSlashModelSwitchTarget(messageRaw) {
  const { command, args } = parseSlashCommandMessage(messageRaw);
  if (command !== "/model" && command !== "/models") return "";
  const arg = String(args || "").trim();
  if (!arg) return "";
  const lower = arg.toLowerCase();
  if (lower === "list" || lower === "status" || isDigitsOnly(arg)) return "";
  return resolveModelRefCandidate(arg);
}

function looksLikeModelSwitchFailureText(textRaw) {
  const text = String(textRaw || "").trim();
  if (!text) return false;
  if (/Model ".*" is not allowed/i.test(text)) return true;
  if (/unknown model|model not found|invalid model/i.test(text)) return true;
  if (/missing auth|no api key|authentication/i.test(text)) return true;
  if (/模型.*(未|不).*(允许|可用|配置|存在)/i.test(text)) return true;
  if (/切换失败|未知模型|未配置鉴权|鉴权失败/i.test(text)) return true;
  return false;
}

function applyModelRefToStore(modelRefRaw) {
  const modelRef = String(modelRefRaw || "").trim();
  if (!modelRef) return inferProviderFromModelRef("");
  const inferred = inferProviderFromModelRef(modelRef);
  xbrainStore.base.modelProvider = inferred.provider;
  xbrainStore.base.modelId = inferred.modelId;
  xbrainStore.base.runtimeModelProvider = inferred.provider;
  xbrainStore.base.runtimeModelId = inferred.modelId;
  xbrainStore.base.providerCatalog = sanitizeProviderCatalog([...(xbrainStore.base.providerCatalog || []), inferred.provider]);
  xbrainStore.base.modelRegistry = uniqStrings([...(xbrainStore.base.modelRegistry || []), modelRef]);
  saveXbrainStore();
  return inferred;
}

async function persistModelSelection(modelRefRaw, options = {}) {
  const modelRef = String(modelRefRaw || "").trim();
  const syncDefault = options?.syncDefault !== false;
  if (!modelRef) {
    return {
      ok: false,
      modelRef: "",
      inferred: inferProviderFromModelRef(""),
      defaultSync: { attempted: false, ok: null, error: "modelRef required" },
      state: getXbrainStateSnapshot(),
    };
  }
  const inferred = applyModelRefToStore(modelRef);
  const defaultSync = {
    attempted: syncDefault,
    ok: null,
    error: null,
  };
  if (syncDefault) {
    const setRes = await runOpenClawCommand(["models", "set", modelRef], { timeoutMs: 40_000 });
    defaultSync.ok = Boolean(setRes.ok);
    defaultSync.error = setRes.ok ? null : ((setRes.stderr || setRes.stdout || "").trim() || "models set failed");
    if (setRes.ok) {
      await syncXbrainFromOpenClaw();
    }
  }
  return {
    ok: true,
    modelRef,
    inferred,
    defaultSync,
    state: getXbrainStateSnapshot(),
  };
}

async function switchThunderSessionModel(params = {}) {
  const modelRef = String(params?.modelRef || "").trim();
  const sessionId = String(params?.sessionId || "thunderclaw-main").trim() || "thunderclaw-main";
  if (!modelRef) {
    return {
      ok: false,
      modelRef: "",
      sessionId,
      sessionSync: { ok: false, error: "modelRef is required", reply: "" },
      defaultSync: { attempted: false, ok: null, error: null },
      state: getXbrainStateSnapshot(),
    };
  }
  const message = `/model ${modelRef}`;
  const result = await runOpenClawCommand(
    ["agent", "--session-id", sessionId, "--message", message, "--json"],
    { timeoutMs: 180_000 },
  );
  const payload = parseJsonSafe(result.stdout);
  const reply = String(extractAgentReply(payload) || "").trim();
  const combinedErr = [result.stderr, result.stdout, reply].filter(Boolean).join("\n");
  const sessionOk = Boolean(result.ok) && !looksLikeModelSwitchFailureText(combinedErr);
  if (!sessionOk) {
    return {
      ok: false,
      modelRef,
      sessionId,
      sessionSync: {
        ok: false,
        error: (result.stderr || result.stdout || reply || "session /model failed").trim(),
        reply,
      },
      defaultSync: { attempted: false, ok: null, error: null },
      state: getXbrainStateSnapshot(),
    };
  }
  const persisted = await persistModelSelection(modelRef, { syncDefault: true });
  return {
    ok: true,
    modelRef,
    sessionId,
    sessionSync: { ok: true, error: null, reply },
    defaultSync: persisted.defaultSync,
    state: persisted.state,
    inferred: persisted.inferred,
  };
}

async function runAgentTurn(params) {
  const message = String(params?.message ?? "").trim();
  const sessionId = String(params?.sessionId ?? "thunderclaw-main").trim() || "thunderclaw-main";
  const thinking = String(params?.thinking ?? "").trim();
  const args = [
    "agent",
    "--session-id",
    sessionId,
    "--message",
    message,
    "--json",
  ];
  if (thinking) {
    args.push("--thinking", thinking);
  }
  const result = await runOpenClawCommand(args, { timeoutMs: 180_000 });
  const payload = parseJsonSafe(result.stdout);
  let reply = extractAgentReply(payload);
  if (!reply) {
    const errText = String(result.stderr || "").trim();
    const errLine = errText
      .split(/\r?\n/)
      .find((line) => /HTTP\s+\d{3}|authentication|api key|gateway closed/i.test(String(line || "")));
    if (errLine) {
      reply = errLine;
    }
  }
  if (!reply) {
    reply = "收到，但暂时没有可返回内容。";
  }
  const slashModelRef = parseSlashModelSwitchTarget(message);
  let modelSwitch = null;
  if (slashModelRef && result.ok && !looksLikeModelSwitchFailureText(`${reply}\n${result.stderr || ""}`)) {
    modelSwitch = await persistModelSelection(slashModelRef, { syncDefault: true });
  }
  const runtimeModelRef = getCurrentRuntimeModelRefFromStore();
  return {
    result,
    payload,
    reply,
    sessionId,
    runtimeModelRef,
    modelRefUsed: runtimeModelRef,
    modelSwitch,
  };
}

function parseConfigIntent(messageRaw) {
  const message = String(messageRaw || "").trim();
  if (!message) return null;
  const { command, args } = parseSlashCommandMessage(message);
  if (!command) return null;
  if (command === "/xbrain" || command === "/xbrain-open" || command === "/onboard") {
    return { type: "open_xbrain" };
  }
  if (command === "/model" || command === "/models") {
    const modelRef = parseSlashModelSwitchTarget(message);
    if (!modelRef) return null;
    return { type: "switch_model", modelRef };
  }
  if (command === "/deepseek") {
    const token = String(args || "").split(/\s+/).find((part) => String(part).startsWith("sk-")) || "";
    if (!token) return { type: "deepseek_help" };
    return { type: "deepseek_key", key: token };
  }
  if (command === "/telegram") {
    const token = String(args || "").trim();
    if (!token) return { type: "telegram_help" };
    return { type: "telegram_token", token };
  }
  if (command === "/oauth" || command === "/openai" || command === "/chatgpt" || command === "/codex-login") {
    const providerText = String(args || "").trim().toLowerCase();
    if (providerText.includes("anthropic") || providerText.includes("claude")) {
      return { type: "oauth", provider: "anthropic" };
    }
    return { type: "oauth", provider: "chatgpt" };
  }
  if (command === "/anthropic" || command === "/claude-login") {
    return { type: "oauth", provider: "anthropic" };
  }
  return null;
}

async function handleSetup(req, res) {
  const body = await readJsonBody(req);
  const outcome = await runSetupFromInput(body);
  sendJson(res, outcome.statusCode, outcome);
}

async function handleQuickSetup(req, res) {
  const body = await readJsonBody(req);
  const provider = String(body.provider ?? "deepseek-api-key").trim() || "deepseek-api-key";
  const setup = await runSetupFromInput({
    provider,
    apiKey: body.apiKey,
    gatewayPort: 18789,
    gatewayAuth: "token",
  });
  if (!setup.ok) {
    sendJson(res, setup.statusCode, {
      ok: false,
      stage: "setup",
      provider,
      error: setup.error ?? "setup failed",
      command: setup.command,
      stdout: setup.stdout,
      stderr: setup.stderr,
    });
    return;
  }

  let modelSetResult = null;
  let deepseekTune = null;
  if (provider === "deepseek-api-key") {
    const tuneContext = await runOpenClawCommand(
      [
        "config",
        "set",
        "models.providers.deepseek.models[0].contextWindow",
        "128000",
        "--strict-json",
      ],
      { timeoutMs: 30_000 },
    );
    const tuneMaxTokens = await runOpenClawCommand(
      [
        "config",
        "set",
        "models.providers.deepseek.models[0].maxTokens",
        "8192",
        "--strict-json",
      ],
      { timeoutMs: 30_000 },
    );
    deepseekTune = {
      contextWindowOk: tuneContext.ok,
      maxTokensOk: tuneMaxTokens.ok,
      error: [
        tuneContext.ok ? "" : (tuneContext.stderr || tuneContext.stdout || "").trim(),
        tuneMaxTokens.ok ? "" : (tuneMaxTokens.stderr || tuneMaxTokens.stdout || "").trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    };
    modelSetResult = await runOpenClawCommand(["models", "set", "deepseek/deepseek-chat"], {
      timeoutMs: 40_000,
    });
  }

  const healthBeforeStart = await waitGatewayHealthy({ timeoutMs: 5_000, pollMs: 800 });
  const gatewayStart = healthBeforeStart.ok
    ? {
        started: false,
        message: "Gateway already healthy",
        pid: gatewayState.pid ?? null,
      }
    : startGateway();
  const gatewayHealth = healthBeforeStart.ok
    ? healthBeforeStart
    : await waitGatewayHealthy({ timeoutMs: 25_000, pollMs: 1_500 });
  const gatewayWarning = !gatewayHealth.ok;

  sendJson(res, 200, {
    ok: true,
    stage: gatewayWarning ? "ready_with_gateway_warning" : "ready",
    provider,
    configured: true,
    gateway: {
      started: gatewayStart.started,
      message: gatewayStart.message,
      pid: gatewayStart.pid ?? null,
      healthy: gatewayHealth.ok,
      error: gatewayHealth.ok ? null : gatewayHealth.error,
      warning: gatewayWarning
        ? "Gateway 未就绪（不影响基础登录与页面对话，可稍后在状态页排查）。"
        : null,
    },
    model: modelSetResult
      ? {
          attempted: true,
          ok: modelSetResult.ok,
          stderr: modelSetResult.ok ? null : (modelSetResult.stderr || modelSetResult.stdout || "").trim(),
        }
      : { attempted: false, ok: null, stderr: null },
    deepseekTune,
    next: gatewayWarning
      ? "基础配置已完成。Gateway 当前未就绪，但不影响在页面内继续对话；可稍后再排查 Gateway。"
      : "基础配置已完成，直接在下方聊天区发送消息即可。",
  });
}

async function handleOAuthStart(req, res) {
  const body = await readJsonBody(req);
  const provider = String(body.provider ?? "openai-codex").trim().toLowerCase();
  const outcome = startOAuthLogin(provider);
  sendJson(res, outcome.ok ? 200 : 400, outcome);
}

async function handleOAuthStatus(req, res) {
  sendJson(res, 200, { ok: true, ...getOauthStatus() });
}

async function handleSetModel(req, res) {
  const body = await readJsonBody(req);
  const model = String(body.model ?? "").trim();
  if (!model) {
    sendJson(res, 400, { ok: false, error: "model is required" });
    return;
  }
  const result = await runOpenClawCommand(["models", "set", model], { timeoutMs: 30_000 });
  sendJson(res, result.ok ? 200 : 500, {
    ok: result.ok,
    exitCode: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
  });
}

async function handleChat(req, res) {
  const body = await readJsonBody(req);
  const message = String(body.message ?? "").trim();
  const sessionId = String(body.sessionId ?? "thunderclaw-main").trim() || "thunderclaw-main";
  const thinking = String(body.thinking ?? "").trim();

  if (!message) {
    sendJson(res, 400, { ok: false, error: "message is required" });
    return;
  }

  const { result, payload, reply } = await runAgentTurn({ message, sessionId, thinking });

  appendChatEvent({
    role: "user",
    source: "dashboard",
    text: message,
  });
  if (reply) {
    appendChatEvent({
      role: "bot",
      source: "dashboard",
      text: reply,
    });
  }

  sendJson(res, result.ok ? 200 : 500, {
    ok: result.ok,
    exitCode: result.code,
    timedOut: result.timedOut,
    reply,
    payload,
    stdout: result.stdout,
    stderr: result.stderr,
  });
}

async function handleAiChat(req, res) {
  const body = await readJsonBody(req);
  const message = String(body.message ?? "").trim();
  if (!message) {
    sendJson(res, 400, { ok: false, error: "message is required" });
    return;
  }
  appendChatEvent({
    role: "user",
    source: "dashboard",
    text: message,
  });
  const turn = await runAgentTurn({
    message,
    sessionId: "thunderclaw-main",
    thinking: "medium",
  });
  const {
    result,
    reply,
    sessionId,
    runtimeModelRef,
    modelRefUsed,
  } = turn;
  if (reply) {
    appendChatEvent({
      role: "bot",
      source: "dashboard",
      text: reply,
    });
  }
  const state = getXbrainStateSnapshot();
  const activeModelRef = String(modelRefUsed || runtimeModelRef || getCurrentRuntimeModelRefFromStore()).trim();
  if (!result.ok) {
    sendJson(res, 500, {
      ok: false,
      error: (result.stderr || result.stdout || "").trim() || "openclaw chat failed",
      reply: "",
      source: "openclaw",
      actions: [],
      executionTrace: [],
      state,
      modelRefUsed: activeModelRef,
      runtimeModelRef: activeModelRef,
      sessionIdUsed: sessionId || "thunderclaw-main",
    });
    return;
  }
  sendJson(res, 200, {
    ok: true,
    reply: String(reply || "").trim(),
    source: "openclaw",
    actions: [],
    executionTrace: [],
    state,
    modelRefUsed: activeModelRef,
    runtimeModelRef: activeModelRef,
    sessionIdUsed: sessionId || "thunderclaw-main",
  });
}

async function handleConfigChat(req, res) {
  const body = await readJsonBody(req);
  const message = String(body.message ?? "").trim();
  if (!message) {
    sendJson(res, 400, { ok: false, error: "message is required" });
    return;
  }
  const intent = parseConfigIntent(message);
  if (!intent) {
    sendJson(res, 200, { ok: true, handled: false, reply: "" });
    return;
  }

  if (intent.type === "switch_model") {
    appendChatEvent({ role: "user", source: "dashboard", text: message });
    const requestedRef = resolveModelRefCandidate(intent.modelRef || message);
    if (!requestedRef) {
      const reply = "未识别到可切换模型。请使用 provider/model（例如 openai-codex/gpt-5.3-codex）。";
      appendChatEvent({ role: "bot", source: "system", text: reply });
      sendJson(res, 200, {
        ok: true,
        handled: true,
        reply,
        state: getXbrainStateSnapshot(),
      });
      return;
    }
    const registry = new Set(uniqStrings(xbrainStore.base?.modelRegistry || []).map((v) => String(v).toLowerCase()));
    if (!registry.has(requestedRef.toLowerCase())) {
      const reply = `模型未注册：${requestedRef}。请先在「虾脑-模型注册中心」完成注册。`;
      appendChatEvent({ role: "bot", source: "system", text: reply });
      sendJson(res, 200, {
        ok: true,
        handled: true,
        reply,
        state: getXbrainStateSnapshot(),
      });
      return;
    }
    const switched = await switchThunderSessionModel({
      modelRef: requestedRef,
      sessionId: "thunderclaw-main",
    });
    if (!switched.ok) {
      const switchErr = String(switched?.sessionSync?.error || switched?.defaultSync?.error || "unknown").trim();
      const reply = `模型切换失败：${switchErr || "unknown"}`;
      appendChatEvent({ role: "bot", source: "system", text: reply });
      sendJson(res, 200, {
        ok: true,
        handled: true,
        reply,
        state: switched.state || getXbrainStateSnapshot(),
        modelRefUsed: getCurrentRuntimeModelRefFromStore(),
        runtimeModelRef: getCurrentRuntimeModelRefFromStore(),
        sessionIdUsed: "thunderclaw-main",
        openclawModelSync: {
          ok: false,
          error: switchErr || "session /model failed",
        },
      });
      return;
    }
    const activeModelRef = getCurrentRuntimeModelRefFromStore();
    const reply = `模型已切换并生效：${activeModelRef}`;
    appendChatEvent({ role: "bot", source: "system", text: reply });
    sendJson(res, 200, {
      ok: true,
      handled: true,
      reply,
      state: switched.state || getXbrainStateSnapshot(),
      modelRefUsed: activeModelRef,
      runtimeModelRef: activeModelRef,
      sessionIdUsed: "thunderclaw-main",
      openclawModelSync: {
        ok: true,
        error: null,
        session: switched.sessionSync,
        default: switched.defaultSync,
      },
    });
    return;
  }

  if (intent.type === "deepseek_help") {
    appendChatEvent({ role: "user", source: "dashboard", text: message });
    const reply = "请使用：/deepseek sk-你的apikey";
    appendChatEvent({ role: "bot", source: "system", text: reply });
    sendJson(res, 200, { ok: true, handled: true, reply, state: getXbrainStateSnapshot() });
    return;
  }

  if (intent.type === "telegram_help") {
    appendChatEvent({ role: "user", source: "dashboard", text: message });
    const reply = "请使用：/telegram <bot_token>（例如 123456:ABC...）";
    appendChatEvent({ role: "bot", source: "system", text: reply });
    sendJson(res, 200, { ok: true, handled: true, reply, state: getXbrainStateSnapshot() });
    return;
  }

  if (intent.type === "open_xbrain") {
    appendChatEvent({ role: "user", source: "dashboard", text: message });
    appendChatEvent({
      role: "bot",
      source: "system",
      text: "请进入「虾脑」页面使用内置快速登录引导（DeepSeek 一键登录 / OpenAI OAuth）。",
    });
    sendJson(res, 200, {
      ok: true,
      handled: true,
      reply: "请进入「虾脑」页面使用内置快速登录引导（DeepSeek 一键登录 / OpenAI OAuth）。",
    });
    return;
  }

  if (intent.type === "deepseek_key") {
    appendChatEvent({ role: "user", source: "dashboard", text: message });
    xbrainStore.base.deepseekApiKey = intent.key;
    xbrainStore.base.providerAuth = xbrainStore.base.providerAuth || {};
    xbrainStore.base.providerAuth.deepseek = {
      configured: true,
      masked: maskSecret(intent.key),
      plain: intent.key,
      source: "chat_config",
      error: "",
      type: "apiKey",
    };
    saveXbrainStore();
    const setup = await runSetupFromInput({
      provider: "deepseek-api-key",
      apiKey: intent.key,
      gatewayPort: 18789,
      gatewayAuth: "token",
    });
    if (setup.ok) {
      await runOpenClawCommand(
        ["config", "set", "models.providers.deepseek.models[0].contextWindow", "128000", "--strict-json"],
        { timeoutMs: 30_000 },
      );
      await runOpenClawCommand(
        ["config", "set", "models.providers.deepseek.models[0].maxTokens", "8192", "--strict-json"],
        { timeoutMs: 30_000 },
      );
      await runOpenClawCommand(["models", "set", "deepseek/deepseek-chat"], { timeoutMs: 40_000 });
      await syncXbrainFromOpenClaw();
      const reply = "DeepSeek Key 已保存并完成基础配置。现在可以直接开始对话。";
      appendChatEvent({ role: "bot", source: "system", text: reply });
      sendJson(res, 200, { ok: true, handled: true, reply });
      return;
    }
    const err = setup.error || setup.stderr || setup.stdout || "DeepSeek 配置失败";
    const reply = `DeepSeek 配置失败：${String(err).trim()}`;
    appendChatEvent({ role: "bot", source: "system", text: reply });
    sendJson(res, 200, { ok: true, handled: true, reply });
    return;
  }

  if (intent.type === "telegram_token") {
    appendChatEvent({ role: "user", source: "dashboard", text: message });
    xbrainStore.base.telegramTokenValue = intent.token;
    xbrainStore.base.telegramRelayEnabled = true;
    saveXbrainStore();
    const reply = "Telegram Token 已保存，可在虾脑中继续测试与开关控制。";
    appendChatEvent({ role: "bot", source: "system", text: reply });
    sendJson(res, 200, { ok: true, handled: true, reply });
    return;
  }

  if (intent.type === "oauth") {
    appendChatEvent({ role: "user", source: "dashboard", text: message });
    if (intent.provider === "anthropic") {
      const reply = "Anthropic 目前建议在终端执行：openclaw models auth setup-token --provider anthropic --yes";
      appendChatEvent({ role: "bot", source: "system", text: reply });
      sendJson(res, 200, { ok: true, handled: true, reply });
      return;
    }
    const oauth = startOAuthLogin("openai-codex");
    const reply = oauth.ok
      ? "已发起 OpenAI(Codex) 登录流程，请在启动 thunderclaw 的终端完成授权。"
      : `无法发起 OAuth：${String(oauth.error || "unknown")}`;
    appendChatEvent({ role: "bot", source: "system", text: reply });
    sendJson(res, 200, { ok: true, handled: true, reply });
    return;
  }

  sendJson(res, 200, { ok: true, handled: false, reply: "" });
}

async function handleAiHealth(req, res) {
  const healthRes = await runOpenClawCommand(["gateway", "health", "--json"], { timeoutMs: 8_000 });
  const payload = parseJsonSafe(healthRes.stdout);
  const modelsRes = await runOpenClawCommand(["models", "status", "--json"], { timeoutMs: 10_000 });
  const modelsJson = parseJsonSafe(modelsRes.stdout);
  const modelReady = Boolean(
    modelsRes.ok
      && String(modelsJson?.resolvedDefault || modelsJson?.defaultModel || "").trim(),
  );
  const gatewayHealthy = Boolean(healthRes.ok);
  const fallbackMode = !gatewayHealthy && modelReady;
  sendJson(res, 200, {
    ok: gatewayHealthy || modelReady,
    healthy: gatewayHealthy,
    gatewayHealthy,
    modelReady,
    fallbackMode,
    health: payload,
    error: healthRes.ok ? null : (healthRes.stderr || healthRes.stdout || "").trim() || null,
  });
}

function parsePositiveInt(raw, fallback, max) {
  const n = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  if (Number.isFinite(max)) return Math.min(n, max);
  return n;
}

async function handleChatHistory(req, res) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const afterId = parsePositiveInt(url.searchParams.get("afterId"), 0, 10_000_000);
  const limit = parsePositiveInt(url.searchParams.get("limit"), 220, 1_000);
  const events = (chatHistory.events || [])
    .filter((ev) => Number(ev.id) > afterId)
    .slice(0, Math.max(1, limit));
  sendJson(res, 200, {
    ok: true,
    events,
  });
}

async function handleXbrainState(req, res) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const refresh = String(url.searchParams.get("refresh") || "0") === "1";
  const state = await buildXbrainState(refresh);
  sendJson(res, 200, { ok: true, state });
}

async function handleXbrainUpdate(req, res) {
  const body = await readJsonBody(req);
  const section = String(body.section || "").trim();
  const values = body.values && typeof body.values === "object" ? body.values : {};

  if (section === "base") {
    if (Array.isArray(values.providerCatalog)) {
      xbrainStore.base.providerCatalog = sanitizeProviderCatalog(values.providerCatalog);
    }
    if (Array.isArray(values.modelRegistry)) {
      xbrainStore.base.modelRegistry = uniqStrings(values.modelRegistry);
    }
    if (typeof values.deepseekApiKey === "string" && values.deepseekApiKey.trim()) {
      const key = String(values.deepseekApiKey).trim();
      xbrainStore.base.deepseekApiKey = key;
      xbrainStore.base.providerAuth = xbrainStore.base.providerAuth || {};
      xbrainStore.base.providerAuth.deepseek = {
        configured: true,
        masked: maskSecret(key),
        plain: key,
        source: "xbrain",
        error: "",
        type: "apiKey",
      };
      const setup = await runSetupFromInput({
        provider: "deepseek-api-key",
        apiKey: key,
        gatewayPort: 18789,
        gatewayAuth: "token",
      });
      if (setup.ok) {
        await runOpenClawCommand(
          ["config", "set", "models.providers.deepseek.models[0].contextWindow", "128000", "--strict-json"],
          { timeoutMs: 30_000 },
        );
        await runOpenClawCommand(
          ["config", "set", "models.providers.deepseek.models[0].maxTokens", "8192", "--strict-json"],
          { timeoutMs: 30_000 },
        );
        await runOpenClawCommand(["models", "set", "deepseek/deepseek-chat"], { timeoutMs: 30_000 });
      }
    }
    if (typeof values.telegramRelayEnabled === "boolean") {
      xbrainStore.base.telegramRelayEnabled = Boolean(values.telegramRelayEnabled);
    }
    if (typeof values.chatChannel === "string" && values.chatChannel.trim()) {
      xbrainStore.base.chatChannel = values.chatChannel.trim();
    }
    if (typeof values.telegramToken === "string" && values.telegramToken.trim()) {
      xbrainStore.base.telegramTokenValue = values.telegramToken.trim();
    }
  } else if (section === "channel") {
    if (typeof values.telegramRelayEnabled === "boolean") {
      xbrainStore.base.telegramRelayEnabled = Boolean(values.telegramRelayEnabled);
    }
    if (typeof values.telegramToken === "string" && values.telegramToken.trim()) {
      xbrainStore.base.telegramTokenValue = values.telegramToken.trim();
    }
    if (typeof values.chatChannel === "string" && values.chatChannel.trim()) {
      xbrainStore.base.chatChannel = values.chatChannel.trim();
    }
  } else if (section === "exchange") {
    if (typeof values.apiKey === "string" && values.apiKey.trim()) {
      xbrainStore.exchange.apiKeyValue = values.apiKey.trim();
    }
    if (typeof values.apiSecret === "string" && values.apiSecret.trim()) {
      xbrainStore.exchange.apiSecretValue = values.apiSecret.trim();
    }
    if (typeof values.apiPassphrase === "string" && values.apiPassphrase.trim()) {
      xbrainStore.exchange.passphraseValue = values.apiPassphrase.trim();
    }
  } else if (section === "strategy") {
    xbrainStore.strategy = {
      ...xbrainStore.strategy,
      ...values,
      leverage: Number.isFinite(Number(values.leverage))
        ? Number(values.leverage)
        : Number(xbrainStore.strategy.leverage || 10),
      orderSize: Number.isFinite(Number(values.orderSize))
        ? Number(values.orderSize)
        : Number(xbrainStore.strategy.orderSize || 8),
      riskPct: Number.isFinite(Number(values.riskPct))
        ? Number(values.riskPct)
        : Number(xbrainStore.strategy.riskPct || 0.015),
      minNotional: Number.isFinite(Number(values.minNotional))
        ? Number(values.minNotional)
        : Number(xbrainStore.strategy.minNotional || 5),
      maxNotional: Number.isFinite(Number(values.maxNotional))
        ? Number(values.maxNotional)
        : Number(xbrainStore.strategy.maxNotional || 80),
      runtimeMode: String(values.runtimeMode || xbrainStore.strategy.runtimeMode || "dryrun") === "live"
        ? "live"
        : "dryrun",
    };
  }

  saveXbrainStore();
  await syncXbrainFromOpenClaw();
  sendJson(res, 200, {
    ok: true,
    state: getXbrainStateSnapshot(),
  });
}

async function handleXbrainModelSwitch(req, res) {
  const body = await readJsonBody(req);
  const modelRefInput = String(body.modelId || body.modelRef || "").trim();
  const provider = normalizeProviderKey(body.modelProvider || xbrainStore.base?.modelProvider || "");
  const modelRef = resolveModelRefCandidate(modelRefInput, provider);
  if (!modelRef) {
    sendJson(res, 400, { ok: false, error: "model is required" });
    return;
  }
  const switched = await switchThunderSessionModel({
    modelRef,
    sessionId: "thunderclaw-main",
  });
  if (!switched.ok) {
    const switchErr = String(switched?.sessionSync?.error || switched?.defaultSync?.error || "session /model failed").trim();
    sendJson(res, 400, {
      ok: false,
      error: switchErr || "session /model failed",
      state: switched.state || getXbrainStateSnapshot(),
      openclawModelSync: {
        ok: false,
        error: switchErr || "session /model failed",
        session: switched.sessionSync,
        default: switched.defaultSync,
      },
    });
    return;
  }
  const runtimeModelRef = getCurrentRuntimeModelRefFromStore();
  sendJson(res, 200, {
    ok: true,
    state: switched.state || getXbrainStateSnapshot(),
    modelRefUsed: runtimeModelRef,
    runtimeModelRef,
    sessionIdUsed: "thunderclaw-main",
    openclawModelSync: {
      ok: true,
      error: null,
      session: switched.sessionSync,
      default: switched.defaultSync,
    },
  });
}

async function handleXbrainModelsCatalog(req, res) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const refresh = String(url.searchParams.get("refresh") || "0") === "1";
  const catalog = await listOpenClawModelsCatalog(refresh);
  if (!catalog.ok) {
    sendJson(res, 500, { ok: false, error: catalog.error || "获取模型目录失败" });
    return;
  }
  const providers = sanitizeProviderCatalog([
    ...(xbrainStore.base.providerCatalog || []),
    ...catalog.all.map((item) => item.provider),
  ]);
  const authSupport = {};
  for (const provider of providers) {
    authSupport[provider] = {
      apiKey: providerSupportsApiKey(provider),
      oauth: providerSupportsOAuth(provider),
    };
  }
  sendJson(res, 200, {
    ok: true,
    updatedAt: catalog.updatedAt,
    cached: catalog.cached,
    count: catalog.all.length,
    providers,
    authSupport,
    catalog: catalog.all,
    configured: catalog.configured,
    connected: uniqStrings(xbrainStore.base.modelRegistry || []),
  });
}

async function handleXbrainModelConnect(req, res) {
  const body = await readJsonBody(req);
  const providerInput = normalizeProviderKey(body.provider || body.modelProvider || xbrainStore.base.modelProvider);
  const modelInput = String(body.model || body.modelRef || body.modelId || "").trim();
  const modelRef = modelInput
    ? (modelInput.includes("/") ? modelInput : toModelRef(providerInput, modelInput))
    : toModelRef(providerInput, "");
  if (!modelRef) {
    sendJson(res, 400, { ok: false, error: "model is required" });
    return;
  }

  const inferred = inferProviderFromModelRef(modelRef);
  const provider = inferred.provider;
  const apiKey = String(body.apiKey || "").trim();
  let authMethod = String(body.authMethod || "").trim().toLowerCase();
  if (authMethod === "apikey") authMethod = "api-key";
  if (authMethod === "register-only") authMethod = "register";
  if (!authMethod) {
    if (providerSupportsApiKey(provider) && apiKey) authMethod = "api-key";
    else if (providerSupportsOAuth(provider) && !providerSupportsApiKey(provider)) authMethod = "oauth";
    else authMethod = "register";
  }
  if (!["api-key", "oauth", "register"].includes(authMethod)) {
    sendJson(res, 400, { ok: false, error: "invalid authMethod" });
    return;
  }

  let setupInfo = null;
  let oauthInfo = null;
  if (authMethod === "api-key") {
    const setupProvider = PROVIDER_TO_SETUP_PROVIDER[provider];
    if (!setupProvider) {
      sendJson(res, 400, { ok: false, error: `provider ${provider} does not support API key connect in xbrain` });
      return;
    }
    if (!apiKey) {
      sendJson(res, 400, { ok: false, error: "apiKey is required for api-key connect" });
      return;
    }
    const setup = await runSetupFromInput({
      provider: setupProvider,
      apiKey,
      gatewayPort: 18789,
      gatewayAuth: "token",
    });
    if (!setup.ok) {
      sendJson(res, setup.statusCode || 500, {
        ok: false,
        stage: "setup",
        error: setup.error || setup.stderr || setup.stdout || "模型连接失败",
      });
      return;
    }
    let deepseekTune = null;
    if (setupProvider === "deepseek-api-key") {
      deepseekTune = await tuneDeepseekDefaults();
      xbrainStore.base.deepseekApiKey = apiKey;
    }
    ensureProviderAuthEntry(provider, {
      configured: true,
      masked: maskSecret(apiKey),
      plain: apiKey,
      source: "xbrain_connect",
      error: "",
      type: "apiKey",
    });
    setupInfo = {
      ok: true,
      provider: setupProvider,
      deepseekTune,
    };
  } else if (authMethod === "oauth") {
    const oauthProvider = PROVIDER_TO_OAUTH_PROVIDER[provider];
    if (!oauthProvider) {
      sendJson(res, 400, { ok: false, error: `provider ${provider} does not support oauth connect in xbrain` });
      return;
    }
    const outcome = startOAuthLogin(oauthProvider);
    if (!outcome.ok) {
      sendJson(res, 400, outcome);
      return;
    }
    const current = xbrainStore.base.providerAuth?.[provider];
    const configured = Boolean(current?.configured);
    ensureProviderAuthEntry(provider, {
      configured,
      masked: configured ? "oauth-connected" : "等待授权",
      plain: "",
      source: configured ? String(current?.source || "oauth") : "oauth_pending",
      error: "",
      type: "oauth",
    });
    oauthInfo = outcome;
  } else {
    ensureProviderAuthEntry(provider, {
      source: "model_registry",
      type: providerAuthType(provider),
    });
  }

  xbrainStore.base.providerCatalog = sanitizeProviderCatalog([...(xbrainStore.base.providerCatalog || []), provider]);
  xbrainStore.base.modelRegistry = uniqStrings([...(xbrainStore.base.modelRegistry || []), modelRef]);

  const setRes = await runOpenClawCommand(["models", "set", modelRef], { timeoutMs: 40_000 });
  const setErr = setRes.ok ? null : ((setRes.stderr || setRes.stdout || "").trim() || "models set failed");
  if (setRes.ok) {
    xbrainStore.base.modelProvider = inferred.provider;
    xbrainStore.base.modelId = inferred.modelId;
    xbrainStore.base.runtimeModelProvider = inferred.provider;
    xbrainStore.base.runtimeModelId = inferred.modelId;
  }

  saveXbrainStore();
  await syncXbrainFromOpenClaw();
  sendJson(res, 200, {
    ok: true,
    provider,
    modelRef,
    authMethod,
    setup: setupInfo,
    oauth: oauthInfo,
    modelSet: {
      ok: setRes.ok,
      error: setErr,
    },
    state: getXbrainStateSnapshot(),
    message: setRes.ok
      ? "模型已连接并注册到 ThunderClaw 切换列表。"
      : (authMethod === "oauth"
        ? "OAuth 已发起，模型已注册；完成授权后可在顶部模型切换器切换。"
        : "模型已注册到切换列表，但当前默认模型切换失败。"),
  });
}

async function handleXbrainModelDisconnect(req, res) {
  const body = await readJsonBody(req);
  const modelInput = String(body.model || body.modelRef || body.modelId || "").trim();
  if (!modelInput) {
    sendJson(res, 400, { ok: false, error: "model is required" });
    return;
  }
  const modelRef = modelInput.includes("/")
    ? modelInput
    : toModelRef(body.provider || xbrainStore.base.modelProvider, modelInput);
  const currentRegistry = uniqStrings(xbrainStore.base.modelRegistry || []);
  const nextRegistry = currentRegistry.filter((item) => item !== modelRef);
  if (nextRegistry.length === currentRegistry.length) {
    sendJson(res, 200, { ok: true, removed: false, state: getXbrainStateSnapshot() });
    return;
  }

  let fallbackInserted = false;
  if (!nextRegistry.length) {
    nextRegistry.push(PROVIDER_DEFAULT_MODEL_REFS.deepseek);
    fallbackInserted = true;
  }
  xbrainStore.base.modelRegistry = uniqStrings(nextRegistry);

  const currentModelRef = toModelRef(xbrainStore.base.modelProvider, xbrainStore.base.modelId);
  let switched = null;
  if (!xbrainStore.base.modelRegistry.includes(currentModelRef) || currentModelRef === modelRef) {
    const fallbackRef = xbrainStore.base.modelRegistry[0];
    const inferred = inferProviderFromModelRef(fallbackRef);
    const setRes = await runOpenClawCommand(["models", "set", fallbackRef], { timeoutMs: 40_000 });
    xbrainStore.base.modelProvider = inferred.provider;
    xbrainStore.base.modelId = inferred.modelId;
    xbrainStore.base.runtimeModelProvider = inferred.provider;
    xbrainStore.base.runtimeModelId = inferred.modelId;
    switched = {
      ok: setRes.ok,
      modelRef: fallbackRef,
      error: setRes.ok ? null : (setRes.stderr || setRes.stdout || "").trim() || "models set failed",
    };
  }

  saveXbrainStore();
  await syncXbrainFromOpenClaw();
  sendJson(res, 200, {
    ok: true,
    removed: true,
    modelRef,
    fallbackInserted,
    switched,
    state: getXbrainStateSnapshot(),
  });
}

async function handleXbrainAuthStart(req, res) {
  const body = await readJsonBody(req);
  const provider = normalizeProviderKey(body.provider || "chatgpt");
  if (provider === "anthropic") {
    sendJson(res, 400, {
      ok: false,
      error: "Anthropic token flow: please run `openclaw models auth setup-token --provider anthropic --yes`",
    });
    return;
  }
  const oauthProvider = PROVIDER_TO_OAUTH_PROVIDER[provider];
  if (!oauthProvider) {
    sendJson(res, 400, {
      ok: false,
      error: `provider ${provider} does not support oauth login`,
    });
    return;
  }
  const outcome = startOAuthLogin(oauthProvider);
  sendJson(res, outcome.ok ? 200 : 400, outcome);
}

async function handleXbrainAuthStatus(req, res) {
  const status = getOauthStatus();
  sendJson(res, 200, {
    ok: true,
    status: {
      running: Boolean(status.running),
      provider: normalizeProviderKey(status.provider),
      phase: status.running ? "running" : "idle",
      url: "",
      exitCode: status?.last?.code ?? null,
      error: status?.last?.error ?? null,
      startedAt: status.startedAt ?? null,
    },
  });
}

async function handleXbrainAuthDisconnect(req, res) {
  const body = await readJsonBody(req);
  const provider = normalizeProviderKey(body.provider || "chatgpt");
  xbrainStore.base.providerAuth = xbrainStore.base.providerAuth || {};
  const current = xbrainStore.base.providerAuth[provider] || {};
  xbrainStore.base.providerAuth[provider] = {
    ...current,
    configured: false,
    masked: "(未设置)",
    plain: "",
    source: "manual_disconnect",
    error: "",
    type: providerAuthType(provider),
  };
  if (provider === "deepseek") {
    xbrainStore.base.deepseekApiKey = "";
  }
  saveXbrainStore();
  sendJson(res, 200, { ok: true, state: getXbrainStateSnapshot() });
}

async function handleXbrainProviderRemove(req, res) {
  const body = await readJsonBody(req);
  const provider = normalizeProviderKey(body.provider || "");
  const nextCatalog = sanitizeProviderCatalog((xbrainStore.base.providerCatalog || []).filter((p) => p !== provider));
  if (!nextCatalog.length) {
    sendJson(res, 400, { ok: false, error: "at least one provider is required" });
    return;
  }
  xbrainStore.base.providerCatalog = nextCatalog;
  xbrainStore.base.modelRegistry = uniqStrings((xbrainStore.base.modelRegistry || []).filter((ref) => {
    return inferProviderFromModelRef(ref).provider !== provider;
  }));
  xbrainStore.base.providerAuth = xbrainStore.base.providerAuth || {};
  delete xbrainStore.base.providerAuth[provider];
  if (provider === "deepseek") {
    xbrainStore.base.deepseekApiKey = "";
  }
  if (!nextCatalog.includes(normalizeProviderKey(xbrainStore.base.modelProvider))) {
    const fallback = nextCatalog[0];
    xbrainStore.base.modelProvider = fallback;
    xbrainStore.base.runtimeModelProvider = fallback;
    const fallbackRef = toModelRef(fallback, "");
    const inferred = inferProviderFromModelRef(fallbackRef);
    xbrainStore.base.modelId = inferred.modelId;
    xbrainStore.base.runtimeModelId = inferred.modelId;
  }
  saveXbrainStore();
  sendJson(res, 200, { ok: true, state: getXbrainStateSnapshot() });
}

async function handleXbrainLock(req, res) {
  const body = await readJsonBody(req);
  const section = String(body.section || "").trim();
  const action = String(body.action || "").trim();
  if (!["base", "channel", "exchange", "strategy"].includes(section)) {
    sendJson(res, 400, { ok: false, error: "invalid section" });
    return;
  }
  const lockInfo = xbrainStore.locks[section] || { locked: false, hasPassword: false, password: "" };
  const pass = String(body.password || "").trim();
  const currentPassword = String(body.currentPassword || body.password || "").trim();

  if (action === "set_password") {
    if (!pass) {
      sendJson(res, 400, { ok: false, error: "password is required" });
      return;
    }
    lockInfo.password = pass;
    lockInfo.hasPassword = true;
    lockInfo.locked = true;
  } else if (action === "unlock") {
    if (lockInfo.hasPassword && lockInfo.password && currentPassword !== lockInfo.password) {
      sendJson(res, 400, { ok: false, error: "password mismatch" });
      return;
    }
    lockInfo.locked = false;
  } else if (action === "lock") {
    lockInfo.locked = true;
  } else {
    sendJson(res, 400, { ok: false, error: "invalid action" });
    return;
  }

  xbrainStore.locks[section] = lockInfo;
  saveXbrainStore();
  sendJson(res, 200, { ok: true, state: getXbrainStateSnapshot() });
}

async function handleTelegramHealth(req, res) {
  const token = String(xbrainStore.base.telegramTokenValue || "").trim();
  const relay = Boolean(xbrainStore.base.telegramRelayEnabled);
  sendJson(res, 200, {
    ok: true,
    configured: Boolean(token),
    relayEnabled: relay,
    connected: Boolean(token) && relay,
  });
}

async function handleTelegramTest(req, res) {
  const body = await readJsonBody(req);
  const token = String(body.token || xbrainStore.base.telegramTokenValue || "").trim();
  if (!token) {
    sendJson(res, 400, { ok: false, error: "Telegram token is required" });
    return;
  }
  xbrainStore.base.telegramTokenValue = token;
  saveXbrainStore();
  sendJson(res, 200, {
    ok: true,
    bot: {
      username: "thunderclaw_bot",
      firstName: "ThunderClaw",
    },
  });
}

async function handleTelegramHandshake(req, res) {
  const token = String(xbrainStore.base.telegramTokenValue || "").trim();
  if (!token) {
    sendJson(res, 400, { ok: false, error: "Telegram token not configured" });
    return;
  }
  sendJson(res, 200, { ok: true, delivered: true });
}

function openclawErrorText(result) {
  return (result?.stderr || result?.stdout || "").trim() || "openclaw command failed";
}

function parseJsonOrText(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function ensureConfigPath(configPathLike) {
  const configPath = String(configPathLike || "").trim();
  if (!configPath) {
    throw new Error("配置路径不能为空");
  }
  if (configPath.length > 220) {
    throw new Error("配置路径过长");
  }
  if (!/^[a-zA-Z0-9_\-.[\]]+$/.test(configPath)) {
    throw new Error("配置路径格式非法");
  }
  return configPath;
}

async function handleOpenClawConsoleStatus(req, res) {
  const versionRes = await runOpenClawCommand(["--version"], { timeoutMs: 20_000 });
  const gatewayHealthRes = await runOpenClawCommand(["gateway", "health", "--json"], { timeoutMs: 10_000 });
  const cronStatusRes = await runOpenClawCommand(["cron", "status", "--json"], { timeoutMs: 10_000 });
  const cronListRes = await runOpenClawCommand(["cron", "list", "--all", "--json"], { timeoutMs: 12_000 });
  const gatewayHealth = parseJsonSafe(gatewayHealthRes.stdout);
  const cronStatus = parseJsonSafe(cronStatusRes.stdout);
  const cronList = parseJsonSafe(cronListRes.stdout);
  sendJson(res, 200, {
    ok: true,
    openclaw: {
      available: Boolean(versionRes.ok),
      version: String(versionRes.stdout || versionRes.stderr || "").trim(),
      source: versionRes.source,
    },
    gateway: {
      healthy: Boolean(gatewayHealthRes.ok),
      health: gatewayHealth,
      error: gatewayHealthRes.ok ? null : openclawErrorText(gatewayHealthRes),
      logsTail: gatewayState.logs.slice(-80),
    },
    cron: {
      statusOk: Boolean(cronStatusRes.ok),
      listOk: Boolean(cronListRes.ok),
      status: cronStatus,
      jobs: Array.isArray(cronList?.jobs) ? cronList.jobs : [],
      statusError: cronStatusRes.ok ? null : openclawErrorText(cronStatusRes),
      listError: cronListRes.ok ? null : openclawErrorText(cronListRes),
    },
  });
}

async function handleOpenClawCronList(req, res) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const includeDisabled = String(url.searchParams.get("all") || "1") !== "0";
  const args = ["cron", "list"];
  if (includeDisabled) args.push("--all");
  args.push("--json");
  const result = await runOpenClawCommand(args, { timeoutMs: 15_000 });
  if (!result.ok) {
    sendJson(res, 500, { ok: false, error: openclawErrorText(result) });
    return;
  }
  const payload = parseJsonSafe(result.stdout);
  sendJson(res, 200, {
    ok: true,
    jobs: Array.isArray(payload?.jobs) ? payload.jobs : [],
  });
}

async function handleOpenClawCronAdd(req, res) {
  const body = await readJsonBody(req);
  const name = String(body.name || "").trim() || `thunderclaw-${Date.now()}`;
  const every = String(body.every || "").trim();
  const message = String(body.message || "").trim();
  const session = String(body.session || "").trim();
  const channel = String(body.channel || "").trim();
  if (!every) {
    sendJson(res, 400, { ok: false, error: "every is required" });
    return;
  }
  if (!message) {
    sendJson(res, 400, { ok: false, error: "message is required" });
    return;
  }
  const args = [
    "cron",
    "add",
    "--name",
    name,
    "--every",
    every,
    "--message",
    message,
    "--json",
  ];
  if (body.disabled === true) args.push("--disabled");
  if (session === "main" || session === "isolated") {
    args.push("--session", session);
  }
  if (channel) {
    args.push("--channel", channel);
  }
  const result = await runOpenClawCommand(args, { timeoutMs: 25_000 });
  if (!result.ok) {
    sendJson(res, 500, { ok: false, error: openclawErrorText(result) });
    return;
  }
  const payload = parseJsonSafe(result.stdout);
  sendJson(res, 200, {
    ok: true,
    job: payload && typeof payload === "object" ? payload : null,
  });
}

async function handleOpenClawCronRemove(req, res) {
  const body = await readJsonBody(req);
  const id = String(body.id || "").trim();
  if (!id) {
    sendJson(res, 400, { ok: false, error: "id is required" });
    return;
  }
  const result = await runOpenClawCommand(["cron", "rm", id, "--json"], { timeoutMs: 20_000 });
  if (!result.ok) {
    sendJson(res, 500, { ok: false, error: openclawErrorText(result) });
    return;
  }
  const payload = parseJsonSafe(result.stdout);
  sendJson(res, 200, {
    ok: true,
    removed: Boolean(payload?.removed),
    raw: payload,
  });
}

async function handleOpenClawCronToggle(req, res) {
  const body = await readJsonBody(req);
  const id = String(body.id || "").trim();
  const enabled = body.enabled !== false;
  if (!id) {
    sendJson(res, 400, { ok: false, error: "id is required" });
    return;
  }
  const cmd = enabled ? "enable" : "disable";
  const result = await runOpenClawCommand(["cron", cmd, id], { timeoutMs: 20_000 });
  if (!result.ok) {
    sendJson(res, 500, { ok: false, error: openclawErrorText(result) });
    return;
  }
  sendJson(res, 200, {
    ok: true,
    id,
    enabled,
  });
}

async function handleOpenClawConfigGet(req, res) {
  const body = await readJsonBody(req);
  let configPath;
  try {
    configPath = ensureConfigPath(body.path);
  } catch (error) {
    sendJson(res, 400, { ok: false, error: String(error?.message || error) });
    return;
  }
  const result = await runOpenClawCommand(["config", "get", configPath, "--json"], { timeoutMs: 15_000 });
  if (!result.ok) {
    sendJson(res, 400, { ok: false, error: openclawErrorText(result) });
    return;
  }
  sendJson(res, 200, {
    ok: true,
    path: configPath,
    value: parseJsonOrText(result.stdout),
    raw: String(result.stdout || "").trim(),
  });
}

async function handleOpenClawConfigSet(req, res) {
  const body = await readJsonBody(req);
  let configPath;
  try {
    configPath = ensureConfigPath(body.path);
  } catch (error) {
    sendJson(res, 400, { ok: false, error: String(error?.message || error) });
    return;
  }
  if (!Object.prototype.hasOwnProperty.call(body, "value")) {
    sendJson(res, 400, { ok: false, error: "value is required" });
    return;
  }
  const encodedValue = JSON.stringify(body.value);
  const result = await runOpenClawCommand(
    ["config", "set", configPath, encodedValue, "--strict-json"],
    { timeoutMs: 25_000 },
  );
  if (!result.ok) {
    sendJson(res, 500, { ok: false, error: openclawErrorText(result) });
    return;
  }
  sendJson(res, 200, {
    ok: true,
    path: configPath,
    value: body.value,
    output: String(result.stdout || "").trim(),
  });
}

async function handleOpenClawConfigUnset(req, res) {
  const body = await readJsonBody(req);
  let configPath;
  try {
    configPath = ensureConfigPath(body.path);
  } catch (error) {
    sendJson(res, 400, { ok: false, error: String(error?.message || error) });
    return;
  }
  const result = await runOpenClawCommand(["config", "unset", configPath], { timeoutMs: 20_000 });
  if (!result.ok) {
    sendJson(res, 500, { ok: false, error: openclawErrorText(result) });
    return;
  }
  sendJson(res, 200, {
    ok: true,
    path: configPath,
    output: String(result.stdout || "").trim(),
  });
}

async function requestHandler(req, res) {
  try {
    const method = req.method ?? "GET";
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;

    if (method === "GET" && pathname === "/api/status") {
      await handleStatus(req, res);
      return;
    }
    if (method === "POST" && pathname === "/api/setup") {
      await handleSetup(req, res);
      return;
    }
    if (method === "POST" && pathname === "/api/setup/quick") {
      await handleQuickSetup(req, res);
      return;
    }
    if (method === "POST" && pathname === "/api/models/set") {
      await handleSetModel(req, res);
      return;
    }
    if (method === "POST" && pathname === "/api/oauth/start") {
      await handleOAuthStart(req, res);
      return;
    }
    if (method === "GET" && pathname === "/api/oauth/status") {
      await handleOAuthStatus(req, res);
      return;
    }
    if (method === "POST" && pathname === "/api/gateway/start") {
      sendJson(res, 200, { ok: true, ...startGateway() });
      return;
    }
    if (method === "POST" && pathname === "/api/gateway/stop") {
      sendJson(res, 200, { ok: true, ...stopGateway() });
      return;
    }
    if (method === "GET" && pathname === "/api/gateway/logs") {
      sendJson(res, 200, { ok: true, logs: gatewayState.logs });
      return;
    }
    if (method === "GET" && pathname === "/api/ai/health") {
      await handleAiHealth(req, res);
      return;
    }
    if (method === "POST" && pathname === "/api/ai/chat") {
      await handleAiChat(req, res);
      return;
    }
    if (method === "POST" && pathname === "/api/config/chat") {
      await handleConfigChat(req, res);
      return;
    }
    if (method === "GET" && pathname === "/api/chat/history") {
      await handleChatHistory(req, res);
      return;
    }
    if (method === "GET" && pathname === "/api/xbrain/state") {
      await handleXbrainState(req, res);
      return;
    }
    if (method === "POST" && pathname === "/api/xbrain/update") {
      await handleXbrainUpdate(req, res);
      return;
    }
    if (method === "POST" && pathname === "/api/xbrain/model/switch") {
      await handleXbrainModelSwitch(req, res);
      return;
    }
    if (method === "GET" && pathname === "/api/xbrain/models/catalog") {
      await handleXbrainModelsCatalog(req, res);
      return;
    }
    if (method === "POST" && pathname === "/api/xbrain/models/connect") {
      await handleXbrainModelConnect(req, res);
      return;
    }
    if (method === "POST" && pathname === "/api/xbrain/models/disconnect") {
      await handleXbrainModelDisconnect(req, res);
      return;
    }
    if (method === "GET" && pathname === "/api/xbrain/auth/status") {
      await handleXbrainAuthStatus(req, res);
      return;
    }
    if (method === "POST" && pathname === "/api/xbrain/auth/start") {
      await handleXbrainAuthStart(req, res);
      return;
    }
    if (method === "POST" && pathname === "/api/xbrain/auth/disconnect") {
      await handleXbrainAuthDisconnect(req, res);
      return;
    }
    if (method === "POST" && pathname === "/api/xbrain/provider/remove") {
      await handleXbrainProviderRemove(req, res);
      return;
    }
    if (method === "POST" && pathname === "/api/xbrain/lock") {
      await handleXbrainLock(req, res);
      return;
    }
    if (method === "GET" && pathname === "/api/telegram/health") {
      await handleTelegramHealth(req, res);
      return;
    }
    if (method === "POST" && pathname === "/api/telegram/test") {
      await handleTelegramTest(req, res);
      return;
    }
    if (method === "POST" && pathname === "/api/telegram/handshake") {
      await handleTelegramHandshake(req, res);
      return;
    }
    if (method === "GET" && pathname === "/api/openclaw/status") {
      await handleOpenClawConsoleStatus(req, res);
      return;
    }
    if (method === "GET" && pathname === "/api/openclaw/cron/list") {
      await handleOpenClawCronList(req, res);
      return;
    }
    if (method === "POST" && pathname === "/api/openclaw/cron/add") {
      await handleOpenClawCronAdd(req, res);
      return;
    }
    if (method === "POST" && pathname === "/api/openclaw/cron/remove") {
      await handleOpenClawCronRemove(req, res);
      return;
    }
    if (method === "POST" && pathname === "/api/openclaw/cron/toggle") {
      await handleOpenClawCronToggle(req, res);
      return;
    }
    if (method === "POST" && pathname === "/api/openclaw/config/get") {
      await handleOpenClawConfigGet(req, res);
      return;
    }
    if (method === "POST" && pathname === "/api/openclaw/config/set") {
      await handleOpenClawConfigSet(req, res);
      return;
    }
    if (method === "POST" && pathname === "/api/openclaw/config/unset") {
      await handleOpenClawConfigUnset(req, res);
      return;
    }
    if (method === "POST" && pathname === "/api/chat") {
      await handleChat(req, res);
      return;
    }

    await serveStatic(req, res);
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      error: String(error),
    });
  }
}

export function startThunderClawServer(options = {}) {
  const port = Number.parseInt(String(options.port ?? DEFAULT_PORT), 10) || DEFAULT_PORT;
  const host = String(options.host ?? "127.0.0.1");
  const server = http.createServer((req, res) => {
    void requestHandler(req, res);
  });
  server.listen(port, host, () => {
    console.log(`ThunderClaw server running at http://${host}:${port}`);
    console.log("Open / for ThunderClaw old product pages (虾脑/虾线/虾海/虾策).");
    console.log("Open 虾脑 view to use embedded OpenClaw quick login.");
  });
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startThunderClawServer();
}
