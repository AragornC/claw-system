#!/usr/bin/env node

import { spawn } from "node:child_process";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loginOpenAICodex } from "@mariozechner/pi-ai";
import { createOpenClawConsoleHandlers } from "./server/handlers/openclaw-console.js";
import { createChatConfigHandlers } from "./server/handlers/chat-config.js";
import { createXbrainCoreHandlers } from "./server/handlers/xbrain-core.js";
import { createTelegramHandlers } from "./server/handlers/telegram.js";
import { createStrategyLabHandlers } from "./server/handlers/strategy-lab.js";
import { createHttpRouter } from "./server/http/router.js";
import { buildApiRouteTable } from "./server/http/route-table.js";
import {
  inferProviderFromModelRef,
  normalizeProviderKey,
  PROVIDER_DEFAULT_MODEL_REFS,
  PROVIDER_TO_OAUTH_PROVIDER,
  PROVIDER_TO_SETUP_PROVIDER,
  providerAuthType,
  providerSupportsApiKey,
  providerSupportsOAuth,
  SUPPORTED_OAUTH_PROVIDERS,
  toModelRef,
} from "./server/domain/model-provider.js";
import { createOpenClawXbrainRuntime } from "./server/core/openclaw-xbrain-runtime.js";
import { createStrategyLabStore } from "./server/core/strategy-lab-store.js";
import { createFreqtradeBacktestAdapter } from "./server/core/freqtrade-backtest-adapter.js";
import { createTradingIntentSkill } from "./server/core/trading-intent-skill.js";
import { createModelSwitchIntentSkill } from "./server/core/model-switch-intent-skill.js";
import { createXbrainStoreManager } from "./server/core/xbrain-store.js";
import { createChatHistoryStore } from "./server/core/chat-history-store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const WEB_DIR = path.resolve(ROOT_DIR, "web");
const REPORT_DIR = path.resolve(ROOT_DIR, "memory", "report");
const MEMORY_DIR = path.resolve(ROOT_DIR, "memory");
const XBRAIN_STATE_PATH = path.join(MEMORY_DIR, "xbrain-state.json");
const CHAT_HISTORY_PATH = path.join(MEMORY_DIR, "chat-history.json");
const STRATEGY_LAB_STATE_PATH = path.join(MEMORY_DIR, "strategy-lab.json");
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

const MODEL_CATALOG_CACHE_TTL_MS = 60_000;
const modelCatalogCache = {
  all: null,
  configured: null,
  at: 0,
};
const sessionModelProbeCache = {
  at: 0,
  modelRef: "",
  error: "",
};

function commandExists(commandLike) {
  const command = String(commandLike || "").trim();
  if (!command) return false;
  const probe = spawnSync(command, ["--version"], {
    encoding: "utf8",
    stdio: "pipe",
    timeout: 8_000,
  });
  return !probe.error && probe.status === 0;
}

function ensureFreqtradeCommandForStartup() {
  const userSpecified = String(process.env.THUNDERCLAW_FREQTRADE_CMD || "").trim();
  if (userSpecified) {
    if (!commandExists(userSpecified)) {
      throw new Error(`[ThunderClaw] THUNDERCLAW_FREQTRADE_CMD is set but unavailable: ${userSpecified}`);
    }
    return userSpecified;
  }

  const managedCmd = path.join(ROOT_DIR, ".thunderclaw", "freqtrade-venv", "bin", "freqtrade");
  if (commandExists(managedCmd)) {
    process.env.THUNDERCLAW_FREQTRADE_CMD = managedCmd;
    return managedCmd;
  }

  const defaultCmd = "freqtrade";
  if (commandExists(defaultCmd)) {
    return defaultCmd;
  }

  throw new Error(
    `[ThunderClaw] freqtrade is required but not installed. ` +
    `Run: bash scripts/setup-install-freqtrade.sh (recommended), ` +
    `or set THUNDERCLAW_FREQTRADE_CMD to an existing binary.`
  );
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

function sanitizeProviderCatalogForStore(items) {
  return uniqStrings((Array.isArray(items) ? items : []).map((v) => normalizeProviderKey(v)));
}

const {
  xbrainStore,
  saveXbrainStore,
  ensureProviderAuthEntry,
  isProviderConfigured,
  markProviderAuthSyncError,
} = createXbrainStoreManager({
  fsModule: fs,
  memoryDir: MEMORY_DIR,
  xbrainStatePath: XBRAIN_STATE_PATH,
  normalizeProviderKey,
  providerAuthType,
  providerSupportsOAuth,
  sanitizeProviderCatalog: sanitizeProviderCatalogForStore,
});

const {
  chatHistory,
  appendChatEvent,
  updateChatCardStatus,
} = createChatHistoryStore({
  fsModule: fs,
  memoryDir: MEMORY_DIR,
  chatHistoryPath: CHAT_HISTORY_PATH,
  maxChatEvents: MAX_CHAT_EVENTS,
});

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

function buildLocalAgentEnvFromStore() {
  const env = {};
  const key = String(xbrainStore?.base?.deepseekApiKey || "").trim();
  if (key) {
    env.DEEPSEEK_API_KEY = key;
    env.DEEPSEEK_KEY = key;
  }
  return env;
}

function buildRuleBasedAgentReply(messageLike = "") {
  const text = String(messageLike || "").trim();
  if (!text) return "收到。";
  const lower = text.toLowerCase();
  const hasTrade = lower.includes("btc") || lower.includes("eth") || lower.includes("策略") || lower.includes("止损") || lower.includes("止盈");
  if (hasTrade) {
    return "建议先从低风险回测开始：定义入场条件、止损1%-2%、止盈2%-4%、单笔风险不超过总资金1%。";
  }
  return "收到，当前外部模型暂不可用，已切换本地规则回复。";
}

function extractAgentReply(payload) {
  function stripControlFragments(textLike) {
    const raw = String(textLike || "");
    if (!raw) return "";
    return raw.replace(/[【\[]([^】\]]{0,480})[】\]]/g, (full, inner) => {
      const body = String(inner || "").trim().toLowerCase();
      if (!body) return full;
      const hasControl =
        body.includes("assistant to=final")
        || body.includes("reply tag")
        || body.includes("no tools")
        || body.includes("consistent tone")
        || body.includes("just output")
        || body.includes("need respond")
        || body.includes("with tag")
        || body.includes("קצר");
      return hasControl ? "" : full;
    });
  }
  function isLikelyInternalControlLine(lineLike) {
    const line = String(lineLike || "").trim().toLowerCase();
    if (!line) return false;
    if (line.includes("no tools") && (line.includes("tag") || line.includes("respond") || line.includes("need"))) {
      return true;
    }
    let score = 0;
    if (line.includes("assistant to=final")) score += 2;
    if (line.includes("reply tag")) score += 2;
    if (line.includes("no tools")) score += 2;
    if (line.includes("need respond")) score += 2;
    if (line.includes("with tag") || line.endsWith(" tag")) score += 1;
    if (line.includes("consistent tone")) score += 1;
    if (line.includes("output.") || line.includes("just output")) score += 1;
    if (line.includes("קצר")) score += 1;
    if (line.startsWith("need ")) score += 1;
    if (line.startsWith("need just ")) score += 1;
    return score >= 3;
  }
  function sanitizeAgentReplyText(textLike) {
    const original = String(textLike || "").trim();
    const raw = stripControlFragments(original).trim();
    if (!raw) return "";
    const cleanedLines = raw
      .split(/\r?\n/)
      .map((line) => String(line || "").trimEnd())
      .filter((line) => !isLikelyInternalControlLine(line));
    let cleaned = stripControlFragments(cleanedLines.join("\n")).trim();
    if (!cleaned) {
      cleaned = stripControlFragments(
        original.replace(/【[^】]{0,480}(assistant to=final|reply tag|no tools|need respond|with tag|just output)[^】]{0,480}】/ig, ""),
      ).trim();
    }
    return cleaned || raw || original;
  }
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
        texts.push(sanitizeAgentReplyText(item.text));
        continue;
      }
      const content = item.content;
      if (typeof content === "string" && content.trim()) {
        texts.push(sanitizeAgentReplyText(content));
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
          texts.push(sanitizeAgentReplyText(joined));
        }
      }
    }
  }
  if (texts.length > 0) {
    return sanitizeAgentReplyText(texts.join("\n\n"));
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

function stripAnsi(textLike) {
  return String(textLike || "").replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, "");
}

function shellQuoteArg(argLike) {
  const arg = String(argLike ?? "");
  if (!arg) return "''";
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function extractUrlFromText(textLike) {
  const text = stripAnsi(textLike);
  const m = text.match(/https?:\/\/[^\s"'<>]+/i);
  return m ? String(m[0] || "").trim() : "";
}

function sleepMs(msLike) {
  const ms = Number.isFinite(Number(msLike)) ? Math.max(0, Number(msLike)) : 0;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveOpenClawStateDir() {
  const explicit = String(process.env.OPENCLAW_STATE_DIR || "").trim();
  if (explicit) return path.resolve(explicit);
  const profile = String(process.env.OPENCLAW_PROFILE || "").trim();
  return path.join(os.homedir(), profile ? `.openclaw-${profile}` : ".openclaw");
}

function resolveOpenClawConfigPath() {
  const explicit = String(process.env.OPENCLAW_CONFIG_PATH || "").trim();
  if (explicit) return path.resolve(explicit);
  return path.join(resolveOpenClawStateDir(), "openclaw.json");
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

function resolveOpenClawDefaultAgentId(configLike) {
  const cfg = configLike && typeof configLike === "object" ? configLike : {};
  const candidates = [
    cfg?.agents?.defaultAgentId,
    cfg?.agents?.default,
    cfg?.agent?.default,
    cfg?.meta?.defaultAgentId,
    process.env.OPENCLAW_AGENT_ID,
  ]
    .map((v) => String(v || "").trim())
    .filter(Boolean);
  return candidates[0] || "main";
}

function resolveOpenClawAgentDir(configLike) {
  const explicit = String(process.env.OPENCLAW_AGENT_DIR || process.env.PI_CODING_AGENT_DIR || "").trim();
  if (explicit) return path.resolve(explicit);
  const stateDir = resolveOpenClawStateDir();
  const agentsRoot = path.join(stateDir, "agents");
  const preferred = resolveOpenClawDefaultAgentId(configLike);
  const candidateIds = [];
  if (preferred) candidateIds.push(preferred);
  if (!candidateIds.includes("main")) candidateIds.push("main");
  try {
    const discovered = fs
      .readdirSync(agentsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
    for (const id of discovered) {
      if (!candidateIds.includes(id)) candidateIds.push(id);
    }
  } catch {}
  for (const id of candidateIds) {
    const agentDir = path.join(agentsRoot, id, "agent");
    if (fs.existsSync(agentDir)) return agentDir;
  }
  return path.join(agentsRoot, preferred || "main", "agent");
}

function resolveOpenClawAuthStorePath(configLike) {
  return path.join(resolveOpenClawAgentDir(configLike), "auth-profiles.json");
}

function persistOpenAICodexCredentials(credsLike) {
  const creds = credsLike && typeof credsLike === "object" ? credsLike : {};
  const access = String(creds.access || "").trim();
  const refresh = String(creds.refresh || "").trim();
  const expires = Number.isFinite(Number(creds.expires)) ? Number(creds.expires) : 0;
  if (!access || !refresh || !expires) {
    return { ok: false, error: "OAuth 凭证不完整（缺少 access/refresh/expires）" };
  }
  const configPath = resolveOpenClawConfigPath();
  const config = readJsonFileSafe(configPath, {});
  const authStorePath = resolveOpenClawAuthStorePath(config);
  const authStore = readJsonFileSafe(authStorePath, { version: 1, profiles: {} });
  authStore.version = 1;
  authStore.profiles = authStore.profiles && typeof authStore.profiles === "object" ? authStore.profiles : {};
  const email = String(creds.email || "").trim();
  const profileId = `openai-codex:${email || "default"}`;
  authStore.profiles[profileId] = {
    type: "oauth",
    provider: "openai-codex",
    access,
    refresh,
    expires,
    ...(email ? { email } : {}),
    ...(creds.accountId ? { accountId: String(creds.accountId) } : {}),
  };
  const existingOrder = Array.isArray(authStore?.order?.["openai-codex"]) ? authStore.order["openai-codex"] : [];
  authStore.order = authStore.order && typeof authStore.order === "object" ? authStore.order : {};
  authStore.order["openai-codex"] = [profileId, ...existingOrder.filter((id) => id !== profileId)];
  writeJsonFileSafe(authStorePath, authStore);

  const nextConfig = config && typeof config === "object" ? config : {};
  nextConfig.auth = nextConfig.auth && typeof nextConfig.auth === "object" ? nextConfig.auth : {};
  nextConfig.auth.profiles = nextConfig.auth.profiles && typeof nextConfig.auth.profiles === "object"
    ? nextConfig.auth.profiles
    : {};
  nextConfig.auth.profiles[profileId] = {
    provider: "openai-codex",
    mode: "oauth",
    ...(email ? { email } : {}),
  };
  nextConfig.auth.order = nextConfig.auth.order && typeof nextConfig.auth.order === "object"
    ? nextConfig.auth.order
    : {};
  const cfgOrder = Array.isArray(nextConfig.auth.order["openai-codex"]) ? nextConfig.auth.order["openai-codex"] : [];
  nextConfig.auth.order["openai-codex"] = [profileId, ...cfgOrder.filter((id) => id !== profileId)];
  writeJsonFileSafe(configPath, nextConfig);

  return {
    ok: true,
    profileId,
    authStorePath,
    configPath,
  };
}

function clearOauthPromptWaiter() {
  if (!oauthState.promptWaiter) {
    oauthState.prompt = null;
    return;
  }
  const waiter = oauthState.promptWaiter;
  if (waiter && waiter.timer) {
    clearTimeout(waiter.timer);
  }
  oauthState.promptWaiter = null;
  oauthState.prompt = null;
}

function waitForOauthPromptInput(attemptId, promptLike) {
  const prompt = promptLike && typeof promptLike === "object" ? promptLike : {};
  const message = String(prompt.message || "请粘贴 OAuth 回调 URL 或验证码").trim();
  const placeholder = String(prompt.placeholder || "").trim();
  const allowEmpty = Boolean(prompt.allowEmpty);
  clearOauthPromptWaiter();
  oauthState.prompt = {
    attemptId,
    message,
    placeholder,
    allowEmpty,
  };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (oauthState.promptWaiter && oauthState.promptWaiter.attemptId === attemptId) {
        oauthState.promptWaiter = null;
        oauthState.prompt = null;
      }
      reject(new Error("OAuth 等待输入超时，请重新发起登录并完成授权。"));
    }, 10 * 60 * 1000);
    oauthState.promptWaiter = {
      attemptId,
      timer,
      resolve: (valueLike) => {
        clearTimeout(timer);
        oauthState.promptWaiter = null;
        oauthState.prompt = null;
        resolve(String(valueLike ?? ""));
      },
      reject: (errorLike) => {
        clearTimeout(timer);
        oauthState.promptWaiter = null;
        oauthState.prompt = null;
        reject(errorLike instanceof Error ? errorLike : new Error(String(errorLike || "OAuth 输入失败")));
      },
    };
  });
}

function submitOauthPromptInput(inputLike, attemptIdLike) {
  const input = String(inputLike ?? "");
  const waiter = oauthState.promptWaiter;
  if (!waiter) {
    return { ok: false, error: "当前没有等待输入的 OAuth 流程。" };
  }
  const attemptId = Number.isFinite(Number(attemptIdLike)) ? Number(attemptIdLike) : 0;
  if (attemptId > 0 && waiter.attemptId !== attemptId) {
    return { ok: false, error: "OAuth 流程已变化，请刷新状态后重试。" };
  }
  waiter.resolve(input);
  return { ok: true };
}

function pushOauthLog(stream, chunkLike) {
  const raw = String(chunkLike || "");
  const lines = stripAnsi(raw)
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => String(line || "").trim())
    .filter(Boolean);
  for (const line of lines) {
    oauthState.logs.push({
      ts: new Date().toISOString(),
      stream,
      line,
    });
    const u = extractUrlFromText(line);
    if (u) oauthState.url = u;
  }
  if (oauthState.logs.length > 500) {
    oauthState.logs.splice(0, oauthState.logs.length - 500);
  }
}

function detectOauthErrorFromLogs(logsLike) {
  const logs = Array.isArray(logsLike) ? logsLike : [];
  const recent = logs.slice(-120).map((item) => String(item?.line || "").trim()).filter(Boolean);
  if (!recent.length) return "";
  const explicit = recent.find((line) => /^error[:\s]/i.test(line));
  if (explicit) return explicit;
  const providerMissing = recent.find((line) => /No provider plugins found/i.test(line));
  if (providerMissing) {
    return "No provider plugins found. 请先安装并启用对应 OAuth provider 插件。";
  }
  const generic = recent.find((line) => /\b(failed|failure|invalid|denied|forbidden|unauthorized|timeout)\b/i.test(line));
  if (generic) return generic;
  return "";
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
  if (filePath.endsWith(".webp")) {
    return "image/webp";
  }
  if (filePath.endsWith(".png")) {
    return "image/png";
  }
  if (filePath.endsWith(".jpg") || filePath.endsWith(".jpeg")) {
    return "image/jpeg";
  }
  if (filePath.endsWith(".gif")) {
    return "image/gif";
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

const {
  handleOpenClawConsoleStatus,
  handleOpenClawCronList,
  handleOpenClawCronAdd,
  handleOpenClawCronRemove,
  handleOpenClawCronToggle,
  handleOpenClawConfigGet,
  handleOpenClawConfigSet,
  handleOpenClawConfigUnset,
} = createOpenClawConsoleHandlers({
  runOpenClawCommand,
  parseJsonSafe,
  readJsonBody,
  sendJson,
  getGatewayLogs: () => gatewayState.logs,
});

const {
  handleTelegramHealth,
  handleTelegramTest,
  handleTelegramHandshake,
} = createTelegramHandlers({
  sendJson,
  readJsonBody,
  getStore: () => xbrainStore,
  saveStore: saveXbrainStore,
});

function gatewayIsRunning() {
  return Boolean(gatewayState.proc && gatewayState.proc.exitCode === null);
}

function oauthIsRunning() {
  return Boolean(
    oauthState.active
    || (oauthState.proc && oauthState.proc.exitCode === null),
  );
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
    const state = getOauthStatus();
    return {
      ok: true,
      started: false,
      message: "OAuth login is already running",
      state,
      attemptId: Number(state?.attemptId || 0),
      startedAt: state?.startedAt || null,
    };
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
  const startedAt = String(oauthState.startedAt || new Date().toISOString());
  const commandHint = "在网页中完成 OpenAI 授权后，若提示需要手动输入，请粘贴回调 URL。";
  pushOauthLog("system", "oauth start mode=native-openai-codex");
  pushOauthLog("system", commandHint);

  void (async () => {
    try {
      const creds = await loginOpenAICodex({
        onAuth: (info) => {
          const url = String(info?.url || "").trim();
          if (url) {
            oauthState.url = url;
            pushOauthLog("system", `oauth url: ${url}`);
          }
          const instructions = String(info?.instructions || "").trim();
          if (instructions) {
            pushOauthLog("system", instructions);
          }
        },
        onPrompt: async (prompt) => {
          const message = String(prompt?.message || "请粘贴 OAuth 回调 URL").trim();
          pushOauthLog("system", `oauth prompt: ${message}`);
          const input = await waitForOauthPromptInput(attemptId, prompt);
          return String(input || "").trim();
        },
        onProgress: (message) => {
          const text = String(message || "").trim();
          if (text) pushOauthLog("stdout", text);
        },
      });
      const persisted = persistOpenAICodexCredentials(creds);
      if (!persisted.ok) {
        throw new Error(String(persisted.error || "OAuth 凭证保存失败"));
      }
      pushOauthLog("system", `oauth credentials saved: ${persisted.profileId}`);
      oauthState.last = {
        attemptId,
        provider: providerId,
        code: 0,
        signal: null,
        error: null,
        commandHint,
        url: String(oauthState.url || ""),
        profileId: persisted.profileId,
        finishedAt: new Date().toISOString(),
      };
    } catch (error) {
      const errText = String(error?.message || error || "OAuth failed");
      pushOauthLog("system", `oauth error: ${errText}`);
      oauthState.last = {
        attemptId,
        provider: providerId,
        code: 1,
        signal: null,
        error: errText,
        commandHint,
        url: String(oauthState.url || ""),
        finishedAt: new Date().toISOString(),
      };
    } finally {
      clearOauthPromptWaiter();
      oauthState.proc = null;
      oauthState.active = false;
      oauthState.provider = null;
      oauthState.startedAt = null;
      oauthState.attemptId = 0;
    }
  })();

  return {
    ok: true,
    started: true,
    message: "OAuth 已发起。正在等待浏览器授权…",
    provider: providerId,
    command: "native-openai-codex",
    launchMode: "native-openai-codex",
    commandHint,
    attemptId,
    startedAt,
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

const {
  providerToAuthConfig,
  buildOnboardArgs,
  runSetupFromInput,
  waitGatewayHealthy,
  sanitizeProviderCatalog,
  getAuthProviderEntry,
  normalizeModelCatalogEntry,
  listOpenClawModelsCatalog,
  tuneDeepseekDefaults,
  syncXbrainFromOpenClaw,
  getLocksSnapshot,
  getXbrainStateSnapshot,
  buildXbrainState,
  getCurrentRuntimeModelRefFromStore,
  normalizeSessionId,
  looksLikeGatewayTransportError,
  setOpenClawDefaultModel,
  applyRuntimeModelRefToStore,
  extractModelRefsFromText,
  pickCurrentModelRefFromText,
  detectModelRefChangeFromAgentOutput,
  probeThunderSessionModelRef,
  refreshRuntimeModelFromSession,
  switchThunderSessionModel,
  resolveModelRefFromToken,
  parseSlashModelSwitchRef,
} = createOpenClawXbrainRuntime({
  normalizeProviderKey,
  providerSupportsOAuth,
  PROVIDER_TO_SETUP_PROVIDER,
  runOpenClawCommand,
  startGateway,
  parseJsonSafe,
  xbrainStore,
  saveXbrainStore,
  ensureProviderAuthEntry,
  isProviderConfigured,
  markProviderAuthSyncError,
  modelCatalogCache,
  sessionModelProbeCache,
  inferProviderFromModelRef,
  toModelRef,
  PROVIDER_DEFAULT_MODEL_REFS,
  uniqStrings,
  extractAgentReply,
  maskSecret,
  providerAuthType,
  oauthState,
  oauthIsRunning,
});

const backtestEngineKey = String(process.env.THUNDERCLAW_BACKTEST_ENGINE || "freqtrade").trim().toLowerCase();
if (backtestEngineKey !== "freqtrade") {
  throw new Error(`[ThunderClaw] unsupported backtest engine: ${backtestEngineKey}. Only 'freqtrade' is supported.`);
}
ensureFreqtradeCommandForStartup();
const freqtradeBacktestAdapter = createFreqtradeBacktestAdapter({
  enabled: process.env.THUNDERCLAW_ENABLE_FREQTRADE,
  command: process.env.THUNDERCLAW_FREQTRADE_CMD,
});

const availability = typeof freqtradeBacktestAdapter.checkAvailability === "function"
  ? freqtradeBacktestAdapter.checkAvailability()
  : { ok: false, error: "freqtrade adapter unavailable" };
if (!availability.ok) {
  throw new Error(`[ThunderClaw] freqtrade is required but unavailable: ${availability.error}. Install freqtrade first.`);
}
const strategyBacktestEngine = freqtradeBacktestAdapter;
console.warn(`[ThunderClaw] strategy backtest engine: freqtrade (${availability.version})`);

const strategyLabStore = createStrategyLabStore({
  statePath: STRATEGY_LAB_STATE_PATH,
  backtestEngine: strategyBacktestEngine,
});

const {
  extractTradingIntentCandidates,
  generateFeatureCodeForCandidate,
} = createTradingIntentSkill({
  runOpenClawCommand,
  parseJsonSafe,
  extractAgentReply,
  normalizeSessionId,
});

const {
  extractModelSwitchIntent,
} = createModelSwitchIntentSkill({
  runOpenClawCommand,
  parseJsonSafe,
  extractAgentReply,
  normalizeSessionId,
});

async function runAgentTurn(params) {
  const message = String(params?.message ?? "").trim();
  const sessionIdRaw = String(params?.sessionId ?? "thunderclaw-main").trim() || "thunderclaw-main";
  const preferredModelRef = String(params?.modelRef || "").trim() || getCurrentRuntimeModelRefFromStore();
  const sessionId = normalizeSessionId(sessionIdRaw);
  const thinking = String(params?.thinking ?? "").trim();
  const modelSet = {
    attempted: false,
    ok: null,
    error: null,
    modelRef: preferredModelRef,
  };
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

  const gatewayBeforeRun = await waitGatewayHealthy({ timeoutMs: 4_000, pollMs: 700 }).catch(() => ({ ok: false }));
  if (!gatewayBeforeRun?.ok) {
    startGateway();
    await waitGatewayHealthy({ timeoutMs: 20_000, pollMs: 1_000 }).catch(() => null);
  }

  let result = await runOpenClawCommand(args, { timeoutMs: 180_000 });
  if (!result.ok) {
    const errText = [result.stderr, result.stdout].filter(Boolean).join("\n");
    if (looksLikeGatewayTransportError(errText)) {
      startGateway();
      await waitGatewayHealthy({ timeoutMs: 15_000, pollMs: 1000 }).catch(() => null);
      result = await runOpenClawCommand(args, { timeoutMs: 180_000 });
    }
  }

  if (!result.ok) {
    const localArgs = [...args, "--local"];
    result = await runOpenClawCommand(localArgs, {
      timeoutMs: 180_000,
      env: buildLocalAgentEnvFromStore(),
    });
  }

  const payload = parseJsonSafe(result.stdout);
  let reply = extractAgentReply(payload);
  if (!reply) {
    const errText = String(result.stderr || "").trim();
    const errLine = errText
      .split(/\r?\n/)
      .find((line) => /HTTP\s+\d{3}|authentication|api key|gateway closed|connection error/i.test(String(line || "")));
    if (errLine) {
      reply = errLine;
    }
  }

  if (!result.ok) {
    reply = buildRuleBasedAgentReply(message);
    result = {
      ok: true,
      code: 0,
      timedOut: false,
      stdout: result.stdout,
      stderr: result.stderr,
      source: "rule_fallback",
    };
  }

  if (!reply) {
    reply = "收到，但暂时没有可返回内容。";
  }
  return {
    result,
    payload,
    reply,
    sessionId,
    modelRef: preferredModelRef,
    modelSet,
  };
}

const {
  handleSetup,
  handleQuickSetup,
  handleOAuthStart,
  handleOAuthStatus,
  handleSetModel,
  handleChat,
  handleAiChat,
  handleConfigChat,
  handleAiHealth,
  handleChatHistory,
  handleChatCardStatus,
} = createChatConfigHandlers({
  normalizeProviderKey,
  uniqStrings,
  inferProviderFromModelRef,
  PROVIDER_DEFAULT_MODEL_REFS,
  readJsonBody,
  runSetupFromInput,
  sendJson,
  runOpenClawCommand,
  switchThunderSessionModel,
  waitGatewayHealthy,
  startGateway,
  startOAuthLogin,
  getOauthStatus,
  getXbrainStateSnapshot,
  runAgentTurn,
  appendChatEvent,
  syncXbrainFromOpenClaw,
  getCurrentRuntimeModelRefFromStore,
  refreshRuntimeModelFromSession,
  extractModelSwitchIntent,
  toModelRef,
  maskSecret,
  parseJsonSafe,
  extractTradingIntentCandidates,
  updateChatCardStatus,
  xbrainStore,
  chatHistory,
  gatewayState,
});

const {
  handleXbrainState,
  handleXbrainUpdate,
  handleXbrainModelSwitch,
  handleXbrainModelsCatalog,
  handleXbrainModelConnect,
  handleXbrainModelDisconnect,
  handleXbrainAuthStart,
  handleXbrainAuthStatus,
  handleXbrainAuthInput,
  handleXbrainAuthDisconnect,
  handleXbrainProviderRemove,
  handleXbrainLock,
} = createXbrainCoreHandlers({
  readJsonBody,
  buildXbrainState,
  sendJson,
  sanitizeProviderCatalog,
  uniqStrings,
  maskSecret,
  runSetupFromInput,
  runOpenClawCommand,
  switchThunderSessionModel,
  syncXbrainFromOpenClaw,
  getXbrainStateSnapshot,
  normalizeProviderKey,
  toModelRef,
  inferProviderFromModelRef,
  listOpenClawModelsCatalog,
  PROVIDER_DEFAULT_MODEL_REFS,
  providerSupportsApiKey,
  providerSupportsOAuth,
  isProviderConfigured,
  PROVIDER_TO_SETUP_PROVIDER,
  PROVIDER_TO_OAUTH_PROVIDER,
  tuneDeepseekDefaults,
  ensureProviderAuthEntry,
  startOAuthLogin,
  sleepMs,
  getOauthStatus,
  providerAuthType,
  saveXbrainStore,
  submitOauthPromptInput,
  xbrainStore,
});

const {
  handleStrategyFeatures,
  handleStrategyFeatureDelete,
  handleStrategyVersions,
  handleStrategyVersionsPropose,
  handleStrategyVersionsEvaluate,
  handleStrategyArtifactReport,
  handleStrategyIntentCandidates,
  handleStrategyIntentGenerateCode,
  handleStrategyIntentApply,
  handleStrategyEntities,
  handleStrategyEntityDetail,
  handleStrategyEntityDraftSave,
  handleStrategyEntityReplay,
  handleStrategyEntityPublish,
  handleStrategyEntityStatus,
  handleStrategyEntityAudits,
  handleStrategyEntityDelete,
} = createStrategyLabHandlers({
  readJsonBody,
  sendJson,
  strategyLabStore,
  extractTradingIntentCandidates,
  generateFeatureCodeForCandidate,
  getCurrentRuntimeModelRefFromStore,
  updateChatCardStatus,
});

async function handleGatewayStart(_req, res) {
  sendJson(res, 200, { ok: true, ...startGateway() });
}

async function handleGatewayStop(_req, res) {
  sendJson(res, 200, { ok: true, ...stopGateway() });
}

async function handleGatewayLogs(_req, res) {
  sendJson(res, 200, { ok: true, logs: gatewayState.logs });
}

const apiRouter = createHttpRouter(buildApiRouteTable({
  handleStatus,
  handleSetup,
  handleQuickSetup,
  handleSetModel,
  handleOAuthStart,
  handleOAuthStatus,
  handleGatewayStart,
  handleGatewayStop,
  handleGatewayLogs,
  handleAiHealth,
  handleAiChat,
  handleConfigChat,
  handleChatHistory,
  handleChatCardStatus,
  handleXbrainState,
  handleXbrainUpdate,
  handleXbrainModelSwitch,
  handleXbrainModelsCatalog,
  handleXbrainModelConnect,
  handleXbrainModelDisconnect,
  handleXbrainAuthStatus,
  handleXbrainAuthStart,
  handleXbrainAuthInput,
  handleXbrainAuthDisconnect,
  handleXbrainProviderRemove,
  handleXbrainLock,
  handleTelegramHealth,
  handleTelegramTest,
  handleTelegramHandshake,
  handleOpenClawConsoleStatus,
  handleOpenClawCronList,
  handleOpenClawCronAdd,
  handleOpenClawCronRemove,
  handleOpenClawCronToggle,
  handleOpenClawConfigGet,
  handleOpenClawConfigSet,
  handleOpenClawConfigUnset,
  handleStrategyFeatures,
  handleStrategyFeatureDelete,
  handleStrategyVersions,
  handleStrategyVersionsPropose,
  handleStrategyVersionsEvaluate,
  handleStrategyArtifactReport,
  handleStrategyIntentCandidates,
  handleStrategyIntentGenerateCode,
  handleStrategyIntentApply,
  handleStrategyEntities,
  handleStrategyEntityDetail,
  handleStrategyEntityDraftSave,
  handleStrategyEntityReplay,
  handleStrategyEntityPublish,
  handleStrategyEntityStatus,
  handleStrategyEntityAudits,
  handleStrategyEntityDelete,
  handleChat,
}));

async function requestHandler(req, res) {
  try {
    const handled = await apiRouter.dispatch(req, res);
    if (handled) return;
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
