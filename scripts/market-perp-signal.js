#!/usr/bin/env node
/**
 * Perp short-term signal generator (BTC only).
 *
 * v2 (2026-02): Move from coarse 24h spot ticker → minute-level perp structure:
 * - 15m: EMA50/EMA200 trend filter
 * - 5m: pullback-to-EMA zone (EMA20/EMA50) + volatility guard (ATR)
 * - 1m: momentum confirmation
 *
 * Data source: CCXT Bitget swap OHLCV (public).
 *
 * Output:
 * {
 *   ok:true,
 *   nowMs,
 *   fng, fngOk,
 *   alerts:[{ key:"BTC", symbol:"BTCUSDT", side:"long"|"short", level:"strong"|"very-strong", reason, metrics }]
 * }
 */

import ccxt from 'ccxt';
import fs from 'node:fs';
import path from 'node:path';

const FNG_URL = 'https://api.alternative.me/fng/?limit=1&format=json';

function loadStrategyConfig() {
  const WORKDIR = process.env.OPENCLAW_WORKDIR || process.cwd();
  const p = process.env.PERP_STRATEGY_PATH
    ? path.resolve(WORKDIR, process.env.PERP_STRATEGY_PATH)
    : path.resolve(WORKDIR, 'memory/perp-strategy.json');
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const j = JSON.parse(raw);
    return { ok: true, path: p, cfg: j };
  } catch (e) {
    return { ok: false, path: p, error: String(e?.message || e), cfg: null };
  }
}

function pickNum(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function pickBool(v, fallback) {
  return typeof v === 'boolean' ? v : fallback;
}

function pickAllowSides(v) {
  if (!Array.isArray(v)) return { long: true, short: true };
  const s = new Set(v.map(String));
  return { long: s.has('long'), short: s.has('short') };
}

function safeNumber(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

async function fetchJson(url, timeoutMs = 12000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: { 'user-agent': 'openclaw-perp-signal/2.0', accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function ema(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
  }
  return e;
}

function atr(ohlcv, period = 14) {
  // ohlcv: [ts, open, high, low, close, vol]
  if (!Array.isArray(ohlcv) || ohlcv.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < ohlcv.length; i++) {
    const prevClose = Number(ohlcv[i - 1][4]);
    const high = Number(ohlcv[i][2]);
    const low = Number(ohlcv[i][3]);
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trs.push(tr);
  }
  // Wilder smoothing
  let a = trs.slice(0, period).reduce((x, y) => x + y, 0) / period;
  for (let i = period; i < trs.length; i++) {
    a = (a * (period - 1) + trs[i]) / period;
  }
  return a;
}

function rsi(values, period = 14) {
  if (!Array.isArray(values) || values.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gains += d;
    else losses += -d;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    const gain = d > 0 ? d : 0;
    const loss = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function pctDiff(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
  return Math.abs(a - b) / Math.abs(b) * 100;
}

function vwapFromOhlcv(ohlcv) {
  // Volume-weighted average price over the provided window.
  // Uses typical price (H+L+C)/3 and the OHLCV volume.
  if (!Array.isArray(ohlcv) || ohlcv.length < 10) return null;
  let pv = 0;
  let v = 0;
  for (const x of ohlcv) {
    const high = Number(x[2]);
    const low = Number(x[3]);
    const close = Number(x[4]);
    const vol = Number(x[5]);
    if (![high, low, close, vol].every(Number.isFinite)) continue;
    if (!(vol > 0)) continue;
    const tp = (high + low + close) / 3;
    pv += tp * vol;
    v += vol;
  }
  if (!(v > 0)) return null;
  return pv / v;
}

async function makeExchange() {
  const ex = new ccxt.bitget({
    enableRateLimit: true,
    options: { defaultType: 'swap' },
  });
  return ex;
}

async function main() {
  const nowMs = Date.now();

  // FNG (optional context only)
  let fng = null;
  let fngOk = false;
  try {
    const j = await fetchJson(FNG_URL);
    const v = safeNumber(j?.data?.[0]?.value);
    if (v != null) { fng = v; fngOk = true; }
  } catch {}

  const strat = loadStrategyConfig();
  const cfg = strat.ok ? strat.cfg : {};

  const symbol = typeof cfg?.symbol === 'string' ? cfg.symbol : 'BTC/USDT:USDT';
  const allow = pickAllowSides(cfg?.allowSides);

  const NEAR_EMA20_PCT = pickNum(cfg?.thresholds?.nearEma20Pct, 0.28);
  const NEAR_EMA50_PCT = pickNum(cfg?.thresholds?.nearEma50Pct, 0.38);

  const COST_PCT = pickNum(cfg?.thresholds?.costPct, 0.08);
  const MIN_ATR_PCT = pickNum(cfg?.thresholds?.minAtrPct, Math.max(0.12, COST_PCT * 2.5));
  const MAX_ATR_PCT = pickNum(cfg?.thresholds?.maxAtrPct, 0.70);

  const requireTwoMinMomentum = pickBool(cfg?.filters?.requireTwoMinMomentum, true);
  const requireVwapConfirm = pickBool(cfg?.filters?.requireVwapConfirm, true);
  const blockIfVolOutsideAtrRange = pickBool(cfg?.filters?.blockIfVolOutsideAtrRange, true);

  const VERY_D50_MAX = pickNum(cfg?.thresholds?.veryStrong?.d50Max, 0.22);
  const VERY_LONG_RSI5_MAX = pickNum(cfg?.thresholds?.veryStrong?.longRsi5Max, 45);
  const VERY_SHORT_RSI5_MIN = pickNum(cfg?.thresholds?.veryStrong?.shortRsi5Min, 55);


  const ex = await makeExchange();
  await ex.loadMarkets();

  // Pull OHLCV
  const o15 = await ex.fetchOHLCV(symbol, '15m', undefined, 220);
  const o5 = await ex.fetchOHLCV(symbol, '5m', undefined, 120);
  const o1 = await ex.fetchOHLCV(symbol, '1m', undefined, 60);

  const c15 = o15.map(x => Number(x[4])).filter(Number.isFinite);
  const c5 = o5.map(x => Number(x[4])).filter(Number.isFinite);
  const c1 = o1.map(x => Number(x[4])).filter(Number.isFinite);

  const last5 = c5.at(-1);
  const last1 = c1.at(-1);

  const ema50_15 = ema(c15, 50);
  const ema200_15 = ema(c15, 200);

  const ema20_5 = ema(c5, 20);
  const ema50_5 = ema(c5, 50);

  const atr14_5 = atr(o5, 14);
  const rsi14_5 = rsi(c5, 14);
  const rsi14_1 = rsi(c1, 14);
  const vwap1m = vwapFromOhlcv(o1);

  const alerts = [];

  // Basic sanity
  if (![last5, last1, ema50_15, ema200_15, ema20_5, ema50_5].every(Number.isFinite)) {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: 'indicator_unavailable',
      nowMs,
      metrics: { last5, last1, ema50_15, ema200_15, ema20_5, ema50_5 },
    }, null, 2));
    return;
  }

  // Trend filter (15m)
  const trend = ema50_15 > ema200_15 ? 'up' : (ema50_15 < ema200_15 ? 'down' : 'flat');

  // Pullback zone (5m): distance to EMA20/EMA50
  const d20 = pctDiff(last5, ema20_5);
  const d50 = pctDiff(last5, ema50_5);

  // Volatility guard: ATR as % of price (avoid too wild / too dead)
  const atrPct = (Number.isFinite(atr14_5) && last5 > 0) ? (atr14_5 / last5 * 100) : null;

  // Volatility guard (ATR%): avoid regimes that are too dead (cost-dominated) or too wild.
  // COST_PCT / MIN_ATR_PCT / MAX_ATR_PCT are strategy-configurable.
  const volOk = (atrPct == null)
    ? true
    : (atrPct >= MIN_ATR_PCT && atrPct <= MAX_ATR_PCT);

  // 1m confirmation: short-term momentum aligned
  const prev1 = c1.at(-2);
  const prev2_1 = c1.at(-3);
  const oneMinUp = Number.isFinite(prev1) ? (last1 > prev1) : false;
  const oneMinDown = Number.isFinite(prev1) ? (last1 < prev1) : false;

  // stronger 1m confirmation: 2 consecutive moves
  const twoMinUp = (Number.isFinite(prev1) && Number.isFinite(prev2_1)) ? (last1 > prev1 && prev1 > prev2_1) : false;
  const twoMinDown = (Number.isFinite(prev1) && Number.isFinite(prev2_1)) ? (last1 < prev1 && prev1 < prev2_1) : false;

  // 1m RSI slope (simple)
  const rsi14_1_prev = rsi(c1.slice(0, -1), 14);
  const rsi1Rising = Number.isFinite(rsi14_1) && Number.isFinite(rsi14_1_prev) ? (rsi14_1 > rsi14_1_prev) : null;
  const rsi1Falling = Number.isFinite(rsi14_1) && Number.isFinite(rsi14_1_prev) ? (rsi14_1 < rsi14_1_prev) : null;

  // 5m RSI slope (simple)
  const rsi14_5_prev = rsi(c5.slice(0, -1), 14);
  const rsi5Rising = Number.isFinite(rsi14_5) && Number.isFinite(rsi14_5_prev) ? (rsi14_5 > rsi14_5_prev) : null;
  const rsi5Falling = Number.isFinite(rsi14_5) && Number.isFinite(rsi14_5_prev) ? (rsi14_5 < rsi14_5_prev) : null;

  // VWAP confirm (1m window): long prefers reclaim above VWAP; short prefers below VWAP
  const vwapOkLong = Number.isFinite(vwap1m) ? last1 >= vwap1m : true;
  const vwapOkShort = Number.isFinite(vwap1m) ? last1 <= vwap1m : true;

  // Thresholds are loaded from memory/perp-strategy.json (see top of main()).

  // Entry quality: strong requires momentum + VWAP direction + RSI slope filters (configurable).

  // Long setup (trend up): pull back near EMA20/50 + confirmation
  if (trend === 'up' && allow.long && (!blockIfVolOutsideAtrRange || volOk)) {
    const pullbackOk = (d20 != null && d20 <= NEAR_EMA20_PCT) || (d50 != null && d50 <= NEAR_EMA50_PCT);

    const momentumOk = requireTwoMinMomentum ? twoMinUp : oneMinUp;
    const vwapOk = requireVwapConfirm ? vwapOkLong : true;
    const confirmOk = momentumOk && vwapOk && (rsi1Rising !== false) && (rsi5Rising !== false);

    if (pullbackOk && confirmOk) {
      const very = (d50 != null && d50 <= VERY_D50_MAX)
        && (rsi5Rising !== false)
        && (Number.isFinite(rsi14_5) ? rsi14_5 <= VERY_LONG_RSI5_MAX : true);
      alerts.push({
        key: 'BTC',
        symbol: 'BTCUSDT',
        side: 'long',
        level: very ? 'very-strong' : 'strong',
        reason: 'trend15m_up+pullback5m_to_ema+confirm1m_vwap_rsi',
        metrics: {
          last5,
          last1,
          trend,
          ema50_15,
          ema200_15,
          ema20_5,
          ema50_5,
          d20,
          d50,
          atr14_5,
          atrPct,
          costPct: COST_PCT,
          minAtrPct: MIN_ATR_PCT,
          maxAtrPct: MAX_ATR_PCT,
          rsi14_5,
          rsi14_1,
          vwap1m,
          fng,
          oneMinUp,
          twoMinUp,
        },
      });
    }
  }

  // Short setup (trend down): pull back near EMA20/50 + confirmation
  if (trend === 'down' && allow.short && (!blockIfVolOutsideAtrRange || volOk)) {
    const pullbackOk = (d20 != null && d20 <= NEAR_EMA20_PCT) || (d50 != null && d50 <= NEAR_EMA50_PCT);

    const momentumOk = requireTwoMinMomentum ? twoMinDown : oneMinDown;
    const vwapOk = requireVwapConfirm ? vwapOkShort : true;
    const confirmOk = momentumOk && vwapOk && (rsi1Falling !== false) && (rsi5Falling !== false);

    if (pullbackOk && confirmOk) {
      const very = (d50 != null && d50 <= VERY_D50_MAX)
        && (rsi5Falling !== false)
        && (Number.isFinite(rsi14_5) ? rsi14_5 >= VERY_SHORT_RSI5_MIN : true);
      alerts.push({
        key: 'BTC',
        symbol: 'BTCUSDT',
        side: 'short',
        level: very ? 'very-strong' : 'strong',
        reason: 'trend15m_down+pullback5m_to_ema+confirm1m_vwap_rsi',
        metrics: {
          last5,
          last1,
          trend,
          ema50_15,
          ema200_15,
          ema20_5,
          ema50_5,
          d20,
          d50,
          atr14_5,
          atrPct,
          costPct: COST_PCT,
          minAtrPct: MIN_ATR_PCT,
          maxAtrPct: MAX_ATR_PCT,
          rsi14_5,
          rsi14_1,
          vwap1m,
          fng,
          oneMinDown,
          twoMinDown,
        },
      });
    }
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    nowMs,
    fng,
    fngOk,
    strategy: {
      ok: strat.ok,
      path: strat.path,
      error: strat.ok ? undefined : strat.error,
      effective: {
        symbol,
        allowSides: { long: allow.long, short: allow.short },
        thresholds: {
          nearEma20Pct: NEAR_EMA20_PCT,
          nearEma50Pct: NEAR_EMA50_PCT,
          costPct: COST_PCT,
          minAtrPct: MIN_ATR_PCT,
          maxAtrPct: MAX_ATR_PCT,
          veryStrong: {
            d50Max: VERY_D50_MAX,
            longRsi5Max: VERY_LONG_RSI5_MAX,
            shortRsi5Min: VERY_SHORT_RSI5_MIN
          }
        },
        filters: {
          requireTwoMinMomentum,
          requireVwapConfirm,
          blockIfVolOutsideAtrRange
        }
      }
    },
    alerts,
  }, null, 2));
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({ ok: false, error: String(e?.stack || e) }, null, 2));
  process.exit(0);
});
