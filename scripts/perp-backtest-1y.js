#!/usr/bin/env node
/**
 * 1y backtest for Bitget perp strategy (BTC/USDT swap) using CCXT OHLCV.
 *
 * Variants:
 *  A) exact-ish (uses 1m confirmation window) but recommended for 60-90 days due to volume
 *  B) approximate 1y (uses 5m-only confirmation + 5m VWAP)
 *
 * Entry: single position, market at close.
 * Exits: TP/SL + trailing + timeout + reverse confirmations.
 *
 * NOTE: This is an offline OHLCV backtest; intrabar ordering is approximated.
 */

import ccxt from 'ccxt';
import fs from 'fs';
import path from 'path';

const SYMBOL = process.env.SYMBOL || 'BTC/USDT:USDT';
const VARIANT = (process.env.VARIANT || 'B').toUpperCase(); // A or B

const YEARS = Number(process.env.YEARS || 1);
const DAYS = Number(process.env.DAYS || (VARIANT === 'A' ? 90 : 365 * YEARS));

const NOTIONAL_USDT = Number(process.env.NOTIONAL || 8);

const TP_PCT = Number(process.env.TP || 0.006);
const SL_PCT = Number(process.env.SL || 0.012);
const TRAIL_ACTIVATE_PCT = Number(process.env.TRAIL_ACTIVATE || 0.006);
const TRAIL_PCT = Number(process.env.TRAIL || 0.004);
const TIMEOUT_TRAIL_PCT = Number(process.env.TIMEOUT_TRAIL || 0.0025);
const MAX_HOLD_MIN = Number(process.env.MAX_HOLD_MIN || 45);
const REVERSE_CONFIRM_BARS = Number(process.env.REVERSE_CONFIRM || 2);

const NEAR_EMA20_PCT = Number(process.env.NEAR_EMA20 || 0.28); // percent
const NEAR_EMA50_PCT = Number(process.env.NEAR_EMA50 || 0.38);

const ATR_PCT_MIN = Number(process.env.ATR_PCT_MIN || 0.08);
const ATR_PCT_MAX = Number(process.env.ATR_PCT_MAX || 0.70);

const VWAP_WINDOW_1M = Number(process.env.VWAP1M_WINDOW || 60);
const VWAP_WINDOW_5M = Number(process.env.VWAP5M_WINDOW || 60);

const CACHE_DIR = path.join(process.cwd(), 'tmp', 'backtest-cache');

function ms(tf) {
  const m = { '1m': 60e3, '5m': 5 * 60e3, '15m': 15 * 60e3 };
  return m[tf];
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function emaSeries(values, period) {
  const out = Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let s = 0;
  for (let i = 0; i < period; i++) s += values[i];
  let e = s / period;
  out[period - 1] = e;
  for (let i = period; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}

function atrSeries(ohlcv, period = 14) {
  const out = Array(ohlcv.length).fill(null);
  if (ohlcv.length < period + 1) return out;
  const tr = [];
  for (let i = 1; i < ohlcv.length; i++) {
    const prevClose = Number(ohlcv[i - 1][4]);
    const high = Number(ohlcv[i][2]);
    const low = Number(ohlcv[i][3]);
    const t = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    tr.push(t);
  }
  // Wilder smoothing
  let a = tr.slice(0, period).reduce((x, y) => x + y, 0) / period;
  out[period] = a; // aligns with ohlcv index = period (since tr starts at i=1)
  for (let i = period; i < tr.length; i++) {
    a = (a * (period - 1) + tr[i]) / period;
    out[i + 1] = a;
  }
  return out;
}

function rsiSeries(values, period = 14) {
  const out = Array(values.length).fill(null);
  if (values.length < period + 1) return out;

  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gains += d;
    else losses += -d;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  out[period] = avgLoss === 0 ? 100 : (100 - 100 / (1 + avgGain / avgLoss));

  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    const gain = d > 0 ? d : 0;
    const loss = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : (100 - 100 / (1 + avgGain / avgLoss));
  }
  return out;
}

function pctDiff(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
  return Math.abs(a - b) / Math.abs(b) * 100;
}

function vwapWindow(ohlcv, endIdx, window) {
  const start = Math.max(0, endIdx - window + 1);
  let pv = 0;
  let v = 0;
  for (let i = start; i <= endIdx; i++) {
    const x = ohlcv[i];
    if (!x) continue;
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
  // Use a larger timeout for bulk historical candle fetching.
  return new ccxt.bitget({
    enableRateLimit: true,
    timeout: 30000,
    options: { defaultType: 'swap' },
  });
}

async function fetchAllOHLCV(ex, symbol, timeframe, sinceMs, untilMs, limit = 1000) {
  const out = [];
  let since = sinceMs;
  let guard = 0;
  while (since < untilMs) {
    guard++;
    if (guard > 20000) throw new Error('fetchAllOHLCV guard exceeded');
    const batch = await ex.fetchOHLCV(symbol, timeframe, since, limit);
    if (!Array.isArray(batch) || batch.length === 0) break;
    // de-dupe
    for (const c of batch) {
      if (!c || c.length < 6) continue;
      const ts = Number(c[0]);
      if (!Number.isFinite(ts)) continue;
      if (ts < sinceMs) continue;
      if (ts > untilMs) continue;
      const last = out[out.length - 1];
      if (!last || Number(last[0]) !== ts) out.push(c);
    }
    const lastTs = Number(batch[batch.length - 1][0]);
    if (!Number.isFinite(lastTs)) break;
    const nextSince = lastTs + ms(timeframe);
    if (nextSince <= since) break;
    since = nextSince;
    // polite pacing
    await ex.sleep(ex.rateLimit);
  }
  return out;
}

function cacheKey(symbol, tf, sinceMs, untilMs) {
  const clean = symbol.replace(/[^A-Za-z0-9:_-]/g, '_');
  return `${clean}_${tf}_${sinceMs}_${untilMs}.json`;
}

function loadCache(key) {
  const p = path.join(CACHE_DIR, key);
  if (!fs.existsSync(p)) return null;
  const txt = fs.readFileSync(p, 'utf8');
  const j = JSON.parse(txt);
  return j;
}

function saveCache(key, data) {
  ensureDir(CACHE_DIR);
  const p = path.join(CACHE_DIR, key);
  fs.writeFileSync(p, JSON.stringify(data));
}

function indexByTs(ohlcv) {
  const m = new Map();
  for (let i = 0; i < ohlcv.length; i++) {
    m.set(Number(ohlcv[i][0]), i);
  }
  return m;
}

function buildTimeToLatestIndex(ohlcv) {
  // For any timestamp t, we need the last candle index with ts <= t.
  // We'll just binary search per query.
  const tsArr = ohlcv.map(x => Number(x[0]));
  return (t) => {
    let lo = 0, hi = tsArr.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (tsArr[mid] <= t) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans;
  };
}

function sideSign(side) {
  return side === 'long' ? 1 : -1;
}

function pnlPct(side, entry, price) {
  if (!Number.isFinite(entry) || !Number.isFinite(price) || entry <= 0) return 0;
  const raw = (price - entry) / entry;
  return side === 'long' ? raw : -raw;
}

function computeMaxDrawdown(equitySeries) {
  let peak = -Infinity;
  let maxDD = 0;
  for (const e of equitySeries) {
    if (!Number.isFinite(e)) continue;
    if (e > peak) peak = e;
    const dd = peak > 0 ? (peak - e) / peak : 0;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}

function summarizeEquity(equitySeries) {
  const n = equitySeries.length;
  if (n === 0) return { start: 0, end: 0, min: 0, max: 0 };
  let min = Infinity, max = -Infinity;
  for (const e of equitySeries) {
    min = Math.min(min, e);
    max = Math.max(max, e);
  }
  return { start: equitySeries[0], end: equitySeries[n - 1], min, max };
}

function getSignalAt(i5, ctx) {
  // Returns 'long' | 'short' | null
  const { o5, c5, ema20_5, ema50_5, atr14_5, rsi14_5, rsi14_5_prev,
    // 15m
    i15For5, ema50_15, ema200_15,
    // 1m
    variant, o1, c1, rsi14_1, rsi14_1_prev, i1For5,
  } = ctx;

  const last5 = c5[i5];
  const i15 = i15For5[i5];
  if (!(i15 >= 0)) return null;

  const e50_15 = ema50_15[i15];
  const e200_15 = ema200_15[i15];
  const e20_5 = ema20_5[i5];
  const e50_5 = ema50_5[i5];

  if (![last5, e50_15, e200_15, e20_5, e50_5].every(Number.isFinite)) return null;

  const trend = e50_15 > e200_15 ? 'up' : (e50_15 < e200_15 ? 'down' : 'flat');

  const d20 = pctDiff(last5, e20_5);
  const d50 = pctDiff(last5, e50_5);

  const atr = atr14_5[i5];
  const atrPct = (Number.isFinite(atr) && last5 > 0) ? (atr / last5 * 100) : null;
  const volOk = (atrPct == null) ? true : (atrPct >= ATR_PCT_MIN && atrPct <= ATR_PCT_MAX);
  if (!volOk) return null;

  const pullbackOk = (d20 != null && d20 <= NEAR_EMA20_PCT) || (d50 != null && d50 <= NEAR_EMA50_PCT);
  if (!pullbackOk) return null;

  // RSI slope guards on 5m
  const rsi5 = rsi14_5[i5];
  const rsi5Prev = rsi14_5_prev[i5];
  const rsi5Rising = (Number.isFinite(rsi5) && Number.isFinite(rsi5Prev)) ? (rsi5 > rsi5Prev) : null;
  const rsi5Falling = (Number.isFinite(rsi5) && Number.isFinite(rsi5Prev)) ? (rsi5 < rsi5Prev) : null;

  if (variant === 'B') {
    // Approx confirm on 5m: 2 consecutive closes + vwap direction + RSI slopes.
    if (i5 < 2) return null;
    const cNow = c5[i5];
    const cPrev = c5[i5 - 1];
    const cPrev2 = c5[i5 - 2];
    const twoUp = cNow > cPrev && cPrev > cPrev2;
    const twoDown = cNow < cPrev && cPrev < cPrev2;

    const vwap5 = vwapWindow(o5, i5, VWAP_WINDOW_5M);
    const vwapOkLong = Number.isFinite(vwap5) ? (cNow >= vwap5) : true;
    const vwapOkShort = Number.isFinite(vwap5) ? (cNow <= vwap5) : true;

    if (trend === 'up') {
      const confirmOk = twoUp && vwapOkLong && (rsi5Rising !== false);
      return confirmOk ? 'long' : null;
    }
    if (trend === 'down') {
      const confirmOk = twoDown && vwapOkShort && (rsi5Falling !== false);
      return confirmOk ? 'short' : null;
    }
    return null;
  }

  // Variant A: use 1m confirm aligned to this 5m close.
  const i1 = i1For5[i5];
  if (!(i1 >= 2)) return null;

  const last1 = c1[i1];
  const prev1 = c1[i1 - 1];
  const prev2_1 = c1[i1 - 2];
  const twoMinUp = last1 > prev1 && prev1 > prev2_1;
  const twoMinDown = last1 < prev1 && prev1 < prev2_1;

  const vwap1 = vwapWindow(o1, i1, VWAP_WINDOW_1M);
  const vwapOkLong = Number.isFinite(vwap1) ? last1 >= vwap1 : true;
  const vwapOkShort = Number.isFinite(vwap1) ? last1 <= vwap1 : true;

  const rsi1 = rsi14_1[i1];
  const rsi1Prev = rsi14_1_prev[i1];
  const rsi1Rising = (Number.isFinite(rsi1) && Number.isFinite(rsi1Prev)) ? (rsi1 > rsi1Prev) : null;
  const rsi1Falling = (Number.isFinite(rsi1) && Number.isFinite(rsi1Prev)) ? (rsi1 < rsi1Prev) : null;

  if (trend === 'up') {
    const confirmOk = twoMinUp && vwapOkLong && (rsi1Rising !== false) && (rsi5Rising !== false);
    return confirmOk ? 'long' : null;
  }
  if (trend === 'down') {
    const confirmOk = twoMinDown && vwapOkShort && (rsi1Falling !== false) && (rsi5Falling !== false);
    return confirmOk ? 'short' : null;
  }
  return null;
}

async function main() {
  if (!['A', 'B'].includes(VARIANT)) throw new Error('VARIANT must be A or B');

  const ex = await makeExchange();
  await ex.loadMarkets();

  const now = Date.now();
  const sinceMs = now - DAYS * 24 * 60 * 60e3;
  const untilMs = now;

  // We need enough warmup for EMAs and ATR.
  const warmup15 = 220 * ms('15m');
  const warmup5 = 200 * ms('5m');
  const warmup1 = 200 * ms('1m');

  const since15 = sinceMs - warmup15;
  const since5 = sinceMs - warmup5;
  const since1 = sinceMs - warmup1;

  async function getOHLCV(tf, since, until) {
    const key = cacheKey(SYMBOL, tf, since, until);
    const cached = loadCache(key);
    if (cached) return cached;
    const data = await fetchAllOHLCV(ex, SYMBOL, tf, since, until);
    saveCache(key, data);
    return data;
  }

  const o15 = await getOHLCV('15m', since15, untilMs);
  const o5 = await getOHLCV('5m', since5, untilMs);
  let o1 = null;
  if (VARIANT === 'A') {
    o1 = await getOHLCV('1m', since1, untilMs);
  }

  const c15 = o15.map(x => Number(x[4]));
  const c5 = o5.map(x => Number(x[4]));

  const ema50_15 = emaSeries(c15, 50);
  const ema200_15 = emaSeries(c15, 200);

  const ema20_5 = emaSeries(c5, 20);
  const ema50_5 = emaSeries(c5, 50);
  const atr14_5 = atrSeries(o5, 14);
  const rsi14_5 = rsiSeries(c5, 14);
  const rsi14_5_prev = rsi14_5.map((v, i) => i > 0 ? rsi14_5[i - 1] : null);

  let c1 = null;
  let rsi14_1 = null;
  let rsi14_1_prev = null;
  if (VARIANT === 'A') {
    c1 = o1.map(x => Number(x[4]));
    rsi14_1 = rsiSeries(c1, 14);
    rsi14_1_prev = rsi14_1.map((v, i) => i > 0 ? rsi14_1[i - 1] : null);
  }

  // Map each 5m candle to latest 15m candle index and latest 1m candle index
  const latest15Idx = buildTimeToLatestIndex(o15);
  const latest1Idx = VARIANT === 'A' ? buildTimeToLatestIndex(o1) : null;
  const i15For5 = [];
  const i1For5 = [];
  for (let i = 0; i < o5.length; i++) {
    const t = Number(o5[i][0]);
    i15For5.push(latest15Idx(t));
    if (VARIANT === 'A') i1For5.push(latest1Idx(t));
  }

  const ctx = {
    variant: VARIANT,
    o5, c5, ema20_5, ema50_5, atr14_5, rsi14_5, rsi14_5_prev,
    i15For5, ema50_15, ema200_15,
    o1, c1, rsi14_1, rsi14_1_prev, i1For5,
  };

  // Find start index in 5m corresponding to sinceMs
  const startI5 = (() => {
    for (let i = 0; i < o5.length; i++) {
      if (Number(o5[i][0]) >= sinceMs) return i;
    }
    return 0;
  })();

  let equity = 0;
  const equitySeries = [];

  let pos = null; // { side, entryPrice, entryTs, qty, bestPrice, trailActive, trailStop, trailPct, reverseCount, reverseSide }
  const trades = [];

  function openPosition(side, price, ts) {
    const qty = NOTIONAL_USDT / price; // linear USDT-margined contract approximation
    pos = {
      side,
      entryPrice: price,
      entryTs: ts,
      qty,
      bestPrice: price,
      trailActive: false,
      trailStop: null,
      trailPct: TRAIL_PCT,
      reverseCount: 0,
      reverseSide: null,
    };
  }

  function closePosition(price, ts, reason) {
    const dir = sideSign(pos.side);
    const pnl = (price - pos.entryPrice) * pos.qty * dir;
    equity += pnl;
    trades.push({
      side: pos.side,
      entryTs: pos.entryTs,
      exitTs: ts,
      entry: pos.entryPrice,
      exit: price,
      pnl,
      pnlPct: pnl / NOTIONAL_USDT,
      reason,
      holdMin: (ts - pos.entryTs) / 60000,
    });
    pos = null;
  }

  function updateTrailingWithBar(high, low, close, ts, tfMs) {
    if (!pos) return;
    const side = pos.side;

    // Update best price (favorable extreme) using bar high/low.
    if (side === 'long') pos.bestPrice = Math.max(pos.bestPrice, high);
    else pos.bestPrice = Math.min(pos.bestPrice, low);

    const favMove = pnlPct(side, pos.entryPrice, pos.bestPrice);

    if (!pos.trailActive && favMove >= TRAIL_ACTIVATE_PCT) {
      pos.trailActive = true;
      pos.trailPct = TRAIL_PCT;
    }

    if (pos.trailActive) {
      const trailPct = pos.trailPct;
      pos.trailStop = side === 'long'
        ? pos.bestPrice * (1 - trailPct)
        : pos.bestPrice * (1 + trailPct);

      // Check stop hit intrabar. Approx: for long, if low <= trailStop; for short, if high >= trailStop.
      const hit = side === 'long' ? (low <= pos.trailStop) : (high >= pos.trailStop);
      if (hit) {
        // Approx fill at trailStop
        closePosition(pos.trailStop, ts, 'trailing_stop');
      }
    }

    // Timeout logic at/after MAX_HOLD_MIN.
    if (!pos) return;
    const holdMin = (ts - pos.entryTs) / 60000;
    if (holdMin >= MAX_HOLD_MIN) {
      const pNow = pnlPct(side, pos.entryPrice, close);
      if (pNow > 0) {
        // tighten trailing
        pos.trailActive = true;
        pos.trailPct = Math.min(pos.trailPct, TIMEOUT_TRAIL_PCT);
        // update stop based on tightened pct
        pos.trailStop = side === 'long'
          ? pos.bestPrice * (1 - pos.trailPct)
          : pos.bestPrice * (1 + pos.trailPct);
      } else {
        closePosition(close, ts, 'timeout_close');
      }
    }
  }

  for (let i5 = startI5; i5 < o5.length; i5++) {
    const [ts, open, high, low, close] = o5[i5];
    const t = Number(ts);
    const o = Number(open);
    const h = Number(high);
    const l = Number(low);
    const c = Number(close);
    if (![t, o, h, l, c].every(Number.isFinite)) continue;

    // Update equity series with mark-to-market (using close)
    if (pos) {
      const dir = sideSign(pos.side);
      const mtm = (c - pos.entryPrice) * pos.qty * dir;
      equitySeries.push(equity + mtm);
    } else {
      equitySeries.push(equity);
    }

    // If in position, check TP/SL intrabar first (approx worst-case ordering).
    if (pos) {
      const side = pos.side;
      const entry = pos.entryPrice;
      const tp = side === 'long' ? entry * (1 + TP_PCT) : entry * (1 - TP_PCT);
      const sl = side === 'long' ? entry * (1 - SL_PCT) : entry * (1 + SL_PCT);

      const hitTP = side === 'long' ? (h >= tp) : (l <= tp);
      const hitSL = side === 'long' ? (l <= sl) : (h >= sl);

      if (hitTP && hitSL) {
        // ambiguous; assume SL first (conservative)
        closePosition(sl, t, 'sl_and_tp_same_bar_assume_sl');
      } else if (hitSL) {
        closePosition(sl, t, 'stop_loss');
      } else if (hitTP) {
        closePosition(tp, t, 'take_profit');
      }
    }

    // If still in position, update trailing/timeout.
    if (pos) {
      updateTrailingWithBar(h, l, c, t, ms('5m'));
    }

    // Signal evaluation at close.
    const sig = getSignalAt(i5, ctx);

    if (!pos) {
      if (sig) {
        openPosition(sig, c, t);
      }
      continue;
    }

    // Reverse logic: need REVERSE_CONFIRM_BARS consecutive opposite signals.
    if (sig && sig !== pos.side) {
      if (pos.reverseSide === sig) pos.reverseCount += 1;
      else { pos.reverseSide = sig; pos.reverseCount = 1; }

      if (pos.reverseCount >= REVERSE_CONFIRM_BARS) {
        const oldSide = pos.side;
        closePosition(c, t, `reverse_${oldSide}_to_${sig}`);
        openPosition(sig, c, t);
      }
    } else {
      pos.reverseSide = null;
      pos.reverseCount = 0;
    }
  }

  // Close open position at end
  if (pos) {
    const last = o5[o5.length - 1];
    closePosition(Number(last[4]), Number(last[0]), 'eod_close');
  }

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const totalPnl = trades.reduce((a, b) => a + b.pnl, 0);
  const avgPnl = trades.length ? totalPnl / trades.length : 0;
  const winrate = trades.length ? wins.length / trades.length : 0;

  // Expectancy as average pnl per trade in USDT.
  const expectancy = avgPnl;

  const maxDD = computeMaxDrawdown(equitySeries);
  const eqSum = summarizeEquity(equitySeries);

  const report = {
    ok: true,
    variant: VARIANT,
    symbol: SYMBOL,
    days: DAYS,
    params: {
      notionalUsdt: NOTIONAL_USDT,
      tpPct: TP_PCT,
      slPct: SL_PCT,
      trailActivatePct: TRAIL_ACTIVATE_PCT,
      trailPct: TRAIL_PCT,
      timeoutTrailPct: TIMEOUT_TRAIL_PCT,
      maxHoldMin: MAX_HOLD_MIN,
      reverseConfirmBars: REVERSE_CONFIRM_BARS,
      nearEma20Pct: NEAR_EMA20_PCT,
      nearEma50Pct: NEAR_EMA50_PCT,
      atrPctMin: ATR_PCT_MIN,
      atrPctMax: ATR_PCT_MAX,
    },
    metrics: {
      trades: trades.length,
      winrate,
      expectancyUsdt: expectancy,
      totalPnlUsdt: totalPnl,
      avgWinUsdt: wins.length ? wins.reduce((a, b) => a + b.pnl, 0) / wins.length : 0,
      avgLossUsdt: losses.length ? losses.reduce((a, b) => a + b.pnl, 0) / losses.length : 0,
      maxDrawdownPct: maxDD,
      equity: eqSum,
      startTs: o5[startI5]?.[0],
      endTs: o5.at(-1)?.[0],
    },
    sampleTrades: trades.slice(0, 5),
    lastTrades: trades.slice(-5),
  };

  // Save full artifacts
  ensureDir(path.join(process.cwd(), 'tmp'));
  fs.writeFileSync(path.join(process.cwd(), 'tmp', `perp-backtest-${VARIANT}-${DAYS}d.json`), JSON.stringify({ report, trades, equitySeries }, null, 2));

  process.stdout.write(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({ ok: false, error: String(e?.stack || e) }, null, 2));
  process.exit(0);
});
