/**
 * ThunderClaw Server — Composition Root
 *
 * Wires all modules together and starts the HTTP server.
 * Uses LLM client directly for all AI operations.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import {
  ROOT_DIR, WEB_DIR, REPORT_DIR, MEMORY_DIR,
  XBRAIN_STATE_PATH, CHAT_HISTORY_PATH, STRATEGY_LAB_STATE_PATH,
  DEFAULT_PORT, MAX_CHAT_EVENTS,
} from "./config.js";

import { createXbrainStoreManager } from "./core/xbrain-store.js";
import { createChatHistoryStore } from "./core/chat-history-store.js";
import { createConversationContextManager } from "./core/conversation-context.js";
import { createMemoryLayer } from "./core/memory-layer.js";
import { createStrategyLabStore } from "./core/strategy-lab-store.js";
import { createFreqtradeBacktestAdapter } from "./core/freqtrade-backtest-adapter.js";
import { createTradingIntentSkill } from "./core/trading-intent-skill.js";
import { createChatHandler } from "./handlers/chat.js";
import { createSessionHandlers } from "./handlers/session.js";
import { createXbrainHandlers } from "./handlers/xbrain.js";
import { createStrategyLabHandlers } from "./handlers/strategy-lab.js";
import { createHttpRouter } from "./http/router.js";
import { buildApiRouteTable } from "./http/route-table.js";
import {
  inferProviderFromModelRef,
  normalizeProviderKey,
  PROVIDER_DEFAULT_MODEL_REFS,
  providerAuthType,
  providerSupportsApiKey,
  providerSupportsOAuth,
  toModelRef,
} from "./domain/model-provider.js";
import { sendJson, readJsonBody, createStaticFileServer } from "./lib/http-helpers.js";
import {
  parseJsonSafe, uniqStrings, maskSecret,
  sanitizeProviderCatalogForStore, commandExistsSync,
} from "./lib/utils.js";

// ─── Xbrain Store (model configuration) ─────────────────────────────
const {
  xbrainStore, saveXbrainStore, ensureProviderAuthEntry,
  isProviderConfigured,
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

// ─── Conversation Context ────────────────────────────────────────────
const conversationContext = createConversationContextManager({ memoryDir: MEMORY_DIR });

// ─── Model Config (reads from xbrainStore, follows model switching) ──
function getModelConfig() {
  const provider = String(xbrainStore?.base?.runtimeModelProvider || "").trim().toLowerCase();
  const modelId = String(xbrainStore?.base?.runtimeModelId || "").trim();
  const providerAuth = xbrainStore?.base?.providerAuth || {};
  const authEntry = providerAuth[provider] || {};
  let apiKey = String(authEntry?.plain || "").trim();
  if (!apiKey) apiKey = String(xbrainStore?.base?.deepseekApiKey || "").trim();
  if (!apiKey) apiKey = String(process.env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_KEY || "").trim();
  // Try all provider env vars as fallback
  if (!apiKey) {
    const envKeys = { openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY", gemini: "GEMINI_API_KEY" };
    if (envKeys[provider]) apiKey = String(process.env[envKeys[provider]] || "").trim();
  }
  return { provider: provider || "deepseek", model: modelId || "deepseek-chat", apiKey, apiBase: "" };
}

function getCurrentRuntimeModelRef() {
  const state = xbrainStore?.base || {};
  return toModelRef(state.runtimeModelProvider, state.runtimeModelId);
}

// ─── Freqtrade Backtest Engine ───────────────────────────────────────
function resolveFreqtradeCmd() {
  const userSpecified = String(process.env.THUNDERCLAW_FREQTRADE_CMD || "").trim();
  if (userSpecified && commandExistsSync(spawnSync, userSpecified)) return userSpecified;
  const managedCmd = path.join(ROOT_DIR, ".thunderclaw", "freqtrade-venv", "bin", "freqtrade");
  if (commandExistsSync(spawnSync, managedCmd)) {
    process.env.THUNDERCLAW_FREQTRADE_CMD = managedCmd;
    return managedCmd;
  }
  if (commandExistsSync(spawnSync, "freqtrade")) return "freqtrade";
  throw new Error("[ThunderClaw] freqtrade not found. Run: bash scripts/setup-install-freqtrade.sh");
}

const freqtradeCmd = resolveFreqtradeCmd();
const freqtradeBacktestAdapter = createFreqtradeBacktestAdapter({
  enabled: process.env.THUNDERCLAW_ENABLE_FREQTRADE,
  command: freqtradeCmd,
});
const ftAvail = freqtradeBacktestAdapter.checkAvailability();
if (!ftAvail.ok) throw new Error(`[ThunderClaw] freqtrade unavailable: ${ftAvail.error}`);
console.warn(`[ThunderClaw] backtest engine: freqtrade (${ftAvail.version})`);

// ─── Strategy Lab Store ──────────────────────────────────────────────
const strategyLabStore = createStrategyLabStore({
  statePath: STRATEGY_LAB_STATE_PATH,
  backtestEngine: freqtradeBacktestAdapter,
});

// ─── Memory Layer (L1-L3) ────────────────────────────────────────────
const memoryLayer = createMemoryLayer({
  conversationContext,
  strategyLabStore,
});

// ─── Trading Intent Skill ────────────────────────────────────────────
const {
  extractTradingIntentCandidates,
  generateFeatureCodeForCandidate,
  detectAndClarify,
  generateFromClarification,
  generateWithAgentLoop,
} = createTradingIntentSkill({ getModelConfig });

// ─── Handlers ────────────────────────────────────────────────────────
const chatHandler = createChatHandler({
  readJsonBody, sendJson, appendChatEvent,
  getXbrainStateSnapshot: () => ({ base: { ...xbrainStore.base } }),
  getCurrentRuntimeModelRef, getModelConfig,
  detectAndClarify, strategyLabStore,
  conversationContext, memoryLayer,
  updateChatCardStatus,
  chatHistory,
});

const sessionHandlers = createSessionHandlers({
  readJsonBody, sendJson, conversationContext, memoryLayer,
});

const xbrainHandlers = createXbrainHandlers({
  readJsonBody, sendJson, xbrainStore, saveXbrainStore,
  normalizeProviderKey, inferProviderFromModelRef,
  PROVIDER_DEFAULT_MODEL_REFS, providerSupportsApiKey,
  ensureProviderAuthEntry, isProviderConfigured,
  maskSecret, uniqStrings, toModelRef,
});

const strategyLabHdl = createStrategyLabHandlers({
  readJsonBody, sendJson, strategyLabStore,
  extractTradingIntentCandidates, generateFeatureCodeForCandidate,
  detectAndClarify, generateFromClarification, generateWithAgentLoop,
  getCurrentRuntimeModelRefFromStore: getCurrentRuntimeModelRef,
  updateChatCardStatus,
  backtestEngine: freqtradeBacktestAdapter,
  conversationContext, memoryLayer,
});

// ─── Status ──────────────────────────────────────────────────────────
async function handleStatus(_req, res) {
  const modelConfig = getModelConfig();
  sendJson(res, 200, {
    ok: true,
    version: "thunderclaw-standalone",
    model: {
      provider: modelConfig.provider,
      model: modelConfig.model,
      hasKey: Boolean(modelConfig.apiKey),
    },
    features: strategyLabStore.getStats(),
    freqtrade: { ok: ftAvail.ok, version: ftAvail.version },
  });
}

// ─── Static Files ────────────────────────────────────────────────────
const serveStatic = createStaticFileServer({ reportDir: REPORT_DIR, webDir: WEB_DIR });

// ─── Router ──────────────────────────────────────────────────────────
const apiRouter = createHttpRouter(buildApiRouteTable({
  handleStatus,
  // Chat
  handleAiChat: chatHandler.handleAiChat,
  handleAiChatStream: chatHandler.handleAiChatStream,
  handleChatHistory: chatHandler.handleChatHistory,
  handleChatCardStatus: chatHandler.handleChatCardStatus,
  // Session
  handleSessionArchive: sessionHandlers.handleSessionArchive,
  handleSessionList: sessionHandlers.handleSessionList,
  handleSessionRestore: sessionHandlers.handleSessionRestore,
  // Xbrain (model config)
  handleXbrainState: xbrainHandlers.handleXbrainState,
  handleXbrainUpdate: xbrainHandlers.handleXbrainUpdate,
  handleXbrainModelSwitch: xbrainHandlers.handleXbrainModelSwitch,
  // Strategy Lab
  ...strategyLabHdl,
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
    console.log(`ThunderClaw running at http://${host}:${port}`);
  });
  return server;
}
