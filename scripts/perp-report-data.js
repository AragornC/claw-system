#!/usr/bin/env node
/**
 * 数据层：只负责产出报告所需的数据文件，不写 HTML。
 * 1) 引擎/运行数据：从 bitget-perp-cycle-decisions.jsonl 读出最近 N 条，写入 report/decisions.json
 * 2) K 线数据：拉取或使用缓存，写入 report/ohlcv.json
 *
 * Usage: node scripts/perp-report-data.js [maxDecisions]
 * Env: PERP_CHART_SYMBOL, OPENCLAW_WORKDIR
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ccxt from 'ccxt';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKDIR = process.env.OPENCLAW_WORKDIR || process.cwd();
const DECISIONS_JSONL = path.resolve(WORKDIR, 'memory/bitget-perp-cycle-decisions.jsonl');
const TRADES_JSONL = path.resolve(WORKDIR, 'memory/bitget-perp-autotrade-trades.jsonl');
const OHLCV_CACHE = path.resolve(WORKDIR, 'memory/perp-ohlcv-multi-tf.json');
const REPORT_DIR = path.resolve(WORKDIR, 'memory/report');
const DECISIONS_JSON = path.resolve(REPORT_DIR, 'decisions.json');
const ORDERS_JSON = path.resolve(REPORT_DIR, 'orders.json');
const OHLCV_JSON = path.resolve(REPORT_DIR, 'ohlcv.json');

const MAX_DECISIONS = Math.min(1000, Math.max(50, parseInt(process.argv[2], 10) || 200));
const SYMBOL = process.env.PERP_CHART_SYMBOL || 'BTC/USDT:USDT';

const TF_CONFIG = [
  { key: '1m', limit: 480 },
  { key: '5m', limit: 320 },
  { key: '15m', limit: 200 },
  { key: '1h', limit: 300 },
  { key: '4h', limit: 150 },
  { key: '1d', limit: 60 },
];

function readJsonl(p, maxLines) {
  try {
    const s = fs.readFileSync(p, 'utf8');
    const lines = s.split('\n').filter(Boolean);
    const trimmed = lines.slice(-maxLines);
    return trimmed.map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function parseTsMs(v) {
  if (v == null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  let s = String(v).trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  if (s.includes(' ') && /\+\d{2}:\d{2}$/.test(s)) s = s.replace(' ', 'T');
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

function toIso(v) {
  const ms = parseTsMs(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function numeric(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function buildOrdersFromTrades(trades) {
  if (!Array.isArray(trades) || !trades.length) return [];

  const opens = trades.filter((t) => t?.event === 'open');
  const closes = trades.filter((t) => t?.event === 'close');
  const out = [];
  const byOpenOrderId = new Map();

  for (let i = 0; i < opens.length; i++) {
    const o = opens[i] || {};
    const openOrderId = o.orderId != null ? String(o.orderId) : null;
    const cycleId = o?.meta?.cycleId != null ? String(o.meta.cycleId) : null;
    const pair = {
      tradeId: openOrderId || (cycleId ? `cycle:${cycleId}` : `open:${i}`),
      source: 'trades',
      isSynthetic: false,
      cycleId,
      symbol: o.symbol || null,
      side: o.side || null,
      level: o.level || null,
      openOrderId,
      closeOrderId: null,
      amount: numeric(o.amount),
      openTs: toIso(o.tsUtc || o.tsLocal || o.ts),
      closeTs: null,
      openPrice: numeric(o.entryPrice),
      closePrice: null,
      closeReason: null,
      pnlEstUSDT: null,
      durationMin: null,
      status: 'open',
    };
    out.push(pair);
    if (openOrderId) byOpenOrderId.set(openOrderId, pair);
  }

  for (let i = 0; i < closes.length; i++) {
    const c = closes[i] || {};
    const openOrderId = c.openOrderId != null ? String(c.openOrderId) : null;
    let pair = openOrderId ? byOpenOrderId.get(openOrderId) : null;
    if (!pair) {
      pair = out.find((x) => x.status === 'open' && x.symbol === (c.symbol || null) && x.side === (c.side || null)) || null;
    }
    if (!pair) {
      pair = {
        tradeId: `close:${i}`,
        source: 'trades',
        isSynthetic: false,
        cycleId: null,
        symbol: c.symbol || null,
        side: c.side || null,
        level: null,
        openOrderId: openOrderId || null,
        closeOrderId: c.closeOrderId != null ? String(c.closeOrderId) : null,
        amount: numeric(c.amount),
        openTs: null,
        closeTs: toIso(c.tsUtc || c.tsLocal || c.ts),
        openPrice: numeric(c.entryPrice),
        closePrice: numeric(c.closePrice),
        closeReason: c.reason || null,
        pnlEstUSDT: numeric(c.pnlEstUSDT),
        durationMin: null,
        status: 'closed_unmatched',
      };
      out.push(pair);
      continue;
    }

    pair.status = 'closed';
    pair.closeOrderId = c.closeOrderId != null ? String(c.closeOrderId) : pair.closeOrderId;
    pair.closeTs = toIso(c.tsUtc || c.tsLocal || c.ts);
    pair.closePrice = numeric(c.closePrice);
    pair.closeReason = c.reason || pair.closeReason || null;
    pair.pnlEstUSDT = numeric(c.pnlEstUSDT);
    const openMs = parseTsMs(pair.openTs);
    const closeMs = parseTsMs(pair.closeTs);
    if (Number.isFinite(openMs) && Number.isFinite(closeMs) && closeMs >= openMs) {
      pair.durationMin = (closeMs - openMs) / 60000;
    }
  }

  return out
    .sort((a, b) => (parseTsMs(b.openTs || b.closeTs) || 0) - (parseTsMs(a.openTs || a.closeTs) || 0))
    .slice(0, 1000);
}

function buildSyntheticOrdersFromDecisions(decisions) {
  const executed = (Array.isArray(decisions) ? decisions : [])
    .filter((r) => r?.executor?.executed === true && r?.signal?.plan)
    .sort((a, b) => (parseTsMs(a.ts) || 0) - (parseTsMs(b.ts) || 0));
  if (!executed.length) return [];

  const out = [];
  for (let i = 0; i < executed.length; i++) {
    const cur = executed[i];
    const next = executed[i + 1] || null;
    const openTs = toIso(cur.ts);
    const closeTs = next ? toIso(next.ts) : null;
    const openPrice = numeric(cur?.executor?.openPosition?.entryPrice || cur?.executor?.wouldOpenPosition?.entryPrice || null);
    const closePrice = next ? numeric(next?.executor?.openPosition?.entryPrice || next?.executor?.wouldOpenPosition?.entryPrice || null) : null;
    const side = cur?.signal?.plan?.side || null;
    let pnl = null;
    if (openPrice != null && closePrice != null && side) {
      const delta = side === 'long' ? (closePrice - openPrice) : (openPrice - closePrice);
      pnl = delta;
    }
    const openMs = parseTsMs(openTs);
    const closeMs = parseTsMs(closeTs);
    out.push({
      tradeId: `synthetic:${cur?.cycleId || i}`,
      source: 'decisions',
      isSynthetic: true,
      cycleId: cur?.cycleId != null ? String(cur.cycleId) : null,
      symbol: cur?.signal?.plan?.symbol || null,
      side,
      level: cur?.signal?.plan?.level || null,
      openOrderId: null,
      closeOrderId: null,
      amount: null,
      openTs,
      closeTs,
      openPrice,
      closePrice,
      closeReason: next ? 'synthetic_next_executed_signal' : null,
      pnlEstUSDT: pnl,
      durationMin: Number.isFinite(openMs) && Number.isFinite(closeMs) ? (closeMs - openMs) / 60000 : null,
      status: next ? 'closed' : 'open',
    });
  }
  return out
    .sort((a, b) => (parseTsMs(b.openTs || b.closeTs) || 0) - (parseTsMs(a.openTs || a.closeTs) || 0))
    .slice(0, 1000);
}

async function fetchOHLCVMulti() {
  const ex = new ccxt.bitget({ enableRateLimit: true });
  const result = {};
  for (const { key, limit } of TF_CONFIG) {
    try {
      const raw = await ex.fetchOHLCV(SYMBOL, key, undefined, limit);
      result[key] = raw.map((c) => ({
        time: Math.floor(c[0] / 1000),
        open: Number(c[1]),
        high: Number(c[2]),
        low: Number(c[3]),
        close: Number(c[4]),
      }));
    } catch (e) {
      console.error('Fetch', key, 'failed:', e.message);
      result[key] = [];
    }
  }
  fs.mkdirSync(path.dirname(OHLCV_CACHE), { recursive: true });
  fs.writeFileSync(OHLCV_CACHE, JSON.stringify({ symbol: SYMBOL, data: result, fetchedAt: new Date().toISOString() }), 'utf8');
  return result;
}

function loadOHLCVFromCache() {
  try {
    const cached = JSON.parse(fs.readFileSync(OHLCV_CACHE, 'utf8'));
    if (cached.data && Object.keys(cached.data).length) return cached.data;
  } catch {}
  return null;
}

async function main() {
  fs.mkdirSync(REPORT_DIR, { recursive: true });

  const records = readJsonl(DECISIONS_JSONL, MAX_DECISIONS);
  fs.writeFileSync(DECISIONS_JSON, JSON.stringify(records), 'utf8');
  console.log('Wrote report/decisions.json:', records.length, 'records');

  const tradeRecords = readJsonl(TRADES_JSONL, 10000);
  const realOrders = buildOrdersFromTrades(tradeRecords);
  const orders = realOrders.length ? realOrders : buildSyntheticOrdersFromDecisions(records);
  fs.writeFileSync(ORDERS_JSON, JSON.stringify({
    generatedAt: new Date().toISOString(),
    source: realOrders.length ? 'trades_jsonl' : 'synthetic_from_decisions',
    orders,
  }), 'utf8');
  console.log('Wrote report/orders.json:', orders.length, 'orders', realOrders.length ? '(real)' : '(synthetic)');

  let ohlcvByTf = loadOHLCVFromCache();
  if (!ohlcvByTf) {
    console.log('Fetching OHLCV...');
    ohlcvByTf = await fetchOHLCVMulti();
    Object.entries(ohlcvByTf).forEach(([k, v]) => console.log('  ', k, v.length, 'bars'));
  }
  const payload = { symbol: SYMBOL, data: ohlcvByTf, fetchedAt: new Date().toISOString() };
  fs.writeFileSync(OHLCV_JSON, JSON.stringify(payload), 'utf8');
  console.log('Wrote report/ohlcv.json');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
