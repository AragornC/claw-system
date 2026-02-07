#!/usr/bin/env node
/**
 * perp-backtest-v2.js
 * Backtest for 三维动量金字塔 v2 (1D bias + 4H setup + 1H entry) on BTC/USDT:USDT perp.
 *
 * Notes / limitations:
 * - OHLCV-only backtest.
 * - Entry assumed at 1H candle close.
 * - Exit triggers (TP/SL/trailing/timeout) are approximated with intrabar high/low.
 * - No fees/slippage modeled (can be added later).
 */

import ccxt from 'ccxt';
import fs from 'node:fs';
import path from 'node:path';

const SYMBOL = process.env.SYMBOL || 'BTC/USDT:USDT';
const DAYS = Number(process.env.DAYS || 180);

const NOTIONAL_USDT = Number(process.env.NOTIONAL || 8);
const TP_PCT = Number(process.env.TP || 0.012);
const SL_PCT = Number(process.env.SL || 0.006);

const TRAIL_ACTIVATE_PCT = Number(process.env.TRAIL_ACTIVATE || 0.006);
const TRAIL_PCT = Number(process.env.TRAIL || 0.004);

const MAX_HOLD_MIN = Number(process.env.MAX_HOLD_MIN || 45);

// v2 params (defaults align with memory/perp-strategy-v2.json)
const EMA_FAST = Number(process.env.EMA_FAST || 50);
const EMA_MID = Number(process.env.EMA_MID || 100);
const EMA_SLOW = Number(process.env.EMA_SLOW || 200);
const ADX_PERIOD = Number(process.env.ADX_PERIOD || 14);
const ADX_MIN = Number(process.env.ADX_MIN || 25);

const MACD_FAST = Number(process.env.MACD_FAST || 12);
const MACD_SLOW = Number(process.env.MACD_SLOW || 26);
const MACD_SIGNAL = Number(process.env.MACD_SIGNAL || 9);

const RSI_PERIOD = Number(process.env.RSI_PERIOD || 14);
const RSI_LONG_MIN = Number(process.env.RSI_LONG_MIN || 50);
const RSI_SHORT_MAX = Number(process.env.RSI_SHORT_MAX || 50);

const VOL_LOOKBACK = Number(process.env.VOL_LOOKBACK || 20);
const VOL_MULT = Number(process.env.VOL_MULT || 1.8);

const BOLL_PERIOD = Number(process.env.BOLL_PERIOD || 20);
const BOLL_MULT = Number(process.env.BOLL_MULT || 2);

const STOCH_K = Number(process.env.STOCH_K || 14);
const STOCH_D = Number(process.env.STOCH_D || 3);
const STOCH_SMOOTH = Number(process.env.STOCH_SMOOTH || 3);

const STOCH_OS = Number(process.env.STOCH_OS || 20);
const STOCH_OB = Number(process.env.STOCH_OB || 80);

const ENTRY_REQUIRE_PREV_INSIDE = (process.env.ENTRY_REQUIRE_PREV_INSIDE ?? '1') !== '0';
const REQUIRE_VOL_BREAK = (process.env.REQUIRE_VOL_BREAK ?? '1') !== '0';
const REQUIRE_STOCH = (process.env.REQUIRE_STOCH ?? '1') !== '0';

const CACHE_DIR = path.join(process.cwd(), 'tmp', 'backtest-cache');

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
function ms(tf) {
  const m = { '1h': 60 * 60e3, '4h': 4 * 60 * 60e3, '1d': 24 * 60 * 60e3 };
  return m[tf];
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

function rsiSeries(values, period = 14) {
  const out = Array(values.length).fill(null);
  if (values.length < period + 1) return out;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gains += d; else losses += -d;
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

function smaAt(values, endIdx, period) {
  if (endIdx + 1 < period) return null;
  let s = 0;
  for (let i = endIdx - period + 1; i <= endIdx; i++) s += values[i];
  return s / period;
}

function stdAt(values, endIdx, period) {
  const m = smaAt(values, endIdx, period);
  if (m == null) return null;
  let v = 0;
  for (let i = endIdx - period + 1; i <= endIdx; i++) {
    const d = values[i] - m;
    v += d * d;
  }
  return Math.sqrt(v / period);
}

function bollAt(values, endIdx, period = 20, mult = 2) {
  const mid = smaAt(values, endIdx, period);
  const sd = stdAt(values, endIdx, period);
  if (mid == null || sd == null) return null;
  return { mid, upper: mid + mult * sd, lower: mid - mult * sd };
}

function macdSeries(values, fast = 12, slow = 26, signal = 9) {
  const eFast = emaSeries(values, fast);
  const eSlow = emaSeries(values, slow);
  const line = values.map((_, i) => (eFast[i] != null && eSlow[i] != null) ? (eFast[i] - eSlow[i]) : null);
  // signal EMA on line with zeros for nulls (approx)
  const sig = emaSeries(line.map((x) => (x == null ? 0 : x)), signal);
  const hist = line.map((x, i) => (x != null && sig[i] != null) ? (x - sig[i]) : null);
  return { line, sig, hist };
}

function adxLast(ohlcv, period = 14) {
  if (!Array.isArray(ohlcv) || ohlcv.length < period + 2) return null;
  const highs = ohlcv.map(x => Number(x[2]));
  const lows = ohlcv.map(x => Number(x[3]));
  const closes = ohlcv.map(x => Number(x[4]));
  const len = ohlcv.length;

  const tr = Array(len).fill(0);
  const plusDM = Array(len).fill(0);
  const minusDM = Array(len).fill(0);

  for (let i = 1; i < len; i++) {
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];
    plusDM[i] = (upMove > downMove && upMove > 0) ? upMove : 0;
    minusDM[i] = (downMove > upMove && downMove > 0) ? downMove : 0;
    tr[i] = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
  }

  let trN = 0, pN = 0, mN = 0;
  for (let i = 1; i <= period; i++) {
    trN += tr[i];
    pN += plusDM[i];
    mN += minusDM[i];
  }

  let adx = null;
  for (let i = period + 1; i < len; i++) {
    trN = trN - (trN / period) + tr[i];
    pN = pN - (pN / period) + plusDM[i];
    mN = mN - (mN / period) + minusDM[i];
    if (!(trN > 0)) continue;
    const pDI = 100 * (pN / trN);
    const mDI = 100 * (mN / trN);
    const dx = (pDI + mDI === 0) ? 0 : (100 * Math.abs(pDI - mDI) / (pDI + mDI));
    if (adx == null) adx = dx;
    else adx = ((adx * (period - 1)) + dx) / period;
  }
  return adx;
}

function stochKDAt(ohlcv, endIdx, kPeriod = 14, dPeriod = 3, smooth = 3) {
  if (endIdx + 1 < kPeriod + smooth + dPeriod) return null;
  const highs = ohlcv.map(x => Number(x[2]));
  const lows = ohlcv.map(x => Number(x[3]));
  const closes = ohlcv.map(x => Number(x[4]));

  // raw %K series up to endIdx
  const rawK = [];
  for (let i = kPeriod - 1; i <= endIdx; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      hh = Math.max(hh, highs[j]);
      ll = Math.min(ll, lows[j]);
    }
    const c = closes[i];
    const k = (hh === ll) ? 50 : (100 * (c - ll) / (hh - ll));
    rawK.push(k);
  }

  // smooth %K
  const smK = [];
  for (let i = smooth - 1; i < rawK.length; i++) {
    const w = rawK.slice(i - smooth + 1, i + 1);
    smK.push(w.reduce((a, b) => a + b, 0) / smooth);
  }
  if (smK.length < dPeriod) return null;
  const kNow = smK.at(-1);
  const dNow = smK.slice(-dPeriod).reduce((a, b) => a + b, 0) / dPeriod;
  return { k: kNow, d: dNow };
}

function cacheKey(symbol, tf, sinceMs, untilMs) {
  const clean = symbol.replace(/[^A-Za-z0-9:_-]/g, '_');
  return `${clean}_${tf}_${sinceMs}_${untilMs}.json`;
}

function loadCache(key) {
  const p = path.join(CACHE_DIR, key);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function saveCache(key, data) {
  ensureDir(CACHE_DIR);
  fs.writeFileSync(path.join(CACHE_DIR, key), JSON.stringify(data));
}

async function makeExchange() {
  return new ccxt.bitget({ enableRateLimit: true, timeout: 30000, options: { defaultType: 'swap' } });
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
    for (const c of batch) {
      const ts = Number(c?.[0]);
      if (!Number.isFinite(ts)) continue;
      if (ts < sinceMs || ts > untilMs) continue;
      const last = out[out.length - 1];
      if (!last || Number(last[0]) !== ts) out.push(c);
    }
    const lastTs = Number(batch[batch.length - 1]?.[0]);
    if (!Number.isFinite(lastTs)) break;
    const nextSince = lastTs + ms(timeframe);
    if (nextSince <= since) break;
    since = nextSince;
    await ex.sleep(ex.rateLimit);
  }
  return out;
}

function buildTimeToLatestIndex(ohlcv) {
  // returns function(ts)->idx of latest candle with openTime<=ts
  let j = 0;
  return (ts) => {
    while (j + 1 < ohlcv.length && Number(ohlcv[j + 1][0]) <= ts) j++;
    return j;
  };
}

function sideSign(side) { return side === 'long' ? 1 : -1; }

function computeTpSl(entry, side) {
  if (side === 'long') return { tp: entry * (1 + TP_PCT), sl: entry * (1 - SL_PCT) };
  return { tp: entry * (1 - TP_PCT), sl: entry * (1 + SL_PCT) };
}

function fmtPct(x) { return Math.round(x * 10000) / 100; }

async function main() {
  const ex = await makeExchange();
  await ex.loadMarkets();

  const now = Date.now();
  const sinceMs = now - DAYS * 24 * 60 * 60e3;
  const untilMs = now;

  // warmups
  const warm1d = (EMA_SLOW + 60) * ms('1d');
  const warm4h = 300 * ms('4h');
  const warm1h = 300 * ms('1h');

  const since1d = sinceMs - warm1d;
  const since4h = sinceMs - warm4h;
  const since1h = sinceMs - warm1h;

  async function getOHLCV(tf, since, until) {
    const key = cacheKey(SYMBOL, tf, since, until);
    const cached = loadCache(key);
    if (cached) return cached;
    const data = await fetchAllOHLCV(ex, SYMBOL, tf, since, until);
    saveCache(key, data);
    return data;
  }

  const o1d = await getOHLCV('1d', since1d, untilMs);
  const o4h = await getOHLCV('4h', since4h, untilMs);
  const o1h = await getOHLCV('1h', since1h, untilMs);

  const c1d = o1d.map(x => Number(x[4]));
  const c4h = o4h.map(x => Number(x[4]));
  const c1h = o1h.map(x => Number(x[4]));

  const emaFast1d = emaSeries(c1d, EMA_FAST);
  const emaMid1d = emaSeries(c1d, EMA_MID);
  const emaSlow1d = emaSeries(c1d, EMA_SLOW);

  const macd4h = macdSeries(c4h, MACD_FAST, MACD_SLOW, MACD_SIGNAL);
  const rsi4h = rsiSeries(c4h, RSI_PERIOD);

  const latest1dIdx = buildTimeToLatestIndex(o1d);
  const latest4hIdx = buildTimeToLatestIndex(o4h);

  // start index for 1h
  let startI1h = 0;
  for (let i = 0; i < o1h.length; i++) {
    if (Number(o1h[i][0]) >= sinceMs) { startI1h = i; break; }
  }

  let equity = 0;
  let equityPeak = 0;
  let maxDrawdownUSDT = 0;
  const equitySeries = [];

  let pos = null; // {side, entryPrice, entryTs, qty, bestPrice, trailActive, trailStop, tp, sl}
  const trades = [];

  function openPosition(side, price, ts) {
    const qty = NOTIONAL_USDT / price;
    const { tp, sl } = computeTpSl(price, side);
    pos = { side, entryPrice: price, entryTs: ts, qty, bestPrice: price, trailActive: false, trailStop: null, tp, sl };
  }

  function closePosition(price, ts, reason) {
    const dir = sideSign(pos.side);
    const pnl = (price - pos.entryPrice) * pos.qty * dir;
    equity += pnl;
    const holdMin = Math.round((ts - pos.entryTs) / 60000);
    trades.push({ side: pos.side, entryTs: pos.entryTs, exitTs: ts, entry: pos.entryPrice, exit: price, pnl, pnlPct: pnl / NOTIONAL_USDT, reason, holdMin });
    pos = null;
  }

  function updateDrawdown(ts) {
    equityPeak = Math.max(equityPeak, equity);
    const dd = equityPeak - equity;
    if (dd > maxDrawdownUSDT) maxDrawdownUSDT = dd;
    equitySeries.push({ ts, equity, peak: equityPeak, dd });
  }

  function signalAt(i1h) {
    const ts = Number(o1h[i1h][0]);
    const i1d = latest1dIdx(ts);
    const i4h = latest4hIdx(ts);

    const eF = emaFast1d[i1d];
    const eM = emaMid1d[i1d];
    const eS = emaSlow1d[i1d];
    const adx = adxLast(o1d.slice(0, i1d + 1), ADX_PERIOD);

    let bias = 'none';
    if ([eF, eM, eS].every(Number.isFinite) && Number.isFinite(adx) && adx >= ADX_MIN) {
      if (eF > eM && eM > eS) bias = 'long';
      else if (eF < eM && eM < eS) bias = 'short';
    }

    // setup 4h
    const macdLine = macd4h.line[i4h];
    const macdSig = macd4h.sig[i4h];
    const macdHist = macd4h.hist[i4h];
    const rsi = rsi4h[i4h];

    const vols4h = o4h.slice(0, i4h + 1).map(x => Number(x[5])).filter(Number.isFinite);
    const lastVol = vols4h.at(-1);
    const avgVol = vols4h.length >= VOL_LOOKBACK ? (vols4h.slice(-VOL_LOOKBACK).reduce((a,b)=>a+b,0)/VOL_LOOKBACK) : null;
    const volBreak = (Number.isFinite(lastVol) && Number.isFinite(avgVol)) ? (lastVol >= avgVol * VOL_MULT) : false;

    const vbOk = REQUIRE_VOL_BREAK ? volBreak : true;

    const setupLong = vbOk && Number.isFinite(macdLine) && Number.isFinite(macdSig) && macdLine > macdSig && (macdHist == null || macdHist >= 0) && (Number.isFinite(rsi) ? (rsi >= RSI_LONG_MIN) : false);
    const setupShort = vbOk && Number.isFinite(macdLine) && Number.isFinite(macdSig) && macdLine < macdSig && (macdHist == null || macdHist <= 0) && (Number.isFinite(rsi) ? (rsi <= RSI_SHORT_MAX) : false);

    // entry 1h
    const close = c1h[i1h];
    const prevClose = c1h[i1h - 1];
    const b = bollAt(c1h, i1h, BOLL_PERIOD, BOLL_MULT);
    const kd = stochKDAt(o1h, i1h, STOCH_K, STOCH_D, STOCH_SMOOTH);

    let entryLong = false;
    let entryShort = false;
    if (Number.isFinite(close) && Number.isFinite(prevClose) && b && kd) {
      // breakout (optionally require previous candle inside band)
      const prevInsideLong = ENTRY_REQUIRE_PREV_INSIDE ? (prevClose <= b.upper) : true;
      const prevInsideShort = ENTRY_REQUIRE_PREV_INSIDE ? (prevClose >= b.lower) : true;
      const stochOkLong = REQUIRE_STOCH ? ((kd.k > kd.d) && (kd.k >= STOCH_OS) && (kd.k <= 55)) : true;
      const stochOkShort = REQUIRE_STOCH ? ((kd.k < kd.d) && (kd.k <= STOCH_OB) && (kd.k >= 45)) : true;
      entryLong = (close > b.upper) && prevInsideLong && stochOkLong;
      entryShort = (close < b.lower) && prevInsideShort && stochOkShort;
    }

    if (bias === 'long' && setupLong && entryLong) return { side: 'long', bias, volBreak, adx, macdLine, macdSig, rsi };
    if (bias === 'short' && setupShort && entryShort) return { side: 'short', bias, volBreak, adx, macdLine, macdSig, rsi };
    return { side: null, bias, volBreak, adx, macdLine, macdSig, rsi };
  }

  for (let i = Math.max(startI1h, 1); i < o1h.length; i++) {
    const ts = Number(o1h[i][0]);
    const open = Number(o1h[i][1]);
    const high = Number(o1h[i][2]);
    const low = Number(o1h[i][3]);
    const close = Number(o1h[i][4]);

    // manage position
    if (pos) {
      const dir = sideSign(pos.side);

      // update best price
      if (pos.side === 'long') pos.bestPrice = Math.max(pos.bestPrice, high);
      else pos.bestPrice = Math.min(pos.bestPrice, low);

      // trailing activation
      const movePct = dir === 1 ? ((pos.bestPrice - pos.entryPrice) / pos.entryPrice) : ((pos.entryPrice - pos.bestPrice) / pos.entryPrice);
      if (!pos.trailActive && movePct >= TRAIL_ACTIVATE_PCT) {
        pos.trailActive = true;
        if (pos.side === 'long') pos.trailStop = pos.bestPrice * (1 - TRAIL_PCT);
        else pos.trailStop = pos.bestPrice * (1 + TRAIL_PCT);
      }
      if (pos.trailActive) {
        if (pos.side === 'long') pos.trailStop = Math.max(pos.trailStop, pos.bestPrice * (1 - TRAIL_PCT));
        else pos.trailStop = Math.min(pos.trailStop, pos.bestPrice * (1 + TRAIL_PCT));
      }

      // intrabar exit approximation (assume worst-case ordering: SL first)
      if (pos.side === 'long') {
        if (low <= pos.sl) { closePosition(pos.sl, ts, 'stop_loss'); }
        else if (high >= pos.tp) { closePosition(pos.tp, ts, 'take_profit'); }
        else if (pos.trailActive && low <= pos.trailStop) { closePosition(pos.trailStop, ts, 'trailing_stop'); }
      } else {
        if (high >= pos.sl) { closePosition(pos.sl, ts, 'stop_loss'); }
        else if (low <= pos.tp) { closePosition(pos.tp, ts, 'take_profit'); }
        else if (pos.trailActive && high >= pos.trailStop) { closePosition(pos.trailStop, ts, 'trailing_stop'); }
      }

      if (pos) {
        const holdMin = (ts - pos.entryTs) / 60000;
        if (holdMin >= MAX_HOLD_MIN) {
          closePosition(close, ts, 'timeout_close');
        }
      }

      updateDrawdown(ts);
      continue;
    }

    // no position: try open at close
    const sig = signalAt(i);
    if (sig.side) {
      openPosition(sig.side, close, ts);
    }
  }

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const totalPnlUsdt = trades.reduce((a, t) => a + t.pnl, 0);
  const winrate = trades.length ? wins.length / trades.length : 0;
  const avgWin = wins.length ? wins.reduce((a, t) => a + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((a, t) => a + t.pnl, 0) / losses.length : 0;
  const expectancyUsdt = trades.length ? totalPnlUsdt / trades.length : 0;

  const report = {
    ok: true,
    strategy: 'v2',
    symbol: SYMBOL,
    days: DAYS,
    params: {
      notionalUsdt: NOTIONAL_USDT,
      tpPct: TP_PCT,
      slPct: SL_PCT,
      trailActivatePct: TRAIL_ACTIVATE_PCT,
      trailPct: TRAIL_PCT,
      maxHoldMin: MAX_HOLD_MIN,
      macro: { EMA_FAST, EMA_MID, EMA_SLOW, ADX_PERIOD, ADX_MIN },
      setup: { MACD_FAST, MACD_SLOW, MACD_SIGNAL, RSI_PERIOD, RSI_LONG_MIN, RSI_SHORT_MAX, VOL_LOOKBACK, VOL_MULT },
      entry: { BOLL_PERIOD, BOLL_MULT, STOCH_K, STOCH_D, STOCH_SMOOTH, STOCH_OS, STOCH_OB, ENTRY_REQUIRE_PREV_INSIDE, REQUIRE_STOCH },
      setupFlags: { REQUIRE_VOL_BREAK },
    },
    metrics: {
      trades: trades.length,
      winrate,
      expectancyUsdt,
      totalPnlUsdt,
      avgWinUsdt: avgWin,
      avgLossUsdt: avgLoss,
      maxDrawdownUSDT,
    },
    lastTrades: trades.slice(-5),
  };

  process.stdout.write(JSON.stringify(report, null, 2));

  ensureDir(path.join(process.cwd(), 'tmp'));
  fs.writeFileSync(path.join(process.cwd(), 'tmp', `perp-backtest-v2-${DAYS}d.json`), JSON.stringify({ report, trades, equitySeries }, null, 2));
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({ ok: false, error: String(e?.stack || e) }, null, 2));
  process.exit(0);
});
