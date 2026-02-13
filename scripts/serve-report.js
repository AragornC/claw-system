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
import { spawn } from 'node:child_process';
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
const telegramKnownChatIds = new Set();
const telegramTradeKnownEventKeys = new Set();
const telegramTradeSentAck = new Set();
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

function buildTradingContext(clientContext) {
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

function normalizeAiActions(actionsLike) {
  if (!Array.isArray(actionsLike)) return [];
  const out = [];
  for (const item of actionsLike) {
    if (!item || typeof item !== 'object') continue;
    const type = String(item.type || '').trim().toLowerCase();
    if (type === 'switch_view') {
      const view = normalizeViewName(item.view);
      if (view) out.push({ type: 'switch_view', view });
      continue;
    }
    if (type === 'focus_trade') {
      const tradeId = String(item.tradeId || '').trim();
      if (tradeId) out.push({ type: 'focus_trade', tradeId });
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
      out.push(normalized);
    }
  }
  return out.slice(0, 4);
}

function pushTelegramEvent(eventLike) {
  const event = eventLike && typeof eventLike === 'object' ? eventLike : {};
  telegramEventSeq += 1;
  const item = {
    id: telegramEventSeq,
    ts: nowIso(),
    source: 'telegram',
    role: event.role === 'bot' ? 'bot' : 'user',
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
  return item;
}

function listTelegramEvents(afterId, limit = 80) {
  const cursor = Number.isFinite(Number(afterId)) ? Number(afterId) : 0;
  const maxN = Math.max(1, Math.min(200, Number(limit) || 80));
  return telegramEvents.filter((e) => e.id > cursor).slice(-maxN);
}

function parseTelegramIncoming(update) {
  const msg = update?.message || null;
  if (!msg) return null;
  const chatIdRaw = msg?.chat?.id;
  const chatId = chatIdRaw != null ? String(chatIdRaw) : '';
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
    chatId,
    from,
    text,
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

  if (!TELEGRAM_AUTO_REPLY) return;

  const trading = buildTradingContext({
    currentView: 'dashboard',
    userIntentHint: 'telegram:' + incoming.chatId,
  });
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
}

function scheduleTelegramPoll(delayMs) {
  if (!TELEGRAM_ENABLED) return;
  if (telegramPollTimer) clearTimeout(telegramPollTimer);
  const waitMs = Math.max(120, Number(delayMs) || 0);
  telegramPollTimer = setTimeout(() => {
    telegramPollTimer = null;
    void pollTelegramOnce();
  }, waitMs);
}

async function pollTelegramOnce() {
  if (!TELEGRAM_ENABLED) return;
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
    scheduleTelegramPoll(140);
  } catch (err) {
    telegramState.connected = false;
    telegramState.lastError = safeErrMsg(err, 'poll failed');
    scheduleTelegramPoll(TELEGRAM_RETRY_MS);
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
    '4) 如果不需要动作，actions 返回空数组。',
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
    const modelMatch = text.match(/deepseek[-_a-z0-9]{2,40}/i);
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
    const modelId = String(intent.model || 'deepseek-chat').trim();
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
  const clientContext =
    body.value?.clientContext && typeof body.value.clientContext === 'object'
      ? body.value.clientContext
      : undefined;
  const trading = buildTradingContext(clientContext);
  try {
    const result = await runOpenClawChat(message, trading.context);
    const structured = parseStructuredAgentReply(result.reply);
    sendJson(res, 200, {
      ok: true,
      source: 'openclaw',
      binding: 'trading-context-v2',
      reply: structured.reply,
      actions: structured.actions,
      contextDigest: trading.digest,
      meta: {
        elapsedMs: result.elapsedMs,
        commandSource: result.commandSource,
        agentId: OPENCLAW_AGENT_ID,
      },
    });
  } catch (err) {
    sendJson(res, 502, {
      ok: false,
      source: 'openclaw',
      binding: 'trading-context-v2',
      error: String(err?.message || err),
      contextDigest: trading.digest,
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
      const trading = buildTradingContext();
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
        telegram: {
          enabled: TELEGRAM_ENABLED,
          autoReply: TELEGRAM_AUTO_REPLY,
          connected: telegramState.connected,
          lastError: telegramState.lastError,
          lastInboundAt: telegramState.lastInboundAt,
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
    if (url.pathname === '/api/ai/context') {
      if (String(req.method || 'GET').toUpperCase() !== 'GET') {
        res.statusCode = 405;
        res.setHeader('Allow', 'GET');
        res.end('Method Not Allowed');
        return;
      }
      const trading = buildTradingContext();
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

server.listen(PORT, () => {
  console.log('Report server: http://localhost:' + PORT);
  console.log('Serving:', REPORT_DIR);
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
  if (TELEGRAM_ENABLED) {
    const allow = telegramState.allowedChatIds.length
      ? telegramState.allowedChatIds.join(',')
      : 'ALL';
    console.log('Telegram relay: enabled (events=/api/telegram/events, autoReply=' + (TELEGRAM_AUTO_REPLY ? 'on' : 'off') + ')');
    console.log('Telegram allowlist:', allow);
    scheduleTelegramPoll(160);
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
