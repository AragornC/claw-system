#!/usr/bin/env node
/**
 * 本地服务：以 memory/report 为根目录提供报告页与数据文件，
 * 供 index.html 通过 fetch('decisions.json') / fetch('ohlcv.json') 加载数据。
 * 同时提供 AI 桥接接口，将聊天请求转发到 OpenClaw。
 *
 * Usage: node scripts/serve-report.js [port]
 * Default port: 8765
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKDIR = process.env.OPENCLAW_WORKDIR || process.cwd();
const REPORT_DIR = path.resolve(WORKDIR, 'memory/report');
const LOCAL_ENV_PATH = path.resolve(WORKDIR, '.env.local');
const PORT = parseInt(process.argv[2], 10) || 8765;
const OPENCLAW_REPO_ENTRY = path.resolve(WORKDIR, 'openclaw/openclaw.mjs');
const OPENCLAW_REPO_MODULES = path.resolve(WORKDIR, 'openclaw/node_modules');
const OPENCLAW_AGENT_ID = (process.env.OPENCLAW_AGENT_ID || 'main').trim() || 'main';
const OPENCLAW_CHANNEL = (process.env.OPENCLAW_CHANNEL || '').trim();
const OPENCLAW_SESSION_ID = (process.env.OPENCLAW_SESSION_ID || '').trim();
const OPENCLAW_TO = (process.env.OPENCLAW_TO || '').trim();
const OPENCLAW_THINKING = (process.env.OPENCLAW_THINKING || '').trim();
const OPENCLAW_VERBOSE = (process.env.OPENCLAW_VERBOSE || '').trim();
const OPENCLAW_REPLY_CHANNEL = (process.env.OPENCLAW_REPLY_CHANNEL || '').trim();
const OPENCLAW_REPLY_TO = (process.env.OPENCLAW_REPLY_TO || '').trim();
const OPENCLAW_REPLY_ACCOUNT = (process.env.OPENCLAW_REPLY_ACCOUNT || '').trim();
const OPENCLAW_DELIVER = /^(1|true|yes|on)$/i.test(
  String(process.env.OPENCLAW_DELIVER || ''),
);
const OPENCLAW_AGENT_LOCAL = /^(1|true|yes|on)$/i.test(
  String(process.env.OPENCLAW_AGENT_LOCAL || ''),
);
const OPENCLAW_TIMEOUT_SEC = positiveInt(process.env.OPENCLAW_TIMEOUT_SEC, 90);
const OPENCLAW_CHAT_TIMEOUT_MS = positiveInt(process.env.OPENCLAW_CHAT_TIMEOUT_MS, 95_000);
const JSON_BODY_LIMIT = 64 * 1024;
const REPORT_DECISIONS_PATH = path.resolve(REPORT_DIR, 'decisions.json');
const REPORT_ORDERS_PATH = path.resolve(REPORT_DIR, 'orders.json');
const REPORT_OHLCV_PATH = path.resolve(REPORT_DIR, 'ohlcv.json');
const TRADES_JSONL_PATH = path.resolve(WORKDIR, 'memory/bitget-perp-autotrade-trades.jsonl');
const OPENCLAW_CONTEXT_MAX_DECISIONS = positiveInt(process.env.OPENCLAW_CONTEXT_MAX_DECISIONS, 36);
const OPENCLAW_CONTEXT_TIMELINE_EVENTS = positiveInt(
  process.env.OPENCLAW_CONTEXT_TIMELINE_EVENTS,
  18,
);
const OPENCLAW_CONTEXT_MAX_ORDERS = positiveInt(process.env.OPENCLAW_CONTEXT_MAX_ORDERS, 12);
const TELEGRAM_BOT_TOKEN = (
  process.env.THUNDERCLAW_TELEGRAM_BOT_TOKEN ||
  process.env.TELEGRAM_BOT_TOKEN ||
  process.env.OPENCLAW_TELEGRAM_BOT_TOKEN ||
  ''
).trim();
const TELEGRAM_ENABLED = Boolean(TELEGRAM_BOT_TOKEN);
const TELEGRAM_API_BASE = TELEGRAM_ENABLED
  ? 'https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN
  : '';
const TELEGRAM_ALLOWED_CHAT_IDS = new Set(
  String(process.env.THUNDERCLAW_TELEGRAM_ALLOWED_CHAT_IDS || process.env.TELEGRAM_ALLOWED_CHAT_IDS || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean),
);
const TELEGRAM_POLL_TIMEOUT_SEC = Math.max(
  5,
  Math.min(50, positiveInt(process.env.THUNDERCLAW_TELEGRAM_POLL_TIMEOUT_SEC, 25)),
);
const TELEGRAM_RETRY_MS = Math.max(300, positiveInt(process.env.THUNDERCLAW_TELEGRAM_RETRY_MS, 1800));
const TELEGRAM_EVENTS_MAX = Math.max(20, positiveInt(process.env.THUNDERCLAW_TELEGRAM_EVENTS_MAX, 240));
const TELEGRAM_AUTO_REPLY = !/^(0|false|off|no)$/i.test(
  String(process.env.THUNDERCLAW_TELEGRAM_AUTO_REPLY || '1'),
);
const TELEGRAM_PUSH_TRADES = !/^(0|false|off|no)$/i.test(
  String(process.env.THUNDERCLAW_TELEGRAM_PUSH_TRADES || '1'),
);
const TELEGRAM_PUSH_CHAT_IDS = String(
  process.env.THUNDERCLAW_TELEGRAM_PUSH_CHAT_IDS || '',
)
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean);
const TELEGRAM_PUSH_INTERVAL_MS = Math.max(
  1_500,
  positiveInt(process.env.THUNDERCLAW_TELEGRAM_PUSH_INTERVAL_MS, 4_000),
);
const TELEGRAM_PUSH_SCAN_LIMIT = Math.max(
  12,
  positiveInt(process.env.THUNDERCLAW_TELEGRAM_PUSH_SCAN_LIMIT, 80),
);
const TELEGRAM_PUSH_EVENTS = new Set(
  String(process.env.THUNDERCLAW_TELEGRAM_PUSH_EVENTS || 'open,close,risk')
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter((v) => v === 'open' || v === 'close' || v === 'risk'),
);
if (!TELEGRAM_PUSH_EVENTS.size) {
  TELEGRAM_PUSH_EVENTS.add('open');
  TELEGRAM_PUSH_EVENTS.add('close');
  TELEGRAM_PUSH_EVENTS.add('risk');
}
const TELEGRAM_POLL_LOCK_KEY = TELEGRAM_ENABLED
  ? createHash('sha1').update(TELEGRAM_BOT_TOKEN, 'utf8').digest('hex').slice(0, 12)
  : 'disabled';
const TELEGRAM_POLL_LOCK_PATH = path.resolve(WORKDIR, 'memory/.telegram-poll.' + TELEGRAM_POLL_LOCK_KEY + '.lock');
const TELEGRAM_POLL_LOCK_STALE_MS = Math.max(
  20_000,
  positiveInt(process.env.THUNDERCLAW_TELEGRAM_POLL_LOCK_STALE_MS, 180_000),
);
const TELEGRAM_INBOUND_DEDUPE_DIR = path.resolve(
  WORKDIR,
  'memory/.telegram-inbound-dedupe.' + TELEGRAM_POLL_LOCK_KEY,
);
const TELEGRAM_INBOUND_DEDUPE_TTL_MS = Math.max(
  6 * 3600 * 1000,
  positiveInt(process.env.THUNDERCLAW_TELEGRAM_INBOUND_DEDUPE_TTL_MS, 7 * 24 * 3600 * 1000),
);
const THUNDERCLAW_RUNTIME_DIR = path.resolve(
  process.env.THUNDERCLAW_RUNTIME_DIR || path.join(os.homedir(), '.thunderclaw', 'runtime'),
);
const THUNDERCLAW_SERVICE_LOCK_KEY = TELEGRAM_ENABLED ? 'tg-' + TELEGRAM_POLL_LOCK_KEY : 'port-' + String(PORT);
const THUNDERCLAW_SERVICE_LOCK_PATH = path.resolve(
  THUNDERCLAW_RUNTIME_DIR,
  'serve-report.' + THUNDERCLAW_SERVICE_LOCK_KEY + '.lock',
);
const THUNDERCLAW_SERVICE_LOCK_STALE_MS = Math.max(
  30_000,
  positiveInt(process.env.THUNDERCLAW_SERVICE_LOCK_STALE_MS, 8 * 60 * 1000),
);
const CHAT_HISTORY_PATH = path.resolve(WORKDIR, 'memory/chat-history.jsonl');
const CHAT_HISTORY_MAX = Math.max(200, positiveInt(process.env.THUNDERCLAW_CHAT_HISTORY_MAX, 2400));
const TELEGRAM_EVENTS_PATH = path.resolve(WORKDIR, 'memory/telegram-events.jsonl');
const TELEGRAM_EVENTS_LOAD = Math.max(100, positiveInt(process.env.THUNDERCLAW_TELEGRAM_EVENTS_LOAD, 1200));

const TRADER_MEMORY_PATH = path.resolve(WORKDIR, 'memory/trader-memory.jsonl');
const TRADER_SHORT_MEMORY_PATH = path.resolve(WORKDIR, 'memory/trader-memory-short.json');
const TRADER_PROFILE_PATH = path.resolve(WORKDIR, 'memory/trader-mid-profile.json');
const STRATEGY_WEIGHTS_PATH = path.resolve(WORKDIR, 'memory/strategy-feedback-weights.json');
const STRATEGY_ARTIFACTS_JSONL_PATH = path.resolve(WORKDIR, 'memory/strategy-artifacts.jsonl');
const STRATEGY_ARTIFACTS_STATE_PATH = path.resolve(WORKDIR, 'memory/strategy-artifacts-state.json');
const TRADER_MEMORY_MAX_ITEMS = Math.max(
  200,
  positiveInt(process.env.THUNDERCLAW_MEMORY_MAX_ITEMS, 4000),
);
const TRADER_SHORT_MEMORY_MAX_ITEMS = Math.max(
  20,
  positiveInt(process.env.THUNDERCLAW_MEMORY_SHORT_MAX_ITEMS, 120),
);
const TRADER_MEMORY_RETRIEVE_TOPK = Math.max(
  2,
  Math.min(20, positiveInt(process.env.THUNDERCLAW_MEMORY_RETRIEVE_TOPK, 8)),
);
const TRADER_MEMORY_RECENT_WINDOW = Math.max(
  20,
  positiveInt(process.env.THUNDERCLAW_MEMORY_RECENT_WINDOW, 200),
);
const TRADER_MEMORY_VECTOR_DIM = Math.max(
  32,
  Math.min(512, positiveInt(process.env.THUNDERCLAW_MEMORY_VECTOR_DIM, 128)),
);
const TRADER_MEMORY_SHORT_RETRIEVE_TOPK = Math.max(
  2,
  Math.min(16, positiveInt(process.env.THUNDERCLAW_MEMORY_SHORT_RETRIEVE_TOPK, 6)),
);
const TRADER_MID_TOP_STRATEGIES = Math.max(
  2,
  Math.min(12, positiveInt(process.env.THUNDERCLAW_MEMORY_MID_TOP_STRATEGIES, 6)),
);
const STRATEGY_FEEDBACK_LR = Math.max(
  0.02,
  Math.min(1, Number(process.env.THUNDERCLAW_STRATEGY_FEEDBACK_LR || '0.16')),
);
const STRATEGY_FEEDBACK_MIN_WEIGHT = Number(process.env.THUNDERCLAW_STRATEGY_FEEDBACK_MIN_WEIGHT || '-1.5');
const STRATEGY_FEEDBACK_MAX_WEIGHT = Number(process.env.THUNDERCLAW_STRATEGY_FEEDBACK_MAX_WEIGHT || '1.5');
const STRATEGY_FEEDBACK_TRADE_PNL_SCALE = Math.max(
  0.001,
  Number(process.env.THUNDERCLAW_STRATEGY_FEEDBACK_TRADE_PNL_SCALE || '0.01'),
);
const STRATEGY_FEEDBACK_SCAN_LIMIT = Math.max(
  100,
  positiveInt(process.env.THUNDERCLAW_STRATEGY_FEEDBACK_SCAN_LIMIT, 1200),
);
const STRATEGY_FEEDBACK_PROCESSED_MAX = Math.max(
  200,
  positiveInt(process.env.THUNDERCLAW_STRATEGY_FEEDBACK_PROCESSED_MAX, 6000),
);
const STRATEGY_ARTIFACTS_MAX_ITEMS = Math.max(
  80,
  positiveInt(process.env.THUNDERCLAW_STRATEGY_ARTIFACTS_MAX_ITEMS, 1200),
);
const STRATEGY_ARTIFACTS_REPORT_KEYS_MAX = Math.max(
  200,
  positiveInt(process.env.THUNDERCLAW_STRATEGY_ARTIFACTS_REPORT_KEYS_MAX, 6000),
);
const STRATEGY_ARTIFACTS_TOPK = Math.max(
  3,
  Math.min(24, positiveInt(process.env.THUNDERCLAW_STRATEGY_ARTIFACTS_TOPK, 8)),
);
const STRATEGY_ARTIFACT_LR = Math.max(
  0.02,
  Math.min(1, Number(process.env.THUNDERCLAW_STRATEGY_ARTIFACT_LR || '0.18')),
);
const STRATEGY_ARTIFACT_MIN_WEIGHT = Number(process.env.THUNDERCLAW_STRATEGY_ARTIFACT_MIN_WEIGHT || '-2');
const STRATEGY_ARTIFACT_MAX_WEIGHT = Number(process.env.THUNDERCLAW_STRATEGY_ARTIFACT_MAX_WEIGHT || '2');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

let telegramUpdateOffset = 0;
let telegramEventSeq = 0;
const telegramEvents = [];
let telegramPollTimer = null;
let telegramTradePushTimer = null;
let telegramPollLockFd = null;
let telegramPollLockAcquired = false;
let thunderclawServiceLockFd = null;
let thunderclawServiceLockAcquired = false;
let telegramInboundDedupeLastCleanupAt = 0;
const telegramKnownChatIds = new Set();
const telegramTradeKnownEventKeys = new Set();
const telegramTradeSentAck = new Set();
let chatHistorySeq = 0;
const chatHistory = [];
const traderMemoryState = {
  loaded: false,
  linesRead: 0,
  entries: [],
  keys: new Set(),
  lastLoadAt: null,
};
const shortTermMemoryState = {
  loaded: false,
  items: [],
  lastSavedAt: null,
};
const strategyFeedbackState = {
  loaded: false,
  processedTradeKeys: new Set(),
  strategies: {},
  lastLearnAt: null,
  lastSavedAt: null,
};
const strategyArtifactState = {
  loaded: false,
  artifacts: {},
  reportKeys: new Set(),
  lastUpdatedAt: null,
  lastSavedAt: null,
};
const midTermMemoryState = {
  profile: null,
  lastBuiltAt: null,
};
const runtimeState = {
  serviceLock: {
    path: THUNDERCLAW_SERVICE_LOCK_PATH,
    acquired: false,
    ownerPid: null,
    reason: null,
  },
};
const telegramState = {
  enabled: TELEGRAM_ENABLED,
  pollActive: false,
  connected: false,
  lastPollAt: null,
  lastInboundAt: null,
  lastOutboundAt: null,
  lastError: null,
  lastUpdateId: null,
  droppedUpdates: 0,
  allowedChatIds: Array.from(TELEGRAM_ALLOWED_CHAT_IDS),
  pollLock: {
    path: TELEGRAM_POLL_LOCK_PATH,
    acquired: false,
    ownerPid: null,
    reason: null,
  },
  dedupe: {
    path: TELEGRAM_INBOUND_DEDUPE_DIR,
    ttlMs: TELEGRAM_INBOUND_DEDUPE_TTL_MS,
    claimed: 0,
    duplicates: 0,
    lastKey: null,
    lastClaimAt: null,
    lastDuplicateAt: null,
    lastError: null,
  },
  conflicts: {
    count: 0,
    lastAt: null,
    lastMessage: null,
  },
  push: {
    enabled: TELEGRAM_ENABLED && TELEGRAM_PUSH_TRADES,
    events: Array.from(TELEGRAM_PUSH_EVENTS),
    configuredChatIds: TELEGRAM_PUSH_CHAT_IDS.slice(),
    active: false,
    lastRunAt: null,
    lastSentAt: null,
    lastError: null,
    lastSentPreview: null,
    sentCount: 0,
    skippedNoTarget: 0,
  },
};

function positiveInt(raw, fallback) {
  const n = Number.parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function truncText(text, maxLen = 2000) {
  const s = String(text || '');
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + '…';
}

function nowIso() {
  return new Date().toISOString();
}

function safeErrMsg(err, fallback = 'unknown error') {
  const msg = String(err?.message || err || fallback).trim();
  return truncText(msg || fallback, 320);
}

function sha1(textLike) {
  return createHash('sha1').update(String(textLike || ''), 'utf8').digest('hex');
}

function fmtTsForMsg(tsLike) {
  const ms = toMs(tsLike);
  if (ms == null) return '-';
  return new Date(ms).toLocaleString('zh-CN', {
    hour12: false,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function fmtPriceNum(v, digits = 2) {
  const n = toNum(v);
  return n == null ? '-' : n.toFixed(digits);
}

function eventIdentity(order, fallbackTs, suffix = '') {
  const trade = order?.tradeId != null ? String(order.tradeId) : '';
  const cycle = order?.cycleId != null ? String(order.cycleId) : '';
  if (trade) return 'trade:' + trade + (suffix ? ':' + suffix : '');
  if (cycle) return 'cycle:' + cycle + (suffix ? ':' + suffix : '');
  const ts = toMs(fallbackTs);
  if (ts != null) return 'ts:' + String(ts) + (suffix ? ':' + suffix : '');
  return 'unknown:' + String(Math.random()).slice(2, 8) + (suffix ? ':' + suffix : '');
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function safeJsonRead(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!String(raw || '').trim()) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function parseEnvPairs(rawText) {
  const lines = String(rawText || '').split(/\r?\n/);
  const pairs = {};
  const indexByKey = new Map();
  lines.forEach((line, idx) => {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) return;
    const key = m[1];
    const val = m[2] ?? '';
    pairs[key] = val;
    indexByKey.set(key, idx);
  });
  return { lines, pairs, indexByKey };
}

function writeEnvLocal(updates) {
  const raw = fs.existsSync(LOCAL_ENV_PATH) ? fs.readFileSync(LOCAL_ENV_PATH, 'utf8') : '';
  const { lines, pairs, indexByKey } = parseEnvPairs(raw);
  const next = { ...pairs };
  Object.entries(updates || {}).forEach(([k, v]) => {
    if (!k) return;
    next[k] = v == null ? '' : String(v);
  });
  Object.entries(updates || {}).forEach(([k]) => {
    if (!k) return;
    const line = k + '=' + (next[k] ?? '');
    if (indexByKey.has(k)) lines[indexByKey.get(k)] = line;
    else lines.push(line);
  });
  const content = lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '\n');
  fs.writeFileSync(LOCAL_ENV_PATH, content, 'utf8');
  try { fs.chmodSync(LOCAL_ENV_PATH, 0o600); } catch {}
  return next;
}

function readEnvLocalPairs() {
  const raw = fs.existsSync(LOCAL_ENV_PATH) ? fs.readFileSync(LOCAL_ENV_PATH, 'utf8') : '';
  return parseEnvPairs(raw).pairs;
}

function isPidAlive(pidLike) {
  const pid = Number(pidLike);
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readTelegramPollLockFile() {
  try {
    if (!fs.existsSync(TELEGRAM_POLL_LOCK_PATH)) return null;
    const raw = fs.readFileSync(TELEGRAM_POLL_LOCK_PATH, 'utf8');
    if (!String(raw || '').trim()) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function releaseTelegramPollLock() {
  if (!telegramPollLockAcquired) return;
  telegramPollLockAcquired = false;
  telegramState.pollLock.acquired = false;
  telegramState.pollLock.ownerPid = null;
  telegramState.pollLock.reason = 'released';
  try {
    if (telegramPollLockFd != null) fs.closeSync(telegramPollLockFd);
  } catch {}
  telegramPollLockFd = null;
  try {
    if (fs.existsSync(TELEGRAM_POLL_LOCK_PATH)) fs.unlinkSync(TELEGRAM_POLL_LOCK_PATH);
  } catch {}
}

function acquireTelegramPollLock() {
  if (!TELEGRAM_ENABLED) return false;
  const tokenHash = sha1(TELEGRAM_BOT_TOKEN).slice(0, 14);
  fs.mkdirSync(path.dirname(TELEGRAM_POLL_LOCK_PATH), { recursive: true });
  for (let i = 0; i < 2; i++) {
    try {
      const fd = fs.openSync(TELEGRAM_POLL_LOCK_PATH, 'wx', 0o600);
      const payload = {
        pid: process.pid,
        tokenHash,
        startedAt: Date.now(),
      };
      fs.writeFileSync(fd, JSON.stringify(payload), 'utf8');
      telegramPollLockFd = fd;
      telegramPollLockAcquired = true;
      telegramState.pollLock.acquired = true;
      telegramState.pollLock.ownerPid = process.pid;
      telegramState.pollLock.reason = null;
      return true;
    } catch (err) {
      if (String(err?.code || '') !== 'EEXIST') break;
      const existing = readTelegramPollLockFile();
      const ownerPid = Number(existing?.pid);
      const ownerToken = String(existing?.tokenHash || '');
      const startedAt = Number(existing?.startedAt || 0);
      const staleByPid = !isPidAlive(ownerPid);
      const staleByTime = startedAt > 0 && Date.now() - startedAt > TELEGRAM_POLL_LOCK_STALE_MS;
      const sameToken = ownerToken && ownerToken === tokenHash;
      if ((sameToken && (staleByPid || staleByTime)) || (!ownerToken && staleByTime)) {
        try { fs.unlinkSync(TELEGRAM_POLL_LOCK_PATH); } catch {}
        continue;
      }
      telegramState.pollLock.acquired = false;
      telegramState.pollLock.ownerPid = Number.isFinite(ownerPid) ? ownerPid : null;
      telegramState.pollLock.reason = 'busy';
      return false;
    }
  }
  telegramState.pollLock.acquired = false;
  telegramState.pollLock.ownerPid = null;
  telegramState.pollLock.reason = 'error';
  return false;
}

function registerProcessCleanupHooks() {
  const once = (fn) => {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      fn();
    };
  };
  const cleanup = once(() => {
    releaseTelegramPollLock();
    releaseThunderClawServiceLock();
  });
  process.once('exit', cleanup);
  process.once('SIGINT', () => {
    cleanup();
    process.exit(130);
  });
  process.once('SIGTERM', () => {
    cleanup();
    process.exit(143);
  });
}

function readLockPayload(lockPath) {
  try {
    if (!fs.existsSync(lockPath)) return null;
    const raw = fs.readFileSync(lockPath, 'utf8');
    if (!String(raw || '').trim()) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function releaseThunderClawServiceLock() {
  if (!thunderclawServiceLockAcquired) return;
  thunderclawServiceLockAcquired = false;
  runtimeState.serviceLock.acquired = false;
  runtimeState.serviceLock.ownerPid = null;
  runtimeState.serviceLock.reason = 'released';
  try {
    if (thunderclawServiceLockFd != null) fs.closeSync(thunderclawServiceLockFd);
  } catch {}
  thunderclawServiceLockFd = null;
  try {
    if (fs.existsSync(THUNDERCLAW_SERVICE_LOCK_PATH)) fs.unlinkSync(THUNDERCLAW_SERVICE_LOCK_PATH);
  } catch {}
}

function acquireThunderClawServiceLock() {
  fs.mkdirSync(path.dirname(THUNDERCLAW_SERVICE_LOCK_PATH), { recursive: true });
  for (let i = 0; i < 2; i++) {
    try {
      const fd = fs.openSync(THUNDERCLAW_SERVICE_LOCK_PATH, 'wx', 0o600);
      const payload = {
        pid: process.pid,
        key: THUNDERCLAW_SERVICE_LOCK_KEY,
        startedAt: Date.now(),
        cwd: WORKDIR,
      };
      fs.writeFileSync(fd, JSON.stringify(payload), 'utf8');
      thunderclawServiceLockFd = fd;
      thunderclawServiceLockAcquired = true;
      runtimeState.serviceLock.acquired = true;
      runtimeState.serviceLock.ownerPid = process.pid;
      runtimeState.serviceLock.reason = null;
      return true;
    } catch (err) {
      if (String(err?.code || '') !== 'EEXIST') break;
      const existing = readLockPayload(THUNDERCLAW_SERVICE_LOCK_PATH);
      const ownerPid = Number(existing?.pid);
      const startedAt = Number(existing?.startedAt || 0);
      const staleByPid = !isPidAlive(ownerPid);
      const staleByTime = startedAt > 0 && Date.now() - startedAt > THUNDERCLAW_SERVICE_LOCK_STALE_MS;
      if (staleByPid || staleByTime) {
        try { fs.unlinkSync(THUNDERCLAW_SERVICE_LOCK_PATH); } catch {}
        continue;
      }
      runtimeState.serviceLock.acquired = false;
      runtimeState.serviceLock.ownerPid = Number.isFinite(ownerPid) ? ownerPid : null;
      runtimeState.serviceLock.reason = 'busy';
      return false;
    }
  }
  runtimeState.serviceLock.acquired = false;
  runtimeState.serviceLock.ownerPid = null;
  runtimeState.serviceLock.reason = 'error';
  return false;
}

function normalizeChatRole(roleLike) {
  const role = String(roleLike || '').toLowerCase();
  if (role === 'bot' || role === 'assistant') return 'bot';
  if (role === 'system') return 'system';
  return 'user';
}

function normalizeChatSource(sourceLike) {
  const s = String(sourceLike || '').toLowerCase();
  if (['telegram', 'dashboard', 'system'].includes(s)) return s;
  return 'dashboard';
}

function trimChatHistoryMemory() {
  if (chatHistory.length > CHAT_HISTORY_MAX) {
    chatHistory.splice(0, chatHistory.length - CHAT_HISTORY_MAX);
  }
}

function appendChatHistoryEvent(eventLike, options = {}) {
  const ev = eventLike && typeof eventLike === 'object' ? eventLike : {};
  const text = truncText(String(ev.text || '').trim(), 4000);
  if (!text) return null;
  const id =
    Number.isFinite(Number(ev.id)) && Number(ev.id) > 0
      ? Math.max(chatHistorySeq + 1, Number(ev.id))
      : chatHistorySeq + 1;
  chatHistorySeq = id;
  const item = {
    id,
    ts: ev.ts || nowIso(),
    role: normalizeChatRole(ev.role),
    source: normalizeChatSource(ev.source),
    chatId: ev.chatId != null ? String(ev.chatId) : null,
    from: ev.from ? truncText(String(ev.from), 64) : null,
    direction: ev.direction === 'outbound' ? 'outbound' : ev.direction === 'inbound' ? 'inbound' : null,
    text,
    meta: ev.meta && typeof ev.meta === 'object' ? ev.meta : undefined,
  };
  chatHistory.push(item);
  trimChatHistoryMemory();
  if (!options.skipPersist) {
    try {
      fs.mkdirSync(path.dirname(CHAT_HISTORY_PATH), { recursive: true });
      fs.appendFileSync(CHAT_HISTORY_PATH, JSON.stringify(item) + '\n', 'utf8');
    } catch {}
  }
  return item;
}

function listChatHistory(afterId, limit = 120) {
  const cursor = Number.isFinite(Number(afterId)) ? Number(afterId) : 0;
  const maxN = Math.max(1, Math.min(500, Number(limit) || 120));
  return chatHistory.filter((x) => Number(x.id) > cursor).slice(-maxN);
}

function loadChatHistoryFromDisk() {
  const rows = readJsonlFile(CHAT_HISTORY_PATH, CHAT_HISTORY_MAX * 3);
  chatHistory.length = 0;
  chatHistorySeq = 0;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    appendChatHistoryEvent(
      {
        id: row.id,
        ts: row.ts || null,
        role: row.role || 'user',
        source: row.source || 'dashboard',
        chatId: row.chatId != null ? String(row.chatId) : null,
        from: row.from || null,
        direction: row.direction || null,
        text: row.text || '',
        meta: row.meta && typeof row.meta === 'object' ? row.meta : undefined,
      },
      { skipPersist: true },
    );
  }
}

function cleanupTelegramInboundDedupe(force = false) {
  const now = Date.now();
  if (!force && now - telegramInboundDedupeLastCleanupAt < 60 * 60 * 1000) return;
  telegramInboundDedupeLastCleanupAt = now;
  try {
    if (!fs.existsSync(TELEGRAM_INBOUND_DEDUPE_DIR)) return;
    const names = fs.readdirSync(TELEGRAM_INBOUND_DEDUPE_DIR);
    for (const name of names) {
      if (!name.endsWith('.seen')) continue;
      const file = path.resolve(TELEGRAM_INBOUND_DEDUPE_DIR, name);
      let st = null;
      try { st = fs.statSync(file); } catch { st = null; }
      if (!st) continue;
      if (now - Number(st.mtimeMs || 0) > TELEGRAM_INBOUND_DEDUPE_TTL_MS) {
        try { fs.unlinkSync(file); } catch {}
      }
    }
  } catch {}
}

function claimTelegramInbound(incoming) {
  const chatId = incoming?.chatId != null ? String(incoming.chatId) : '';
  const messageId = Number(incoming?.messageId);
  const updateId = Number(incoming?.updateId);
  if (!chatId) return { claimed: true, key: null };
  const idPart = Number.isFinite(messageId) && messageId > 0
    ? 'm:' + String(messageId)
    : Number.isFinite(updateId) && updateId > 0
      ? 'u:' + String(updateId)
      : 'h:' + sha1(chatId + '|' + String(incoming?.from || '') + '|' + String(incoming?.text || '')).slice(0, 20);
  const key = chatId + ':' + idPart;
  const file = path.resolve(TELEGRAM_INBOUND_DEDUPE_DIR, sha1(key).slice(0, 32) + '.seen');
  try {
    fs.mkdirSync(TELEGRAM_INBOUND_DEDUPE_DIR, { recursive: true });
    const fd = fs.openSync(file, 'wx', 0o600);
    const payload = {
      key,
      chatId,
      messageId: Number.isFinite(messageId) ? messageId : null,
      updateId: Number.isFinite(updateId) ? updateId : null,
      ts: nowIso(),
    };
    fs.writeFileSync(fd, JSON.stringify(payload), 'utf8');
    fs.closeSync(fd);
    telegramState.dedupe.claimed += 1;
    telegramState.dedupe.lastKey = key;
    telegramState.dedupe.lastClaimAt = nowIso();
    telegramState.dedupe.lastError = null;
    cleanupTelegramInboundDedupe(false);
    return { claimed: true, key };
  } catch (err) {
    if (String(err?.code || '') === 'EEXIST') {
      telegramState.dedupe.duplicates += 1;
      telegramState.dedupe.lastKey = key;
      telegramState.dedupe.lastDuplicateAt = nowIso();
      return { claimed: false, key };
    }
    telegramState.dedupe.lastError = safeErrMsg(err, 'dedupe failed');
    // Fail-open: if dedupe file unexpectedly errors, don't block normal replies.
    return { claimed: true, key, dedupeError: telegramState.dedupe.lastError };
  }
}

function redactSecrets(textLike) {
  let text = String(textLike || '');
  text = text.replace(/\bsk-[A-Za-z0-9\-_]{10,}\b/g, '[REDACTED_API_KEY]');
  text = text.replace(/\b\d{6,12}:[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_TELEGRAM_TOKEN]');
  text = text.replace(/\bbg_[A-Za-z0-9]{10,}\b/g, '[REDACTED_BITGET_KEY]');
  text = text.replace(/\b[a-fA-F0-9]{48,}\b/g, '[REDACTED_SECRET]');
  return truncText(text, 3500);
}

function tokenizeMemoryText(textLike) {
  const text = String(textLike || '').toLowerCase();
  const tokens = [];
  const reWord = /[a-z0-9_/\-]{2,}/g;
  let m;
  while ((m = reWord.exec(text)) != null) {
    tokens.push(m[0]);
  }
  const cjkSegments = text.match(/[\u4e00-\u9fa5]{2,}/g) || [];
  for (const seg of cjkSegments) {
    if (seg.length <= 2) {
      tokens.push(seg);
      continue;
    }
    for (let i = 0; i < seg.length - 1; i++) {
      tokens.push(seg.slice(i, i + 2));
    }
  }
  return Array.from(new Set(tokens)).slice(0, 220);
}

function inferMemoryTags(textLike) {
  const text = String(textLike || '').toLowerCase();
  const tags = [];
  if (/btc|比特币|xbt/.test(text)) tags.push('btc');
  if (/eth|以太坊/.test(text)) tags.push('eth');
  if (/sol/.test(text)) tags.push('sol');
  if (/风控|止损|回撤|risk|drawdown/.test(text)) tags.push('risk');
  if (/开仓|平仓|加仓|减仓|仓位|trade|order/.test(text)) tags.push('trade');
  if (/策略|信号|虾策|回测|backtest/.test(text)) tags.push('strategy');
  if (/虾线|k线|kline|candl/.test(text)) tags.push('kline');
  if (/telegram|tg/.test(text)) tags.push('telegram');
  if (/简短|简洁|直接/.test(text)) tags.push('brief-style');
  if (/详细|展开|解释/.test(text)) tags.push('detailed-style');
  return Array.from(new Set(tags)).slice(0, 8);
}

function tokenVecIndex(token) {
  const hex = sha1(token).slice(0, 8);
  const n = Number.parseInt(hex, 16);
  if (!Number.isFinite(n)) return 0;
  return n % TRADER_MEMORY_VECTOR_DIM;
}

function buildSparseVector(tokensLike) {
  const counts = new Map();
  const tokens = Array.isArray(tokensLike) ? tokensLike : [];
  for (const t of tokens) {
    const idx = tokenVecIndex(String(t || ''));
    counts.set(idx, (counts.get(idx) || 0) + 1);
  }
  const list = Array.from(counts.entries())
    .map(([idx, value]) => [idx, value])
    .sort((a, b) => a[0] - b[0]);
  return list;
}

function sparseVecCosine(aLike, bLike) {
  const a = Array.isArray(aLike) ? aLike : [];
  const b = Array.isArray(bLike) ? bLike : [];
  if (!a.length || !b.length) return 0;
  let i = 0;
  let j = 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [, v] of a) na += Number(v || 0) ** 2;
  for (const [, v] of b) nb += Number(v || 0) ** 2;
  while (i < a.length && j < b.length) {
    const ai = Number(a[i]?.[0]);
    const bi = Number(b[j]?.[0]);
    if (ai === bi) {
      dot += Number(a[i]?.[1] || 0) * Number(b[j]?.[1] || 0);
      i += 1;
      j += 1;
      continue;
    }
    if (ai < bi) i += 1;
    else j += 1;
  }
  if (na <= 0 || nb <= 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function safeJsonWrite(filePath, value, pretty = true) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpPath = filePath + '.tmp-' + process.pid + '-' + String(Math.random()).slice(2, 7);
    const text = pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
    fs.writeFileSync(tmpPath, text + '\n', 'utf8');
    fs.renameSync(tmpPath, filePath);
    try { fs.chmodSync(filePath, 0o600); } catch {}
    return true;
  } catch {
    return false;
  }
}

function readJsonlFile(filePath, maxLines = 1000) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = String(raw || '').split(/\r?\n/).filter(Boolean);
    const tail = lines.slice(-Math.max(1, maxLines));
    const out = [];
    for (const line of tail) {
      try {
        const row = JSON.parse(line);
        if (row && typeof row === 'object') out.push(row);
      } catch {}
    }
    return out;
  } catch {
    return [];
  }
}

function knownStrategyNames() {
  return ['v5_hybrid', 'v5_retest', 'v5_reentry', 'v4_breakout', 'manual'];
}

function normalizeStrategyName(nameLike) {
  const raw = String(nameLike || '').trim().toLowerCase();
  if (!raw) return null;
  const alias = {
    hybrid: 'v5_hybrid',
    'v5 hybrid': 'v5_hybrid',
    'v5-hybrid': 'v5_hybrid',
    retest: 'v5_retest',
    'v5 retest': 'v5_retest',
    'v5-retest': 'v5_retest',
    reentry: 'v5_reentry',
    'v5 reentry': 'v5_reentry',
    'v5-reentry': 'v5_reentry',
    breakout: 'v4_breakout',
    'v4 breakout': 'v4_breakout',
    'v4-breakout': 'v4_breakout',
    手动: 'manual',
    人工: 'manual',
    manual: 'manual',
  };
  if (alias[raw]) return alias[raw];
  if (knownStrategyNames().includes(raw)) return raw;
  if (/^v\d+_[a-z0-9_]+$/.test(raw)) return raw;
  return null;
}

function detectStrategyFromText(textLike, fallback = null) {
  const text = String(textLike || '');
  if (!text.trim()) return fallback;
  const direct = text.match(/\b(v5_hybrid|v5_retest|v5_reentry|v4_breakout)\b/i);
  if (direct) return normalizeStrategyName(direct[1]) || fallback;
  const lower = text.toLowerCase();
  if (/v5\s*retest|突破回踩|retest/.test(lower)) return 'v5_retest';
  if (/v5\s*reentry|趋势再入|reentry/.test(lower)) return 'v5_reentry';
  if (/v4|donchian|breakout|突破策略/.test(lower)) return 'v4_breakout';
  if (/手动|manual/.test(lower)) return 'manual';
  return fallback;
}

function clampStrategyWeight(value) {
  const maxW = Number.isFinite(STRATEGY_FEEDBACK_MAX_WEIGHT) ? STRATEGY_FEEDBACK_MAX_WEIGHT : 1.5;
  const minW = Number.isFinite(STRATEGY_FEEDBACK_MIN_WEIGHT) ? STRATEGY_FEEDBACK_MIN_WEIGHT : -1.5;
  return clampNum(Number(value) || 0, Math.min(minW, maxW), Math.max(minW, maxW)) || 0;
}

function loadShortTermMemory() {
  if (shortTermMemoryState.loaded) return;
  shortTermMemoryState.loaded = true;
  const parsed = safeJsonRead(TRADER_SHORT_MEMORY_PATH, { items: [] });
  const items = Array.isArray(parsed?.items)
    ? parsed.items
    : Array.isArray(parsed)
      ? parsed
      : [];
  shortTermMemoryState.items = items
    .filter((x) => x && typeof x === 'object')
    .map((x) => ({
      id: x.id || null,
      ts: x.ts || null,
      channel: x.channel || null,
      role: x.role || null,
      kind: x.kind || 'note',
      text: truncText(redactSecrets(x.text || ''), 320),
      tags: Array.isArray(x.tags) ? x.tags.map((t) => String(t)).slice(0, 10) : [],
      strategy: normalizeStrategyName(x.strategy) || null,
      tokens: Array.isArray(x.tokens)
        ? x.tokens.map((t) => String(t)).slice(0, 180)
        : tokenizeMemoryText(String(x.text || '')).slice(0, 180),
    }))
    .slice(-TRADER_SHORT_MEMORY_MAX_ITEMS);
}

function saveShortTermMemory() {
  loadShortTermMemory();
  const ok = safeJsonWrite(
    TRADER_SHORT_MEMORY_PATH,
    {
      updatedAt: nowIso(),
      items: shortTermMemoryState.items.slice(-TRADER_SHORT_MEMORY_MAX_ITEMS),
    },
    false,
  );
  if (ok) shortTermMemoryState.lastSavedAt = nowIso();
}

function appendShortTermMemory(itemLike) {
  loadShortTermMemory();
  const item = itemLike && typeof itemLike === 'object' ? itemLike : {};
  const text = truncText(redactSecrets(item.text || ''), 320);
  if (!text) return null;
  const record = {
    id: String(Date.now()) + '-' + String(Math.random()).slice(2, 8),
    ts: item.ts || nowIso(),
    channel: item.channel || 'system',
    role: item.role || 'system',
    kind: item.kind || 'note',
    text,
    tags: Array.isArray(item.tags) ? item.tags.map((t) => String(t)).slice(0, 10) : [],
    strategy: normalizeStrategyName(item.strategy) || detectStrategyFromText(text, null),
  };
  record.tokens = tokenizeMemoryText(
    [record.text, Array.isArray(record.tags) ? record.tags.join(' ') : '', record.strategy || ''].join(' '),
  ).slice(0, 180);
  shortTermMemoryState.items.push(record);
  if (shortTermMemoryState.items.length > TRADER_SHORT_MEMORY_MAX_ITEMS) {
    shortTermMemoryState.items = shortTermMemoryState.items.slice(-TRADER_SHORT_MEMORY_MAX_ITEMS);
  }
  saveShortTermMemory();
  return record;
}

function syncShortTermFromLongRecord(recordLike) {
  const r = recordLike && typeof recordLike === 'object' ? recordLike : null;
  if (!r) return;
  const tags = Array.isArray(r.tags) ? r.tags.map((x) => String(x)) : [];
  const role = tags.includes('assistant')
    ? 'assistant'
    : tags.includes('user')
      ? 'user'
      : r.kind === 'trade_outcome' || r.kind === 'strategy_feedback'
        ? 'system'
        : 'system';
  appendShortTermMemory({
    ts: r.ts || nowIso(),
    channel: r.channel || 'system',
    role,
    kind: r.kind || 'note',
    text: String(r.content || ''),
    tags,
    strategy: detectStrategyFromText(r.content || '', null),
  });
}

function retrieveShortTermMemory(query, limit = TRADER_MEMORY_SHORT_RETRIEVE_TOPK) {
  loadShortTermMemory();
  const qText = redactSecrets(query || '');
  const qTokens = tokenizeMemoryText(qText);
  const now = Date.now();
  const maxN = Math.max(1, Math.min(24, Number(limit) || TRADER_MEMORY_SHORT_RETRIEVE_TOPK));
  const ranked = [];
  for (const e of shortTermMemoryState.items) {
    const tokens = Array.isArray(e.tokens) ? e.tokens : [];
    let score = 0;
    if (qText && String(e.text || '').toLowerCase().includes(qText.toLowerCase())) score += 4;
    for (const t of qTokens) {
      if (tokens.includes(t)) score += 1;
    }
    const ageMs = Math.max(0, now - (toMs(e.ts) || now));
    score += Math.max(0, 1.5 - ageMs / (6 * 3600 * 1000));
    if (score <= 0.1) continue;
    ranked.push({ score, e });
  }
  ranked.sort((a, b) => b.score - a.score || (toMs(b.e.ts) || 0) - (toMs(a.e.ts) || 0));
  return ranked.slice(0, maxN).map((x) => ({
    ts: x.e.ts || null,
    channel: x.e.channel || null,
    role: x.e.role || null,
    kind: x.e.kind || null,
    text: truncText(String(x.e.text || ''), 260),
    tags: Array.isArray(x.e.tags) ? x.e.tags.slice(0, 8) : [],
    strategy: x.e.strategy || null,
    score: Number(x.score.toFixed(3)),
  }));
}

function buildShortTermSnapshot(queryText) {
  loadShortTermMemory();
  const recent = shortTermMemoryState.items.slice(-10).map((x) => ({
    ts: x.ts || null,
    channel: x.channel || null,
    role: x.role || null,
    kind: x.kind || null,
    text: truncText(String(x.text || ''), 220),
    strategy: x.strategy || null,
  }));
  return {
    recent,
    relevant: retrieveShortTermMemory(queryText, TRADER_MEMORY_SHORT_RETRIEVE_TOPK),
    totalItems: shortTermMemoryState.items.length,
  };
}

function defaultStrategyFeedbackRecord(strategy) {
  return {
    strategy,
    weight: 0,
    scoreEma: 0,
    tradeCount: 0,
    feedbackCount: 0,
    wins: 0,
    losses: 0,
    avgPnlUSDT: 0,
    lastPnlUSDT: null,
    lastReward: 0,
    lastSource: null,
    lastReason: null,
    lastUpdatedAt: null,
  };
}

function loadStrategyFeedbackState() {
  if (strategyFeedbackState.loaded) return;
  strategyFeedbackState.loaded = true;
  const parsed = safeJsonRead(STRATEGY_WEIGHTS_PATH, {});
  const processed = Array.isArray(parsed?.processedTradeKeys)
    ? parsed.processedTradeKeys.map((x) => String(x)).filter(Boolean)
    : [];
  strategyFeedbackState.processedTradeKeys = new Set(processed.slice(-STRATEGY_FEEDBACK_PROCESSED_MAX));
  const source = parsed?.strategies && typeof parsed.strategies === 'object' ? parsed.strategies : {};
  const out = {};
  for (const [key, value] of Object.entries(source)) {
    const strategy = normalizeStrategyName(key);
    if (!strategy) continue;
    const base = defaultStrategyFeedbackRecord(strategy);
    const v = value && typeof value === 'object' ? value : {};
    out[strategy] = {
      ...base,
      weight: clampStrategyWeight(v.weight),
      scoreEma: clampNum(v.scoreEma, -1, 1) || 0,
      tradeCount: Math.max(0, Number(v.tradeCount) || 0),
      feedbackCount: Math.max(0, Number(v.feedbackCount) || 0),
      wins: Math.max(0, Number(v.wins) || 0),
      losses: Math.max(0, Number(v.losses) || 0),
      avgPnlUSDT: Number(v.avgPnlUSDT) || 0,
      lastPnlUSDT: Number.isFinite(Number(v.lastPnlUSDT)) ? Number(v.lastPnlUSDT) : null,
      lastReward: clampNum(v.lastReward, -1, 1) || 0,
      lastSource: v.lastSource || null,
      lastReason: v.lastReason || null,
      lastUpdatedAt: v.lastUpdatedAt || null,
    };
  }
  knownStrategyNames().forEach((name) => {
    if (!out[name]) out[name] = defaultStrategyFeedbackRecord(name);
  });
  strategyFeedbackState.strategies = out;
  strategyFeedbackState.lastLearnAt = parsed?.lastLearnAt || null;
}

function saveStrategyFeedbackState() {
  loadStrategyFeedbackState();
  const payload = {
    version: 1,
    updatedAt: nowIso(),
    lastLearnAt: strategyFeedbackState.lastLearnAt || null,
    processedTradeKeys: Array.from(strategyFeedbackState.processedTradeKeys).slice(-STRATEGY_FEEDBACK_PROCESSED_MAX),
    strategies: strategyFeedbackState.strategies,
  };
  const ok = safeJsonWrite(STRATEGY_WEIGHTS_PATH, payload, true);
  if (ok) strategyFeedbackState.lastSavedAt = nowIso();
}

function trimStrategyFeedbackState() {
  const keys = Array.from(strategyFeedbackState.processedTradeKeys);
  if (keys.length > STRATEGY_FEEDBACK_PROCESSED_MAX) {
    strategyFeedbackState.processedTradeKeys = new Set(keys.slice(-STRATEGY_FEEDBACK_PROCESSED_MAX));
  }
}

function ensureStrategyFeedbackRecord(strategyLike) {
  loadStrategyFeedbackState();
  const strategy = normalizeStrategyName(strategyLike) || 'v5_hybrid';
  if (!strategyFeedbackState.strategies[strategy]) {
    strategyFeedbackState.strategies[strategy] = defaultStrategyFeedbackRecord(strategy);
  }
  return strategyFeedbackState.strategies[strategy];
}

function strategyConfidence(rec) {
  const tradeCount = Math.max(0, Number(rec?.tradeCount) || 0);
  const feedbackCount = Math.max(0, Number(rec?.feedbackCount) || 0);
  return clampNum((tradeCount + feedbackCount * 1.5) / 12, 0, 1) || 0;
}

function applyStrategyReward(updateLike) {
  loadStrategyFeedbackState();
  const u = updateLike && typeof updateLike === 'object' ? updateLike : {};
  const strategy = normalizeStrategyName(u.strategy) || 'v5_hybrid';
  const reward = clampNum(Number(u.reward), -1, 1);
  if (!Number.isFinite(reward)) return { ok: false, reason: 'invalid_reward' };
  const tradeKey = u.tradeKey ? String(u.tradeKey) : null;
  if (tradeKey && strategyFeedbackState.processedTradeKeys.has(tradeKey)) {
    return { ok: true, applied: false, strategy, reward, duplicate: true };
  }
  const rec = ensureStrategyFeedbackRecord(strategy);
  const oldWeight = Number(rec.weight) || 0;
  const nextWeight = clampStrategyWeight(oldWeight * (1 - STRATEGY_FEEDBACK_LR * 0.12) + STRATEGY_FEEDBACK_LR * reward);
  rec.weight = nextWeight;
  rec.scoreEma = clampNum((Number(rec.scoreEma) || 0) * 0.88 + reward * 0.12, -1, 1) || 0;
  rec.lastReward = reward;
  rec.lastSource = u.source || 'unknown';
  rec.lastReason = truncText(String(u.reason || ''), 220) || null;
  rec.lastUpdatedAt = u.ts || nowIso();
  if (u.source === 'trade') {
    rec.tradeCount = Math.max(0, Number(rec.tradeCount) || 0) + 1;
    const pnl = toNum(u.pnlUSDT);
    if (pnl != null) {
      rec.lastPnlUSDT = pnl;
      const n = rec.tradeCount;
      rec.avgPnlUSDT = n <= 1 ? pnl : ((Number(rec.avgPnlUSDT) || 0) * (n - 1) + pnl) / n;
      if (pnl >= 0) rec.wins = Math.max(0, Number(rec.wins) || 0) + 1;
      else rec.losses = Math.max(0, Number(rec.losses) || 0) + 1;
    }
  } else {
    rec.feedbackCount = Math.max(0, Number(rec.feedbackCount) || 0) + 1;
  }
  if (tradeKey) strategyFeedbackState.processedTradeKeys.add(tradeKey);
  trimStrategyFeedbackState();
  saveStrategyFeedbackState();
  return {
    ok: true,
    applied: true,
    strategy,
    reward,
    oldWeight: Number(oldWeight.toFixed(4)),
    newWeight: Number(nextWeight.toFixed(4)),
    confidence: Number(strategyConfidence(rec).toFixed(3)),
  };
}

function resolveStrategyFromTrade(openEvent, closeEvent) {
  const openReason = String(openEvent?.meta?.reason || '').trim();
  const closeReason = String(closeEvent?.reason || '').trim();
  const level = String(openEvent?.level || closeEvent?.level || '').trim();
  return (
    detectStrategyFromText(openReason, null) ||
    detectStrategyFromText(closeReason, null) ||
    detectStrategyFromText(level, null) ||
    'v5_hybrid'
  );
}

function rewardFromTradeOutcome(pnlUSDT, closeReasonLike) {
  const pnl = toNum(pnlUSDT);
  const closeReason = String(closeReasonLike || '').toLowerCase();
  if (pnl == null) {
    if (/liquidat|强平|爆仓/.test(closeReason)) return -0.9;
    return 0;
  }
  let reward = Math.tanh(pnl / STRATEGY_FEEDBACK_TRADE_PNL_SCALE);
  if (/liquidat|强平|爆仓/.test(closeReason)) reward -= 0.35;
  if (/manual|手动/.test(closeReason)) reward -= 0.08;
  return clampNum(reward, -1, 1) || 0;
}

function learnStrategyWeightsFromTrades() {
  loadStrategyFeedbackState();
  const rows = readJsonlFile(TRADES_JSONL_PATH, STRATEGY_FEEDBACK_SCAN_LIMIT * 3);
  if (!rows.length) return { applied: 0, scanned: 0, skipped: 0 };
  const opensByOrderId = new Map();
  for (const r of rows) {
    if (String(r?.event || '').toLowerCase() !== 'open') continue;
    if (r?.orderId == null) continue;
    opensByOrderId.set(String(r.orderId), r);
  }
  const closes = rows
    .filter((r) => String(r?.event || '').toLowerCase() === 'close')
    .slice(-STRATEGY_FEEDBACK_SCAN_LIMIT);
  let applied = 0;
  let skipped = 0;
  for (const close of closes) {
    const tsMs = toMs(close?.tsUtc || close?.ts || close?.tsLocal) || 0;
    const openOrderId = close?.openOrderId != null ? String(close.openOrderId) : '';
    const closeOrderId = close?.closeOrderId != null ? String(close.closeOrderId) : '';
    const tradeKey = ['trade-close', closeOrderId || '-', openOrderId || '-', String(tsMs)].join(':');
    if (strategyFeedbackState.processedTradeKeys.has(tradeKey)) {
      skipped += 1;
      continue;
    }
    const open = openOrderId ? opensByOrderId.get(openOrderId) : null;
    const strategy = resolveStrategyFromTrade(open, close);
    const pnlUSDT = toNum(close?.pnlEstUSDT);
    const reward = rewardFromTradeOutcome(pnlUSDT, close?.reason);
    const updated = applyStrategyReward({
      strategy,
      reward,
      source: 'trade',
      reason: String(open?.meta?.reason || close?.reason || '').trim(),
      ts: close?.tsUtc || close?.ts || nowIso(),
      pnlUSDT,
      tradeKey,
    });
    if (updated?.applied) {
      applied += 1;
      appendTraderMemory({
        key: 'strategy-trade-feedback:' + tradeKey,
        ts: close?.tsUtc || close?.ts || nowIso(),
        kind: 'strategy_feedback',
        channel: 'system',
        tags: ['strategy', 'trade_feedback', strategy],
        content: [
          '策略反馈(交易结果)',
          'strategy=' + strategy,
          'reward=' + String(Number(reward).toFixed(4)),
          'pnl=' + (pnlUSDT == null ? '-' : String(Number(pnlUSDT).toFixed(6)) + 'U'),
          'closeReason=' + String(close?.reason || '-'),
        ].join(' | '),
      });
    }
  }
  strategyFeedbackState.lastLearnAt = nowIso();
  saveStrategyFeedbackState();
  return { applied, scanned: closes.length, skipped };
}

function buildStrategyWeightsRanking(limit = TRADER_MID_TOP_STRATEGIES) {
  loadStrategyFeedbackState();
  const list = Object.values(strategyFeedbackState.strategies || {});
  const rows = list.map((rec) => {
    const tradeCount = Math.max(0, Number(rec.tradeCount) || 0);
    const feedbackCount = Math.max(0, Number(rec.feedbackCount) || 0);
    const conf = strategyConfidence(rec);
    const strength = (Number(rec.weight) || 0) * 0.75 + (Number(rec.scoreEma) || 0) * 0.25;
    return {
      strategy: rec.strategy,
      weight: Number((Number(rec.weight) || 0).toFixed(4)),
      scoreEma: Number((Number(rec.scoreEma) || 0).toFixed(4)),
      confidence: Number(conf.toFixed(3)),
      strength: Number(strength.toFixed(4)),
      tradeCount,
      feedbackCount,
      wins: Math.max(0, Number(rec.wins) || 0),
      losses: Math.max(0, Number(rec.losses) || 0),
      winRate: tradeCount > 0 ? Number((Math.max(0, Number(rec.wins) || 0) / tradeCount).toFixed(3)) : null,
      avgPnlUSDT: Number((Number(rec.avgPnlUSDT) || 0).toFixed(6)),
      lastUpdatedAt: rec.lastUpdatedAt || null,
      lastReason: rec.lastReason || null,
    };
  });
  rows.sort((a, b) => b.strength - a.strength || b.confidence - a.confidence || b.tradeCount - a.tradeCount);
  return rows.slice(0, Math.max(1, limit));
}

function parseStrategyFeedbackIntent(messageLike) {
  const text = String(messageLike || '').trim();
  if (!text) return null;
  const lower = text.toLowerCase();
  const explicit = /^(反馈|策略反馈|strategy\s*feedback)\s*[:：]?\s*/i.test(text);
  const hasStrategyWords = /(策略|strategy|v5_|v4_|retest|reentry|breakout|手动)/i.test(text);
  if (!explicit && !hasStrategyWords) return null;

  let strategy =
    normalizeStrategyName((text.match(/\b(v5_hybrid|v5_retest|v5_reentry|v4_breakout|manual)\b/i) || [])[1]) ||
    detectStrategyFromText(text, null);
  if (!strategy) {
    const top = buildStrategyWeightsRanking(1)[0];
    if (top?.strategy) strategy = top.strategy;
  }
  strategy = strategy || 'v5_hybrid';

  let reward = null;
  const numMatch = text.match(/(?:^|[\s:：,，])([+-]?\d+(?:\.\d+)?)(?=$|[\s,，。!！])/);
  if (numMatch) {
    const n = Number(numMatch[1]);
    if (Number.isFinite(n)) {
      reward = Math.abs(n) > 1 ? clampNum(n / 2, -1, 1) : clampNum(n, -1, 1);
    }
  }
  if (reward == null) {
    const positive = /(看好|很好|不错|有效|有用|收益|盈利|继续|增强|加强|喜欢|稳|牛|赚|good|great|works?)/i.test(
      lower,
    );
    const negative = /(不好|很差|失效|无效|亏损|回撤|太激进|风险高|停用|减弱|削弱|讨厌|bad|poor|worse|loss)/i.test(
      lower,
    );
    if (positive && !negative) reward = 0.55;
    else if (negative && !positive) reward = -0.55;
    else if (positive && negative) reward = -0.15;
  }
  if (reward == null) return explicit ? { explicit, strategy, reward: null } : null;
  return {
    explicit,
    strategy,
    reward: clampNum(reward, -1, 1) || 0,
  };
}

function applyUserStrategyFeedback(messageLike, channel = 'dashboard') {
  const intent = parseStrategyFeedbackIntent(messageLike);
  if (!intent) return { handled: false };
  if (intent.reward == null) {
    return {
      handled: Boolean(intent.explicit),
      applied: false,
      strategy: intent.strategy,
      reason: 'missing_sentiment',
      reply: '已识别为策略反馈，但未识别到正/负方向。可发：反馈 v5_retest +0.6',
    };
  }
  const updated = applyStrategyReward({
    strategy: intent.strategy,
    reward: intent.reward,
    source: 'feedback',
    reason: String(messageLike || '').slice(0, 240),
    ts: nowIso(),
  });
  if (updated?.applied) {
    appendTraderMemory({
      key: 'strategy-user-feedback:' + sha1(String(messageLike || '') + ':' + String(Date.now())).slice(0, 20),
      ts: nowIso(),
      kind: 'strategy_feedback',
      channel,
      tags: ['strategy', 'user_feedback', intent.strategy],
      content:
        '策略反馈(用户) | strategy=' +
        intent.strategy +
        ' | reward=' +
        String(Number(intent.reward).toFixed(4)) +
        ' | text=' +
        redactSecrets(messageLike),
    });
  }
  const rec = buildStrategyWeightsRanking(TRADER_MID_TOP_STRATEGIES).find((x) => x.strategy === intent.strategy);
  return {
    handled: true,
    applied: Boolean(updated?.applied),
    explicit: Boolean(intent.explicit),
    strategy: intent.strategy,
    reward: intent.reward,
    weight: rec ? rec.weight : null,
    confidence: rec ? rec.confidence : null,
    reply:
      '已记录策略反馈：' +
      intent.strategy +
      ' ' +
      (intent.reward >= 0 ? '+' : '') +
      Number(intent.reward).toFixed(2) +
      '（当前权重=' +
      (rec ? Number(rec.weight).toFixed(3) : '-') +
      '）',
  };
}

function clampArtifactWeight(value) {
  const maxW = Number.isFinite(STRATEGY_ARTIFACT_MAX_WEIGHT) ? STRATEGY_ARTIFACT_MAX_WEIGHT : 2;
  const minW = Number.isFinite(STRATEGY_ARTIFACT_MIN_WEIGHT) ? STRATEGY_ARTIFACT_MIN_WEIGHT : -2;
  return clampNum(Number(value) || 0, Math.min(minW, maxW), Math.max(minW, maxW)) || 0;
}

function strategyArtifactStrength(recordLike) {
  const rec = recordLike && typeof recordLike === 'object' ? recordLike : {};
  const reports = Math.max(0, Number(rec?.stats?.reports) || 0);
  const avgPnl = Number(rec?.stats?.avgNetPnlPct) || 0;
  const conf = Math.max(0, Math.min(1, Math.log1p(reports) / Math.log(16)));
  return (
    (Number(rec.learningWeight) || 0) * 0.5 +
    (Number(rec.scoreEma) || 0) * 0.35 +
    conf * 0.1 +
    Math.max(-0.3, Math.min(0.4, avgPnl / 80))
  );
}

function defaultStrategyArtifactRecord(initLike = {}) {
  const init = initLike && typeof initLike === 'object' ? initLike : {};
  return {
    artifactId: String(init.artifactId || ''),
    configHash: String(init.configHash || ''),
    label: truncText(String(init.label || ''), 80) || 'strategy-artifact',
    strategyType: String(init.strategyType || 'custom'),
    source: String(init.source || 'dashboard'),
    query: truncText(String(init.query || ''), 260) || null,
    config: init.config && typeof init.config === 'object' ? init.config : {},
    version: 0,
    createdAt: init.createdAt || nowIso(),
    updatedAt: init.updatedAt || nowIso(),
    lastUsedAt: init.lastUsedAt || nowIso(),
    lastResult: null,
    scoreEma: 0,
    learningWeight: 0,
    feedbackCount: 0,
    positiveFeedback: 0,
    negativeFeedback: 0,
    stats: {
      reports: 0,
      totalTrades: 0,
      avgWinRate: 0,
      avgNetPnlPct: 0,
      avgDrawdownPct: 0,
      bestNetPnlPct: null,
      worstDrawdownPct: null,
      lastReward: 0,
      lastSource: null,
      lastReason: null,
      lastUpdatedAt: null,
    },
  };
}

function normalizeArtifactConfig(configLike) {
  const cfg = configLike && typeof configLike === 'object' ? configLike : {};
  const out = {};
  const strategy = String(cfg.strategy || '').trim();
  const tf = String(cfg.tf || '').trim();
  if (strategy) out.strategy = strategy.slice(0, 64);
  if (['1m', '5m', '15m', '1h', '4h', '1d'].includes(tf)) out.tf = tf;
  const bars = clampNum(cfg.bars, 80, 20000);
  const feeBps = clampNum(cfg.feeBps, 0, 100);
  const stopAtr = clampNum(cfg.stopAtr, 0.2, 20);
  const tpAtr = clampNum(cfg.tpAtr, 0.2, 40);
  const maxHold = clampNum(cfg.maxHold, 1, 3000);
  if (bars != null) out.bars = Math.round(bars);
  if (feeBps != null) out.feeBps = Number(feeBps);
  if (stopAtr != null) out.stopAtr = Number(stopAtr);
  if (tpAtr != null) out.tpAtr = Number(tpAtr);
  if (maxHold != null) out.maxHold = Math.round(maxHold);
  const custom = cfg.custom && typeof cfg.custom === 'object' ? cfg.custom : {};
  const customOut = {};
  const lookback = clampNum(custom.lookback, 2, 500);
  const retestWindow = clampNum(custom.retestWindow, 1, 300);
  const reentryWindow = clampNum(custom.reentryWindow, 1, 500);
  const retestTolAtr = clampNum(custom.retestTolAtr, 0.01, 8);
  const reentryTolAtr = clampNum(custom.reentryTolAtr, 0.01, 12);
  const biasAdxMin = clampNum(custom.biasAdxMin, 0, 100);
  const biasEmaFast = clampNum(custom.biasEmaFast, 2, 600);
  const biasEmaSlow = clampNum(custom.biasEmaSlow, 2, 800);
  const entryEma = clampNum(custom.entryEma, 2, 600);
  if (lookback != null) customOut.lookback = Math.round(lookback);
  if (retestWindow != null) customOut.retestWindow = Math.round(retestWindow);
  if (reentryWindow != null) customOut.reentryWindow = Math.round(reentryWindow);
  if (retestTolAtr != null) customOut.retestTolAtr = Number(retestTolAtr);
  if (reentryTolAtr != null) customOut.reentryTolAtr = Number(reentryTolAtr);
  if (biasAdxMin != null) customOut.biasAdxMin = Number(biasAdxMin);
  if (biasEmaFast != null) customOut.biasEmaFast = Math.round(biasEmaFast);
  if (biasEmaSlow != null) customOut.biasEmaSlow = Math.round(biasEmaSlow);
  if (entryEma != null) customOut.entryEma = Math.round(entryEma);
  if (typeof custom.allowRetest === 'boolean') customOut.allowRetest = custom.allowRetest;
  if (typeof custom.allowReentry === 'boolean') customOut.allowReentry = custom.allowReentry;
  if (typeof custom.allowBreakout === 'boolean') customOut.allowBreakout = custom.allowBreakout;
  if (['long', 'short', 'both'].includes(String(custom.side || ''))) customOut.side = String(custom.side);
  if (Object.keys(customOut).length) out.custom = customOut;
  const dsl = normalizeStrategyDslSpec(cfg.dsl || cfg.spec);
  if (Object.keys(dsl).length) out.dsl = dsl;
  return out;
}

function normalizeArtifactResult(resultLike) {
  const src = resultLike && typeof resultLike === 'object' ? resultLike : {};
  const strategy = String(src.strategy || '').trim();
  const tf = String(src.tf || '').trim();
  const bars = clampNum(src.bars, 0, 20000);
  const tradeCount = clampNum(src.tradeCount != null ? src.tradeCount : src.trades, 0, 50000);
  const winRate = clampNum(src.winRate, 0, 100);
  const netPnlPct = clampNum(src.netPnlPct != null ? src.netPnlPct : src.totalPnlPct, -1000, 2000);
  const maxDrawdownPct = clampNum(src.maxDrawdownPct, 0, 1000);
  const avgPnlPct = clampNum(src.avgPnlPct, -100, 100);
  return {
    strategy: strategy || null,
    tf: tf || null,
    bars: bars != null ? Math.round(bars) : null,
    tradeCount: tradeCount != null ? Math.round(tradeCount) : 0,
    winRate: winRate != null ? Number(winRate) : 0,
    netPnlPct: netPnlPct != null ? Number(netPnlPct) : 0,
    maxDrawdownPct: maxDrawdownPct != null ? Number(maxDrawdownPct) : 0,
    avgPnlPct: avgPnlPct != null ? Number(avgPnlPct) : 0,
  };
}

function normalizeStrategyArtifactReport(reportLike) {
  const src = reportLike && typeof reportLike === 'object' ? reportLike : {};
  const ts = src.ts || nowIso();
  const source = truncText(String(src.source || 'dashboard'), 32);
  const query = truncText(redactSecrets(src.query || src.userQuery || ''), 320) || null;
  const config = normalizeArtifactConfig(src.config);
  const result = normalizeArtifactResult(src.result);
  const configHash = sha1(JSON.stringify(config));
  const strategyType = config.dsl
    ? 'dsl'
    : config.custom
      ? 'custom'
      : String(config.strategy || result.strategy || 'preset').toLowerCase();
  const label =
    truncText(
      String(
        src.label ||
          config.dsl?.name ||
          (strategyType === 'dsl' ? (config.strategy || result.strategy || 'dsl') : config.strategy || result.strategy || 'custom'),
      ),
      80,
    ) || 'strategy-artifact';
  const artifactId = /^art-[a-f0-9]{8,20}$/i.test(String(src.artifactId || ''))
    ? String(src.artifactId).toLowerCase()
    : 'art-' + configHash.slice(0, 12);
  const reportKey =
    String(src.reportKey || '').trim() ||
    sha1(
      [
        artifactId,
        configHash,
        String(result.tradeCount),
        String(result.winRate),
        String(result.netPnlPct),
        String(result.maxDrawdownPct),
        String(toMs(ts) || Date.now()),
      ].join('|'),
    ).slice(0, 32);
  return {
    ts,
    source,
    query,
    artifactId,
    reportKey,
    label,
    strategyType,
    configHash,
    config,
    result,
  };
}

function scoreArtifactFromResultMetrics(metricsLike) {
  const m = metricsLike && typeof metricsLike === 'object' ? metricsLike : {};
  const trades = Math.max(0, Number(m.tradeCount) || 0);
  const winRate = Math.max(0, Math.min(100, Number(m.winRate) || 0)) / 100;
  const pnl = Math.tanh((Number(m.netPnlPct) || 0) / 16);
  const dd = Math.max(0, Number(m.maxDrawdownPct) || 0);
  const ddPenalty = Math.tanh(dd / 28);
  const tradeScore = Math.min(1, trades / 180);
  return clampNum(winRate * 0.45 + pnl * 0.35 + tradeScore * 0.15 - ddPenalty * 0.25, -1, 1) || 0;
}

function loadStrategyArtifactState() {
  if (strategyArtifactState.loaded) return;
  strategyArtifactState.loaded = true;
  strategyArtifactState.artifacts = {};
  strategyArtifactState.reportKeys = new Set();
  const parsed = safeJsonRead(STRATEGY_ARTIFACTS_STATE_PATH, {});
  if (parsed && typeof parsed === 'object') {
    const source = parsed.artifacts && typeof parsed.artifacts === 'object' ? parsed.artifacts : {};
    for (const [id, raw] of Object.entries(source)) {
      if (!/^art-[a-f0-9]{8,20}$/i.test(id)) continue;
      const rec = raw && typeof raw === 'object' ? raw : {};
      const base = defaultStrategyArtifactRecord({
        artifactId: String(id).toLowerCase(),
        configHash: String(rec.configHash || ''),
        label: String(rec.label || ''),
        strategyType: String(rec.strategyType || 'custom'),
        source: String(rec.source || 'dashboard'),
        query: rec.query || null,
        config: normalizeArtifactConfig(rec.config),
        createdAt: rec.createdAt || nowIso(),
        updatedAt: rec.updatedAt || nowIso(),
        lastUsedAt: rec.lastUsedAt || rec.updatedAt || nowIso(),
      });
      base.version = Math.max(0, Number(rec.version) || 0);
      base.lastResult = normalizeArtifactResult(rec.lastResult);
      base.scoreEma = clampNum(rec.scoreEma, -1, 1) || 0;
      base.learningWeight = clampArtifactWeight(rec.learningWeight);
      base.feedbackCount = Math.max(0, Number(rec.feedbackCount) || 0);
      base.positiveFeedback = Math.max(0, Number(rec.positiveFeedback) || 0);
      base.negativeFeedback = Math.max(0, Number(rec.negativeFeedback) || 0);
      const stats = rec.stats && typeof rec.stats === 'object' ? rec.stats : {};
      base.stats = {
        reports: Math.max(0, Number(stats.reports) || 0),
        totalTrades: Math.max(0, Number(stats.totalTrades) || 0),
        avgWinRate: Number(stats.avgWinRate) || 0,
        avgNetPnlPct: Number(stats.avgNetPnlPct) || 0,
        avgDrawdownPct: Number(stats.avgDrawdownPct) || 0,
        bestNetPnlPct:
          Number.isFinite(Number(stats.bestNetPnlPct)) ? Number(stats.bestNetPnlPct) : null,
        worstDrawdownPct:
          Number.isFinite(Number(stats.worstDrawdownPct)) ? Number(stats.worstDrawdownPct) : null,
        lastReward: clampNum(stats.lastReward, -1, 1) || 0,
        lastSource: stats.lastSource || null,
        lastReason: stats.lastReason || null,
        lastUpdatedAt: stats.lastUpdatedAt || null,
      };
      strategyArtifactState.artifacts[base.artifactId] = base;
    }
    const reportKeys = Array.isArray(parsed.reportKeys)
      ? parsed.reportKeys.map((x) => String(x)).filter(Boolean)
      : [];
    strategyArtifactState.reportKeys = new Set(reportKeys.slice(-STRATEGY_ARTIFACTS_REPORT_KEYS_MAX));
    strategyArtifactState.lastUpdatedAt = parsed.lastUpdatedAt || null;
    return;
  }
  const rows = readJsonlFile(STRATEGY_ARTIFACTS_JSONL_PATH, STRATEGY_ARTIFACTS_MAX_ITEMS * 2);
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    registerStrategyArtifactReport(row, { skipPersist: true, source: 'rebuild' });
  }
}

function trimStrategyArtifactState() {
  const entries = Object.values(strategyArtifactState.artifacts || {});
  if (entries.length > STRATEGY_ARTIFACTS_MAX_ITEMS) {
    entries.sort((a, b) => (toMs(b.updatedAt) || 0) - (toMs(a.updatedAt) || 0));
    const keep = entries.slice(0, STRATEGY_ARTIFACTS_MAX_ITEMS);
    strategyArtifactState.artifacts = {};
    keep.forEach((r) => {
      strategyArtifactState.artifacts[r.artifactId] = r;
    });
  }
  const keys = Array.from(strategyArtifactState.reportKeys);
  if (keys.length > STRATEGY_ARTIFACTS_REPORT_KEYS_MAX) {
    strategyArtifactState.reportKeys = new Set(keys.slice(-STRATEGY_ARTIFACTS_REPORT_KEYS_MAX));
  }
}

function saveStrategyArtifactState() {
  loadStrategyArtifactState();
  trimStrategyArtifactState();
  const payload = {
    version: 1,
    updatedAt: nowIso(),
    reportKeys: Array.from(strategyArtifactState.reportKeys).slice(-STRATEGY_ARTIFACTS_REPORT_KEYS_MAX),
    artifacts: strategyArtifactState.artifacts,
  };
  const ok = safeJsonWrite(STRATEGY_ARTIFACTS_STATE_PATH, payload, true);
  if (ok) strategyArtifactState.lastSavedAt = nowIso();
}

function applyArtifactLearning(updateLike) {
  loadStrategyArtifactState();
  const u = updateLike && typeof updateLike === 'object' ? updateLike : {};
  const artifactId = /^art-[a-f0-9]{8,20}$/i.test(String(u.artifactId || ''))
    ? String(u.artifactId).toLowerCase()
    : null;
  if (!artifactId) return { ok: false, reason: 'invalid_artifact_id' };
  const reward = clampNum(Number(u.reward), -1, 1);
  if (!Number.isFinite(reward)) return { ok: false, reason: 'invalid_reward' };
  const rec = strategyArtifactState.artifacts[artifactId];
  if (!rec) return { ok: false, reason: 'not_found', artifactId };
  const oldWeight = Number(rec.learningWeight) || 0;
  const nextWeight = clampArtifactWeight(oldWeight * (1 - STRATEGY_ARTIFACT_LR * 0.1) + STRATEGY_ARTIFACT_LR * reward);
  rec.learningWeight = nextWeight;
  rec.scoreEma = clampNum((Number(rec.scoreEma) || 0) * 0.86 + reward * 0.14, -1, 1) || 0;
  rec.updatedAt = u.ts || nowIso();
  rec.lastUsedAt = rec.updatedAt;
  rec.stats.lastReward = reward;
  rec.stats.lastSource = u.source || 'feedback';
  rec.stats.lastReason = truncText(String(u.reason || ''), 220) || null;
  rec.stats.lastUpdatedAt = rec.updatedAt;
  if (u.source === 'feedback') {
    rec.feedbackCount = Math.max(0, Number(rec.feedbackCount) || 0) + 1;
    if (reward >= 0) rec.positiveFeedback = Math.max(0, Number(rec.positiveFeedback) || 0) + 1;
    else rec.negativeFeedback = Math.max(0, Number(rec.negativeFeedback) || 0) + 1;
  }
  saveStrategyArtifactState();
  return {
    ok: true,
    artifactId,
    oldWeight: Number(oldWeight.toFixed(4)),
    newWeight: Number(nextWeight.toFixed(4)),
    scoreEma: Number((Number(rec.scoreEma) || 0).toFixed(4)),
    reward: Number(reward.toFixed(4)),
  };
}

function registerStrategyArtifactReport(reportLike, options = {}) {
  loadStrategyArtifactState();
  const skipPersist = Boolean(options.skipPersist);
  const normalized = normalizeStrategyArtifactReport(reportLike);
  const existingKey = strategyArtifactState.reportKeys.has(normalized.reportKey);
  if (existingKey) {
    const rec = strategyArtifactState.artifacts[normalized.artifactId];
    return {
      ok: true,
      duplicate: true,
      artifactId: normalized.artifactId,
      version: rec ? rec.version : null,
      record: rec || null,
    };
  }
  const now = normalized.ts || nowIso();
  const artifactId = normalized.artifactId;
  const rec =
    strategyArtifactState.artifacts[artifactId] ||
    defaultStrategyArtifactRecord({
      artifactId,
      configHash: normalized.configHash,
      label: normalized.label,
      strategyType: normalized.strategyType,
      source: normalized.source,
      query: normalized.query,
      config: normalized.config,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: now,
    });
  if (!strategyArtifactState.artifacts[artifactId]) {
    strategyArtifactState.artifacts[artifactId] = rec;
  }
  rec.version = Math.max(0, Number(rec.version) || 0) + 1;
  rec.updatedAt = now;
  rec.lastUsedAt = now;
  rec.label = normalized.label || rec.label;
  rec.source = normalized.source || rec.source;
  rec.query = normalized.query || rec.query;
  rec.strategyType = normalized.strategyType || rec.strategyType;
  rec.configHash = normalized.configHash || rec.configHash;
  rec.config = normalized.config;
  rec.lastResult = normalized.result;
  rec.stats.reports = Math.max(0, Number(rec.stats.reports) || 0) + 1;
  rec.stats.totalTrades = Math.max(0, Number(rec.stats.totalTrades) || 0) + Math.max(0, Number(normalized.result.tradeCount) || 0);
  const n = rec.stats.reports;
  rec.stats.avgWinRate =
    n <= 1
      ? Number(normalized.result.winRate) || 0
      : ((Number(rec.stats.avgWinRate) || 0) * (n - 1) + (Number(normalized.result.winRate) || 0)) / n;
  rec.stats.avgNetPnlPct =
    n <= 1
      ? Number(normalized.result.netPnlPct) || 0
      : ((Number(rec.stats.avgNetPnlPct) || 0) * (n - 1) + (Number(normalized.result.netPnlPct) || 0)) / n;
  rec.stats.avgDrawdownPct =
    n <= 1
      ? Number(normalized.result.maxDrawdownPct) || 0
      : ((Number(rec.stats.avgDrawdownPct) || 0) * (n - 1) + (Number(normalized.result.maxDrawdownPct) || 0)) / n;
  if (rec.stats.bestNetPnlPct == null || Number(normalized.result.netPnlPct) > Number(rec.stats.bestNetPnlPct)) {
    rec.stats.bestNetPnlPct = Number(normalized.result.netPnlPct) || 0;
  }
  if (
    rec.stats.worstDrawdownPct == null ||
    Number(normalized.result.maxDrawdownPct) > Number(rec.stats.worstDrawdownPct)
  ) {
    rec.stats.worstDrawdownPct = Number(normalized.result.maxDrawdownPct) || 0;
  }
  const reward = scoreArtifactFromResultMetrics(normalized.result);
  applyArtifactLearning({
    artifactId,
    reward,
    source: 'backtest',
    reason:
      'report:' +
      (normalized.result.strategy || '-') +
      ' wr=' +
      Number(normalized.result.winRate || 0).toFixed(2) +
      ' pnl=' +
      Number(normalized.result.netPnlPct || 0).toFixed(2),
    ts: now,
  });
  strategyArtifactState.reportKeys.add(normalized.reportKey);
  strategyArtifactState.lastUpdatedAt = nowIso();
  trimStrategyArtifactState();
  if (!skipPersist) {
    try {
      fs.mkdirSync(path.dirname(STRATEGY_ARTIFACTS_JSONL_PATH), { recursive: true });
      fs.appendFileSync(
        STRATEGY_ARTIFACTS_JSONL_PATH,
        JSON.stringify({
          ts: now,
          source: normalized.source,
          artifactId,
          reportKey: normalized.reportKey,
          version: rec.version,
          label: rec.label,
          strategyType: rec.strategyType,
          configHash: rec.configHash,
          config: rec.config,
          result: normalized.result,
          reward: Number(reward.toFixed(4)),
          learningWeight: Number(rec.learningWeight || 0),
          scoreEma: Number(rec.scoreEma || 0),
          query: normalized.query || null,
        }) + '\n',
        'utf8',
      );
    } catch {}
    appendTraderMemory({
      key: 'strategy-artifact:' + normalized.reportKey,
      ts: now,
      kind: 'strategy_artifact',
      channel: normalized.source || 'dashboard',
      tags: ['strategy', 'artifact', rec.strategyType || 'custom'],
      content: [
        '策略工件更新',
        'id=' + artifactId + ' v' + String(rec.version),
        'type=' + String(rec.strategyType || '-'),
        'label=' + String(rec.label || '-'),
        'wr=' + String(Number(normalized.result.winRate || 0).toFixed(2)) + '%',
        'trades=' + String(Math.max(0, Number(normalized.result.tradeCount) || 0)),
        'pnl=' + String(Number(normalized.result.netPnlPct || 0).toFixed(2)) + '%',
        'dd=' + String(Number(normalized.result.maxDrawdownPct || 0).toFixed(2)) + '%',
        'weight=' + String(Number(rec.learningWeight || 0).toFixed(4)),
      ].join(' | '),
    });
  }
  saveStrategyArtifactState();
  return {
    ok: true,
    duplicate: false,
    artifactId,
    version: rec.version,
    reward: Number(reward.toFixed(4)),
    learningWeight: Number((Number(rec.learningWeight) || 0).toFixed(4)),
    scoreEma: Number((Number(rec.scoreEma) || 0).toFixed(4)),
    strength: Number(strategyArtifactStrength(rec).toFixed(4)),
    record: rec,
  };
}

function listStrategyArtifacts(limit = STRATEGY_ARTIFACTS_TOPK, query = '') {
  loadStrategyArtifactState();
  const q = String(query || '').trim().toLowerCase();
  const rows = Object.values(strategyArtifactState.artifacts || {}).map((rec) => {
    const strength = strategyArtifactStrength(rec);
    return {
      artifactId: rec.artifactId,
      label: rec.label || null,
      strategyType: rec.strategyType || null,
      source: rec.source || null,
      version: Math.max(0, Number(rec.version) || 0),
      configHash: rec.configHash || null,
      tf: rec?.config?.tf || rec?.lastResult?.tf || null,
      bars: Number(rec?.config?.bars || rec?.lastResult?.bars || 0) || null,
      learningWeight: Number((Number(rec.learningWeight) || 0).toFixed(4)),
      scoreEma: Number((Number(rec.scoreEma) || 0).toFixed(4)),
      strength: Number(strength.toFixed(4)),
      feedbackCount: Math.max(0, Number(rec.feedbackCount) || 0),
      reports: Math.max(0, Number(rec?.stats?.reports) || 0),
      totalTrades: Math.max(0, Number(rec?.stats?.totalTrades) || 0),
      avgWinRate: Number((Number(rec?.stats?.avgWinRate) || 0).toFixed(2)),
      avgNetPnlPct: Number((Number(rec?.stats?.avgNetPnlPct) || 0).toFixed(3)),
      avgDrawdownPct: Number((Number(rec?.stats?.avgDrawdownPct) || 0).toFixed(3)),
      bestNetPnlPct:
        rec?.stats?.bestNetPnlPct == null ? null : Number(Number(rec.stats.bestNetPnlPct).toFixed(3)),
      worstDrawdownPct:
        rec?.stats?.worstDrawdownPct == null ? null : Number(Number(rec.stats.worstDrawdownPct).toFixed(3)),
      lastResult: rec.lastResult || null,
      config: rec.config || null,
      updatedAt: rec.updatedAt || null,
      createdAt: rec.createdAt || null,
      query: rec.query || null,
    };
  });
  const filtered = q
    ? rows.filter((r) => {
        const text = [
          r.artifactId,
          r.label,
          r.strategyType,
          r.source,
          r.tf,
          r.query,
          r?.config?.strategy,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return text.includes(q);
      })
    : rows;
  filtered.sort(
    (a, b) =>
      Number(b.strength || 0) - Number(a.strength || 0) ||
      (toMs(b.updatedAt) || 0) - (toMs(a.updatedAt) || 0) ||
      Number(b.reports || 0) - Number(a.reports || 0),
  );
  return filtered.slice(0, Math.max(1, Math.min(100, Number(limit) || STRATEGY_ARTIFACTS_TOPK)));
}

function strategyArtifactToAction(recordLike) {
  const rec = recordLike && typeof recordLike === 'object' ? recordLike : null;
  if (!rec) return null;
  const cfg = rec.config && typeof rec.config === 'object' ? rec.config : {};
  const base = {};
  if (['1m', '5m', '15m', '1h', '4h', '1d'].includes(String(cfg.tf || ''))) base.tf = String(cfg.tf);
  if (Number.isFinite(Number(cfg.bars))) base.bars = Number(cfg.bars);
  if (Number.isFinite(Number(cfg.feeBps))) base.feeBps = Number(cfg.feeBps);
  if (Number.isFinite(Number(cfg.stopAtr))) base.stopAtr = Number(cfg.stopAtr);
  if (Number.isFinite(Number(cfg.tpAtr))) base.tpAtr = Number(cfg.tpAtr);
  if (Number.isFinite(Number(cfg.maxHold))) base.maxHold = Number(cfg.maxHold);
  if (cfg.dsl && typeof cfg.dsl === 'object') {
    return {
      type: 'run_strategy_dsl',
      artifactId: rec.artifactId,
      ...base,
      dsl: normalizeStrategyDslSpec(cfg.dsl),
    };
  }
  if (cfg.custom && typeof cfg.custom === 'object') {
    return {
      type: 'run_custom_backtest',
      artifactId: rec.artifactId,
      strategy: String(cfg.strategy || 'custom'),
      ...base,
      custom: cfg.custom,
    };
  }
  return {
    type: 'run_backtest',
    artifactId: rec.artifactId,
    strategy: String(cfg.strategy || rec?.lastResult?.strategy || 'v5_hybrid'),
    ...base,
  };
}

function parseStrategyArtifactFeedbackIntent(messageLike) {
  const text = String(messageLike || '').trim();
  if (!text) return null;
  const lower = text.toLowerCase();
  const explicit = /^(反馈工件|工件反馈|artifact\s*feedback|strategy\s*artifact\s*feedback)\s*[:：]?\s*/i.test(
    text,
  );
  const hasArtifactWord = /(工件|artifact|art-[a-f0-9]{8,20})/i.test(text);
  if (!explicit && !hasArtifactWord) return null;
  const idMatch = text.match(/\b(art-[a-f0-9]{8,20})\b/i);
  let artifactId = idMatch ? String(idMatch[1]).toLowerCase() : null;
  if (!artifactId) {
    artifactId = listStrategyArtifacts(1)[0]?.artifactId || null;
  }
  if (!artifactId) {
    return {
      explicit: true,
      artifactId: null,
      reward: null,
      handled: true,
      reason: 'no_artifact',
    };
  }
  let reward = null;
  const numMatch = text.match(/(?:^|[\s:：,，])([+-]?\d+(?:\.\d+)?)(?=$|[\s,，。!！])/);
  if (numMatch) {
    const n = Number(numMatch[1]);
    if (Number.isFinite(n)) reward = Math.abs(n) > 1 ? clampNum(n / 2, -1, 1) : clampNum(n, -1, 1);
  }
  if (reward == null) {
    const positive = /(看好|很好|不错|有效|有用|收益|盈利|继续|增强|加强|喜欢|稳|牛|赚|good|great|works?)/i.test(
      lower,
    );
    const negative = /(不好|很差|失效|无效|亏损|回撤|太激进|风险高|停用|减弱|削弱|讨厌|bad|poor|worse|loss)/i.test(
      lower,
    );
    if (positive && !negative) reward = 0.55;
    else if (negative && !positive) reward = -0.55;
    else if (positive && negative) reward = -0.15;
  }
  if (reward == null && explicit) {
    return { explicit, artifactId, reward: null, handled: true, reason: 'missing_sentiment' };
  }
  if (reward == null) return null;
  return {
    explicit: Boolean(explicit),
    artifactId,
    reward: clampNum(reward, -1, 1) || 0,
  };
}

function applyUserStrategyArtifactFeedback(messageLike, channel = 'dashboard') {
  const intent = parseStrategyArtifactFeedbackIntent(messageLike);
  if (!intent) return { handled: false };
  if (!intent.artifactId) {
    return {
      handled: true,
      applied: false,
      explicit: true,
      reply: '未找到可反馈的策略工件。先运行一次策略回验，系统会自动沉淀工件。',
    };
  }
  if (intent.reward == null) {
    return {
      handled: true,
      applied: false,
      explicit: true,
      artifactId: intent.artifactId,
      reply: '已识别为工件反馈，但未识别到正/负方向。示例：反馈工件 ' + intent.artifactId + ' +0.6',
    };
  }
  const updated = applyArtifactLearning({
    artifactId: intent.artifactId,
    reward: intent.reward,
    source: 'feedback',
    reason: truncText(String(messageLike || ''), 220),
    ts: nowIso(),
  });
  if (!updated?.ok) {
    return {
      handled: true,
      applied: false,
      explicit: Boolean(intent.explicit),
      artifactId: intent.artifactId,
      reply: '工件反馈失败：' + String(updated?.reason || 'unknown'),
    };
  }
  const top = listStrategyArtifacts(12).find((x) => x.artifactId === intent.artifactId) || null;
  appendTraderMemory({
    key: 'strategy-artifact-feedback:' + sha1(String(messageLike || '') + ':' + nowIso()).slice(0, 24),
    ts: nowIso(),
    kind: 'strategy_artifact_feedback',
    channel,
    tags: ['strategy', 'artifact', 'user_feedback', intent.artifactId],
    content:
      '工件反馈(用户) | artifact=' +
      intent.artifactId +
      ' | reward=' +
      String(Number(intent.reward).toFixed(4)) +
      ' | text=' +
      redactSecrets(messageLike),
  });
  return {
    handled: true,
    applied: true,
    explicit: Boolean(intent.explicit),
    artifactId: intent.artifactId,
    reward: intent.reward,
    learningWeight: top?.learningWeight ?? null,
    strength: top?.strength ?? null,
    reply:
      '已记录工件反馈：' +
      intent.artifactId +
      ' ' +
      (intent.reward >= 0 ? '+' : '') +
      Number(intent.reward).toFixed(2) +
      '（当前权重=' +
      (top ? Number(top.learningWeight).toFixed(3) : Number(updated.newWeight || 0).toFixed(3)) +
      '）',
  };
}

function buildStrategyArtifactStatusReply(limit = 6) {
  const rows = listStrategyArtifacts(limit);
  if (!rows.length) {
    return [
      '策略工件：暂无记录。',
      '提示：运行策略回验后，系统会自动沉淀工件并进入闭环学习。',
    ].join('\n');
  }
  const list = rows.map((r, idx) => {
    const pnl = Number(r.avgNetPnlPct || 0);
    return (
      String(idx + 1) +
      '. ' +
      r.artifactId +
      ' · ' +
      (r.label || '-') +
      ' · type=' +
      (r.strategyType || '-') +
      ' · v' +
      String(r.version || 0) +
      ' · 权重=' +
      Number(r.learningWeight || 0).toFixed(3) +
      ' · 胜率=' +
      Number(r.avgWinRate || 0).toFixed(1) +
      '% · PnL=' +
      (pnl >= 0 ? '+' : '') +
      pnl.toFixed(2) +
      '%'
    );
  });
  return [
    '策略工件状态（Top ' + rows.length + '）：',
    ...list,
    '',
    '使用方式：发送「使用工件 art-xxxxxx」即可直接执行该工件策略。',
    '反馈方式：发送「反馈工件 art-xxxxxx +0.6」可强化闭环学习。',
  ].join('\n');
}

function buildMidTermMemoryProfile() {
  learnStrategyWeightsFromTrades();
  loadStrategyArtifactState();
  const longProfile = buildTraderProfileSummary();
  const ranking = buildStrategyWeightsRanking(TRADER_MID_TOP_STRATEGIES);
  const artifactRanking = listStrategyArtifacts(STRATEGY_ARTIFACTS_TOPK);
  const topTags = Array.isArray(longProfile?.topTags) ? longProfile.topTags : [];
  const styleTag = topTags.find((x) => x.tag === 'brief-style' || x.tag === 'detailed-style');
  const responseStyle = styleTag?.tag === 'brief-style' ? 'brief' : styleTag?.tag === 'detailed-style' ? 'detailed' : 'balanced';
  const profile = {
    updatedAt: nowIso(),
    responseStyle,
    preferredSymbols: Array.isArray(longProfile?.symbols) ? longProfile.symbols.slice(0, 4) : [],
    topTags: topTags.slice(0, 8),
    strategyWeights: ranking,
    strategyArtifacts: artifactRanking,
    guidance: {
      topStrategy: ranking[0]?.strategy || null,
      topArtifactId: artifactRanking[0]?.artifactId || null,
      topArtifactType: artifactRanking[0]?.strategyType || null,
      keepRiskFirst: true,
      summaryTone: responseStyle,
    },
  };
  midTermMemoryState.profile = profile;
  midTermMemoryState.lastBuiltAt = profile.updatedAt;
  safeJsonWrite(TRADER_PROFILE_PATH, profile, true);
  return profile;
}

function buildLayeredMemoryBundle(queryText) {
  const q = String(queryText || '').trim();
  const longProfile = buildTraderProfileSummary();
  const longRelevant = retrieveTraderMemories(q, TRADER_MEMORY_RETRIEVE_TOPK);
  const shortSnapshot = buildShortTermSnapshot(q);
  const midProfile = buildMidTermMemoryProfile();
  return {
    profile: longProfile,
    relevant: longRelevant,
    layers: {
      shortTerm: shortSnapshot,
      midTerm: midProfile,
      longTerm: {
        profile: longProfile,
        relevant: longRelevant,
      },
    },
  };
}

function loadTraderMemory() {
  if (traderMemoryState.loaded) return;
  traderMemoryState.loaded = true;
  traderMemoryState.entries = [];
  traderMemoryState.keys = new Set();
  try {
    if (!fs.existsSync(TRADER_MEMORY_PATH)) return;
    const raw = fs.readFileSync(TRADER_MEMORY_PATH, 'utf8');
    const lines = String(raw || '').split(/\r?\n/).filter(Boolean);
    const parsed = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (!entry || typeof entry !== 'object') continue;
        const content = redactSecrets(entry.content || '');
        const normalized = {
          id: entry.id || null,
          key: entry.key || null,
          ts: entry.ts || null,
          kind: entry.kind || 'note',
          channel: entry.channel || null,
          content,
          tags: Array.isArray(entry.tags) ? entry.tags.map((x) => String(x)).slice(0, 12) : [],
          tokens: Array.isArray(entry.tokens)
            ? entry.tokens.map((x) => String(x))
            : tokenizeMemoryText(content + ' ' + (Array.isArray(entry.tags) ? entry.tags.join(' ') : '')),
          vec: Array.isArray(entry.vec)
            ? entry.vec
                .map((pair) =>
                  Array.isArray(pair) && pair.length >= 2
                    ? [Number(pair[0]) || 0, Number(pair[1]) || 0]
                    : null,
                )
                .filter(Boolean)
            : null,
        };
        if (!normalized.vec || !normalized.vec.length) {
          normalized.vec = buildSparseVector(normalized.tokens);
        }
        parsed.push(normalized);
        if (normalized.key) traderMemoryState.keys.add(normalized.key);
      } catch {}
    }
    traderMemoryState.entries = parsed.slice(-TRADER_MEMORY_MAX_ITEMS);
    traderMemoryState.linesRead = traderMemoryState.entries.length;
    traderMemoryState.lastLoadAt = nowIso();
  } catch {}
}

function appendTraderMemory(entryLike) {
  loadTraderMemory();
  const entry = entryLike && typeof entryLike === 'object' ? entryLike : {};
  const key = entry.key ? String(entry.key) : null;
  if (key && traderMemoryState.keys.has(key)) return null;
  const ts = entry.ts || nowIso();
  const content = redactSecrets(entry.content || '');
  if (!String(content || '').trim()) return null;
  const explicitTags = Array.isArray(entry.tags) ? entry.tags.map((x) => String(x)).slice(0, 12) : [];
  const tags = Array.from(new Set([...explicitTags, ...inferMemoryTags(content)])).slice(0, 12);
  const record = {
    id: String(Date.now()) + '-' + String(Math.random()).slice(2, 8),
    key,
    ts,
    kind: entry.kind || 'note',
    channel: entry.channel || null,
    content,
    tags,
    tokens: tokenizeMemoryText(content + ' ' + tags.join(' ')).slice(0, 220),
  };
  record.vec = buildSparseVector(record.tokens);
  try {
    fs.mkdirSync(path.dirname(TRADER_MEMORY_PATH), { recursive: true });
    fs.appendFileSync(TRADER_MEMORY_PATH, JSON.stringify(record) + '\n');
  } catch {}
  traderMemoryState.entries.push(record);
  if (record.key) traderMemoryState.keys.add(record.key);
  if (traderMemoryState.entries.length > TRADER_MEMORY_MAX_ITEMS) {
    const keep = traderMemoryState.entries.slice(-TRADER_MEMORY_MAX_ITEMS);
    traderMemoryState.entries = keep;
    traderMemoryState.keys = new Set(keep.map((x) => x.key).filter(Boolean));
  }
  syncShortTermFromLongRecord(record);
  return record;
}

function rememberTradeOutcomesToMemory() {
  const ordersRaw = safeJsonRead(REPORT_ORDERS_PATH, { orders: [] });
  const orders = normalizedOrdersFromPayload(ordersRaw).filter(Boolean);
  const closed = orders.filter((o) => o?.closeTs).slice(-180);
  for (const o of closed) {
    const tradeId = o?.tradeId != null ? String(o.tradeId) : '-';
    const cycleId = o?.cycleId != null ? String(o.cycleId) : '-';
    const key = 'trade-close:' + tradeId + ':' + cycleId + ':' + String(toMs(o?.closeTs) || 0);
    const pnl = toNum(o?.pnlEstUSDT);
    const pnlTxt = pnl == null ? '-' : (pnl >= 0 ? '+' : '') + pnl.toFixed(4) + 'U';
    const content = [
      '交易结果记录',
      'trade=' + tradeId + ' cycle=' + cycleId,
      'symbol=' + String(o?.symbol || '-') + ' side=' + sideCn(o?.side),
      'open=' + fmtPriceNum(o?.openPrice, 2) + ' close=' + fmtPriceNum(o?.closePrice, 2),
      'pnl=' + pnlTxt + ' reason=' + String(o?.closeReason || '-'),
      'closeTs=' + String(o?.closeTs || '-'),
    ].join(' | ');
    appendTraderMemory({
      key,
      ts: o?.closeTs || nowIso(),
      kind: 'trade_outcome',
      channel: 'system',
      tags: ['trade', 'outcome', String(o?.side || 'unknown')],
      content,
    });
  }
}

function buildTraderProfileSummary() {
  loadTraderMemory();
  const recent = traderMemoryState.entries.slice(-TRADER_MEMORY_RECENT_WINDOW);
  const tagCount = new Map();
  const symCount = new Map();
  let lastActiveAt = null;
  for (const e of recent) {
    const ts = toMs(e?.ts);
    if (ts != null && (lastActiveAt == null || ts > lastActiveAt)) lastActiveAt = ts;
    (Array.isArray(e?.tags) ? e.tags : []).forEach((t) => {
      tagCount.set(t, (tagCount.get(t) || 0) + 1);
    });
    const text = String(e?.content || '').toUpperCase();
    ['BTC', 'ETH', 'SOL'].forEach((sym) => {
      if (text.includes(sym)) symCount.set(sym, (symCount.get(sym) || 0) + 1);
    });
  }
  const topTags = Array.from(tagCount.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([tag, cnt]) => ({ tag, count: cnt }));
  const symbols = Array.from(symCount.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([symbol, count]) => ({ symbol, count }));
  return {
    memoryItems: traderMemoryState.entries.length,
    recentWindow: recent.length,
    lastActiveAt: lastActiveAt != null ? new Date(lastActiveAt).toISOString() : null,
    topTags,
    symbols,
  };
}

function retrieveTraderMemories(query, limit = TRADER_MEMORY_RETRIEVE_TOPK) {
  loadTraderMemory();
  rememberTradeOutcomesToMemory();
  const queryText = redactSecrets(query || '');
  const qTokens = tokenizeMemoryText(queryText);
  const qVec = buildSparseVector(qTokens);
  const now = Date.now();
  const maxN = Math.max(1, Math.min(24, Number(limit) || TRADER_MEMORY_RETRIEVE_TOPK));
  const ranked = [];
  const pool = traderMemoryState.entries.slice(-Math.max(400, TRADER_MEMORY_RECENT_WINDOW * 8));
  for (const e of pool) {
    const tokens = Array.isArray(e.tokens) ? e.tokens : [];
    let score = 0;
    if (queryText && String(e.content || '').toLowerCase().includes(queryText.toLowerCase())) score += 4;
    for (const t of qTokens) {
      if (tokens.includes(t)) score += 1;
    }
    const vecScore = sparseVecCosine(qVec, Array.isArray(e.vec) ? e.vec : buildSparseVector(tokens));
    score += vecScore * 4;
    const ageMs = Math.max(0, now - (toMs(e.ts) || now));
    const ageH = ageMs / 3600000;
    score += Math.max(0, 1.6 - ageH / 96);
    if (e.kind === 'trade_outcome') score += 0.4;
    if (score <= 0.2) continue;
    ranked.push({ score, e });
  }
  ranked.sort((a, b) => b.score - a.score || (toMs(b.e?.ts) || 0) - (toMs(a.e?.ts) || 0));
  return ranked.slice(0, maxN).map((x) => ({
    ts: x.e.ts || null,
    kind: x.e.kind || 'note',
    channel: x.e.channel || null,
    tags: Array.isArray(x.e.tags) ? x.e.tags.slice(0, 8) : [],
    content: truncText(String(x.e.content || ''), 480),
    score: Number(x.score.toFixed(3)),
  }));
}

function toMs(tsLike) {
  const ms = Date.parse(String(tsLike || ''));
  return Number.isFinite(ms) ? ms : null;
}

function toNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizedOrdersFromPayload(payload) {
  if (Array.isArray(payload?.orders)) return payload.orders;
  if (Array.isArray(payload)) return payload;
  return [];
}

function latestPriceFromOhlcv(dataByTf) {
  const tfOrder = ['1m', '5m', '15m', '1h', '4h', '1d'];
  for (const tf of tfOrder) {
    const bars = Array.isArray(dataByTf?.[tf]) ? dataByTf[tf] : [];
    if (!bars.length) continue;
    const last = bars[bars.length - 1];
    const prev = bars.length > 1 ? bars[bars.length - 2] : null;
    const close = toNum(last?.close);
    const prevClose = toNum(prev?.close);
    const changePct =
      close != null && prevClose != null && prevClose !== 0
        ? ((close - prevClose) / prevClose) * 100
        : null;
    return {
      tf,
      time: last?.time ?? null,
      close,
      open: toNum(last?.open),
      high: toNum(last?.high),
      low: toNum(last?.low),
      changePct,
    };
  }
  return null;
}

function normalizeSide(side) {
  const s = String(side || '').toLowerCase();
  if (s === 'long') return 'long';
  if (s === 'short') return 'short';
  return 'neutral';
}

function sideCn(side) {
  const s = normalizeSide(side);
  if (s === 'long') return '做多';
  if (s === 'short') return '做空';
  return '无信号';
}

function summarizeDecision(r) {
  const plan = r?.signal?.plan || null;
  const side = normalizeSide(plan?.side);
  return {
    ts: r?.ts || null,
    cycleId: r?.cycleId || null,
    side,
    sideCn: sideCn(side),
    hasAlert: Boolean(r?.signal?.hasAlert),
    blockedByNews: Boolean(r?.decision?.blockedByNews),
    executed: Boolean(r?.executor?.executed),
    dryRun: Boolean(r?.executor?.dryRun),
    executorReason: r?.executor?.reason || null,
    signalReason: plan?.reason || null,
  };
}

function summarizeOrder(o) {
  const side = normalizeSide(o?.side);
  return {
    tradeId: o?.tradeId != null ? String(o.tradeId) : null,
    cycleId: o?.cycleId != null ? String(o.cycleId) : null,
    side,
    sideCn: sideCn(side),
    symbol: o?.symbol || null,
    openTs: o?.openTs || null,
    closeTs: o?.closeTs || null,
    openPrice: toNum(o?.openPrice),
    closePrice: toNum(o?.closePrice),
    pnlEstUSDT: toNum(o?.pnlEstUSDT),
    isSynthetic: Boolean(o?.isSynthetic),
    state: o?.closeTs ? 'closed' : 'open',
  };
}

function buildTimelineEvent(r) {
  const plan = r?.signal?.plan || null;
  const side = normalizeSide(plan?.side);
  const blocked = Boolean(r?.decision?.blockedByNews);
  const hasSignal = Boolean(r?.signal?.hasAlert);
  const executed = Boolean(r?.executor?.executed);
  const reason = String(r?.executor?.reason || '').trim();
  let tag = 'info';
  if (blocked) tag = 'risk';
  else if (executed || reason.includes('open') || reason.includes('close')) tag = 'order';
  else if (hasSignal) tag = 'signal';

  let title = '无信号，继续观察';
  if (blocked) title = '触发新闻/风控拦截';
  else if (hasSignal && side === 'long') title = '识别做多信号';
  else if (hasSignal && side === 'short') title = '识别做空信号';
  else if (hasSignal) title = '识别交易信号';

  const bits = [];
  if (plan?.reason) bits.push(String(plan.reason));
  if (reason) bits.push('执行器: ' + reason);
  if (!bits.length && r?.decision?.newsReason?.length) {
    bits.push('风控原因: ' + String(r.decision.newsReason[0]));
  }
  return {
    ts: r?.ts || null,
    tag,
    title,
    sub: bits.join(' | ') || '-',
  };
}

function getCurrentTradeFromDecisions(sortedDecisions) {
  const latest = sortedDecisions[0];
  const wp = latest?.executor?.wouldOpenPosition || null;
  if (!latest || !wp) return null;
  const side = normalizeSide(wp?.side);
  return {
    tradeId: latest?.cycleId ? 'cycle:' + String(latest.cycleId) : null,
    cycleId: latest?.cycleId || null,
    side,
    sideCn: sideCn(side),
    state: 'dryrun-open',
    openTs: latest?.ts || null,
    openPrice: toNum(wp?.entryPrice),
    closeTs: null,
  };
}

function buildTradingContext(clientContext, memoryContext) {
  const decisionsRaw = safeJsonRead(REPORT_DECISIONS_PATH, []);
  const ordersRaw = safeJsonRead(REPORT_ORDERS_PATH, { orders: [] });
  const ohlcvRaw = safeJsonRead(REPORT_OHLCV_PATH, { symbol: 'BTC/USDT:USDT', data: {} });

  const decisions = Array.isArray(decisionsRaw) ? decisionsRaw : [];
  const orders = normalizedOrdersFromPayload(ordersRaw);
  const symbol = typeof ohlcvRaw?.symbol === 'string' ? ohlcvRaw.symbol : 'BTC/USDT:USDT';
  const ohlcvByTf =
    ohlcvRaw && typeof ohlcvRaw === 'object' && ohlcvRaw.data && typeof ohlcvRaw.data === 'object'
      ? ohlcvRaw.data
      : {};

  const sortedDecisions = decisions
    .filter((r) => r && r.ts && !r.stage)
    .slice()
    .sort((a, b) => (toMs(b?.ts) || 0) - (toMs(a?.ts) || 0));
  const sortedOrders = orders
    .filter(Boolean)
    .slice()
    .sort((a, b) => (toMs(b?.openTs || b?.closeTs) || 0) - (toMs(a?.openTs || a?.closeTs) || 0));
  const openOrders = sortedOrders.filter((o) => !o?.closeTs);
  const latestDecision = sortedDecisions[0] || null;
  const currentOrder = openOrders[0] || sortedOrders[0] || getCurrentTradeFromDecisions(sortedDecisions);
  const latestPrice = latestPriceFromOhlcv(ohlcvByTf);
  const recentDecisions = sortedDecisions
    .slice(0, Math.max(8, OPENCLAW_CONTEXT_MAX_DECISIONS))
    .map(summarizeDecision);
  const recentOrders = sortedOrders.slice(0, OPENCLAW_CONTEXT_MAX_ORDERS).map(summarizeOrder);

  const blockedCount = sortedDecisions.filter((r) => r?.decision?.blockedByNews).length;
  const executedCount = sortedDecisions.filter((r) => r?.executor?.executed).length;
  const dryRunOpenCount = sortedDecisions.filter(
    (r) => Boolean(r?.executor?.dryRun) && Boolean(r?.executor?.wouldOpenPosition),
  ).length;

  let timelineSource = sortedDecisions.slice(0, OPENCLAW_CONTEXT_TIMELINE_EVENTS);
  const currentCycle = Number(currentOrder?.cycleId);
  if (Number.isFinite(currentCycle)) {
    const filtered = sortedDecisions.filter((r) => Number(r?.cycleId) >= currentCycle);
    if (filtered.length) timelineSource = filtered.slice(0, OPENCLAW_CONTEXT_TIMELINE_EVENTS);
  }
  const runtimeTimeline = timelineSource.map(buildTimelineEvent).reverse();
  const layeredMemory =
    memoryContext && memoryContext.layers && typeof memoryContext.layers === 'object'
      ? memoryContext.layers
      : null;
  const longLayer = layeredMemory?.longTerm || {
    profile: memoryContext?.profile || null,
    relevant: Array.isArray(memoryContext?.relevant) ? memoryContext.relevant : [],
  };
  const midLayer = layeredMemory?.midTerm || null;
  const shortLayer = layeredMemory?.shortTerm || null;
  const topStrategy = Array.isArray(midLayer?.strategyWeights) ? midLayer.strategyWeights[0] || null : null;
  const topArtifact = Array.isArray(midLayer?.strategyArtifacts) ? midLayer.strategyArtifacts[0] || null : null;

  const digest = {
    symbol,
    decisions: sortedDecisions.length,
    orders: sortedOrders.length,
    openOrders: openOrders.length,
    latestDecisionTs: latestDecision?.ts || null,
    latestSignal: sideCn(latestDecision?.signal?.plan?.side),
    currentTradeId: currentOrder?.tradeId || null,
    currentTradeSide: currentOrder?.side ? sideCn(currentOrder.side) : '无',
    currentPrice: latestPrice?.close ?? null,
    blockedCount,
    executedCount,
    dryRunOpenCount,
    memoryItems: Number(longLayer?.profile?.memoryItems || memoryContext?.profile?.memoryItems || 0),
    topStrategy: topStrategy?.strategy || null,
    topStrategyWeight: toNum(topStrategy?.weight),
    topArtifactId: topArtifact?.artifactId || null,
    topArtifactWeight: toNum(topArtifact?.learningWeight),
  };

  const context = {
    generatedAt: new Date().toISOString(),
    digest,
    market: {
      symbol,
      latestPrice,
    },
    strategy: {
      latestDecision: latestDecision ? summarizeDecision(latestDecision) : null,
      blockedCount,
      executedCount,
      dryRunOpenCount,
      recentDecisions,
      artifacts: Array.isArray(midLayer?.strategyArtifacts)
        ? midLayer.strategyArtifacts.slice(0, STRATEGY_ARTIFACTS_TOPK)
        : [],
    },
    trades: {
      openOrders: openOrders.slice(0, 6).map(summarizeOrder),
      recentOrders,
      currentTrade: currentOrder ? summarizeOrder(currentOrder) : null,
      runtimeTimeline,
    },
    uiActions: {
      switchViews: ['dashboard', 'runtime', 'kline', 'history', 'backtest', 'xsea'],
      backtest: {
        strategy: ['v5_hybrid', 'v5_retest', 'v5_reentry', 'v4_breakout'],
        tf: ['1m', '5m', '15m', '1h', '4h', '1d'],
        artifactApi: '/api/strategy/artifacts',
        reportApi: '/api/strategy/artifacts/report',
      },
    },
    clientContext:
      clientContext && typeof clientContext === 'object'
        ? {
            currentView: clientContext.currentView || null,
            activeTradeId: clientContext.activeTradeId || null,
            userIntentHint: clientContext.userIntentHint || null,
          }
        : null,
    shortTermMemory: shortLayer || null,
    midTermMemory: midLayer || null,
    longTermMemory:
      longLayer && typeof longLayer === 'object'
        ? {
            profile: longLayer.profile || null,
            relevant: Array.isArray(longLayer.relevant)
              ? longLayer.relevant.slice(0, TRADER_MEMORY_RETRIEVE_TOPK)
              : [],
          }
        : null,
    memoryLayers: layeredMemory
      ? {
          shortTerm: shortLayer || null,
          midTerm: midLayer || null,
          longTerm: longLayer || null,
        }
      : null,
  };
  return { context, digest };
}

function resolveOpenClawCli() {
  const explicit = (process.env.OPENCLAW_CLI_BIN || '').trim();
  if (explicit) {
    return { command: explicit, prefixArgs: [], source: 'env:OPENCLAW_CLI_BIN' };
  }
  if (fs.existsSync(OPENCLAW_REPO_ENTRY) && fs.existsSync(OPENCLAW_REPO_MODULES)) {
    return {
      command: process.execPath,
      prefixArgs: [OPENCLAW_REPO_ENTRY],
      source: 'workspace:openclaw/openclaw.mjs',
    };
  }
  return { command: 'openclaw', prefixArgs: [], source: 'system:openclaw' };
}

function parseJsonLoose(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {}
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {}
  }
  return null;
}

function parseStructuredAgentReply(text) {
  const raw = String(text || '').trim();
  if (!raw) return { reply: '', actions: [] };

  const candidates = [];
  const direct = parseJsonLoose(raw);
  if (direct && typeof direct === 'object') candidates.push(direct);

  const blocks = raw.match(/```(?:json)?[\s\S]*?```/gi) || [];
  for (const block of blocks) {
    const inner = block
      .replace(/^```(?:json)?/i, '')
      .replace(/```$/i, '')
      .trim();
    const parsed = parseJsonLoose(inner);
    if (parsed && typeof parsed === 'object') candidates.push(parsed);
  }

  for (const c of candidates) {
    const reply = typeof c.reply === 'string' ? c.reply.trim() : '';
    const actions = normalizeAiActions(c.actions);
    if (reply || actions.length) {
      return {
        reply: reply || raw,
        actions,
      };
    }
  }

  return { reply: raw, actions: [] };
}

function normalizeViewName(viewLike) {
  const raw = String(viewLike || '').trim().toLowerCase();
  if (!raw) return null;
  const alias = {
    main: 'dashboard',
    thunderclaw: 'dashboard',
    dashboard: 'dashboard',
    ai: 'dashboard',
    chat: 'dashboard',
    'ai聊天': 'dashboard',
    runtime: 'runtime',
    current: 'runtime',
    position: 'runtime',
    当前单: 'runtime',
    kline: 'kline',
    xline: 'kline',
    虾线: 'kline',
    chart: 'kline',
    k线: 'kline',
    history: 'history',
    orders: 'history',
    历史: 'history',
    历史单: 'history',
    backtest: 'backtest',
    xstrategy: 'backtest',
    虾策: 'backtest',
    复盘: 'backtest',
    回验: 'backtest',
    回测: 'backtest',
    xsea: 'xsea',
    虾海: 'xsea',
    社区策略: 'xsea',
  };
  return alias[raw] || null;
}

function clampNum(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (Number.isFinite(min) && n < min) return min;
  if (Number.isFinite(max) && n > max) return max;
  return n;
}

function normalizeStrategyDslSpec(specLike) {
  const src = specLike && typeof specLike === 'object' ? specLike : {};
  const out = {};
  const allowedKinds = new Set([
    'price',
    'ema',
    'sma',
    'rsi',
    'atr',
    'adx',
    'donchian_high',
    'donchian_low',
    'pct_change',
    'constant',
  ]);
  const allowedSources = new Set(['open', 'high', 'low', 'close', 'volume', 'hl2', 'ohlc4']);
  const normName = (v, fallback) => {
    const raw = String(v || '').toLowerCase();
    const n = raw.replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
    return /^[a-z][a-z0-9_]{0,31}$/.test(n) ? n : fallback;
  };
  const normExpr = (v) => {
    const raw = String(v || '').trim();
    if (!raw) return '';
    let s = raw
      .replace(/（/g, '(')
      .replace(/）/g, ')')
      .replace(/，/g, ',')
      .replace(/：/g, ':')
      .replace(/并且|且/g, '&&')
      .replace(/或者|或/g, '||')
      .replace(/\band\b/gi, '&&')
      .replace(/\bor\b/gi, '||')
      .replace(/；/g, ' ')
      .replace(/;/g, ' ')
      .trim();
    if (s.length > 260) s = s.slice(0, 260);
    if (!/^[a-zA-Z0-9_\s().,+\-*/%<>=!&|?:]+$/.test(s)) return '';
    return s;
  };
  const name = String(src.name || '').trim();
  if (name) out.name = name.slice(0, 64);
  const side = String(src.side || '').toLowerCase();
  if (['long', 'short', 'both'].includes(side)) out.side = side;
  const features = [];
  const usedNames = new Set();
  const rawFeatures = Array.isArray(src.features) ? src.features : [];
  rawFeatures.slice(0, 24).forEach((f, idx) => {
    if (!f || typeof f !== 'object') return;
    const kind = String(f.kind || '').toLowerCase();
    if (!allowedKinds.has(kind)) return;
    const fallbackName = (kind + '_' + String(idx + 1)).replace(/[^a-z0-9_]/g, '_');
    const nameNorm = normName(f.name, fallbackName);
    if (!nameNorm || usedNames.has(nameNorm)) return;
    usedNames.add(nameNorm);
    const item = { name: nameNorm, kind };
    const srcVal = String(f.source || '').toLowerCase();
    if (allowedSources.has(srcVal)) item.source = srcVal;
    const period = clampNum(f.period, 1, 500);
    const lookback = clampNum(f.lookback, 1, 500);
    const shift = clampNum(f.shift, -120, 120);
    const value = clampNum(f.value, -1e9, 1e9);
    if (period != null) item.period = Math.round(period);
    if (lookback != null) item.lookback = Math.round(lookback);
    if (shift != null) item.shift = Math.round(shift);
    if (value != null) item.value = Number(value);
    features.push(item);
  });
  if (features.length) out.features = features;
  const entryLong = normExpr(src.entryLong);
  const entryShort = normExpr(src.entryShort);
  const exitLong = normExpr(src.exitLong);
  const exitShort = normExpr(src.exitShort);
  if (entryLong) out.entryLong = entryLong;
  if (entryShort) out.entryShort = entryShort;
  if (exitLong) out.exitLong = exitLong;
  if (exitShort) out.exitShort = exitShort;
  if ((!out.entryLong || !out.entryShort || !out.exitLong || !out.exitShort) && features.length) {
    const n = features[0].name;
    if (!out.entryLong) out.entryLong = 'close > ' + n;
    if (!out.entryShort) out.entryShort = 'close < ' + n;
    if (!out.exitLong) out.exitLong = 'close < ' + n;
    if (!out.exitShort) out.exitShort = 'close > ' + n;
  }
  const risk = src.risk && typeof src.risk === 'object' ? src.risk : {};
  const riskOut = {};
  const stopAtr = clampNum(risk.stopAtr, 0.2, 20);
  const tpAtr = clampNum(risk.tpAtr, 0.2, 40);
  const maxHold = clampNum(risk.maxHold, 1, 3000);
  const cooldownBars = clampNum(risk.cooldownBars, 0, 60);
  if (stopAtr != null) riskOut.stopAtr = Number(stopAtr);
  if (tpAtr != null) riskOut.tpAtr = Number(tpAtr);
  if (maxHold != null) riskOut.maxHold = Math.round(maxHold);
  if (cooldownBars != null) riskOut.cooldownBars = Math.round(cooldownBars);
  if (Object.keys(riskOut).length) out.risk = riskOut;
  return out;
}

function normalizeAiActions(actionsLike) {
  if (!Array.isArray(actionsLike)) return [];
  const out = [];
  const seen = new Set();
  const pushUnique = (action) => {
    if (!action || typeof action !== 'object') return;
    const key = JSON.stringify(action);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(action);
  };
  for (const item of actionsLike) {
    if (!item || typeof item !== 'object') continue;
    const type = String(item.type || '').trim().toLowerCase();
    if (type === 'switch_view') {
      const view = normalizeViewName(item.view);
      if (view) pushUnique({ type: 'switch_view', view });
      continue;
    }
    if (type === 'focus_trade') {
      const tradeId = String(item.tradeId || '').trim();
      if (tradeId) pushUnique({ type: 'focus_trade', tradeId });
      continue;
    }
    if (type === 'run_backtest') {
      const strategy = String(item.strategy || '').trim();
      const tf = String(item.tf || '').trim();
      const normalized = { type: 'run_backtest' };
      if (['v5_hybrid', 'v5_retest', 'v5_reentry', 'v4_breakout'].includes(strategy)) {
        normalized.strategy = strategy;
      }
      if (['1m', '5m', '15m', '1h', '4h', '1d'].includes(tf)) {
        normalized.tf = tf;
      }
      const bars = clampNum(item.bars, 80, 5000);
      const feeBps = clampNum(item.feeBps, 0, 100);
      const stopAtr = clampNum(item.stopAtr, 0.2, 10);
      const tpAtr = clampNum(item.tpAtr, 0.2, 20);
      const maxHold = clampNum(item.maxHold, 1, 1000);
      if (bars != null) normalized.bars = Math.round(bars);
      if (feeBps != null) normalized.feeBps = Number(feeBps);
      if (stopAtr != null) normalized.stopAtr = Number(stopAtr);
      if (tpAtr != null) normalized.tpAtr = Number(tpAtr);
      if (maxHold != null) normalized.maxHold = Math.round(maxHold);
      pushUnique(normalized);
      continue;
    }
    if (type === 'run_custom_backtest') {
      const strategy = String(item.strategy || '').trim();
      const tf = String(item.tf || '').trim();
      const normalized = { type: 'run_custom_backtest' };
      if (['v5_hybrid', 'v5_retest', 'v5_reentry', 'v4_breakout', 'custom'].includes(strategy)) {
        normalized.strategy = strategy;
      }
      if (['1m', '5m', '15m', '1h', '4h', '1d'].includes(tf)) {
        normalized.tf = tf;
      }
      const bars = clampNum(item.bars, 80, 5000);
      const feeBps = clampNum(item.feeBps, 0, 100);
      const stopAtr = clampNum(item.stopAtr, 0.2, 10);
      const tpAtr = clampNum(item.tpAtr, 0.2, 20);
      const maxHold = clampNum(item.maxHold, 1, 1000);
      if (bars != null) normalized.bars = Math.round(bars);
      if (feeBps != null) normalized.feeBps = Number(feeBps);
      if (stopAtr != null) normalized.stopAtr = Number(stopAtr);
      if (tpAtr != null) normalized.tpAtr = Number(tpAtr);
      if (maxHold != null) normalized.maxHold = Math.round(maxHold);
      const custom = item.custom && typeof item.custom === 'object' ? item.custom : {};
      const customOut = {};
      const lookback = clampNum(custom.lookback, 2, 300);
      const retestWindow = clampNum(custom.retestWindow, 1, 200);
      const reentryWindow = clampNum(custom.reentryWindow, 1, 300);
      const retestTolAtr = clampNum(custom.retestTolAtr, 0.01, 6);
      const reentryTolAtr = clampNum(custom.reentryTolAtr, 0.01, 8);
      const biasAdxMin = clampNum(custom.biasAdxMin, 0, 80);
      const biasEmaFast = clampNum(custom.biasEmaFast, 2, 400);
      const biasEmaSlow = clampNum(custom.biasEmaSlow, 2, 600);
      const entryEma = clampNum(custom.entryEma, 2, 400);
      if (lookback != null) customOut.lookback = Math.round(lookback);
      if (retestWindow != null) customOut.retestWindow = Math.round(retestWindow);
      if (reentryWindow != null) customOut.reentryWindow = Math.round(reentryWindow);
      if (retestTolAtr != null) customOut.retestTolAtr = Number(retestTolAtr);
      if (reentryTolAtr != null) customOut.reentryTolAtr = Number(reentryTolAtr);
      if (biasAdxMin != null) customOut.biasAdxMin = Number(biasAdxMin);
      if (biasEmaFast != null) customOut.biasEmaFast = Math.round(biasEmaFast);
      if (biasEmaSlow != null) customOut.biasEmaSlow = Math.round(biasEmaSlow);
      if (entryEma != null) customOut.entryEma = Math.round(entryEma);
      if (typeof custom.allowRetest === 'boolean') customOut.allowRetest = custom.allowRetest;
      if (typeof custom.allowReentry === 'boolean') customOut.allowReentry = custom.allowReentry;
      if (typeof custom.allowBreakout === 'boolean') customOut.allowBreakout = custom.allowBreakout;
      if (['long', 'short', 'both'].includes(String(custom.side || ''))) customOut.side = String(custom.side);
      if (Object.keys(customOut).length) normalized.custom = customOut;
      pushUnique(normalized);
      continue;
    }
    if (type === 'run_strategy_dsl') {
      const normalized = { type: 'run_strategy_dsl' };
      const tf = String(item.tf || '').trim();
      if (['1m', '5m', '15m', '1h', '4h', '1d'].includes(tf)) normalized.tf = tf;
      const bars = clampNum(item.bars, 80, 5000);
      const feeBps = clampNum(item.feeBps, 0, 100);
      const stopAtr = clampNum(item.stopAtr, 0.2, 10);
      const tpAtr = clampNum(item.tpAtr, 0.2, 20);
      const maxHold = clampNum(item.maxHold, 1, 1000);
      if (bars != null) normalized.bars = Math.round(bars);
      if (feeBps != null) normalized.feeBps = Number(feeBps);
      if (stopAtr != null) normalized.stopAtr = Number(stopAtr);
      if (tpAtr != null) normalized.tpAtr = Number(tpAtr);
      if (maxHold != null) normalized.maxHold = Math.round(maxHold);
      const dsl = normalizeStrategyDslSpec(item.dsl || item.spec);
      if (Object.keys(dsl).length) {
        normalized.dsl = dsl;
        pushUnique(normalized);
      }
      continue;
    }
    if (type === 'run_backtest_compare') {
      const normalized = { type: 'run_backtest_compare' };
      const tf = String(item.tf || '').trim();
      if (['1m', '5m', '15m', '1h', '4h', '1d'].includes(tf)) {
        normalized.tf = tf;
      }
      const rawStrategies = Array.isArray(item.strategies)
        ? item.strategies
        : item.strategy
          ? [item.strategy]
          : [];
      const strategies = rawStrategies
        .map((x) => String(x || '').trim())
        .filter((x) => ['v5_hybrid', 'v5_retest', 'v5_reentry', 'v4_breakout'].includes(x));
      if (strategies.length) normalized.strategies = Array.from(new Set(strategies)).slice(0, 4);
      const bars = clampNum(item.bars, 80, 5000);
      const feeBps = clampNum(item.feeBps, 0, 100);
      const stopAtr = clampNum(item.stopAtr, 0.2, 10);
      const tpAtr = clampNum(item.tpAtr, 0.2, 20);
      const maxHold = clampNum(item.maxHold, 1, 1000);
      if (bars != null) normalized.bars = Math.round(bars);
      if (feeBps != null) normalized.feeBps = Number(feeBps);
      if (stopAtr != null) normalized.stopAtr = Number(stopAtr);
      if (tpAtr != null) normalized.tpAtr = Number(tpAtr);
      if (maxHold != null) normalized.maxHold = Math.round(maxHold);
      pushUnique(normalized);
    }
  }
  return out.slice(0, 4);
}

function parseTfFromText(messageLike) {
  const text = String(messageLike || '').toLowerCase();
  const m = text.match(/\b(1m|5m|15m|1h|4h|1d)\b/);
  if (m && m[1]) return m[1];
  if (/1分钟|分时/.test(text)) return '1m';
  if (/5分钟/.test(text)) return '5m';
  if (/15分钟/.test(text)) return '15m';
  if (/1小时/.test(text)) return '1h';
  if (/4小时/.test(text)) return '4h';
  if (/日线|1天/.test(text)) return '1d';
  return null;
}

function parseBarsFromText(messageLike) {
  const text = String(messageLike || '');
  const m = text.match(/(\d{2,5})\s*(根|bars?|k线)/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return Math.round(clampNum(n, 80, 5000) || 900);
}

function parseTradingGoalIntent(messageLike) {
  const text = String(messageLike || '').trim();
  const lower = text.toLowerCase();
  if (!lower) return null;
  const goalVerbs = [
    /我想|想要|希望|我要|帮我|请你|给我|来个|整一个|搞个|安排|run|execute|做一个|执行|开始|开跑/,
  ];
  const tradingDomain = [
    /交易|挣钱|赚钱|盈利|收益|胜率|策略|机器人|回测|回验|复盘|做多|做空|仓位|止损|止盈|风险|行情|进场|出场|快进快出|短线|长线|高频|激进|保守|稳一点|低回撤/,
    /\bbtc\b|\beth\b|\bsol\b|币/,
  ];
  const hasGoalVerb = goalVerbs.some((re) => re.test(lower));
  const hasTradingDomain = tradingDomain.some((re) => re.test(lower));
  const hasMoneyGoal = /(赚钱|挣钱|盈利|收益|赚点|盈利能力)/.test(lower);
  const hasDirectiveGoal = /(稳一点|保守|激进|低回撤|高胜率|风险小|快进快出|短线|长线|降低风险|提高胜率)/.test(
    lower,
  );
  const looksLikeConfig = /(config|配置|设置|telegram|token|apikey|api key|deepseek|chatgpt|codex|登录|login)/.test(
    lower,
  );
  if (!hasTradingDomain && !hasMoneyGoal) {
    if (!(hasGoalVerb && !looksLikeConfig)) return null;
  }
  if (!hasGoalVerb && !hasMoneyGoal && !hasDirectiveGoal) return null;
  let goal = 'general';
  if (/(高胜率|胜率高|稳|稳定|保守|风险小|低回撤|少亏|安全)/.test(lower)) goal = 'stability';
  else if (/(赚钱|挣钱|盈利|收益|多赚|利润|回报|翻倍)/.test(lower)) goal = 'profit';
  else if (/(快|短线|高频|快进快出|激进|猛一点)/.test(lower)) goal = 'aggressive';
  else if (/(策略|系统|方案|模型)/.test(lower)) goal = 'strategy';
  let risk = 'balanced';
  if (/(保守|稳|风险小|低回撤|安全|别太激进)/.test(lower)) risk = 'conservative';
  else if (/(激进|高风险|冲一点|猛一点|收益优先|快进快出)/.test(lower)) risk = 'aggressive';
  let horizon = 'medium';
  if (/(短线|快|今天|当日|高频|scalp)/.test(lower)) horizon = 'short';
  else if (/(长线|日线|周线|趋势|中长线)/.test(lower)) horizon = 'long';
  const tf = parseTfFromText(lower) || (horizon === 'short' ? '15m' : horizon === 'long' ? '1d' : '1h');
  const bars = parseBarsFromText(lower) || (horizon === 'short' ? 1200 : horizon === 'long' ? 1800 : 900);
  const wantsCompare = /(对比|比较|筛选|找一个|挑一个|推荐|最好|最优|高胜率)/.test(lower) || goal !== 'general';
  const wantsExecute = /(执行|运行|开跑|开始|直接|马上|一键)/.test(lower) || true;
  return {
    goal,
    risk,
    horizon,
    tf,
    bars,
    wantsCompare,
    wantsExecute,
    isNovice: /(不懂|不会|小白|简单说|口语|直接给我|你来决定)/.test(lower),
    text: lower,
  };
}

function chooseStrategiesByGoal(intentLike) {
  const intent = intentLike && typeof intentLike === 'object' ? intentLike : {};
  const risk = String(intent.risk || 'balanced');
  const goal = String(intent.goal || 'general');
  let base = ['v5_hybrid', 'v5_retest', 'v5_reentry', 'v4_breakout'];
  if (risk === 'conservative') base = ['v5_retest', 'v5_hybrid', 'v4_breakout', 'v5_reentry'];
  else if (risk === 'aggressive') base = ['v5_reentry', 'v5_hybrid', 'v4_breakout', 'v5_retest'];
  if (goal === 'stability') base = ['v5_retest', 'v5_hybrid', 'v4_breakout', 'v5_reentry'];
  if (goal === 'profit' || goal === 'aggressive') base = ['v5_hybrid', 'v5_reentry', 'v4_breakout', 'v5_retest'];
  return Array.from(new Set(base)).slice(0, 4);
}

function recommendArtifactActionByGoal(intentLike) {
  const intent = intentLike && typeof intentLike === 'object' ? intentLike : null;
  if (!intent) return null;
  const rows = listStrategyArtifacts(40);
  if (!rows.length) return null;
  const filtered = rows.filter((x) => {
    if (!x) return false;
    if (intent.risk === 'conservative' && Number(x.avgDrawdownPct || 0) > 18) return false;
    if (intent.goal === 'stability' && Number(x.avgWinRate || 0) < 45) return false;
    return true;
  });
  const source = (filtered.length ? filtered : rows).slice();
  source.sort((a, b) => {
    const sa =
      Number(a.strength || 0) * 0.55 +
      (intent.goal === 'profit' ? Number(a.avgNetPnlPct || 0) / 60 : Number(a.avgWinRate || 0) / 100) * 0.25 -
      Number(a.avgDrawdownPct || 0) / 220;
    const sb =
      Number(b.strength || 0) * 0.55 +
      (intent.goal === 'profit' ? Number(b.avgNetPnlPct || 0) / 60 : Number(b.avgWinRate || 0) / 100) * 0.25 -
      Number(b.avgDrawdownPct || 0) / 220;
    return sb - sa || Number(b.reports || 0) - Number(a.reports || 0);
  });
  const top = source[0];
  if (!top) return null;
  if (Number(top.strength || 0) < 0.06) return null;
  const action = strategyArtifactToAction(top);
  if (!action) return null;
  if (!action.tf && intent.tf) action.tf = intent.tf;
  if (!action.bars && intent.bars) action.bars = intent.bars;
  return action;
}

function parseStrategyNamesFromText(messageLike) {
  const text = String(messageLike || '').toLowerCase();
  const out = new Set();
  if (/\bv5_hybrid\b|v5\s*hybrid|混合/.test(text)) out.add('v5_hybrid');
  if (/\bv5_retest\b|v5\s*retest|回踩/.test(text)) out.add('v5_retest');
  if (/\bv5_reentry\b|v5\s*reentry|再入/.test(text)) out.add('v5_reentry');
  if (/\bv4_breakout\b|v4\s*breakout|donchian|突破/.test(text)) out.add('v4_breakout');
  return Array.from(out);
}

function parseNumByRegex(text, regex, min, max) {
  const m = String(text || '').match(regex);
  if (!m) return null;
  const raw = m.slice(1).reverse().find((x) => x != null && String(x).trim() !== '');
  if (raw == null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return clampNum(n, min, max);
}

function parseRiskAndCustomFromText(messageLike) {
  const text = String(messageLike || '').toLowerCase();
  const out = { custom: {} };
  const stopAtr = parseNumByRegex(text, /止损[^\d]{0,8}([0-9]+(?:\.[0-9]+)?)\s*atr/i, 0.2, 12);
  const tpAtr = parseNumByRegex(text, /止盈[^\d]{0,8}([0-9]+(?:\.[0-9]+)?)\s*atr/i, 0.2, 20);
  const feeBps = parseNumByRegex(text, /手续费[^\d]{0,8}([0-9]+(?:\.[0-9]+)?)\s*bps/i, 0, 100);
  const maxHold = parseNumByRegex(text, /持仓[^\d]{0,8}([0-9]{1,4})\s*(?:根|bars?|小时|h)/i, 1, 1000);
  const lookback = parseNumByRegex(text, /(lookback|窗口|通道)[^\d]{0,6}([0-9]{1,3})/i, 2, 300);
  const adxMin = parseNumByRegex(text, /adx[^\d]{0,8}([0-9]+(?:\.[0-9]+)?)/i, 0, 80);
  const retestTol = parseNumByRegex(text, /回踩容差[^\d]{0,8}([0-9]+(?:\.[0-9]+)?)\s*atr/i, 0.01, 6);
  const reentryTol = parseNumByRegex(text, /再入容差[^\d]{0,8}([0-9]+(?:\.[0-9]+)?)\s*atr/i, 0.01, 8);
  if (stopAtr != null) out.stopAtr = Number(stopAtr);
  if (tpAtr != null) out.tpAtr = Number(tpAtr);
  if (feeBps != null) out.feeBps = Number(feeBps);
  if (maxHold != null) out.maxHold = Math.round(maxHold);
  if (lookback != null) out.custom.lookback = Math.round(lookback);
  if (adxMin != null) out.custom.biasAdxMin = Number(adxMin);
  if (retestTol != null) out.custom.retestTolAtr = Number(retestTol);
  if (reentryTol != null) out.custom.reentryTolAtr = Number(reentryTol);
  if (/回踩/.test(text) && !/再入/.test(text) && !/突破/.test(text)) {
    out.custom.allowRetest = true;
    out.custom.allowReentry = false;
    out.custom.allowBreakout = false;
  } else if (/再入/.test(text) && !/回踩/.test(text) && !/突破/.test(text)) {
    out.custom.allowRetest = false;
    out.custom.allowReentry = true;
    out.custom.allowBreakout = false;
  } else if (/突破/.test(text) && !/回踩|再入/.test(text)) {
    out.custom.allowRetest = false;
    out.custom.allowReentry = false;
    out.custom.allowBreakout = true;
  }
  if (/只做多|仅做多|long only/.test(text)) out.custom.side = 'long';
  if (/只做空|仅做空|short only/.test(text)) out.custom.side = 'short';
  if (!Object.keys(out.custom).length) delete out.custom;
  return out;
}

function parseFeatureDslSpecFromText(messageLike) {
  const text = String(messageLike || '').toLowerCase();
  const hasFeatureHint = /(特征|因子|feature|ema|sma|ma\b|rsi|k线|均线|突破|donchian|通道)/.test(text);
  if (!hasFeatureHint) return null;
  const dayN = text.match(/(\d{1,3})\s*(日|天)/);
  const baseN = dayN && Number.isFinite(Number(dayN[1])) ? Math.max(2, Math.min(240, Math.round(Number(dayN[1])))) : 14;
  const hasExplicitDayFeature = Boolean(dayN) && /(k线|日线|特征|因子|feature)/.test(text);
  const features = [];
  const used = new Set();
  const pushFeature = (item) => {
    if (!item || typeof item !== 'object') return;
    const name = String(item.name || '')
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '');
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(name)) return;
    if (used.has(name)) return;
    used.add(name);
    features.push({ ...item, name });
  };
  if (/ema|指数均线/.test(text)) {
    pushFeature({ name: 'ema_' + baseN, kind: 'ema', source: 'close', period: baseN });
  }
  if ((/sma|均线|ma\b/.test(text) && !/ema|指数均线/.test(text)) || hasExplicitDayFeature) {
    pushFeature({ name: 'sma_' + baseN, kind: 'sma', source: 'close', period: baseN });
  }
  const rsiN = text.match(/rsi[^0-9]{0,4}(\d{1,3})/);
  if (/rsi/.test(text)) {
    const p = rsiN && Number.isFinite(Number(rsiN[1])) ? Math.max(2, Math.min(120, Math.round(Number(rsiN[1])))) : 14;
    pushFeature({ name: 'rsi_' + p, kind: 'rsi', source: 'close', period: p });
  }
  const adxN = text.match(/adx[^0-9]{0,4}(\d{1,3})/);
  if (/adx/.test(text)) {
    const p = adxN && Number.isFinite(Number(adxN[1])) ? Math.max(2, Math.min(120, Math.round(Number(adxN[1])))) : 14;
    pushFeature({ name: 'adx_' + p, kind: 'adx', period: p });
  }
  if (/atr/.test(text)) {
    pushFeature({ name: 'atr_14', kind: 'atr', period: 14 });
  }
  if (/donchian|通道|突破/.test(text)) {
    const lb = dayN && Number.isFinite(Number(dayN[1])) ? Math.max(2, Math.min(240, Math.round(Number(dayN[1])))) : 20;
    pushFeature({ name: 'dch_' + lb, kind: 'donchian_high', lookback: lb });
    pushFeature({ name: 'dcl_' + lb, kind: 'donchian_low', lookback: lb });
  }
  if (!features.length) return null;
  const primary =
    features.find((f) => ['ema', 'sma', 'donchian_high', 'donchian_low', 'price'].includes(String(f.kind || ''))) ||
    features[0];
  let entryLong = 'close > ' + primary.name;
  let entryShort = 'close < ' + primary.name;
  let exitLong = 'close < ' + primary.name;
  let exitShort = 'close > ' + primary.name;
  if (primary.kind === 'donchian_high') {
    const lowName = features.find((f) => f.kind === 'donchian_low')?.name;
    entryLong = 'close > ' + primary.name;
    entryShort = lowName ? 'close < ' + lowName : 'close < open';
    exitLong = lowName ? 'close < ' + lowName : 'close < open';
    exitShort = 'close > ' + primary.name;
  }
  const adxFeature = features.find((f) => f.kind === 'adx');
  if (adxFeature) {
    const adxFloor = text.match(/adx[^0-9]{0,4}(\d{1,2})(?:\.\d+)?/);
    const floor = adxFloor && Number.isFinite(Number(adxFloor[1])) ? Number(adxFloor[1]) : 20;
    entryLong = '(' + entryLong + ') && ' + adxFeature.name + ' >= ' + floor;
    entryShort = '(' + entryShort + ') && ' + adxFeature.name + ' >= ' + floor;
  }
  const side = /只做多|仅做多|long only/.test(text) ? 'long' : /只做空|仅做空|short only/.test(text) ? 'short' : 'both';
  return normalizeStrategyDslSpec({
    name: 'feature-driven',
    side,
    features,
    entryLong,
    entryShort,
    exitLong,
    exitShort,
  });
}

function inferTaskActionFromMessage(messageLike) {
  const text = String(messageLike || '').trim().toLowerCase();
  if (!text) return null;
  const goalIntent = parseTradingGoalIntent(text);
  const hasTaskVerb =
    /(跑|执行|做|帮我|请你|生成|对比|比较|评估|筛选|优化|回测|回验|复盘|simulate|backtest|compare|evaluate)/i.test(
      text,
    );
  const hasStrategyDomain = /(策略|胜率|回测|回验|复盘|特征|因子|k线|均线|ema|sma|rsi|adx|v5_|v4_|retest|reentry|breakout|donchian)/i.test(text);
  if (!hasTaskVerb && !goalIntent) return null;
  if (!hasStrategyDomain && !goalIntent) return null;
  const tf = parseTfFromText(text);
  const bars = parseBarsFromText(text);
  const strategies = parseStrategyNamesFromText(text);
  const riskAndCustom = parseRiskAndCustomFromText(text);
  const dsl = parseFeatureDslSpecFromText(text);
  const compareIntent = /(高胜率|最高胜率|对比|比较|筛选|哪套更好|最佳策略|best strategy|compare)/i.test(
    text,
  );
  if (dsl && !compareIntent) {
    const action = { type: 'run_strategy_dsl', dsl };
    if (tf) action.tf = tf;
    if (bars != null) action.bars = bars;
    if (riskAndCustom.feeBps != null) action.feeBps = riskAndCustom.feeBps;
    if (riskAndCustom.stopAtr != null) action.stopAtr = riskAndCustom.stopAtr;
    if (riskAndCustom.tpAtr != null) action.tpAtr = riskAndCustom.tpAtr;
    if (riskAndCustom.maxHold != null) action.maxHold = riskAndCustom.maxHold;
    if (riskAndCustom.custom?.side && ['long', 'short', 'both'].includes(String(riskAndCustom.custom.side))) {
      action.dsl.side = String(riskAndCustom.custom.side);
    }
    if (Number.isFinite(Number(riskAndCustom.custom?.biasAdxMin))) {
      const adxMin = Number(riskAndCustom.custom.biasAdxMin);
      const hasAdx = Array.isArray(action.dsl.features)
        ? action.dsl.features.some((f) => f && f.kind === 'adx')
        : false;
      if (!hasAdx) {
        action.dsl.features = Array.isArray(action.dsl.features) ? action.dsl.features.slice(0, 16) : [];
        action.dsl.features.push({ name: 'adx_14', kind: 'adx', period: 14 });
      }
      action.dsl.entryLong = '(' + String(action.dsl.entryLong || 'true') + ') && adx_14 >= ' + adxMin;
      action.dsl.entryShort = '(' + String(action.dsl.entryShort || 'true') + ') && adx_14 >= ' + adxMin;
      action.dsl = normalizeStrategyDslSpec(action.dsl);
    }
    return action;
  }
  const hasCustomHints = Boolean(riskAndCustom.custom && Object.keys(riskAndCustom.custom).length);
  if (hasCustomHints && !compareIntent) {
    const action = {
      type: 'run_custom_backtest',
      strategy: strategies[0] || 'custom',
      ...riskAndCustom,
    };
    if (tf) action.tf = tf;
    if (bars != null) action.bars = bars;
    return action;
  }
  if (compareIntent || strategies.length >= 2 || (!strategies.length && goalIntent?.wantsCompare)) {
    const inferredStrategies = strategies.length ? strategies : chooseStrategiesByGoal(goalIntent);
    const action = { type: 'run_backtest_compare' };
    if (inferredStrategies.length) action.strategies = inferredStrategies.slice(0, 4);
    if (tf || goalIntent?.tf) action.tf = tf || goalIntent.tf;
    if (bars != null || goalIntent?.bars != null) action.bars = bars != null ? bars : goalIntent.bars;
    if (riskAndCustom.feeBps != null) action.feeBps = riskAndCustom.feeBps;
    if (riskAndCustom.stopAtr != null) action.stopAtr = riskAndCustom.stopAtr;
    if (riskAndCustom.tpAtr != null) action.tpAtr = riskAndCustom.tpAtr;
    if (riskAndCustom.maxHold != null) action.maxHold = riskAndCustom.maxHold;
    return action;
  }
  if (!strategies.length && goalIntent) {
    const artifactAction = recommendArtifactActionByGoal(goalIntent);
    if (artifactAction) {
      if (!artifactAction.tf && (tf || goalIntent.tf)) artifactAction.tf = tf || goalIntent.tf;
      if (!artifactAction.bars && (bars != null || goalIntent.bars != null)) {
        artifactAction.bars = bars != null ? bars : goalIntent.bars;
      }
      if (riskAndCustom.stopAtr != null && artifactAction.stopAtr == null) artifactAction.stopAtr = riskAndCustom.stopAtr;
      if (riskAndCustom.tpAtr != null && artifactAction.tpAtr == null) artifactAction.tpAtr = riskAndCustom.tpAtr;
      return artifactAction;
    }
    const defaults = chooseStrategiesByGoal(goalIntent);
    return {
      type: goalIntent.wantsCompare ? 'run_backtest_compare' : 'run_backtest',
      strategy: goalIntent.wantsCompare ? undefined : defaults[0],
      strategies: goalIntent.wantsCompare ? defaults.slice(0, 4) : undefined,
      tf: tf || goalIntent.tf,
      bars: bars != null ? bars : goalIntent.bars,
      stopAtr:
        riskAndCustom.stopAtr != null
          ? riskAndCustom.stopAtr
          : goalIntent.risk === 'conservative'
            ? 1.1
            : goalIntent.risk === 'aggressive'
              ? 1.8
              : 1.4,
      tpAtr:
        riskAndCustom.tpAtr != null
          ? riskAndCustom.tpAtr
          : goalIntent.risk === 'conservative'
            ? 2.0
            : goalIntent.risk === 'aggressive'
              ? 3.6
              : 2.8,
      maxHold:
        riskAndCustom.maxHold != null
          ? riskAndCustom.maxHold
          : goalIntent.horizon === 'short'
            ? 36
            : goalIntent.horizon === 'long'
              ? 180
              : 72,
    };
  }
  const action = { type: 'run_backtest', strategy: strategies[0] || 'v5_hybrid' };
  if (tf || goalIntent?.tf) action.tf = tf || goalIntent.tf;
  if (bars != null || goalIntent?.bars != null) action.bars = bars != null ? bars : goalIntent.bars;
  if (riskAndCustom.feeBps != null) action.feeBps = riskAndCustom.feeBps;
  if (riskAndCustom.stopAtr != null) action.stopAtr = riskAndCustom.stopAtr;
  if (riskAndCustom.tpAtr != null) action.tpAtr = riskAndCustom.tpAtr;
  if (riskAndCustom.maxHold != null) action.maxHold = riskAndCustom.maxHold;
  return action;
}

function augmentActionsByIntent(messageLike, actionsLike) {
  const normalized = normalizeAiActions(actionsLike);
  const hasTaskAction = normalized.some(
    (a) =>
      a?.type === 'run_backtest' ||
      a?.type === 'run_backtest_compare' ||
      a?.type === 'run_custom_backtest' ||
      a?.type === 'run_strategy_dsl',
  );
  if (hasTaskAction) return normalized;
  const inferred = inferTaskActionFromMessage(messageLike);
  if (!inferred) return normalized;
  return normalizeAiActions([inferred, ...normalized]);
}

function pushTelegramEvent(eventLike) {
  const event = eventLike && typeof eventLike === 'object' ? eventLike : {};
  telegramEventSeq += 1;
  const item = {
    id: telegramEventSeq,
    ts: nowIso(),
    source: 'telegram',
    role: event.role === 'bot' ? 'bot' : event.role === 'system' ? 'system' : 'user',
    chatId: event.chatId != null ? String(event.chatId) : null,
    from: event.from ? truncText(String(event.from), 64) : null,
    text: truncText(String(event.text || '').trim(), 4000),
    direction: event.direction === 'outbound' ? 'outbound' : 'inbound',
    ok: event.ok !== false,
  };
  telegramEvents.push(item);
  if (telegramEvents.length > TELEGRAM_EVENTS_MAX) {
    telegramEvents.splice(0, telegramEvents.length - TELEGRAM_EVENTS_MAX);
  }
  try {
    fs.mkdirSync(path.dirname(TELEGRAM_EVENTS_PATH), { recursive: true });
    fs.appendFileSync(TELEGRAM_EVENTS_PATH, JSON.stringify(item) + '\n', 'utf8');
  } catch {}
  appendChatHistoryEvent({
    ts: item.ts,
    role: item.role,
    source: 'telegram',
    chatId: item.chatId,
    from: item.from,
    direction: item.direction,
    text: item.text,
    meta: { ok: item.ok },
  });
  return item;
}

function listTelegramEvents(afterId, limit = 80) {
  const cursor = Number.isFinite(Number(afterId)) ? Number(afterId) : 0;
  const maxN = Math.max(1, Math.min(200, Number(limit) || 80));
  return telegramEvents.filter((e) => e.id > cursor).slice(-maxN);
}

function loadTelegramEventsFromDisk() {
  const rows = readJsonlFile(TELEGRAM_EVENTS_PATH, TELEGRAM_EVENTS_LOAD);
  telegramEvents.length = 0;
  telegramEventSeq = 0;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const id = Number(row.id);
    if (!Number.isFinite(id) || id <= 0) continue;
    const item = {
      id,
      ts: row.ts || nowIso(),
      source: 'telegram',
      role: row.role === 'bot' ? 'bot' : row.role === 'system' ? 'system' : 'user',
      chatId: row.chatId != null ? String(row.chatId) : null,
      from: row.from ? truncText(String(row.from), 64) : null,
      text: truncText(String(row.text || '').trim(), 4000),
      direction: row.direction === 'outbound' ? 'outbound' : 'inbound',
      ok: row.ok !== false,
    };
    telegramEvents.push(item);
    telegramEventSeq = Math.max(telegramEventSeq, id);
  }
  if (telegramEvents.length > TELEGRAM_EVENTS_MAX) {
    telegramEvents.splice(0, telegramEvents.length - TELEGRAM_EVENTS_MAX);
  }
}

function parseTelegramIncoming(update) {
  const msg = update?.message || null;
  if (!msg) return null;
  if (msg?.from?.is_bot) return null;
  const chatIdRaw = msg?.chat?.id;
  const chatId = chatIdRaw != null ? String(chatIdRaw) : '';
  const messageId = Number(msg?.message_id);
  if (!chatId) return null;
  if (TELEGRAM_ALLOWED_CHAT_IDS.size && !TELEGRAM_ALLOWED_CHAT_IDS.has(chatId)) {
    telegramState.droppedUpdates += 1;
    return null;
  }
  const text = String(msg?.text || msg?.caption || '').trim();
  if (!text) return null;
  const fromName = [msg?.from?.first_name, msg?.from?.last_name]
    .filter(Boolean)
    .join(' ')
    .trim();
  const from =
    truncText(
      fromName ||
        msg?.from?.username ||
        msg?.chat?.title ||
        msg?.chat?.username ||
        ('chat:' + chatId),
      64,
    ) || 'telegram';
  return {
    updateId: Number(update?.update_id) || 0,
    messageId: Number.isFinite(messageId) ? messageId : 0,
    chatId,
    from,
    text,
    ts: Number.isFinite(Number(msg?.date)) ? new Date(Number(msg.date) * 1000).toISOString() : null,
  };
}

async function telegramApiCall(methodPath, payload, timeoutMs = 30_000) {
  if (!TELEGRAM_ENABLED) throw new Error('telegram disabled');
  const url = TELEGRAM_API_BASE + '/' + String(methodPath || '');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(2_000, timeoutMs));
  try {
    const opts = payload
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: ctrl.signal,
        }
      : { method: 'GET', signal: ctrl.signal };
    const resp = await fetch(url, opts);
    const text = await resp.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    if (!resp.ok) {
      throw new Error('telegram http ' + resp.status + ': ' + truncText(text, 180));
    }
    if (!json || json.ok !== true) {
      const desc = json && json.description ? String(json.description) : 'invalid telegram response';
      throw new Error('telegram api: ' + truncText(desc, 180));
    }
    return json.result;
  } finally {
    clearTimeout(timer);
  }
}

async function sendTelegramText(chatId, text) {
  const body = {
    chat_id: chatId,
    text: truncText(text, 4000),
    disable_web_page_preview: true,
  };
  await telegramApiCall('sendMessage', body, 20_000);
}

async function handleTelegramIncoming(incoming) {
  if (!incoming || !incoming.text) return;
  const dedupe = claimTelegramInbound(incoming);
  if (!dedupe.claimed) {
    pushTelegramEvent({
      role: 'system',
      chatId: incoming.chatId,
      from: 'thunderclaw-dedupe',
      text: '[去重] 忽略重复 Telegram 消息: ' + truncText(incoming.text, 120),
      direction: 'inbound',
      ok: true,
    });
    return;
  }
  telegramState.lastInboundAt = nowIso();
  if (incoming.chatId) telegramKnownChatIds.add(String(incoming.chatId));
  pushTelegramEvent({
    role: 'user',
    chatId: incoming.chatId,
    from: incoming.from,
    text: incoming.text,
    direction: 'inbound',
    ok: true,
  });
  appendTraderMemory({
    kind: 'chat',
    channel: 'telegram',
    tags: ['telegram', 'user'],
    content: '用户: ' + redactSecrets(incoming.text),
  });

  const artifactFeedback = applyUserStrategyArtifactFeedback(incoming.text, 'telegram');
  if (artifactFeedback?.handled && (artifactFeedback?.explicit || artifactFeedback?.applied)) {
    const replyText = String(artifactFeedback.reply || '已记录工件反馈。');
    let ok = true;
    try {
      await sendTelegramText(incoming.chatId, replyText);
      telegramState.lastOutboundAt = nowIso();
    } catch (err) {
      ok = false;
      const errMsg = safeErrMsg(err, 'send failed');
      telegramState.lastError = errMsg;
      pushTelegramEvent({
        role: 'bot',
        chatId: incoming.chatId,
        from: 'thunderclaw',
        text: replyText + '\n(发送到 Telegram 失败: ' + errMsg + ')',
        direction: 'outbound',
        ok: false,
      });
      return;
    }
    pushTelegramEvent({
      role: 'bot',
      chatId: incoming.chatId,
      from: 'thunderclaw',
      text: replyText,
      direction: 'outbound',
      ok,
    });
    appendTraderMemory({
      kind: 'chat',
      channel: 'telegram',
      tags: ['telegram', 'assistant'],
      content: '用户: ' + redactSecrets(incoming.text) + '\n助手: ' + redactSecrets(replyText),
    });
    return;
  }
  const feedback = applyUserStrategyFeedback(incoming.text, 'telegram');
  if (feedback?.handled && feedback?.explicit) {
    const replyText = String(feedback.reply || '已记录策略反馈。');
    let ok = true;
    try {
      await sendTelegramText(incoming.chatId, replyText);
      telegramState.lastOutboundAt = nowIso();
    } catch (err) {
      ok = false;
      const errMsg = safeErrMsg(err, 'send failed');
      telegramState.lastError = errMsg;
      pushTelegramEvent({
        role: 'bot',
        chatId: incoming.chatId,
        from: 'thunderclaw',
        text: replyText + '\n(发送到 Telegram 失败: ' + errMsg + ')',
        direction: 'outbound',
        ok: false,
      });
      return;
    }
    pushTelegramEvent({
      role: 'bot',
      chatId: incoming.chatId,
      from: 'thunderclaw',
      text: replyText,
      direction: 'outbound',
      ok,
    });
    appendTraderMemory({
      kind: 'chat',
      channel: 'telegram',
      tags: ['telegram', 'assistant'],
      content: '用户: ' + redactSecrets(incoming.text) + '\n助手: ' + redactSecrets(replyText),
    });
    return;
  }

  if (!TELEGRAM_AUTO_REPLY) return;

  const memoryBundle = buildLayeredMemoryBundle(incoming.text);
  const trading = buildTradingContext({
    currentView: 'dashboard',
    userIntentHint: 'telegram:' + incoming.chatId,
  }, memoryBundle);
  let reply = '';
  let ok = true;
  try {
    const result = await runOpenClawChat(incoming.text, trading.context);
    const structured = parseStructuredAgentReply(result.reply);
    reply = String(structured.reply || '').trim() || '收到。';
  } catch (err) {
    ok = false;
    reply = '收到，但处理消息失败：' + safeErrMsg(err, 'unknown');
  }

  try {
    await sendTelegramText(incoming.chatId, reply);
    telegramState.lastOutboundAt = nowIso();
  } catch (err) {
    ok = false;
    const errMsg = safeErrMsg(err, 'send failed');
    telegramState.lastError = errMsg;
    reply = reply + '\n(发送到 Telegram 失败: ' + errMsg + ')';
  }

  pushTelegramEvent({
    role: 'bot',
    chatId: incoming.chatId,
    from: 'thunderclaw',
    text: reply,
    direction: 'outbound',
    ok,
  });
  appendTraderMemory({
    kind: 'chat',
    channel: 'telegram',
    tags: ['telegram', 'assistant'],
    content:
      '用户: ' +
      redactSecrets(incoming.text) +
      '\n助手: ' +
      redactSecrets(reply),
  });
}

function scheduleTelegramPoll(delayMs) {
  if (!TELEGRAM_ENABLED) return;
  if (telegramPollTimer) clearTimeout(telegramPollTimer);
  const waitMs = Math.max(220, Number(delayMs) || 0);
  telegramPollTimer = setTimeout(() => {
    telegramPollTimer = null;
    if (!telegramPollLockAcquired) {
      const got = acquireTelegramPollLock();
      if (!got) {
        telegramState.connected = false;
        telegramState.lastError =
          telegramState.pollLock.ownerPid != null
            ? 'telegram poll lock busy (pid=' + String(telegramState.pollLock.ownerPid) + ')'
            : 'telegram poll lock busy';
        scheduleTelegramPoll(Math.max(3_500, TELEGRAM_RETRY_MS * 2));
        return;
      }
    }
    void pollTelegramOnce();
  }, waitMs);
}

async function pollTelegramOnce() {
  if (!TELEGRAM_ENABLED) return;
  if (!telegramPollLockAcquired) {
    const got = acquireTelegramPollLock();
    if (!got) {
      telegramState.connected = false;
      scheduleTelegramPoll(Math.max(3_500, TELEGRAM_RETRY_MS * 2));
      return;
    }
  }
  if (telegramState.pollActive) {
    scheduleTelegramPoll(300);
    return;
  }
  telegramState.pollActive = true;
  telegramState.lastPollAt = nowIso();
  try {
    const params = new URLSearchParams();
    params.set('timeout', String(TELEGRAM_POLL_TIMEOUT_SEC));
    if (telegramUpdateOffset > 0) params.set('offset', String(telegramUpdateOffset));
    params.set('allowed_updates', JSON.stringify(['message']));
    const updates = await telegramApiCall(
      'getUpdates?' + params.toString(),
      null,
      (TELEGRAM_POLL_TIMEOUT_SEC + 8) * 1000,
    );
    const list = Array.isArray(updates) ? updates : [];
    for (const update of list) {
      const updateId = Number(update?.update_id);
      if (Number.isFinite(updateId)) {
        telegramUpdateOffset = Math.max(telegramUpdateOffset, updateId + 1);
        telegramState.lastUpdateId = updateId;
      }
      const incoming = parseTelegramIncoming(update);
      if (!incoming) continue;
      await handleTelegramIncoming(incoming);
    }
    telegramState.connected = true;
    telegramState.lastError = null;
    telegramState.conflicts.lastMessage = null;
    scheduleTelegramPoll(140);
  } catch (err) {
    const errMsg = safeErrMsg(err, 'poll failed');
    const conflict = /telegram http 409|terminated by other getupdates request|can't use getupdates method/i.test(
      String(errMsg || ''),
    );
    telegramState.connected = false;
    telegramState.lastError = errMsg;
    if (conflict) {
      telegramState.conflicts.count += 1;
      telegramState.conflicts.lastAt = nowIso();
      telegramState.conflicts.lastMessage = errMsg;
      const retry = Math.min(
        120_000,
        Math.max(TELEGRAM_RETRY_MS, TELEGRAM_RETRY_MS * Math.pow(2, Math.min(5, telegramState.conflicts.count))),
      );
      scheduleTelegramPoll(retry);
    } else {
      scheduleTelegramPoll(TELEGRAM_RETRY_MS);
    }
  } finally {
    telegramState.pollActive = false;
  }
}

function resolveTelegramPushTargets() {
  const out = new Set();
  if (TELEGRAM_PUSH_CHAT_IDS.length) {
    TELEGRAM_PUSH_CHAT_IDS.forEach((x) => out.add(x));
    return Array.from(out);
  }
  if (OPENCLAW_CHANNEL.toLowerCase() === 'telegram' && OPENCLAW_TO) {
    out.add(OPENCLAW_TO);
  }
  TELEGRAM_ALLOWED_CHAT_IDS.forEach((x) => out.add(x));
  telegramKnownChatIds.forEach((x) => out.add(x));
  return Array.from(out);
}

function buildTradePushCandidates() {
  const ordersRaw = safeJsonRead(REPORT_ORDERS_PATH, { orders: [] });
  const decisionsRaw = safeJsonRead(REPORT_DECISIONS_PATH, []);
  const orders = normalizedOrdersFromPayload(ordersRaw)
    .filter(Boolean)
    .slice()
    .sort((a, b) => (toMs(a?.openTs || a?.closeTs) || 0) - (toMs(b?.openTs || b?.closeTs) || 0));
  const decisions = (Array.isArray(decisionsRaw) ? decisionsRaw : [])
    .filter((x) => x && x.ts && !x.stage)
    .slice()
    .sort((a, b) => (toMs(a?.ts) || 0) - (toMs(b?.ts) || 0));

  const candidates = [];
  const recentOrders = orders.slice(-TELEGRAM_PUSH_SCAN_LIMIT);
  for (const o of recentOrders) {
    const side = sideCn(o?.side);
    const symbol = String(o?.symbol || 'UNKNOWN');
    const level = o?.level ? String(o.level) : '-';
    if (TELEGRAM_PUSH_EVENTS.has('open') && o?.openTs) {
      const openKey = 'open:' + eventIdentity(o, o.openTs, 'open');
      candidates.push({
        key: openKey,
        type: 'open',
        tsMs: toMs(o.openTs) || Date.now(),
        text: [
          '[交易开仓]',
          symbol + ' · ' + side,
          'trade=' + (o?.tradeId != null ? String(o.tradeId) : '-') + ' · cycle=' + (o?.cycleId != null ? String(o.cycleId) : '-'),
          '价格=' + fmtPriceNum(o?.openPrice, 2) + ' · level=' + level,
          '时间=' + fmtTsForMsg(o.openTs),
        ].join('\n'),
      });
    }
    if (TELEGRAM_PUSH_EVENTS.has('close') && o?.closeTs) {
      const closeKey = 'close:' + eventIdentity(o, o.closeTs, 'close');
      const pnl = toNum(o?.pnlEstUSDT);
      const pnlTxt = pnl == null ? '-' : (pnl >= 0 ? '+' : '') + pnl.toFixed(2) + 'U';
      candidates.push({
        key: closeKey,
        type: 'close',
        tsMs: toMs(o.closeTs) || Date.now(),
        text: [
          '[交易平仓]',
          symbol + ' · ' + side,
          'trade=' + (o?.tradeId != null ? String(o.tradeId) : '-') + ' · cycle=' + (o?.cycleId != null ? String(o.cycleId) : '-'),
          '开=' + fmtPriceNum(o?.openPrice, 2) + ' · 平=' + fmtPriceNum(o?.closePrice, 2) + ' · PnL=' + pnlTxt,
          '时间=' + fmtTsForMsg(o.closeTs),
        ].join('\n'),
      });
    }
  }

  if (TELEGRAM_PUSH_EVENTS.has('risk')) {
    const risks = decisions
      .filter((r) => Boolean(r?.decision?.blockedByNews))
      .slice(-TELEGRAM_PUSH_SCAN_LIMIT);
    for (const r of risks) {
      const reasonList = Array.isArray(r?.decision?.newsReason) ? r.decision.newsReason : [];
      const reason =
        reasonList.length > 0
          ? truncText(String(reasonList[0]), 180)
          : truncText(String(r?.executor?.reason || r?.signal?.plan?.reason || '命中风控门控'), 180);
      const key = 'risk:' + String(r?.cycleId != null ? r.cycleId : '-') + ':' + String(toMs(r?.ts) || 0);
      const side = sideCn(r?.signal?.plan?.side);
      candidates.push({
        key,
        type: 'risk',
        tsMs: toMs(r?.ts) || Date.now(),
        text: [
          '[风控拦截]',
          '方向=' + side + ' · cycle=' + (r?.cycleId != null ? String(r.cycleId) : '-'),
          '原因=' + reason,
          '时间=' + fmtTsForMsg(r?.ts),
        ].join('\n'),
      });
    }
  }

  return candidates
    .filter((x) => x && x.key && x.text)
    .sort((a, b) => (a.tsMs || 0) - (b.tsMs || 0))
    .slice(-Math.max(20, TELEGRAM_PUSH_SCAN_LIMIT * 3));
}

function trimTelegramTradeState() {
  if (telegramTradeKnownEventKeys.size > 3000) {
    const keep = Array.from(telegramTradeKnownEventKeys).slice(-2000);
    telegramTradeKnownEventKeys.clear();
    keep.forEach((k) => telegramTradeKnownEventKeys.add(k));
  }
  if (telegramTradeSentAck.size > 6000) {
    const keep = Array.from(telegramTradeSentAck).slice(-3500);
    telegramTradeSentAck.clear();
    keep.forEach((k) => telegramTradeSentAck.add(k));
  }
}

function primeTelegramTradePushBaseline() {
  const initial = buildTradePushCandidates();
  for (const ev of initial) {
    telegramTradeKnownEventKeys.add(ev.key);
  }
  trimTelegramTradeState();
}

function scheduleTelegramTradePush(delayMs) {
  if (!telegramState.push.enabled) return;
  if (telegramTradePushTimer) clearTimeout(telegramTradePushTimer);
  const waitMs = Math.max(300, Number(delayMs) || 0);
  telegramTradePushTimer = setTimeout(() => {
    telegramTradePushTimer = null;
    void pollTelegramTradePushOnce();
  }, waitMs);
}

async function pollTelegramTradePushOnce() {
  if (!telegramState.push.enabled) return;
  if (telegramState.push.active) {
    scheduleTelegramTradePush(800);
    return;
  }
  telegramState.push.active = true;
  telegramState.push.lastRunAt = nowIso();
  telegramState.push.lastError = null;
  try {
    const candidates = buildTradePushCandidates();
    const targets = resolveTelegramPushTargets();
    if (!targets.length) {
      for (const ev of candidates) {
        telegramTradeKnownEventKeys.add(ev.key);
      }
      telegramState.push.skippedNoTarget += candidates.length;
      scheduleTelegramTradePush(TELEGRAM_PUSH_INTERVAL_MS);
      return;
    }

    for (const ev of candidates) {
      if (telegramTradeKnownEventKeys.has(ev.key)) continue;
      let allOk = true;
      for (const chatId of targets) {
        const ackKey = ev.key + '::' + chatId;
        if (telegramTradeSentAck.has(ackKey)) continue;
        try {
          await sendTelegramText(chatId, ev.text);
          telegramTradeSentAck.add(ackKey);
          telegramState.lastOutboundAt = nowIso();
          telegramState.push.lastSentAt = telegramState.lastOutboundAt;
          telegramState.push.lastSentPreview = truncText(ev.text.replace(/\s+/g, ' '), 140);
          telegramState.push.sentCount += 1;
          pushTelegramEvent({
            role: 'bot',
            chatId,
            from: 'thunderclaw-trade',
            text: ev.text,
            direction: 'outbound',
            ok: true,
          });
        } catch (err) {
          allOk = false;
          const msg = safeErrMsg(err, 'trade push failed');
          telegramState.push.lastError = msg;
          telegramState.lastError = msg;
          pushTelegramEvent({
            role: 'bot',
            chatId,
            from: 'thunderclaw-trade',
            text: ev.text + '\n(推送失败: ' + msg + ')',
            direction: 'outbound',
            ok: false,
          });
        }
      }
      if (allOk) telegramTradeKnownEventKeys.add(ev.key);
      trimTelegramTradeState();
    }
    if (!telegramState.push.lastError) telegramState.push.lastError = null;
    scheduleTelegramTradePush(TELEGRAM_PUSH_INTERVAL_MS);
  } catch (err) {
    telegramState.push.lastError = safeErrMsg(err, 'trade push poll failed');
    scheduleTelegramTradePush(Math.max(TELEGRAM_PUSH_INTERVAL_MS, TELEGRAM_RETRY_MS));
  } finally {
    telegramState.push.active = false;
  }
}

function payloadToText(payload) {
  const lines = [];
  const text = typeof payload?.text === 'string' ? payload.text.trim() : '';
  if (text) lines.push(text);
  const mediaUrls = Array.isArray(payload?.mediaUrls)
    ? payload.mediaUrls.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim())
    : [];
  if (!mediaUrls.length && typeof payload?.mediaUrl === 'string' && payload.mediaUrl.trim()) {
    mediaUrls.push(payload.mediaUrl.trim());
  }
  for (const url of mediaUrls) {
    lines.push('MEDIA: ' + url);
  }
  return lines.join('\n').trim();
}

function extractReplyFromOutput(stdout) {
  const parsed = parseJsonLoose(stdout);
  if (!parsed) {
    const text = String(stdout || '').trim();
    return { reply: text, parsed: null };
  }
  const payloads = Array.isArray(parsed?.result?.payloads)
    ? parsed.result.payloads
    : Array.isArray(parsed?.payloads)
      ? parsed.payloads
      : [];
  const parts = payloads
    .map(payloadToText)
    .map((v) => v.trim())
    .filter(Boolean);
  if (parts.length) {
    return { reply: parts.join('\n\n'), parsed };
  }
  if (typeof parsed?.summary === 'string' && parsed.summary.trim()) {
    return { reply: parsed.summary.trim(), parsed };
  }
  if (typeof parsed?.result?.summary === 'string' && parsed.result.summary.trim()) {
    return { reply: parsed.result.summary.trim(), parsed };
  }
  const fallback = String(stdout || '').trim();
  return { reply: fallback, parsed };
}

function buildOpenClawPrompt(message, context) {
  const baseMessage = String(message || '').trim();
  if (!baseMessage) return '';
  let contextJson = '{}';
  if (context && typeof context === 'object') {
    try {
      contextJson = JSON.stringify(context, null, 2);
    } catch {
      contextJson = '{}';
    }
  }
  return [
    '你是交易系统里的 AI 交易助理（OpenClaw 驱动）。',
    '必须仅基于下面给出的交易上下文回答；上下文是服务端实时生成的权威数据。',
    '上下文中包含分层记忆：shortTermMemory（近期会话）、midTermMemory（偏好与策略权重）、longTermMemory（长期检索）。',
    '优先利用 midTermMemory.strategyWeights 与 longTermMemory.relevant，让回答持续贴近该交易者。',
    '上下文 strategy.artifacts 为已沉淀策略工件（含权重/表现）；可优先复用高权重工件并继续迭代。',
    '若信息不足，请直接说明缺失项，不得编造事实。',
    '',
    '输出要求（必须严格遵守）:',
    '1) 只输出 JSON（不要代码块、不要额外解释）。',
    '2) JSON 格式固定为：',
    '{"reply":"给用户看的中文回复","actions":[...]}',
    '3) actions 可选，最多 4 个。支持动作：',
    '- {"type":"switch_view","view":"dashboard|runtime|kline|history|backtest|xsea"}',
    '- {"type":"focus_trade","tradeId":"交易ID"}',
    '- {"type":"run_backtest","strategy":"v5_hybrid|v5_retest|v5_reentry|v4_breakout","tf":"1m|5m|15m|1h|4h|1d","bars":900,"feeBps":5,"stopAtr":1.8,"tpAtr":3,"maxHold":72}',
    '- {"type":"run_backtest_compare","strategies":["v5_hybrid","v5_retest","v5_reentry","v4_breakout"],"tf":"1h","bars":900,"feeBps":5,"stopAtr":1.8,"tpAtr":3,"maxHold":72}',
    '- {"type":"run_custom_backtest","strategy":"custom|v5_hybrid|v5_retest|v5_reentry|v4_breakout","tf":"1h","bars":900,"feeBps":5,"stopAtr":1.8,"tpAtr":3,"maxHold":72,"custom":{"lookback":18,"allowRetest":true,"allowReentry":true,"allowBreakout":false,"biasAdxMin":15,"side":"both"}}',
    '- {"type":"run_strategy_dsl","tf":"1d","bars":1200,"feeBps":5,"stopAtr":1.2,"tpAtr":2.8,"maxHold":120,"dsl":{"name":"feature-strategy","side":"both","features":[{"name":"ema_5","kind":"ema","source":"close","period":5},{"name":"adx_14","kind":"adx","period":14}],"entryLong":"close > ema_5 && adx_14 >= 20","entryShort":"close < ema_5 && adx_14 >= 20","exitLong":"close < ema_5","exitShort":"close > ema_5","risk":{"stopAtr":1.2,"tpAtr":2.8,"maxHold":120}}}',
    '4) 如果不需要动作，actions 返回空数组。',
    '5) 除非用户明确要求切页/跳转，否则不要输出 switch_view。',
    '6) 如果输出 run_backtest，请优先给出 1 条最关键任务动作，避免重复动作。',
    '7) 如果用户要求“高胜率/对比/筛选策略”，优先输出 run_backtest_compare，不要只返回口头承诺。',
    '8) 如果用户描述了自定义规则（如回踩/再入/突破、ADX阈值、止盈止损ATR、只做多/空），优先输出 run_custom_backtest。',
    '9) 如果用户要求基于任意新特征/因子（如“5日K线特征、EMA/RSI/ADX组合”）构建并执行策略，优先输出 run_strategy_dsl。',
    '10) 若上下文已有可复用工件，请在 reply 中点明“复用了哪个工件”，并在动作里带上相应 dsl/custom 配置继续执行。',
    '11) 用户可能非常口语化（如“我想挣钱”“帮我搞个能跑的策略”），你必须把口语目标翻译成可执行动作，不要要求用户提供术语。',
    '12) 当用户表达的是交易目标而非技术细节时，请主动补全默认参数并先执行一轮对比/回验，再给结果摘要与下一步建议。',
    '',
    '[交易看板上下文]',
    contextJson,
    '',
    '[用户问题]',
    baseMessage,
  ].join('\n');
}

function runProcess(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const child = spawn(command, args, {
      cwd: WORKDIR,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, Math.max(1_000, timeoutMs));

    child.stdout.on('data', (buf) => {
      stdout += String(buf);
    });
    child.stderr.on('data', (buf) => {
      stderr += String(buf);
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? -1, signal: signal || '', timedOut, stdout, stderr });
    });
  });
}

async function runOpenClawChat(message, context) {
  const prompt = buildOpenClawPrompt(message, context);
  if (!prompt) {
    throw new Error('empty message');
  }
  const cli = resolveOpenClawCli();
  const args = [
    ...cli.prefixArgs,
    'agent',
    '--agent',
    OPENCLAW_AGENT_ID,
    '--message',
    prompt,
    '--json',
    '--timeout',
    String(OPENCLAW_TIMEOUT_SEC),
  ];
  if (OPENCLAW_CHANNEL) args.push('--channel', OPENCLAW_CHANNEL);
  if (OPENCLAW_AGENT_LOCAL) args.push('--local');
  if (OPENCLAW_THINKING) args.push('--thinking', OPENCLAW_THINKING);
  if (OPENCLAW_VERBOSE) args.push('--verbose', OPENCLAW_VERBOSE);
  if (OPENCLAW_SESSION_ID) args.push('--session-id', OPENCLAW_SESSION_ID);
  if (OPENCLAW_TO) args.push('--to', OPENCLAW_TO);
  if (OPENCLAW_DELIVER) args.push('--deliver');
  if (OPENCLAW_REPLY_CHANNEL) args.push('--reply-channel', OPENCLAW_REPLY_CHANNEL);
  if (OPENCLAW_REPLY_TO) args.push('--reply-to', OPENCLAW_REPLY_TO);
  if (OPENCLAW_REPLY_ACCOUNT) args.push('--reply-account', OPENCLAW_REPLY_ACCOUNT);

  const startedAt = Date.now();
  const proc = await runProcess(cli.command, args, OPENCLAW_CHAT_TIMEOUT_MS);
  if (proc.timedOut) {
    throw new Error('OpenClaw 调用超时，请检查 Gateway/模型状态');
  }
  if (proc.code !== 0) {
    const reason = String(proc.stderr || proc.stdout || '').trim();
    throw new Error(reason || ('OpenClaw 进程退出码: ' + proc.code));
  }
  const extracted = extractReplyFromOutput(proc.stdout);
  if (!extracted.reply) {
    throw new Error('OpenClaw 返回为空');
  }
  return {
    reply: extracted.reply,
    parsed: extracted.parsed,
    elapsedMs: Date.now() - startedAt,
    commandSource: cli.source,
  };
}

async function runOpenClawAdmin(args, timeoutMs = 35_000) {
  const cli = resolveOpenClawCli();
  const proc = await runProcess(cli.command, [...cli.prefixArgs, ...args], timeoutMs);
  if (proc.timedOut) {
    throw new Error('OpenClaw 管理命令超时');
  }
  if (proc.code !== 0) {
    throw new Error(String(proc.stderr || proc.stdout || '').trim() || ('exit code ' + proc.code));
  }
  return { stdout: String(proc.stdout || '').trim(), commandSource: cli.source };
}

function looksLikeConfigIntent(message) {
  const text = String(message || '').trim();
  if (!text) return false;
  if (/查看配置|当前配置|配置状态|^配置$|^设置$/.test(text)) return true;
  if (/^\/(config|配置|设置|setup)\b/i.test(text)) return true;
  if (/telegram|tg|deepseek|codex|chatgpt|模型|model|token|apikey|api key/i.test(text)) {
    return /配置|设置|绑定|连接|修改|切换|登录|login|token|apikey|api key|模型|model/i.test(text);
  }
  return false;
}

function maskMaybeSecret(value) {
  const s = String(value || '').trim();
  if (!s) return '(未设置)';
  if (s.length <= 10) return '***';
  return s.slice(0, 4) + '...' + s.slice(-3);
}

function parseConfigIntent(message) {
  const text = String(message || '').trim();
  const lower = text.toLowerCase();
  if (!text) return { type: 'none' };

  if (/^\/config\s+status$/i.test(text) || /^\/配置\s*状态$/.test(text) || /查看配置|当前配置|配置状态/.test(text)) {
    return { type: 'status' };
  }

  const deepseekKeyMatch = text.match(/\bsk-[A-Za-z0-9\-_]{12,}\b/);
  if (deepseekKeyMatch && /(deepseek|模型|model|配置|设置|绑定|apikey|api key|key)/i.test(text)) {
    const modelMatch =
      text.match(/\bdeepseek\/[a-z0-9._-]+\b/i) ||
      text.match(/\bdeepseek(?:-chat|-reasoner)\b/i) ||
      text.match(/\bdeepseek[-_][a-z0-9._-]+\b/i);
    return { type: 'set_deepseek', apiKey: deepseekKeyMatch[0], model: modelMatch ? modelMatch[0] : 'deepseek-chat' };
  }

  const telegramTokenMatch = text.match(/\b\d{6,12}:[A-Za-z0-9_-]{20,}\b/);
  if (telegramTokenMatch && /(telegram|tg|机器人|bot|token|配置|设置|绑定|连接)/i.test(text)) {
    return { type: 'set_telegram_token', token: telegramTokenMatch[0] };
  }

  if (/chatgpt|codex|openai/.test(lower) && /(登录|连接|绑定|login|auth|配置)/i.test(text)) {
    return { type: 'connect_chatgpt' };
  }

  if (/telegram/.test(lower) && /(自动回复|auto.?reply)/i.test(lower)) {
    if (/(关闭|停用|off|false|0)/i.test(lower)) return { type: 'set_telegram_auto_reply', value: '0' };
    if (/(开启|启用|on|true|1)/i.test(lower)) return { type: 'set_telegram_auto_reply', value: '1' };
  }

  if (/telegram/.test(lower) && /(交易事件|推送|trade push|push)/i.test(lower)) {
    if (/(关闭|停用|off|false|0)/i.test(lower)) return { type: 'set_trade_push', value: '0' };
    if (/(开启|启用|on|true|1)/i.test(lower)) return { type: 'set_trade_push', value: '1' };
  }

  return { type: 'none' };
}

function buildConfigStatusReply() {
  const envPairs = readEnvLocalPairs();
  const tgToken = envPairs.THUNDERCLAW_TELEGRAM_BOT_TOKEN || '';
  const tgAuto = String(envPairs.THUNDERCLAW_TELEGRAM_AUTO_REPLY || '1');
  const tgPush = String(envPairs.THUNDERCLAW_TELEGRAM_PUSH_TRADES || '1');
  const modelHint = String(envPairs.OPENCLAW_AGENT_ID || 'main');
  return [
    '当前配置状态：',
    '- OpenClaw Agent: ' + modelHint,
    '- Telegram Token: ' + maskMaybeSecret(tgToken),
    '- Telegram 自动回复: ' + (/^(1|true|yes|on)$/i.test(tgAuto) ? '开启' : '关闭'),
    '- Telegram 交易事件推送: ' + (/^(1|true|yes|on)$/i.test(tgPush) ? '开启' : '关闭'),
    '',
    '可直接发送：',
    '- 设置 Telegram token 123456:ABC...',
    '- 设置 DeepSeek key sk-xxxx',
    '- 连接 ChatGPT/Codex',
    '- 关闭 Telegram 自动回复',
  ].join('\n');
}

function normalizeDeepSeekModelId(modelLike) {
  const raw = String(modelLike || '').trim();
  if (!raw) return 'deepseek/deepseek-chat';
  if (raw.includes('/')) return raw;
  return 'deepseek/' + raw;
}

async function handleConfigIntent(intent) {
  if (!intent || intent.type === 'none') {
    return { handled: false, reply: '' };
  }
  if (intent.type === 'status') {
    return { handled: true, reply: buildConfigStatusReply() };
  }
  if (intent.type === 'set_telegram_token') {
    const token = String(intent.token || '').trim();
    if (!token) return { handled: true, reply: 'Telegram token 为空，未更新。' };
    writeEnvLocal({
      THUNDERCLAW_TELEGRAM_BOT_TOKEN: token,
      THUNDERCLAW_TELEGRAM_AUTO_REPLY: '1',
      THUNDERCLAW_TELEGRAM_PUSH_TRADES: '1',
      THUNDERCLAW_TELEGRAM_PUSH_EVENTS: 'open,close,risk',
    });
    return {
      handled: true,
      reply: '已保存 Telegram token：' + maskMaybeSecret(token) + '\n请重启 thunderclaw start 使新 token 生效。',
    };
  }
  if (intent.type === 'set_telegram_auto_reply') {
    const v = intent.value === '0' ? '0' : '1';
    writeEnvLocal({ THUNDERCLAW_TELEGRAM_AUTO_REPLY: v });
    return { handled: true, reply: 'Telegram 自动回复已' + (v === '1' ? '开启' : '关闭') + '。重启后生效。' };
  }
  if (intent.type === 'set_trade_push') {
    const v = intent.value === '0' ? '0' : '1';
    writeEnvLocal({ THUNDERCLAW_TELEGRAM_PUSH_TRADES: v });
    return { handled: true, reply: 'Telegram 交易事件主动推送已' + (v === '1' ? '开启' : '关闭') + '。重启后生效。' };
  }
  if (intent.type === 'set_deepseek') {
    const apiKey = String(intent.apiKey || '').trim();
    if (!apiKey.toLowerCase().startsWith('sk-')) {
      return { handled: true, reply: 'DeepSeek key 格式不正确（需 sk- 开头）。' };
    }
    const modelId = normalizeDeepSeekModelId(intent.model || 'deepseek-chat');
    const providerJson = JSON.stringify({
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey,
      api: 'openai-completions',
      models: [
        { id: 'deepseek-chat', name: 'DeepSeek Chat' },
        { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
      ],
    });
    try {
      await runOpenClawAdmin(['config', 'set', 'models.mode', 'merge']);
      await runOpenClawAdmin(['config', 'set', '--json', 'models.providers.deepseek', providerJson]);
      await runOpenClawAdmin(['config', 'set', 'agents.defaults.model.primary', modelId]);
      return {
        handled: true,
        reply:
          'DeepSeek 已配置成功。\n- 默认模型: ' +
          modelId +
          '\n- key: ' +
          maskMaybeSecret(apiKey) +
          '\n现在可以直接在聊天中继续对话。',
      };
    } catch (err) {
      return { handled: true, reply: '写入 DeepSeek 配置失败：' + safeErrMsg(err, 'unknown') };
    }
  }
  if (intent.type === 'connect_chatgpt') {
    return {
      handled: true,
      reply: [
        'ChatGPT/Codex 连接需要一次交互式登录（设备授权流程）。',
        '请在本机终端执行：',
        '1) openclaw models auth login --set-default',
        '2) 按终端提示打开链接并完成登录',
        '',
        '登录完成后回到 ThunderClaw 聊天即可使用。',
      ].join('\n'),
    };
  }
  return { handled: false, reply: '' };
}

function readJsonBody(req, limitBytes = JSON_BODY_LIMIT) {
  return new Promise((resolve) => {
    let body = '';
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > limitBytes) {
        resolve({ ok: false, error: 'payload too large' });
        req.destroy();
        return;
      }
      body += String(chunk);
    });
    req.on('error', () => {
      resolve({ ok: false, error: 'request stream error' });
    });
    req.on('end', () => {
      if (!body.trim()) {
        resolve({ ok: true, value: {} });
        return;
      }
      try {
        resolve({ ok: true, value: JSON.parse(body) });
      } catch {
        resolve({ ok: false, error: 'invalid json body' });
      }
    });
  });
}

async function handleChatApi(req, res) {
  if (String(req.method || 'GET').toUpperCase() !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Allow', 'POST');
    res.end('Method Not Allowed');
    return;
  }
  const body = await readJsonBody(req);
  if (!body.ok) {
    sendJson(res, body.error === 'payload too large' ? 413 : 400, { ok: false, error: body.error });
    return;
  }
  const message = typeof body.value?.message === 'string' ? body.value.message.trim() : '';
  if (!message) {
    sendJson(res, 400, { ok: false, error: 'message is required' });
    return;
  }
  appendChatHistoryEvent({
    source: 'dashboard',
    role: 'user',
    direction: 'inbound',
    text: message,
  });
  if (/^(记忆状态|查看记忆|memory status)$/i.test(message)) {
    const memoryBundle = buildLayeredMemoryBundle('');
    const profile = memoryBundle?.layers?.longTerm?.profile || buildTraderProfileSummary();
    const shortItems = Number(memoryBundle?.layers?.shortTerm?.totalItems || 0);
    const topTags = Array.isArray(profile?.topTags)
      ? profile.topTags.map((x) => x.tag + '(' + x.count + ')').join(', ')
      : '';
    const strategyRows = Array.isArray(memoryBundle?.layers?.midTerm?.strategyWeights)
      ? memoryBundle.layers.midTerm.strategyWeights.slice(0, 3)
      : [];
    const strategyText = strategyRows.length
      ? strategyRows.map((x) => x.strategy + ':' + Number(x.weight).toFixed(3)).join(', ')
      : '-';
    const artifactRows = Array.isArray(memoryBundle?.layers?.midTerm?.strategyArtifacts)
      ? memoryBundle.layers.midTerm.strategyArtifacts.slice(0, 3)
      : [];
    const artifactText = artifactRows.length
      ? artifactRows
          .map((x) => String(x.artifactId || '-') + ':' + Number(x.learningWeight || 0).toFixed(3))
          .join(', ')
      : '-';
    sendJson(res, 200, {
      ok: true,
      source: 'memory',
      reply: [
        '记忆分层状态：',
        '- 长期条目: ' + String(profile.memoryItems || 0),
        '- 短期条目: ' + String(shortItems),
        '- 最近活跃: ' + String(profile.lastActiveAt || '-'),
        '- 高频标签: ' + (topTags || '-'),
        '- 策略权重Top: ' + strategyText,
        '- 策略工件Top: ' + artifactText,
      ].join('\n'),
      actions: [],
      contextDigest: null,
      meta: {
        memoryItems: profile.memoryItems || 0,
        shortItems,
        topStrategies: strategyRows,
        topArtifacts: artifactRows,
      },
    });
    appendChatHistoryEvent({
      source: 'dashboard',
      role: 'bot',
      direction: 'outbound',
      text: [
        '记忆分层状态：',
        '- 长期条目: ' + String(profile.memoryItems || 0),
        '- 短期条目: ' + String(shortItems),
        '- 最近活跃: ' + String(profile.lastActiveAt || '-'),
        '- 高频标签: ' + (topTags || '-'),
        '- 策略权重Top: ' + strategyText,
        '- 策略工件Top: ' + artifactText,
      ].join('\n'),
    });
    return;
  }
  if (/^(工件状态|策略工件|artifact status)$/i.test(message)) {
    const reply = buildStrategyArtifactStatusReply(8);
    sendJson(res, 200, {
      ok: true,
      source: 'memory',
      reply,
      actions: [],
      contextDigest: null,
      meta: {
        artifacts: listStrategyArtifacts(8),
      },
    });
    appendChatHistoryEvent({
      source: 'dashboard',
      role: 'bot',
      direction: 'outbound',
      text: reply,
    });
    return;
  }
  const useArtifactMatch = message.match(/(?:使用|启用|执行|回测|运行|use)\s*(?:工件|artifact)?\s*[:：]?\s*(art-[a-f0-9]{8,20})/i);
  if (useArtifactMatch && useArtifactMatch[1]) {
    const artifactId = String(useArtifactMatch[1]).toLowerCase();
    const artifact = listStrategyArtifacts(200).find((x) => x.artifactId === artifactId) || null;
    if (!artifact) {
      sendJson(res, 200, {
        ok: true,
        source: 'memory',
        reply: '未找到工件 ' + artifactId + '。可先发送「工件状态」查看可用工件列表。',
        actions: [],
        contextDigest: null,
      });
      appendChatHistoryEvent({
        source: 'dashboard',
        role: 'bot',
        direction: 'outbound',
        text: '未找到工件 ' + artifactId + '。可先发送「工件状态」查看可用工件列表。',
      });
      return;
    }
    const action = strategyArtifactToAction(artifact);
    if (!action) {
      sendJson(res, 200, {
        ok: true,
        source: 'memory',
        reply: '工件 ' + artifactId + ' 存在，但配置不完整，暂时无法执行。',
        actions: [],
        contextDigest: null,
      });
      appendChatHistoryEvent({
        source: 'dashboard',
        role: 'bot',
        direction: 'outbound',
        text: '工件 ' + artifactId + ' 存在，但配置不完整，暂时无法执行。',
      });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      source: 'memory',
      reply:
        '已加载工件 ' +
        artifactId +
        '（' +
        String(artifact.label || artifact.strategyType || '-') +
        '），现在执行一轮回验并返回结果。',
      actions: [action],
      contextDigest: null,
      meta: { artifactId, artifact },
    });
    appendChatHistoryEvent({
      source: 'dashboard',
      role: 'bot',
      direction: 'outbound',
      text:
        '已加载工件 ' +
        artifactId +
        '（' +
        String(artifact.label || artifact.strategyType || '-') +
        '），现在执行一轮回验并返回结果。',
    });
    return;
  }
  const rememberMatch = message.match(/^(记住|remember)\s*[:：]?\s*(.+)$/i);
  if (rememberMatch) {
    const note = String(rememberMatch[2] || '').trim();
    if (!note) {
      sendJson(res, 400, { ok: false, error: '记忆内容为空' });
      return;
    }
    appendTraderMemory({
      kind: 'manual_note',
      channel: 'dashboard',
      tags: ['manual-note', 'user'],
      content: note,
    });
    sendJson(res, 200, {
      ok: true,
      source: 'memory',
      reply: '已记住：' + truncText(redactSecrets(note), 180),
      actions: [],
      contextDigest: null,
      meta: { memoryItems: traderMemoryState.entries.length },
    });
    appendChatHistoryEvent({
      source: 'dashboard',
      role: 'bot',
      direction: 'outbound',
      text: '已记住：' + truncText(redactSecrets(note), 180),
    });
    return;
  }
  const artifactFeedback = applyUserStrategyArtifactFeedback(message, 'dashboard');
  if (artifactFeedback?.handled && (artifactFeedback?.explicit || artifactFeedback?.applied)) {
    sendJson(res, 200, {
      ok: true,
      source: 'memory',
      reply: String(artifactFeedback.reply || '已记录工件反馈。'),
      actions: [],
      contextDigest: null,
      meta: {
        artifactId: artifactFeedback.artifactId || null,
        reward: artifactFeedback.reward ?? null,
        learningWeight: artifactFeedback.learningWeight ?? null,
        strength: artifactFeedback.strength ?? null,
      },
    });
    appendChatHistoryEvent({
      source: 'dashboard',
      role: 'bot',
      direction: 'outbound',
      text: String(artifactFeedback.reply || '已记录工件反馈。'),
    });
    return;
  }
  const feedback = applyUserStrategyFeedback(message, 'dashboard');
  if (feedback?.handled && feedback?.explicit) {
    sendJson(res, 200, {
      ok: true,
      source: 'memory',
      reply: String(feedback.reply || '已记录策略反馈。'),
      actions: [],
      contextDigest: null,
      meta: {
        strategy: feedback.strategy || null,
        reward: feedback.reward ?? null,
        weight: feedback.weight ?? null,
      },
    });
    appendChatHistoryEvent({
      source: 'dashboard',
      role: 'bot',
      direction: 'outbound',
      text: String(feedback.reply || '已记录策略反馈。'),
    });
    return;
  }
  const clientContext =
    body.value?.clientContext && typeof body.value.clientContext === 'object'
      ? body.value.clientContext
      : undefined;
  appendTraderMemory({
    kind: 'chat',
    channel: 'dashboard',
    tags: ['dashboard', 'user'],
    content: '用户: ' + redactSecrets(message),
  });
  const memoryBundle = buildLayeredMemoryBundle(message);
  const trading = buildTradingContext(clientContext, memoryBundle);
  try {
    const result = await runOpenClawChat(message, trading.context);
    const structured = parseStructuredAgentReply(result.reply);
    const finalActions = augmentActionsByIntent(message, structured.actions);
    appendTraderMemory({
      kind: 'chat',
      channel: 'dashboard',
      tags: ['dashboard', 'assistant'],
      content: '助手: ' + redactSecrets(String(structured.reply || '').trim()),
    });
    sendJson(res, 200, {
      ok: true,
      source: 'openclaw',
      binding: 'trading-context-v2',
      reply: structured.reply,
      actions: finalActions,
      contextDigest: trading.digest,
      meta: {
        elapsedMs: result.elapsedMs,
        commandSource: result.commandSource,
        agentId: OPENCLAW_AGENT_ID,
      },
    });
    appendChatHistoryEvent({
      source: 'dashboard',
      role: 'bot',
      direction: 'outbound',
      text: String(structured.reply || '').trim() || '收到。',
    });
  } catch (err) {
    appendTraderMemory({
      kind: 'chat',
      channel: 'dashboard',
      tags: ['dashboard', 'error'],
      content: '错误: ' + safeErrMsg(err, 'openclaw error'),
    });
    sendJson(res, 502, {
      ok: false,
      source: 'openclaw',
      binding: 'trading-context-v2',
      error: String(err?.message || err),
      contextDigest: trading.digest,
    });
    appendChatHistoryEvent({
      source: 'dashboard',
      role: 'bot',
      direction: 'outbound',
      text: '处理失败：' + safeErrMsg(err, 'openclaw error'),
    });
  }
}

async function handleConfigChatApi(req, res) {
  if (String(req.method || 'GET').toUpperCase() !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Allow', 'POST');
    res.end('Method Not Allowed');
    return;
  }
  const body = await readJsonBody(req);
  if (!body.ok) {
    sendJson(res, body.error === 'payload too large' ? 413 : 400, { ok: false, error: body.error });
    return;
  }
  const message = typeof body.value?.message === 'string' ? body.value.message.trim() : '';
  if (!message) {
    sendJson(res, 400, { ok: false, error: 'message is required' });
    return;
  }
  if (!looksLikeConfigIntent(message)) {
    sendJson(res, 200, { ok: true, handled: false, reply: '' });
    return;
  }
  try {
    const intent = parseConfigIntent(message);
    const result = await handleConfigIntent(intent);
    sendJson(res, 200, {
      ok: true,
      handled: Boolean(result.handled),
      reply: String(result.reply || ''),
      intent: intent.type || 'none',
    });
  } catch (err) {
    sendJson(res, 500, {
      ok: false,
      handled: false,
      error: safeErrMsg(err, 'config handler failed'),
    });
  }
}

function handleTelegramEventsApi(req, res) {
  if (String(req.method || 'GET').toUpperCase() !== 'GET') {
    res.statusCode = 405;
    res.setHeader('Allow', 'GET');
    res.end('Method Not Allowed');
    return;
  }
  const url = new URL(req.url || '/', 'http://localhost');
  const afterId = Number(url.searchParams.get('afterId') || '0');
  const limit = Number(url.searchParams.get('limit') || '80');
  sendJson(res, 200, {
    ok: true,
    enabled: TELEGRAM_ENABLED,
    autoReply: TELEGRAM_AUTO_REPLY,
    latestEventId: telegramEventSeq,
    events: listTelegramEvents(afterId, limit),
  });
}

function handleTelegramHealthApi(req, res) {
  if (String(req.method || 'GET').toUpperCase() !== 'GET') {
    res.statusCode = 405;
    res.setHeader('Allow', 'GET');
    res.end('Method Not Allowed');
    return;
  }
  sendJson(res, 200, {
    ok: true,
    provider: 'telegram-bot-api',
    enabled: TELEGRAM_ENABLED,
    autoReply: TELEGRAM_AUTO_REPLY,
    connected: telegramState.connected,
    pollActive: telegramState.pollActive,
    lastPollAt: telegramState.lastPollAt,
    lastInboundAt: telegramState.lastInboundAt,
    lastOutboundAt: telegramState.lastOutboundAt,
    lastUpdateId: telegramState.lastUpdateId,
    lastError: telegramState.lastError,
    droppedUpdates: telegramState.droppedUpdates,
    allowedChatIds: telegramState.allowedChatIds,
    pollLock: {
      path: telegramState.pollLock.path,
      acquired: telegramState.pollLock.acquired,
      ownerPid: telegramState.pollLock.ownerPid,
      reason: telegramState.pollLock.reason,
    },
    dedupe: {
      path: telegramState.dedupe.path,
      ttlMs: telegramState.dedupe.ttlMs,
      claimed: telegramState.dedupe.claimed,
      duplicates: telegramState.dedupe.duplicates,
      lastKey: telegramState.dedupe.lastKey,
      lastClaimAt: telegramState.dedupe.lastClaimAt,
      lastDuplicateAt: telegramState.dedupe.lastDuplicateAt,
      lastError: telegramState.dedupe.lastError,
    },
    conflicts: {
      count: telegramState.conflicts.count,
      lastAt: telegramState.conflicts.lastAt,
      lastMessage: telegramState.conflicts.lastMessage,
    },
    knownChatIds: Array.from(telegramKnownChatIds),
    push: {
      enabled: telegramState.push.enabled,
      events: telegramState.push.events,
      configuredChatIds: telegramState.push.configuredChatIds,
      resolvedTargets: resolveTelegramPushTargets(),
      active: telegramState.push.active,
      lastRunAt: telegramState.push.lastRunAt,
      lastSentAt: telegramState.push.lastSentAt,
      lastSentPreview: telegramState.push.lastSentPreview,
      lastError: telegramState.push.lastError,
      sentCount: telegramState.push.sentCount,
      skippedNoTarget: telegramState.push.skippedNoTarget,
    },
  });
}

function handleMemoryHealthApi(req, res) {
  if (String(req.method || 'GET').toUpperCase() !== 'GET') {
    res.statusCode = 405;
    res.setHeader('Allow', 'GET');
    res.end('Method Not Allowed');
    return;
  }
  const url = new URL(req.url || '/', 'http://localhost');
  const q = String(url.searchParams.get('q') || '').trim();
  loadTraderMemory();
  loadShortTermMemory();
  loadStrategyFeedbackState();
  rememberTradeOutcomesToMemory();
  const memoryBundle = buildLayeredMemoryBundle(q);
  sendJson(res, 200, {
    ok: true,
    enabled: true,
    paths: {
      longTerm: TRADER_MEMORY_PATH,
      shortTerm: TRADER_SHORT_MEMORY_PATH,
      midTerm: TRADER_PROFILE_PATH,
      strategyWeights: STRATEGY_WEIGHTS_PATH,
      strategyArtifactsJsonl: STRATEGY_ARTIFACTS_JSONL_PATH,
      strategyArtifactsState: STRATEGY_ARTIFACTS_STATE_PATH,
    },
    totalEntries: traderMemoryState.entries.length,
    shortEntries: shortTermMemoryState.items.length,
    profile: memoryBundle?.layers?.longTerm?.profile || null,
    layers: memoryBundle?.layers || null,
    strategyFeedback: {
      processedTrades: strategyFeedbackState.processedTradeKeys.size,
      lastLearnAt: strategyFeedbackState.lastLearnAt,
      ranking: buildStrategyWeightsRanking(TRADER_MID_TOP_STRATEGIES),
    },
    strategyArtifacts: {
      total: Object.keys(strategyArtifactState.artifacts || {}).length,
      lastUpdatedAt: strategyArtifactState.lastUpdatedAt,
      ranking: listStrategyArtifacts(STRATEGY_ARTIFACTS_TOPK),
    },
  });
}

function handleStrategyArtifactsApi(req, res) {
  if (String(req.method || 'GET').toUpperCase() !== 'GET') {
    res.statusCode = 405;
    res.setHeader('Allow', 'GET');
    res.end('Method Not Allowed');
    return;
  }
  const url = new URL(req.url || '/', 'http://localhost');
  const q = String(url.searchParams.get('q') || '').trim();
  const limit = Number(url.searchParams.get('limit') || String(STRATEGY_ARTIFACTS_TOPK));
  const artifactId = String(url.searchParams.get('artifactId') || '').trim().toLowerCase();
  const list = listStrategyArtifacts(limit, q);
  const item = artifactId ? listStrategyArtifacts(1000).find((x) => x.artifactId === artifactId) || null : null;
  sendJson(res, 200, {
    ok: true,
    total: Object.keys(strategyArtifactState.artifacts || {}).length,
    latestUpdatedAt: strategyArtifactState.lastUpdatedAt,
    artifactId: artifactId || null,
    artifact: item,
    artifacts: list,
  });
}

async function handleStrategyArtifactReportApi(req, res) {
  if (String(req.method || 'GET').toUpperCase() !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Allow', 'POST');
    res.end('Method Not Allowed');
    return;
  }
  const body = await readJsonBody(req, Math.max(JSON_BODY_LIMIT, 256 * 1024));
  if (!body.ok) {
    sendJson(res, body.error === 'payload too large' ? 413 : 400, { ok: false, error: body.error });
    return;
  }
  const payload =
    body.value?.report && typeof body.value.report === 'object'
      ? body.value.report
      : body.value && typeof body.value === 'object'
        ? body.value
        : {};
  const result = registerStrategyArtifactReport(payload);
  if (!result?.ok) {
    sendJson(res, 400, { ok: false, error: String(result?.reason || 'invalid report') });
    return;
  }
  sendJson(res, 200, {
    ok: true,
    duplicate: Boolean(result.duplicate),
    artifactId: result.artifactId || null,
    version: result.version || null,
    reward: result.reward ?? null,
    learningWeight: result.learningWeight ?? null,
    scoreEma: result.scoreEma ?? null,
    strength: result.strength ?? null,
  });
}

function handleChatHistoryApi(req, res) {
  if (String(req.method || 'GET').toUpperCase() !== 'GET') {
    res.statusCode = 405;
    res.setHeader('Allow', 'GET');
    res.end('Method Not Allowed');
    return;
  }
  const url = new URL(req.url || '/', 'http://localhost');
  const afterId = Number(url.searchParams.get('afterId') || '0');
  const limit = Number(url.searchParams.get('limit') || '120');
  sendJson(res, 200, {
    ok: true,
    latestEventId: chatHistorySeq,
    events: listChatHistory(afterId, limit),
  });
}

async function handleStatic(req, res, pathname) {
  const pagePath = pathname === '/' ? '/index.html' : pathname;
  const file = path.resolve(REPORT_DIR, '.' + pagePath);
  if (!(file === REPORT_DIR || file.startsWith(REPORT_DIR + path.sep))) {
    res.writeHead(403);
    res.end();
    return;
  }
  try {
    const data = await fs.promises.readFile(file);
    const ext = path.extname(file).toLowerCase();
    res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
    res.end(data);
  } catch (err) {
    const code = err && err.code === 'ENOENT' ? 404 : 500;
    res.writeHead(code);
    res.end(code === 404 ? 'Not Found' : 'Error');
  }
}

const server = http.createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname === '/api/ai/health') {
      if (String(req.method || 'GET').toUpperCase() !== 'GET') {
        res.statusCode = 405;
        res.setHeader('Allow', 'GET');
        res.end('Method Not Allowed');
        return;
      }
      const cli = resolveOpenClawCli();
      const healthMemory = buildLayeredMemoryBundle('');
      const trading = buildTradingContext(undefined, healthMemory);
      sendJson(res, 200, {
        ok: true,
        provider: 'openclaw',
        bridge: '/api/ai/chat',
        binding: 'trading-context-v2',
        agentId: OPENCLAW_AGENT_ID,
        channel: OPENCLAW_CHANNEL || null,
        deliver: OPENCLAW_DELIVER,
        agentLocal: OPENCLAW_AGENT_LOCAL,
        hasTo: Boolean(OPENCLAW_TO),
        hasSessionId: Boolean(OPENCLAW_SESSION_ID),
        replyChannel: OPENCLAW_REPLY_CHANNEL || null,
        hasReplyTo: Boolean(OPENCLAW_REPLY_TO),
        hasReplyAccount: Boolean(OPENCLAW_REPLY_ACCOUNT),
        thinking: OPENCLAW_THINKING || null,
        verbose: OPENCLAW_VERBOSE || null,
        timeoutSec: OPENCLAW_TIMEOUT_SEC,
        commandSource: cli.source,
        contextDigest: trading.digest,
        memory: {
          shortItems: Number(healthMemory?.layers?.shortTerm?.totalItems || 0),
          longItems: Number(healthMemory?.layers?.longTerm?.profile?.memoryItems || 0),
          topStrategy: healthMemory?.layers?.midTerm?.strategyWeights?.[0] || null,
          topArtifact: healthMemory?.layers?.midTerm?.strategyArtifacts?.[0] || null,
        },
        runtime: {
          serviceLock: {
            path: runtimeState.serviceLock.path,
            acquired: runtimeState.serviceLock.acquired,
            ownerPid: runtimeState.serviceLock.ownerPid,
            reason: runtimeState.serviceLock.reason,
          },
          chatHistory: {
            path: CHAT_HISTORY_PATH,
            total: chatHistory.length,
            latestId: chatHistorySeq,
          },
        },
        telegram: {
          enabled: TELEGRAM_ENABLED,
          autoReply: TELEGRAM_AUTO_REPLY,
          connected: telegramState.connected,
          lastError: telegramState.lastError,
          lastInboundAt: telegramState.lastInboundAt,
          pollLockAcquired: telegramState.pollLock.acquired,
          pollLockOwnerPid: telegramState.pollLock.ownerPid,
          dedupeDuplicates: telegramState.dedupe.duplicates,
          dedupeLastAt: telegramState.dedupe.lastDuplicateAt,
          conflictCount: telegramState.conflicts.count,
          conflictLastAt: telegramState.conflicts.lastAt,
          pushTrades: telegramState.push.enabled,
          pushTargets: resolveTelegramPushTargets().length,
          pushLastSentAt: telegramState.push.lastSentAt,
          pushLastError: telegramState.push.lastError,
        },
      });
      return;
    }
    if (url.pathname === '/api/telegram/events') {
      handleTelegramEventsApi(req, res);
      return;
    }
    if (url.pathname === '/api/telegram/health') {
      handleTelegramHealthApi(req, res);
      return;
    }
    if (url.pathname === '/api/memory/health') {
      handleMemoryHealthApi(req, res);
      return;
    }
    if (url.pathname === '/api/strategy/artifacts') {
      handleStrategyArtifactsApi(req, res);
      return;
    }
    if (url.pathname === '/api/strategy/artifacts/report') {
      await handleStrategyArtifactReportApi(req, res);
      return;
    }
    if (url.pathname === '/api/chat/history') {
      handleChatHistoryApi(req, res);
      return;
    }
    if (url.pathname === '/api/ai/context') {
      if (String(req.method || 'GET').toUpperCase() !== 'GET') {
        res.statusCode = 405;
        res.setHeader('Allow', 'GET');
        res.end('Method Not Allowed');
        return;
      }
      const contextMemory = buildLayeredMemoryBundle('');
      const trading = buildTradingContext(undefined, contextMemory);
      const full = url.searchParams.get('full') === '1';
      sendJson(res, 200, {
        ok: true,
        binding: 'trading-context-v2',
        contextDigest: trading.digest,
        context: full ? trading.context : undefined,
      });
      return;
    }
    if (url.pathname === '/api/config/chat') {
      await handleConfigChatApi(req, res);
      return;
    }
    if (url.pathname === '/api/ai/chat') {
      await handleChatApi(req, res);
      return;
    }
    await handleStatic(req, res, url.pathname);
  })().catch(() => {
    res.statusCode = 500;
    res.end('Internal Server Error');
  });
});

const serviceLockOk = acquireThunderClawServiceLock();
if (!serviceLockOk) {
  const ownerTxt =
    runtimeState.serviceLock.ownerPid != null
      ? ' (ownerPid=' + String(runtimeState.serviceLock.ownerPid) + ')'
      : '';
  console.error(
    '[thunderclaw] serve-report already running for key=' +
      THUNDERCLAW_SERVICE_LOCK_KEY +
      ownerTxt +
      ' ; stop old process first.',
  );
  process.exit(1);
}

registerProcessCleanupHooks();
loadChatHistoryFromDisk();
loadTelegramEventsFromDisk();
loadTraderMemory();
loadShortTermMemory();
loadStrategyFeedbackState();
loadStrategyArtifactState();
rememberTradeOutcomesToMemory();
learnStrategyWeightsFromTrades();
buildMidTermMemoryProfile();
cleanupTelegramInboundDedupe(true);

server.listen(PORT, () => {
  console.log('Report server: http://localhost:' + PORT);
  console.log('Serving:', REPORT_DIR);
  console.log(
    'Service lock: ' +
      THUNDERCLAW_SERVICE_LOCK_PATH +
      ' (key=' +
      THUNDERCLAW_SERVICE_LOCK_KEY +
      ', pid=' +
      process.pid +
      ')',
  );
  console.log('AI bridge: POST /api/ai/chat (OpenClaw agent=' + OPENCLAW_AGENT_ID + ', binding=trading-context-v2)');
  const routingParts = [];
  if (OPENCLAW_CHANNEL) routingParts.push('channel=' + OPENCLAW_CHANNEL);
  if (OPENCLAW_TO) routingParts.push('to=' + OPENCLAW_TO);
  if (OPENCLAW_SESSION_ID) routingParts.push('session=' + OPENCLAW_SESSION_ID);
  if (OPENCLAW_DELIVER) routingParts.push('deliver=on');
  if (OPENCLAW_REPLY_CHANNEL) routingParts.push('replyChannel=' + OPENCLAW_REPLY_CHANNEL);
  if (OPENCLAW_REPLY_TO) routingParts.push('replyTo=' + OPENCLAW_REPLY_TO);
  if (OPENCLAW_REPLY_ACCOUNT) routingParts.push('replyAccount=' + OPENCLAW_REPLY_ACCOUNT);
  if (routingParts.length) console.log('AI routing:', routingParts.join(' | '));
  console.log('AI context: GET /api/ai/context');
  console.log('AI config channel: POST /api/config/chat');
  console.log('Chat history: GET /api/chat/history?afterId=<id>');
  console.log('Memory health: GET /api/memory/health?q=...');
  console.log('Strategy artifacts: GET /api/strategy/artifacts?limit=<n>&q=... | POST /api/strategy/artifacts/report');
  console.log(
    'Memory layers: short=' +
      TRADER_SHORT_MEMORY_PATH +
      ' | mid=' +
      TRADER_PROFILE_PATH +
      ' | long=' +
      TRADER_MEMORY_PATH,
  );
  console.log('Strategy feedback: ' + STRATEGY_WEIGHTS_PATH);
  console.log('Strategy artifacts state: ' + STRATEGY_ARTIFACTS_STATE_PATH);
  if (TELEGRAM_ENABLED) {
    const allow = telegramState.allowedChatIds.length
      ? telegramState.allowedChatIds.join(',')
      : 'ALL';
    console.log('Telegram relay: enabled (events=/api/telegram/events, autoReply=' + (TELEGRAM_AUTO_REPLY ? 'on' : 'off') + ')');
    console.log('Telegram allowlist:', allow);
    const lockOk = acquireTelegramPollLock();
    if (lockOk) {
      console.log('Telegram poll lock: acquired (pid=' + process.pid + ')');
      scheduleTelegramPoll(160);
    } else {
      console.log(
        'Telegram poll lock: busy (ownerPid=' +
          String(telegramState.pollLock.ownerPid || '?') +
          ', will retry)',
      );
      scheduleTelegramPoll(Math.max(3_500, TELEGRAM_RETRY_MS * 2));
    }
    if (telegramState.push.enabled) {
      const configuredTargets = TELEGRAM_PUSH_CHAT_IDS.length
        ? TELEGRAM_PUSH_CHAT_IDS.join(',')
        : '(auto)';
      console.log(
        'Telegram trade push: on (events=' +
          Array.from(TELEGRAM_PUSH_EVENTS).join(',') +
          ', targets=' +
          configuredTargets +
          ', intervalMs=' +
          TELEGRAM_PUSH_INTERVAL_MS +
          ')',
      );
      primeTelegramTradePushBaseline();
      scheduleTelegramTradePush(600);
    } else {
      console.log('Telegram trade push: off (set THUNDERCLAW_TELEGRAM_PUSH_TRADES=1 to enable)');
    }
  } else {
    console.log('Telegram relay: disabled (set THUNDERCLAW_TELEGRAM_BOT_TOKEN to enable)');
  }
});
