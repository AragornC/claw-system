#!/usr/bin/env node
/**
 * Bitget USDT perpetual auto-trader via CCXT.
 * - BTC/USDT:USDT only
 * - isolated 2x
 * - market entry
 * - SL/TP: attempt to place conditional reduceOnly orders; if not supported, rely on 1-min guard.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import ccxt from 'ccxt';

const WORKDIR = process.env.OPENCLAW_WORKDIR || process.cwd();
const CONFIG_PATH = path.resolve(WORKDIR, 'memory/bitget-perp-autotrade-config.json');
const STATE_PATH = path.resolve(WORKDIR, 'memory/bitget-perp-autotrade-state.json');
const TRADES_PATH = path.resolve(WORKDIR, 'memory/bitget-perp-autotrade-trades.jsonl');
const CYCLES_PATH = path.resolve(WORKDIR, 'memory/bitget-perp-autotrade-cycles.jsonl');

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}
function appendJsonl(p, obj) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(obj) + '\n');
  } catch {}
}
function todayCN() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
}
function sha1(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex');
}
function stableStringify(x) {
  if (x == null) return 'null';
  if (typeof x !== 'object') return JSON.stringify(x);
  if (Array.isArray(x)) return '[' + x.map(stableStringify).join(',') + ']';
  const keys = Object.keys(x).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(x[k])).join(',') + '}';
}
function pickBool(v, fallback) {
  return typeof v === 'boolean' ? v : fallback;
}
function roundTo(x, step) {
  if (!step) return x;
  return Math.round(x / step) * step;
}

async function makeExchange() {
  const apiKey = process.env.BITGET_API_KEY || '';
  const secret = process.env.BITGET_API_SECRET || '';
  const password = process.env.BITGET_API_PASSPHRASE || '';
  const allowPublicOnly = process.env.ALLOW_PUBLIC_ONLY === '1';
  const hasPrivateCreds = Boolean(apiKey && secret && password);
  if (!hasPrivateCreds && !allowPublicOnly) throw new Error('Missing BITGET env vars');

  const ex = new ccxt.bitget({
    ...(hasPrivateCreds ? { apiKey, secret, password } : {}),
    enableRateLimit: true,
    options: {
      defaultType: 'swap', // USDT perpetual
    },
  });
  return ex;
}

async function ensureSettings(ex, symbol, cfg) {
  // Best-effort; not all ccxt methods exist for all exchanges.
  try { await ex.setMarginMode(cfg.marginMode, symbol); } catch {}
  try { await ex.setLeverage(cfg.leverage, symbol); } catch {}
  try {
    if (cfg.positionMode === 'hedge') await ex.setPositionMode(true, symbol);
    else if (cfg.positionMode === 'oneway') await ex.setPositionMode(false, symbol);
  } catch {}
}

function computeTpSl(entry, side, tpPct, slPct) {
  if (side === 'long') {
    return { tp: entry * (1 + tpPct), sl: entry * (1 - slPct) };
  }
  return { tp: entry * (1 - tpPct), sl: entry * (1 + slPct) };
}

function computeTpSlAtr(entry, side, atr, tpMult, slMult) {
  if (!(Number.isFinite(entry) && Number.isFinite(atr) && atr > 0)) return null;
  if (side === 'long') {
    return { tp: entry + atr * tpMult, sl: entry - atr * slMult };
  }
  return { tp: entry - atr * tpMult, sl: entry + atr * slMult };
}

function atrWilder(ohlcv, period = 14) {
  // ohlcv: [ts, open, high, low, close]
  if (!Array.isArray(ohlcv) || ohlcv.length < period + 2) return null;
  const tr = [];
  for (let i = 1; i < ohlcv.length; i++) {
    const prevClose = Number(ohlcv[i - 1][4]);
    const high = Number(ohlcv[i][2]);
    const low = Number(ohlcv[i][3]);
    const t = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    tr.push(t);
  }
  let a = tr.slice(0, period).reduce((x, y) => x + y, 0) / period;
  for (let i = period; i < tr.length; i++) {
    a = (a * (period - 1) + tr[i]) / period;
  }
  return a;
}

async function main() {
  const input = await new Promise((resolve) => {
    let s = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (s += c));
    process.stdin.on('end', () => resolve(s));
  });

  const payload = input ? JSON.parse(input) : null;

  // Dry-run: do everything except placing real orders.
  const dryRun = pickBool(payload?.dryRun, false) || pickBool(process.env.DRY_RUN === '1', false);
  const forceDryRun = dryRun && process.env.DRY_RUN_FORCE === '1';
  const cfg = readJson(CONFIG_PATH, null);
  const runtimeCfg = cfg || (forceDryRun
    ? {
        enabled: true,
        symbol: 'BTC/USDT:USDT',
        marginMode: 'isolated',
        leverage: 2,
        positionMode: 'hedge',
        maxTradesPerDay: 60,
        minIntervalMinutes: 3,
        order: { type: 'market', notionalUSDT: 8 },
        risk: {
          mode: 'atr',
          atr: { tf: '1h', period: 14 },
          stopAtrMult: 1.8,
          takeProfitAtrMult: 6.0,
          maxHoldMinutes: 14400,
          timeoutMinPnlUSDT: 0.02,
          maxDailyLossUSDT: 2,
          trailing: { enabled: true, activateAtAtr: 1.2, trailAtrMult: 2.2, timeoutTrailPct: 0.0025 },
          reverseSignal: { confirmations: 999 },
          fallback: { stopLossPct: 0.02, takeProfitPct: 0.2, activationProfitPct: 0.01, trailPct: 0.008 },
        },
      }
    : null);
  if (!runtimeCfg?.enabled && !forceDryRun) {
    process.stdout.write(JSON.stringify({ ok: true, skipped: true, reason: 'auto_disabled' }, null, 2));
    return;
  }
  if (forceDryRun && runtimeCfg && runtimeCfg.enabled !== true) runtimeCfg.enabled = true;

  const state = readJson(STATE_PATH, { date: null, tradesToday: 0, dailyRealizedPnlUSDT: 0, lastTradeAtMs: 0, openPosition: null, lastExecuted: null });
  const today = todayCN();
  if (state.date !== today) {
    state.date = today;
    state.tradesToday = 0;
    state.dailyRealizedPnlUSDT = 0;
    state.lastTradeAtMs = 0;
    state.openPosition = null;
  }

  // TradePlan v1 (preferred)
  // {
  //   tradePlanVersion: 1,
  //   cycleId: "...",
  //   plan: { symbol:"BTCUSDT"|"BTC/USDT:USDT", side:"long"|"short", level:"strong"|"very-strong", reason?:string }
  //   news?: { ... } // optional, for logging only
  // }
  let plan = null;
  let cycleId = null;

  if (payload && payload.tradePlanVersion === 1 && payload.plan && typeof payload.plan === 'object') {
    plan = {
      symbol: payload.plan.symbol,
      side: payload.plan.side,
      level: payload.plan.level,
      reason: payload.plan.reason,
    };
    cycleId = payload.cycleId != null ? String(payload.cycleId) : null;
  }

  // Legacy input (back-compat): { alerts, news }
  const alerts = plan ? [] : (Array.isArray(payload?.alerts) ? payload.alerts : []);
  const news = payload?.news && typeof payload.news === 'object' ? payload.news : null;

  // Gate by daily loss
  if (Number(state.dailyRealizedPnlUSDT) <= -Math.abs(runtimeCfg.risk.maxDailyLossUSDT || 0)) {
    appendJsonl(CYCLES_PATH, { ts: new Date().toISOString(), date: state.date, summary: 'daily_loss_cap', dailyRealizedPnlUSDT: state.dailyRealizedPnlUSDT });
    process.stdout.write(JSON.stringify({ ok: true, skipped: true, reason: 'daily_loss_cap', dailyRealizedPnlUSDT: state.dailyRealizedPnlUSDT }, null, 2));
    return;
  }

  // Only 1 position at a time.
  if (state.openPosition) {
    appendJsonl(CYCLES_PATH, { ts: new Date().toISOString(), date: state.date, summary: 'position_open', openPosition: state.openPosition });
    process.stdout.write(JSON.stringify({ ok: true, skipped: true, reason: 'position_open', openPosition: state.openPosition }, null, 2));
    return;
  }

  // If using TradePlan v1, we treat it as a single intent.
  // TradePlan v1 with no plan means: explicitly no actionable signal.
  if (payload?.tradePlanVersion === 1 && payload.plan == null) {
    const cid = payload?.cycleId != null ? String(payload.cycleId) : null;
    appendJsonl(CYCLES_PATH, { ts: new Date().toISOString(), date: state.date, summary: 'no_plan', newsOk: news?.ok === true, cycleId: cid });
    process.stdout.write(JSON.stringify({ ok: true, skipped: true, reason: 'no_plan', cycleId: cid }, null, 2));
    return;
  }

  if (plan == null && !alerts.length) {
    appendJsonl(CYCLES_PATH, { ts: new Date().toISOString(), date: state.date, summary: 'no_alerts', newsOk: news?.ok === true });
    process.stdout.write(JSON.stringify({ ok: true, skipped: true, reason: 'no_alerts' }, null, 2));
    return;
  }

  if (state.tradesToday >= runtimeCfg.maxTradesPerDay) {
    appendJsonl(CYCLES_PATH, { ts: new Date().toISOString(), date: state.date, summary: 'daily_cap', tradesToday: state.tradesToday });
    process.stdout.write(JSON.stringify({ ok: true, skipped: true, reason: 'daily_cap', tradesToday: state.tradesToday }, null, 2));
    return;
  }

  const minGapMs = (runtimeCfg.minIntervalMinutes || 20) * 60 * 1000;
  if (Date.now() - Number(state.lastTradeAtMs || 0) < minGapMs) {
    appendJsonl(CYCLES_PATH, { ts: new Date().toISOString(), date: state.date, summary: 'min_interval' });
    process.stdout.write(JSON.stringify({ ok: true, skipped: true, reason: 'min_interval' }, null, 2));
    return;
  }

  // Build the single action we will execute.
  // - TradePlan v1 provides side/level directly.
  // - Legacy mode: pick first BTC alert.
  let a = null;
  if (plan) {
    a = {
      key: 'BTC',
      side: plan.side,
      level: plan.level,
      reason: plan.reason,
    };
  } else {
    a = alerts.find(x => x?.key === 'BTC');
    if (!a) {
      appendJsonl(CYCLES_PATH, { ts: new Date().toISOString(), date: state.date, summary: 'no_btc_alert' });
      process.stdout.write(JSON.stringify({ ok: true, skipped: true, reason: 'no_btc_alert' }, null, 2));
      return;
    }
  }

  // Validate side
  if (a.side !== 'long' && a.side !== 'short') {
    appendJsonl(CYCLES_PATH, { ts: new Date().toISOString(), date: state.date, summary: 'invalid_side', side: a.side });
    process.stdout.write(JSON.stringify({ ok: true, skipped: true, reason: 'invalid_side', side: a.side }, null, 2));
    return;
  }

  // Idempotency: if the exact same plan (cycleId+side+level) already executed, skip.
  // We intentionally do NOT allow the strategy to force re-execution within the same cycle.
  const idemKey = sha1(stableStringify({ cycleId, side: a.side, level: a.level, symbol: runtimeCfg.symbol }));
  if (cycleId && state.lastExecuted?.cycleId === cycleId && state.lastExecuted?.idemKey === idemKey) {
    appendJsonl(CYCLES_PATH, { ts: new Date().toISOString(), date: state.date, summary: 'idempotent_skip', cycleId, idemKey });
    process.stdout.write(JSON.stringify({ ok: true, skipped: true, reason: 'idempotent_skip', cycleId }, null, 2));
    return;
  }

  // News gating:
  // Prefer upstream decision from TradePlan payload if present.
  const upstreamBlocked = payload?.decision?.blockedByNews === true;
  const upstreamReason = Array.isArray(payload?.decision?.newsReason) ? payload.decision.newsReason : [];

  // Fallback to legacy local calculation when upstream decision absent.
  let blockedByNews = upstreamBlocked;
  let newsReason = upstreamBlocked ? upstreamReason : [];

  if (!upstreamBlocked && news?.ok === true) {
    const allow = news?.allow || {};
    const block = news?.block || {};
    const reasons = news?.reasons || {};
    const blockReasons = news?.blockReasons || {};
    if (a.side === 'long' && block?.BTC === true) {
      blockedByNews = true;
      newsReason = blockReasons?.BTC || [];
    }
    if (a.side === 'short' && allow?.BTC === true) {
      blockedByNews = true;
      newsReason = reasons?.BTC || [];
    }
  }

  if (blockedByNews) {
    appendJsonl(CYCLES_PATH, { ts: new Date().toISOString(), date: state.date, summary: 'blocked_by_news', side: a.side, newsReason, cycleId });
    process.stdout.write(JSON.stringify({ ok: true, skipped: true, reason: 'blocked_by_news', side: a.side, newsReason, cycleId }, null, 2));
    return;
  }

  const symbol = runtimeCfg.symbol;

  // In dry-run we still fetch public price to compute amount and TP/SL.
  if (dryRun) process.env.ALLOW_PUBLIC_ONLY = '1';
  const ex = await makeExchange();
  await ex.loadMarkets();
  const m = ex.market(symbol);

  // If we're only dry-running, avoid any private endpoint calls.
  if (!dryRun) {
    await ensureSettings(ex, symbol, runtimeCfg);
  }

  const ticker = await ex.fetchTicker(symbol);
  const last = Number(ticker?.last);
  if (!Number.isFinite(last) || last <= 0) throw new Error('last_price_unavailable');

  // Compute amount in base currency (BTC) from notional.
  let amount = (runtimeCfg.order.notionalUSDT || 5) / last;
  // Apply precision/limits
  // CCXT may expose precision.amount either as "decimal places" (e.g. 4) or as an actual step (e.g. 0.0001).
  let step = null;
  if (typeof m?.precision?.amount === 'number' && Number.isFinite(m.precision.amount)) {
    step = m.precision.amount >= 1 ? Math.pow(10, -m.precision.amount) : m.precision.amount;
  }
  if (step && step > 0) amount = Math.floor(amount / step) * step;
  if (m?.limits?.amount?.min && amount < m.limits.amount.min) amount = m.limits.amount.min;

  const side = a.side === 'long' ? 'buy' : 'sell';

  // Place market order and set preset TP/SL on the position (Bitget supports preset prices).
  // CCXT Bitget: params.hedged is a MODE FLAG (true=hedge mode, false=one-way), not side.
  // Risk model: percent (legacy) or atr (preferred for v5).
  const riskMode = String(runtimeCfg?.risk?.mode || 'percent');

  let atrVal = null;
  let tpSlRef = null;

  if (riskMode === 'atr') {
    const tf = String(runtimeCfg?.risk?.atr?.tf || '1h');
    const period = Number(runtimeCfg?.risk?.atr?.period || 14);
    const stopMult = Number(runtimeCfg?.risk?.stopAtrMult || 1.8);
    const tpMult = Number(runtimeCfg?.risk?.takeProfitAtrMult || 6.0);

    // Fetch OHLCV to compute ATR (public endpoint). Keep it lightweight.
    const ohlcv = await ex.fetchOHLCV(symbol, tf, undefined, Math.max(50, period + 5));
    atrVal = atrWilder(ohlcv, period);
    if (Number.isFinite(atrVal) && atrVal > 0) {
      tpSlRef = computeTpSlAtr(last, a.side, atrVal, tpMult, stopMult);
    }
  }

  if (!tpSlRef) {
    const tpPct = Number(runtimeCfg?.risk?.fallback?.takeProfitPct ?? runtimeCfg?.risk?.takeProfitPct ?? 0.012);
    const slPct = Number(runtimeCfg?.risk?.fallback?.stopLossPct ?? runtimeCfg?.risk?.stopLossPct ?? 0.006);
    tpSlRef = computeTpSl(last, a.side, tpPct, slPct);
  }

  const params = {
    marginMode: runtimeCfg.marginMode,
    stopLoss: { triggerPrice: tpSlRef.sl },
    takeProfit: { triggerPrice: tpSlRef.tp },
  };
  if (runtimeCfg.positionMode === 'hedge') params.hedged = true;

  let order = null;
  const entryRef = last;
  const tpRef = tpSlRef.tp;
  const slRef = tpSlRef.sl;

  if (!dryRun) {
    order = await ex.createOrder(symbol, 'market', side, amount, undefined, params);
  }

  // Determine entry price best-effort
  const entry = dryRun ? entryRef : Number(order?.average || order?.price || last);
  let tp = tpRef;
  let sl = slRef;
  if (riskMode === 'atr' && Number.isFinite(atrVal) && atrVal > 0) {
    const stopMult = Number(runtimeCfg?.risk?.stopAtrMult || 1.8);
    const tpMult = Number(runtimeCfg?.risk?.takeProfitAtrMult || 6.0);
    const tpsl = computeTpSlAtr(entry, a.side, atrVal, tpMult, stopMult);
    if (tpsl) { tp = tpsl.tp; sl = tpsl.sl; }
  }
  if (!(Number.isFinite(tp) && Number.isFinite(sl))) {
    const tpPct = Number(runtimeCfg?.risk?.fallback?.takeProfitPct ?? runtimeCfg?.risk?.takeProfitPct ?? 0.012);
    const slPct = Number(runtimeCfg?.risk?.fallback?.stopLossPct ?? runtimeCfg?.risk?.stopLossPct ?? 0.006);
    const tpsl = computeTpSl(entry, a.side, tpPct, slPct);
    tp = tpsl.tp;
    sl = tpsl.sl;
  }

  const openPos = {
    symbol,
    side: a.side,
    level: a.level,
    amount,
    entryPrice: entry,
    openedAtMs: Date.now(),
    tpPrice: tp,
    slPrice: sl,
    orderId: dryRun ? null : (order?.id || null),
    tpSlMode: 'exchange-preset',
    trailing: {
      enabled: Boolean(runtimeCfg?.risk?.trailing?.enabled),
      // percent-mode params (fallback)
      activationProfitPct: Number(runtimeCfg?.risk?.fallback?.activationProfitPct ?? runtimeCfg?.risk?.trailing?.activationProfitPct ?? 0),
      trailPct: Number(runtimeCfg?.risk?.fallback?.trailPct ?? runtimeCfg?.risk?.trailing?.trailPct ?? 0),
      // atr-mode params
      activateAtAtr: Number(runtimeCfg?.risk?.trailing?.activateAtAtr ?? 0),
      trailAtrMult: Number(runtimeCfg?.risk?.trailing?.trailAtrMult ?? 0),
      atrAtEntry: Number.isFinite(atrVal) ? atrVal : null,

      bestPrice: entry,
      stopPrice: null,
      active: false,
      mode: riskMode,
    },
    meta: {
      cycleId,
      idemKey,
      reason: a.reason || null,
      dryRun,
      lastPriceRef: last,
      tpRef,
      slRef,
      riskMode,
      atr: Number.isFinite(atrVal) ? atrVal : null,
    }
  };

  const out = {
    ok: true,
    executed: !dryRun,
    dryRun,
    openPosition: dryRun ? null : openPos,
    wouldOpenPosition: dryRun ? openPos : null,
    newsOk: news?.ok === true,
    cycleId,
  };

  appendJsonl(CYCLES_PATH, { ts: new Date().toISOString(), date: state.date, summary: dryRun ? 'dry_run_open' : 'opened', openPosition: openPos, cycleId });

  if (!dryRun) {
    state.openPosition = openPos;
    state.tradesToday += 1;
    state.lastTradeAtMs = Date.now();
    if (cycleId) state.lastExecuted = { cycleId, idemKey, atMs: Date.now() };
    writeJson(STATE_PATH, state);

    const tsUtc = new Date().toISOString();
    const tsLocal = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace(' ', ' ') + '+08:00';
    appendJsonl(TRADES_PATH, { ts: tsLocal, tsUtc, event: 'open', ...openPos });
  }

  process.stdout.write(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({ ok: false, error: String(e?.stack || e) }, null, 2));
  process.exit(0);
});
