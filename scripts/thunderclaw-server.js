#!/usr/bin/env node
/**
 * ThunderClaw Server — Composition Root
 *
 * This file wires all modules together and starts the HTTP server.
 * All business logic lives in the extracted modules under server/core/ and server/handlers/.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
import { createOpenClawCli } from "./server/core/openclaw-cli.js";
import { createGatewayManager } from "./server/core/gateway-manager.js";
import { createOAuthManager } from "./server/core/oauth-manager.js";
import { createAgentRuntime, extractAgentReply } from "./server/core/agent-runtime.js";
import { sendJson, readJsonBody, createStaticFileServer } from "./server/lib/http-helpers.js";
import {
  parseJsonSafe, uniqStrings, maskSecret, sleepMs, stripAnsi,
  commandExistsSync, sanitizeProviderCatalogForStore,
} from "./server/lib/utils.js";

// ─── Paths & Constants ───────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const WEB_DIR = path.resolve(ROOT_DIR, "web");
const REPORT_DIR = path.resolve(ROOT_DIR, "memory", "report");
const MEMORY_DIR = path.resolve(ROOT_DIR, "memory");
const XBRAIN_STATE_PATH = path.join(MEMORY_DIR, "xbrain-state.json");
const CHAT_HISTORY_PATH = path.join(MEMORY_DIR, "chat-history.json");
const STRATEGY_LAB_STATE_PATH = path.join(MEMORY_DIR, "strategy-lab.json");
const DEFAULT_PORT = Number.parseInt(process.env.THUNDERCLAW_PORT ?? "3456", 10) || 3456;
const MAX_CHAT_EVENTS = 2_000;

// ─── OpenClaw CLI ────────────────────────────────────────────────────
const openclawCli = createOpenClawCli({ rootDir: ROOT_DIR });
const { runOpenClawCommand, resolveOpenClawConfigPath, resolveOpenClawAuthStorePath } = openclawCli;

// ─── Gateway Manager ─────────────────────────────────────────────────
const gateway = createGatewayManager({
  resolveOpenClawCommand: openclawCli.resolveOpenClawCommand,
  rootDir: ROOT_DIR,
});
const { gatewayState, startGateway, stopGateway, gatewayIsRunning } = gateway;

// ─── OAuth Manager ───────────────────────────────────────────────────
const oauth = createOAuthManager({ resolveOpenClawConfigPath, resolveOpenClawAuthStorePath });
const { oauthState, oauthIsRunning, getOauthStatus, startOAuthLogin, submitOauthPromptInput } = oauth;

// ─── Caches ──────────────────────────────────────────────────────────
const MODEL_CATALOG_CACHE_TTL_MS = 60_000;
const modelCatalogCache = { all: null, configured: null, at: 0 };
const sessionModelProbeCache = { at: 0, modelRef: "", error: "" };

// ─── Xbrain Store ────────────────────────────────────────────────────
const {
  xbrainStore, saveXbrainStore, ensureProviderAuthEntry,
  isProviderConfigured, markProviderAuthSyncError,
} = createXbrainStoreManager({
  fsModule: fs, memoryDir: MEMORY_DIR, xbrainStatePath: XBRAIN_STATE_PATH,
  normalizeProviderKey, providerAuthType, providerSupportsOAuth,
  sanitizeProviderCatalog: (items) => sanitizeProviderCatalogForStore(items, normalizeProviderKey),
});

// ─── Chat History ────────────────────────────────────────────────────
const { chatHistory, appendChatEvent, updateChatCardStatus } = createChatHistoryStore({
  fsModule: fs, memoryDir: MEMORY_DIR, chatHistoryPath: CHAT_HISTORY_PATH,
  maxChatEvents: MAX_CHAT_EVENTS,
});

// ─── Xbrain Runtime ──────────────────────────────────────────────────
const {
  runSetupFromInput, waitGatewayHealthy, sanitizeProviderCatalog,
  listOpenClawModelsCatalog, tuneDeepseekDefaults, syncXbrainFromOpenClaw,
  getXbrainStateSnapshot, buildXbrainState, getCurrentRuntimeModelRefFromStore,
  normalizeSessionId, looksLikeGatewayTransportError,
  refreshRuntimeModelFromSession, switchThunderSessionModel,
  getLocksSnapshot, getAuthProviderEntry, normalizeModelCatalogEntry,
  setOpenClawDefaultModel, applyRuntimeModelRefToStore,
  extractModelRefsFromText, pickCurrentModelRefFromText,
  detectModelRefChangeFromAgentOutput, probeThunderSessionModelRef,
  resolveModelRefFromToken, parseSlashModelSwitchRef, providerToAuthConfig, buildOnboardArgs,
} = createOpenClawXbrainRuntime({
  normalizeProviderKey, providerSupportsOAuth, PROVIDER_TO_SETUP_PROVIDER,
  runOpenClawCommand, startGateway, parseJsonSafe,
  xbrainStore, saveXbrainStore, ensureProviderAuthEntry,
  isProviderConfigured, markProviderAuthSyncError,
  modelCatalogCache, sessionModelProbeCache,
  inferProviderFromModelRef, toModelRef, PROVIDER_DEFAULT_MODEL_REFS,
  uniqStrings, extractAgentReply, maskSecret, providerAuthType,
  oauthState, oauthIsRunning,
});

// ─── Freqtrade ───────────────────────────────────────────────────────
function ensureFreqtradeCommandForStartup() {
  const userSpecified = String(process.env.THUNDERCLAW_FREQTRADE_CMD || "").trim();
  if (userSpecified) {
    if (!commandExistsSync(spawnSync, userSpecified)) {
      throw new Error(`[ThunderClaw] THUNDERCLAW_FREQTRADE_CMD is set but unavailable: ${userSpecified}`);
    }
    return userSpecified;
  }
  const managedCmd = path.join(ROOT_DIR, ".thunderclaw", "freqtrade-venv", "bin", "freqtrade");
  if (commandExistsSync(spawnSync, managedCmd)) {
    process.env.THUNDERCLAW_FREQTRADE_CMD = managedCmd;
    return managedCmd;
  }
  if (commandExistsSync(spawnSync, "freqtrade")) return "freqtrade";
  throw new Error(
    `[ThunderClaw] freqtrade is required but not installed. ` +
    `Run: bash scripts/setup-install-freqtrade.sh`
  );
}

ensureFreqtradeCommandForStartup();
const freqtradeBacktestAdapter = createFreqtradeBacktestAdapter({
  enabled: process.env.THUNDERCLAW_ENABLE_FREQTRADE,
  command: process.env.THUNDERCLAW_FREQTRADE_CMD,
});
const availability = freqtradeBacktestAdapter.checkAvailability();
if (!availability.ok) {
  throw new Error(`[ThunderClaw] freqtrade is required but unavailable: ${availability.error}`);
}
console.warn(`[ThunderClaw] strategy backtest engine: freqtrade (${availability.version})`);

// ─── Strategy Lab Store ──────────────────────────────────────────────
const strategyLabStore = createStrategyLabStore({
  statePath: STRATEGY_LAB_STATE_PATH,
  backtestEngine: freqtradeBacktestAdapter,
});

// ─── Trading Intent Skill ────────────────────────────────────────────
const { extractTradingIntentCandidates, generateFeatureCodeForCandidate } = createTradingIntentSkill({
  normalizeSessionId,
  getModelConfig: () => {
    const provider = String(xbrainStore?.base?.runtimeModelProvider || "deepseek").trim().toLowerCase();
    const modelId = String(xbrainStore?.base?.runtimeModelId || "deepseek-chat").trim();
    const providerAuth = xbrainStore?.base?.providerAuth || {};
    const authEntry = providerAuth[provider] || {};
    let apiKey = String(authEntry?.plain || "").trim();
    if (!apiKey && provider === "deepseek") apiKey = String(xbrainStore?.base?.deepseekApiKey || "").trim();
    if (!apiKey) apiKey = String(process.env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_KEY || "").trim();
    return { provider, model: modelId, apiKey, apiBase: "" };
  },
});

// ─── Model Switch Intent Skill ───────────────────────────────────────
const { extractModelSwitchIntent } = createModelSwitchIntentSkill({
  runOpenClawCommand, parseJsonSafe, extractAgentReply, normalizeSessionId,
});

// ─── Agent Runtime ───────────────────────────────────────────────────
function buildLocalAgentEnvFromStore() {
  const env = {};
  const key = String(xbrainStore?.base?.deepseekApiKey || "").trim();
  if (key) { env.DEEPSEEK_API_KEY = key; env.DEEPSEEK_KEY = key; }
  return env;
}

const { runAgentTurn } = createAgentRuntime({
  runOpenClawCommand, parseJsonSafe,
  waitGatewayHealthy, startGateway,
  looksLikeGatewayTransportError, buildLocalAgentEnvFromStore,
  normalizeSessionId, getCurrentRuntimeModelRefFromStore,
});

// ─── Static File Server ──────────────────────────────────────────────
const serveStatic = createStaticFileServer({ reportDir: REPORT_DIR, webDir: WEB_DIR });

// ─── Status Handler ──────────────────────────────────────────────────
async function handleStatus(req, res) {
  const versionRes = await runOpenClawCommand(["--version"], { timeoutMs: 20_000 });
  const versionText = versionRes.stdout.trim() || versionRes.stderr.trim();
  const stateDir = path.join(os.homedir(), ".openclaw");
  const defaultConfigPath = path.join(stateDir, "openclaw.json");
  const legacyConfigPath = path.join(stateDir, "config.json");
  const healthRes = await runOpenClawCommand(["gateway", "health", "--json"], { timeoutMs: 8_000 });
  const healthJson = parseJsonSafe(healthRes.stdout);
  const modelsRes = await runOpenClawCommand(["models", "status", "--json"], { timeoutMs: 15_000 });
  const modelsJson = parseJsonSafe(modelsRes.stdout);
  const configPath = typeof modelsJson?.configPath === "string" && modelsJson.configPath.trim()
    ? modelsJson.configPath
    : fs.existsSync(defaultConfigPath) ? defaultConfigPath : legacyConfigPath;
  const configExists = fs.existsSync(configPath) || fs.existsSync(defaultConfigPath) || fs.existsSync(legacyConfigPath);
  sendJson(res, 200, {
    ok: true,
    openclaw: { available: versionRes.ok, version: versionText, source: versionRes.source },
    config: { path: configPath, exists: configExists },
    gateway: {
      managedByThunderClaw: gatewayIsRunning(), pid: gatewayState.pid,
      startedAt: gatewayState.startedAt, healthy: healthRes.ok, health: healthJson,
      healthError: healthRes.ok ? null : (healthRes.stderr || healthRes.stdout || "").trim() || null,
      logsTail: gatewayState.logs.slice(-60),
    },
    models: { ok: modelsRes.ok, status: modelsJson, error: modelsRes.ok ? null : (modelsRes.stderr || modelsRes.stdout || "").trim() || null },
    oauth: getOauthStatus(),
    onboarding: { simpleReady: Boolean(versionRes.ok && configExists && healthRes.ok), recommendedProvider: "deepseek-api-key", tip: "推荐先用 DeepSeek API Key 一键完成基础配置。" },
  });
}

// ─── Handler Factories ───────────────────────────────────────────────
const { handleOpenClawConsoleStatus, handleOpenClawCronList, handleOpenClawCronAdd, handleOpenClawCronRemove, handleOpenClawCronToggle, handleOpenClawConfigGet, handleOpenClawConfigSet, handleOpenClawConfigUnset } = createOpenClawConsoleHandlers({ runOpenClawCommand, parseJsonSafe, readJsonBody, sendJson, getGatewayLogs: () => gatewayState.logs });
const { handleTelegramHealth, handleTelegramTest, handleTelegramHandshake } = createTelegramHandlers({ sendJson, readJsonBody, getStore: () => xbrainStore, saveStore: saveXbrainStore });

const { handleSetup, handleQuickSetup, handleOAuthStart, handleOAuthStatus, handleSetModel, handleChat, handleAiChat, handleConfigChat, handleAiHealth, handleChatHistory, handleChatCardStatus } = createChatConfigHandlers({
  normalizeProviderKey, uniqStrings, inferProviderFromModelRef, PROVIDER_DEFAULT_MODEL_REFS,
  readJsonBody, runSetupFromInput, sendJson, runOpenClawCommand,
  switchThunderSessionModel, waitGatewayHealthy, startGateway,
  startOAuthLogin, getOauthStatus, getXbrainStateSnapshot, runAgentTurn,
  appendChatEvent, syncXbrainFromOpenClaw, getCurrentRuntimeModelRefFromStore,
  refreshRuntimeModelFromSession, extractModelSwitchIntent,
  saveXbrainStore: saveXbrainStore, toModelRef, maskSecret, parseJsonSafe,
  extractTradingIntentCandidates, updateChatCardStatus,
  xbrainStore, chatHistory, gatewayState,
});

const { handleXbrainState, handleXbrainUpdate, handleXbrainModelSwitch, handleXbrainModelsCatalog, handleXbrainModelConnect, handleXbrainModelDisconnect, handleXbrainAuthStart, handleXbrainAuthStatus, handleXbrainAuthInput, handleXbrainAuthDisconnect, handleXbrainProviderRemove, handleXbrainLock } = createXbrainCoreHandlers({
  readJsonBody, buildXbrainState, sendJson,
  sanitizeProviderCatalog, uniqStrings, maskSecret,
  runSetupFromInput, runOpenClawCommand, switchThunderSessionModel,
  syncXbrainFromOpenClaw, getXbrainStateSnapshot, normalizeProviderKey,
  toModelRef, inferProviderFromModelRef, listOpenClawModelsCatalog,
  PROVIDER_DEFAULT_MODEL_REFS, providerSupportsApiKey, providerSupportsOAuth,
  isProviderConfigured, PROVIDER_TO_SETUP_PROVIDER, PROVIDER_TO_OAUTH_PROVIDER,
  tuneDeepseekDefaults, ensureProviderAuthEntry, startOAuthLogin,
  sleepMs, getOauthStatus, providerAuthType, saveXbrainStore,
  submitOauthPromptInput, xbrainStore,
});

const { handleStrategyFeatures, handleStrategyFeatureDelete, handleStrategyVersions, handleStrategyVersionsPropose, handleStrategyVersionsEvaluate, handleStrategyArtifactReport, handleStrategyIntentCandidates, handleStrategyIntentGenerateCode, handleStrategyIntentApply, handleStrategyEntities, handleStrategyEntityDetail, handleStrategyEntityDraftSave, handleStrategyEntityReplay, handleStrategyEntityPublish, handleStrategyEntityStatus, handleStrategyEntityAudits, handleStrategyEntityDelete } = createStrategyLabHandlers({
  readJsonBody, sendJson, strategyLabStore,
  extractTradingIntentCandidates, generateFeatureCodeForCandidate,
  getCurrentRuntimeModelRefFromStore, updateChatCardStatus,
});

// ─── Gateway Handlers ────────────────────────────────────────────────
async function handleGatewayStart(_req, res) { sendJson(res, 200, { ok: true, ...startGateway() }); }
async function handleGatewayStop(_req, res) { sendJson(res, 200, { ok: true, ...stopGateway() }); }
async function handleGatewayLogs(_req, res) { sendJson(res, 200, { ok: true, logs: gatewayState.logs }); }

// ─── Router ──────────────────────────────────────────────────────────
const apiRouter = createHttpRouter(buildApiRouteTable({
  handleStatus, handleSetup, handleQuickSetup, handleSetModel,
  handleOAuthStart, handleOAuthStatus, handleGatewayStart, handleGatewayStop, handleGatewayLogs,
  handleAiHealth, handleAiChat, handleConfigChat, handleChatHistory, handleChatCardStatus,
  handleXbrainState, handleXbrainUpdate, handleXbrainModelSwitch, handleXbrainModelsCatalog,
  handleXbrainModelConnect, handleXbrainModelDisconnect, handleXbrainAuthStatus, handleXbrainAuthStart,
  handleXbrainAuthInput, handleXbrainAuthDisconnect, handleXbrainProviderRemove, handleXbrainLock,
  handleTelegramHealth, handleTelegramTest, handleTelegramHandshake,
  handleOpenClawConsoleStatus, handleOpenClawCronList, handleOpenClawCronAdd, handleOpenClawCronRemove,
  handleOpenClawCronToggle, handleOpenClawConfigGet, handleOpenClawConfigSet, handleOpenClawConfigUnset,
  handleStrategyFeatures, handleStrategyFeatureDelete, handleStrategyVersions, handleStrategyVersionsPropose,
  handleStrategyVersionsEvaluate, handleStrategyArtifactReport, handleStrategyIntentCandidates,
  handleStrategyIntentGenerateCode, handleStrategyIntentApply, handleStrategyEntities, handleStrategyEntityDetail,
  handleStrategyEntityDraftSave, handleStrategyEntityReplay, handleStrategyEntityPublish,
  handleStrategyEntityStatus, handleStrategyEntityAudits, handleStrategyEntityDelete, handleChat,
}));

// ─── HTTP Server ─────────────────────────────────────────────────────
async function requestHandler(req, res) {
  try {
    const handled = await apiRouter.dispatch(req, res);
    if (handled) return;
    await serveStatic(req, res);
  } catch (error) {
    sendJson(res, 500, { ok: false, error: String(error) });
  }
}

export function startThunderClawServer(options = {}) {
  const port = Number.parseInt(String(options.port ?? DEFAULT_PORT), 10) || DEFAULT_PORT;
  const host = String(options.host ?? "127.0.0.1");
  const server = http.createServer((req, res) => void requestHandler(req, res));
  server.listen(port, host, () => {
    console.log(`ThunderClaw server running at http://${host}:${port}`);
    console.log("Open / for ThunderClaw product pages (虾脑/虾线/虾海/虾策).");
  });
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startThunderClawServer();
}
