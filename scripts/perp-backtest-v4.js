#!/usr/bin/env node
/**
 * perp-backtest-v4.js
 * V4: Trend Breakout (Donchian) + ATR risk + optional compounding sizing.
 *
 * - Bias (1D): EMA50/EMA200 + ADX>=min decides allowed direction.
 * - Entry (4H): Donchian N breakout on close (close > prior N-high / close < prior N-low).
 * - Exit (4H): Donchian M opposite breakout on close (close < prior M-low for long; close > prior M-high for short).
 * - Risk: ATR-based initial stop + ATR trailing.
 * - Costs: fee + slippage.
 *
 * Limitations: OHLCV-only; intrabar ordering approximated (SL first).
 */

import ccxt from 'ccxt';
import fs from 'node:fs';
import path from 'node:path';

const SYMBOL = process.env.SYMBOL || 'BTC/USDT:USDT';
const DAYS = Number(process.env.DAYS || 180);

// Bias
const EMA_FAST = Number(process.env.EMA_FAST || 50);
const EMA_SLOW = Number(process.env.EMA_SLOW || 200);
const ADX_TF = String(process.env.ADX_TF || '1d'); // 1d|4h
const ADX_PERIOD = Number(process.env.ADX_PERIOD || 14);
const ADX_MIN = Number(process.env.ADX_MIN || 20);

// Donchian
const ENTRY_LOOKBACK = Number(process.env.ENTRY_LOOKBACK || 20);
const EXIT_LOOKBACK = Number(process.env.EXIT_LOOKBACK || 10);

// Risk
const ATR_PERIOD = Number(process.env.ATR_PERIOD || 14);
const STOP_ATR_MULT = Number(process.env.STOP_ATR_MULT || 2.0);
const TRAIL_MULT = Number(process.env.TRAIL_MULT || 2.0);
const TRAIL_ACTIVATE_ATR = Number(process.env.TRAIL_ACTIVATE_ATR || 1.0);
const MAX_HOLD_BARS = Number(process.env.MAX_HOLD_BARS || 60); // 4h bars (~10d)

// Sizing
const SIZE_MODE = String(process.env.SIZE_MODE || 'risk'); // fixed|risk
const START_EQUITY = Number(process.env.START_EQUITY || 20);
const FIXED_NOTIONAL = Number(process.env.NOTIONAL || 8);
const RISK_PCT = Number(process.env.RISK_PCT || 0.02);
const MAX_LEVERAGE = Number(process.env.MAX_LEVERAGE || 10);
const MIN_NOTIONAL = Number(process.env.MIN_NOTIONAL || 5);
const MAX_NOTIONAL = Number(process.env.MAX_NOTIONAL || 80);

// Costs (per side)
const FEE_PCT = Number(process.env.FEE_PCT || 0.0004);
const SLIPPAGE_PCT = Number(process.env.SLIPPAGE_PCT || 0.0003);

const CACHE_DIR = path.join(process.cwd(), 'tmp', 'backtest-cache');

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
function ms(tf) { return tf === '1d' ? 24 * 60 * 60e3 : 4 * 60 * 60e3; }

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
    const t = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    tr.push(t);
  }
  let a = tr.slice(0, period).reduce((x, y) => x + y, 0) / period;
  out[period] = a;
  for (let i = period; i < tr.length; i++) {
    a = (a * (period - 1) + tr[i]) / period;
    out[i + 1] = a;
  }
  return out;
}

function adxSeries(ohlcv, period = 14) {
  const len = ohlcv.length;
  const out = Array(len).fill(null);
  if (len < period + 2) return out;
  const highs = ohlcv.map(x => Number(x[2]));
  const lows = ohlcv.map(x => Number(x[3]));
  const closes = ohlcv.map(x => Number(x[4]));

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
    out[i] = adx;
  }
  return out;
}

function buildTimeToLatestIndex(ohlcv) {
  let j = 0;
  return (ts) => {
    while (j + 1 < ohlcv.length && Number(ohlcv[j + 1][0]) <= ts) j++;
    return j;
  };
}

function sideSign(side) { return side === 'long' ? 1 : -1; }

function donchianHigh(ohlcv, endIdx, lookback) {
  const start = Math.max(0, endIdx - lookback + 1);
  let hh = -Infinity;
  for (let i = start; i <= endIdx; i++) hh = Math.max(hh, Number(ohlcv[i][2]));
  return Number.isFinite(hh) ? hh : null;
}
function donchianLow(ohlcv, endIdx, lookback) {
  const start = Math.max(0, endIdx - lookback + 1);
  let ll = Infinity;
  for (let i = start; i <= endIdx; i++) ll = Math.min(ll, Number(ohlcv[i][3]));
  return Number.isFinite(ll) ? ll : null;
}

async function main() {
  const ex = await makeExchange();
  const LOAD_MARKETS = String(process.env.LOAD_MARKETS || '0') === '1';
  if (LOAD_MARKETS) await ex.loadMarkets();

  const now = Date.now();
  const sinceMs = now - DAYS * 24 * 60 * 60e3;
  const untilMs = now;

  const warm1d = (Math.max(EMA_SLOW, EMA_FAST) + 80) * ms('1d');
  const warm4h = Math.max(300, ENTRY_LOOKBACK + EXIT_LOOKBACK + 50) * ms('4h');

  const since1d = sinceMs - warm1d;
  const since4h = sinceMs - warm4h;

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

  const c1d = o1d.map(x => Number(x[4]));
  const c4h = o4h.map(x => Number(x[4]));

  const emaFast1d = emaSeries(c1d, EMA_FAST);
  const emaSlow1d = emaSeries(c1d, EMA_SLOW);
  const adx1d = adxSeries(o1d, ADX_PERIOD);
  const adx4h = adxSeries(o4h, ADX_PERIOD);

  const latest1dIdx = buildTimeToLatestIndex(o1d);

  const atr4h = atrSeries(o4h, ATR_PERIOD);

  let startI4h = 0;
  for (let i = 0; i < o4h.length; i++) {
    if (Number(o4h[i][0]) >= sinceMs) { startI4h = i; break; }
  }

  let equity = START_EQUITY;
  let peak = equity;
  let maxDrawdownUSDT = 0;
  const equitySeries = [];
  const trades = [];

  let pos = null; // {side, entryPrice, entryTs, qty, notional, barsHeld, bestPrice, trailActive, trailStop, sl, atrAtEntry, feeEntry}

  function updateDD(ts) {
    peak = Math.max(peak, equity);
    const dd = peak - equity;
    if (dd > maxDrawdownUSDT) maxDrawdownUSDT = dd;
    equitySeries.push({ ts, equity, peak, dd });
  }

  function openPosition(side, price, ts, atr) {
    const entry = side === 'long' ? price * (1 + SLIPPAGE_PCT) : price * (1 - SLIPPAGE_PCT);

    let notional = FIXED_NOTIONAL;
    if (SIZE_MODE === 'risk') {
      const riskUSDT = Math.max(0, equity) * RISK_PCT;
      const stopDist = Math.max(1e-9, atr * STOP_ATR_MULT);
      const qtyRisk = riskUSDT / stopDist;
      notional = qtyRisk * entry;
      notional = Math.min(notional, equity * MAX_LEVERAGE);
      notional = Math.max(notional, MIN_NOTIONAL);
      notional = Math.min(notional, MAX_NOTIONAL);
    }

    const qty = notional / entry;
    const sl = side === 'long' ? (entry - atr * STOP_ATR_MULT) : (entry + atr * STOP_ATR_MULT);

    const feeEntry = notional * FEE_PCT;
    equity -= feeEntry;

    pos = {
      side,
      entryPrice: entry,
      entryTs: ts,
      qty,
      notional,
      barsHeld: 0,
      bestPrice: entry,
      trailActive: false,
      trailStop: null,
      sl,
      atrAtEntry: atr,
      feeEntry,
    };
  }

  function closePosition(price, ts, reason) {
    const exit = pos.side === 'long' ? price * (1 - SLIPPAGE_PCT) : price * (1 + SLIPPAGE_PCT);
    const dir = sideSign(pos.side);
    const pnlGross = (exit - pos.entryPrice) * pos.qty * dir;
    const exitNotional = Math.abs(exit * pos.qty);
    const feeExit = exitNotional * FEE_PCT;
    const pnlNet = pnlGross - feeExit;
    equity += pnlNet;

    const holdMin = Math.round((ts - pos.entryTs) / 60000);
    trades.push({ side: pos.side, entryTs: pos.entryTs, exitTs: ts, entry: pos.entryPrice, exit, pnl: pnlNet, pnlGross, feeEntry: pos.feeEntry, feeExit, pnlPct: pnlNet / Math.max(1e-9, START_EQUITY), reason, holdMin, notional: pos.notional });
    pos = null;
  }

  for (let i = Math.max(startI4h, Math.max(ENTRY_LOOKBACK, EXIT_LOOKBACK) + 2); i < o4h.length; i++) {
    const ts = Number(o4h[i][0]);
    const high = Number(o4h[i][2]);
    const low = Number(o4h[i][3]);
    const close = Number(o4h[i][4]);

    if (!Number.isFinite(close)) continue;

    // manage position
    if (pos) {
      pos.barsHeld += 1;

      // update best price
      if (pos.side === 'long') pos.bestPrice = Math.max(pos.bestPrice, high);
      else pos.bestPrice = Math.min(pos.bestPrice, low);

      // trailing activation
      const favorable = pos.side === 'long' ? (pos.bestPrice - pos.entryPrice) : (pos.entryPrice - pos.bestPrice);
      if (!pos.trailActive && favorable >= pos.atrAtEntry * TRAIL_ACTIVATE_ATR) {
        pos.trailActive = true;
        pos.trailStop = pos.side === 'long'
          ? (pos.bestPrice - pos.atrAtEntry * TRAIL_MULT)
          : (pos.bestPrice + pos.atrAtEntry * TRAIL_MULT);
      }
      if (pos.trailActive) {
        const candidate = pos.side === 'long'
          ? (pos.bestPrice - pos.atrAtEntry * TRAIL_MULT)
          : (pos.bestPrice + pos.atrAtEntry * TRAIL_MULT);
        if (pos.side === 'long') pos.trailStop = Math.max(pos.trailStop, candidate);
        else pos.trailStop = Math.min(pos.trailStop, candidate);
      }

      // exit signal (donchian opposite on close)
      const exitHighPrev = donchianHigh(o4h, i - 1, EXIT_LOOKBACK);
      const exitLowPrev = donchianLow(o4h, i - 1, EXIT_LOOKBACK);
      const exitSignal = (pos.side === 'long')
        ? (exitLowPrev != null && close < exitLowPrev)
        : (exitHighPrev != null && close > exitHighPrev);

      // intrabar: SL first
      if (pos.side === 'long') {
        if (low <= pos.sl) closePosition(pos.sl, ts, 'stop_loss');
        else if (pos.trailActive && low <= pos.trailStop) closePosition(pos.trailStop, ts, 'trailing_stop');
        else if (exitSignal) closePosition(close, ts, 'donchian_exit');
      } else {
        if (high >= pos.sl) closePosition(pos.sl, ts, 'stop_loss');
        else if (pos.trailActive && high >= pos.trailStop) closePosition(pos.trailStop, ts, 'trailing_stop');
        else if (exitSignal) closePosition(close, ts, 'donchian_exit');
      }

      if (pos) {
        if (pos.barsHeld >= MAX_HOLD_BARS) closePosition(close, ts, 'timeout_close');
      }

      updateDD(ts);
      continue;
    }

    // no position: bias filter
    const i1d = latest1dIdx(ts);
    const eF = emaFast1d[i1d];
    const eS = emaSlow1d[i1d];
    const adxVal = (ADX_TF === '4h') ? adx4h[i] : adx1d[i1d];
    if (!(Number.isFinite(eF) && Number.isFinite(eS) && Number.isFinite(adxVal))) continue;
    if (adxVal < ADX_MIN) continue;

    const bias = eF > eS ? 'long' : (eF < eS ? 'short' : 'none');
    if (bias === 'none') continue;

    const atr = atr4h[i];
    if (!Number.isFinite(atr)) continue;

    const entryHighPrev = donchianHigh(o4h, i - 1, ENTRY_LOOKBACK);
    const entryLowPrev = donchianLow(o4h, i - 1, ENTRY_LOOKBACK);

    const longEntry = entryHighPrev != null && close > entryHighPrev;
    const shortEntry = entryLowPrev != null && close < entryLowPrev;

    if (bias === 'long' && longEntry) openPosition('long', close, ts, atr);
    else if (bias === 'short' && shortEntry) openPosition('short', close, ts, atr);
  }

  const totalPnlUsdt = trades.reduce((a, t) => a + t.pnl, 0);
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const winrate = trades.length ? wins.length / trades.length : 0;
  const avgWin = wins.length ? wins.reduce((a, t) => a + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((a, t) => a + t.pnl, 0) / losses.length : 0;
  const expectancyUsdt = trades.length ? totalPnlUsdt / trades.length : 0;
  const totalFees = trades.reduce((a, t) => a + (Number(t.feeEntry) || 0) + (Number(t.feeExit) || 0), 0);

  const report = {
    ok: true,
    strategy: 'v4_donchian_atr',
    symbol: SYMBOL,
    days: DAYS,
    params: {
      bias: { emaFast: EMA_FAST, emaSlow: EMA_SLOW, adxTf: ADX_TF, adxPeriod: ADX_PERIOD, adxMin: ADX_MIN },
      entry: { lookback: ENTRY_LOOKBACK },
      exit: { lookback: EXIT_LOOKBACK },
      risk: { atrPeriod: ATR_PERIOD, stopAtrMult: STOP_ATR_MULT, trailMult: TRAIL_MULT, trailActivateAtr: TRAIL_ACTIVATE_ATR, maxHoldBars: MAX_HOLD_BARS },
      sizing: { mode: SIZE_MODE, startEquity: START_EQUITY, riskPct: RISK_PCT, maxLeverage: MAX_LEVERAGE, fixedNotional: FIXED_NOTIONAL, minNotional: MIN_NOTIONAL, maxNotional: MAX_NOTIONAL },
      costs: { feePct: FEE_PCT, slippagePct: SLIPPAGE_PCT },
    },
    metrics: {
      trades: trades.length,
      winrate,
      expectancyUsdt,
      totalPnlUsdt,
      avgWinUsdt: avgWin,
      avgLossUsdt: avgLoss,
      totalFeesUSDT: totalFees,
      endEquityUSDT: equity,
      maxDrawdownUSDT,
    },
    lastTrades: trades.slice(-5),
  };

  process.stdout.write(JSON.stringify(report, null, 2));
  ensureDir(path.join(process.cwd(), 'tmp'));
  fs.writeFileSync(path.join(process.cwd(), 'tmp', `perp-backtest-v4-${DAYS}d.json`), JSON.stringify({ report, trades, equitySeries }, null, 2));
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({ ok: false, error: String(e?.stack || e) }, null, 2));
  process.exit(0);
});
