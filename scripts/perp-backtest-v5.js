#!/usr/bin/env node
/**
 * perp-backtest-v5.js
 * High-frequency swing backtest:
 * - Bias TF: 4h EMA fast/slow + ADX filter
 * - Trade TF: 1h
 * - Entry: 1h Donchian breakout on close
 * - Exit: ATR initial stop + ATR trailing + timeout
 * - Sizing: risk-based compounding with leverage cap
 * - Costs: fee + slippage
 */

import ccxt from 'ccxt';
import fs from 'node:fs';
import path from 'node:path';

const SYMBOL = process.env.SYMBOL || 'BTC/USDT:USDT';
const DAYS = Number(process.env.DAYS || 180);

// Bias (4h)
const BIAS_EMA_FAST = Number(process.env.BIAS_EMA_FAST || 20);
const BIAS_EMA_SLOW = Number(process.env.BIAS_EMA_SLOW || 50);
const ADX_PERIOD = Number(process.env.ADX_PERIOD || 14);
const ADX_MIN = Number(process.env.ADX_MIN || 18);

// Trade TF (default 15m for higher frequency; can use 1h)
const TRADE_TF = String(process.env.TRADE_TF || '1h'); // 15m|1h
const ENTRY_LOOKBACK = Number(process.env.ENTRY_LOOKBACK || (TRADE_TF === '15m' ? 12 : 20));
const COOLDOWN_BARS = Number(process.env.COOLDOWN_BARS || (TRADE_TF === '15m' ? 4 : 2));
const BREAKOUT_BUFFER_ATR = Number(process.env.BREAKOUT_BUFFER_ATR || (TRADE_TF === '15m' ? 0.2 : 0.0));

// Retest entry (for swing): after breakout, wait for retest near breakout level and then confirmation close.
const ENTRY_MODE = String(process.env.ENTRY_MODE || 'retest'); // breakout|retest
const RETEST_WINDOW_BARS = Number(process.env.RETEST_WINDOW_BARS || (TRADE_TF === '15m' ? 32 : 16));
const RETEST_TOL_ATR = Number(process.env.RETEST_TOL_ATR || 0.25);

// Re-entry to increase frequency: after a profitable/any exit, allow re-entry in the same bias direction
// when price retests EMA on trade TF.
const REENTRY_ENABLED = String(process.env.REENTRY_ENABLED || '1') === '1';
const REENTRY_EMA = Number(process.env.REENTRY_EMA || 20);
const REENTRY_WINDOW_BARS = Number(process.env.REENTRY_WINDOW_BARS || 24);
const REENTRY_TOL_ATR = Number(process.env.REENTRY_TOL_ATR || 0.35);

// Risk (ATR on trade TF)
const ATR_PERIOD = Number(process.env.ATR_PERIOD || 14);
const STOP_ATR_MULT = Number(process.env.STOP_ATR_MULT || 1.8);
const TRAIL_MULT = Number(process.env.TRAIL_MULT || 1.8);
const TRAIL_ACTIVATE_ATR = Number(process.env.TRAIL_ACTIVATE_ATR || 0.8);
const TIMEOUT_BARS = Number(process.env.TIMEOUT_BARS || (TRADE_TF === '15m' ? 192 : 240)); // 15m: 2d, 1h: 10d

// Sizing
const SIZE_MODE = String(process.env.SIZE_MODE || 'risk'); // fixed|risk
const START_EQUITY = Number(process.env.START_EQUITY || 20);
const FIXED_NOTIONAL = Number(process.env.NOTIONAL || 8);
const RISK_PCT = Number(process.env.RISK_PCT || 0.015);
const MAX_LEVERAGE = Number(process.env.MAX_LEVERAGE || 10);
const MIN_NOTIONAL = Number(process.env.MIN_NOTIONAL || 5);
const MAX_NOTIONAL = Number(process.env.MAX_NOTIONAL || 80);

// Loss streak throttle
const THROTTLE_ENABLED = String(process.env.THROTTLE_ENABLED || '1') === '1';
const THROTTLE_AFTER = Number(process.env.THROTTLE_AFTER || 3);
const THROTTLE_RISK_PCT = Number(process.env.THROTTLE_RISK_PCT || 0.008);

// Costs per side
const FEE_PCT = Number(process.env.FEE_PCT || 0.0004);
const SLIPPAGE_PCT = Number(process.env.SLIPPAGE_PCT || 0.0003);

const CACHE_DIR = path.join(process.cwd(), 'tmp', 'backtest-cache');

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
function ms(tf) {
  if (tf === '1d') return 24 * 60 * 60e3;
  if (tf === '4h') return 4 * 60 * 60e3;
  if (tf === '1h') return 60 * 60e3;
  if (tf === '15m') return 15 * 60e3;
  throw new Error('bad tf');
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
    if (guard > 40000) throw new Error('fetchAllOHLCV guard exceeded');
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

function sideSign(side) { return side === 'long' ? 1 : -1; }

async function main() {
  const ex = await makeExchange();
  const now = Date.now();
  const sinceMs = now - DAYS * 24 * 60 * 60e3;
  const untilMs = now;

  // warmup
  const warmBias = 260 * ms('4h');
  const warmTrade = Math.max(1200, ENTRY_LOOKBACK + 200) * ms(TRADE_TF);
  const since4h = sinceMs - warmBias;
  const sinceTrade = sinceMs - warmTrade;

  async function getOHLCV(tf, since, until) {
    const key = cacheKey(SYMBOL, tf, since, until);
    const cached = loadCache(key);
    if (cached) return cached;
    const data = await fetchAllOHLCV(ex, SYMBOL, tf, since, until);
    saveCache(key, data);
    return data;
  }

  const o4h = await getOHLCV('4h', since4h, untilMs);
  const oT = await getOHLCV(TRADE_TF, sinceTrade, untilMs);

  const c4h = o4h.map(x => Number(x[4]));
  const emaFast4h = emaSeries(c4h, BIAS_EMA_FAST);
  const emaSlow4h = emaSeries(c4h, BIAS_EMA_SLOW);
  const adx4h = adxSeries(o4h, ADX_PERIOD);
  const latest4hIdx = buildTimeToLatestIndex(o4h);

  const cT = oT.map(x => Number(x[4]));
  const emaReentryT = emaSeries(cT, REENTRY_EMA);
  const atrT = atrSeries(oT, ATR_PERIOD);

  let startIT = 0;
  for (let i = 0; i < oT.length; i++) {
    if (Number(oT[i][0]) >= sinceMs) { startIT = i; break; }
  }

  let equity = START_EQUITY;
  let peak = equity;
  let maxDrawdownUSDT = 0;
  const equitySeries = [];
  const trades = [];

  let pos = null; // {side, entryPrice, entryTs, qty, notional, barsHeld, bestPrice, trailActive, trailStop, sl, atrAtEntry, feeEntry}
  let cooldown = 0;
  let lossStreak = 0;
  let pending = null; // {side, level, atr, setAtI, expiresI, touched}
  let reentryArmed = false;
  let lastExitSide = null;

  function updateDD(ts) {
    peak = Math.max(peak, equity);
    const dd = peak - equity;
    if (dd > maxDrawdownUSDT) maxDrawdownUSDT = dd;
    equitySeries.push({ ts, equity, peak, dd });
  }

  function currentRiskPct() {
    if (!THROTTLE_ENABLED) return RISK_PCT;
    if (lossStreak >= THROTTLE_AFTER) return THROTTLE_RISK_PCT;
    return RISK_PCT;
  }

  function openPosition(side, price, ts, atr) {
    const entry = side === 'long' ? price * (1 + SLIPPAGE_PCT) : price * (1 - SLIPPAGE_PCT);

    let notional = FIXED_NOTIONAL;
    if (SIZE_MODE === 'risk') {
      const rp = currentRiskPct();
      const riskUSDT = Math.max(0, equity) * rp;
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

    // update loss streak by net pnl
    if (pnlNet <= 0) lossStreak += 1;
    else lossStreak = 0;

    const holdMin = Math.round((ts - pos.entryTs) / 60000);
    trades.push({ side: pos.side, entryTs: pos.entryTs, exitTs: ts, entry: pos.entryPrice, exit, pnl: pnlNet, pnlGross, feeEntry: pos.feeEntry, feeExit, reason, holdMin, notional: pos.notional, lossStreakAfter: lossStreak });

    // arm re-entry in the same direction after any exit
    lastExitSide = pos.side;
    reentryArmed = REENTRY_ENABLED;

    pos = null;
  }

  for (let i = Math.max(startIT, ENTRY_LOOKBACK + 2); i < oT.length; i++) {
    const ts = Number(oT[i][0]);
    const high = Number(oT[i][2]);
    const low = Number(oT[i][3]);
    const close = Number(oT[i][4]);
    if (!Number.isFinite(close)) continue;

    if (cooldown > 0) cooldown -= 1;

    // manage position
    if (pos) {
      pos.barsHeld += 1;

      if (pos.side === 'long') pos.bestPrice = Math.max(pos.bestPrice, high);
      else pos.bestPrice = Math.min(pos.bestPrice, low);

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

      // intrabar exits: SL first
      if (pos.side === 'long') {
        if (low <= pos.sl) closePosition(pos.sl, ts, 'stop_loss');
        else if (pos.trailActive && low <= pos.trailStop) closePosition(pos.trailStop, ts, 'trailing_stop');
      } else {
        if (high >= pos.sl) closePosition(pos.sl, ts, 'stop_loss');
        else if (pos.trailActive && high >= pos.trailStop) closePosition(pos.trailStop, ts, 'trailing_stop');
      }

      if (pos) {
        if (pos.barsHeld >= TIMEOUT_BARS) closePosition(close, ts, 'timeout_close');
      } else {
        cooldown = COOLDOWN_BARS;
      }

      updateDD(ts);
      continue;
    }

    if (cooldown > 0) {
      updateDD(ts);
      continue;
    }

    // expire pending
    if (pending && i > pending.expiresI) pending = null;

    // bias from 4h
    const i4 = latest4hIdx(ts);
    const eF = emaFast4h[i4];
    const eS = emaSlow4h[i4];
    const adx = adx4h[i4];
    if (!(Number.isFinite(eF) && Number.isFinite(eS) && Number.isFinite(adx))) {
      updateDD(ts);
      continue;
    }
    if (adx < ADX_MIN) {
      updateDD(ts);
      continue;
    }
    const bias = eF > eS ? 'long' : (eF < eS ? 'short' : 'none');
    if (bias === 'none') {
      updateDD(ts);
      continue;
    }

    const atr = atrT[i];
    if (!Number.isFinite(atr)) {
      updateDD(ts);
      continue;
    }

    // optional re-entry to increase frequency (trend-following):
    // If armed, in the same bias direction, and price retests EMA(REENTRY_EMA) within a window, then confirm and enter.
    if (reentryArmed && lastExitSide && REENTRY_ENABLED) {
      // disarm if bias changes
      if ((lastExitSide === 'long' && bias !== 'long') || (lastExitSide === 'short' && bias !== 'short')) {
        reentryArmed = false;
        lastExitSide = null;
      } else {
        const eRe = emaReentryT[i];
        if (Number.isFinite(eRe)) {
          const tol = REENTRY_TOL_ATR * atr;
          if (lastExitSide === 'long') {
            const touched = low <= (eRe + tol);
            const confirmed = close > eRe;
            if (touched && confirmed) {
              openPosition('long', close, ts, atr);
              reentryArmed = false;
              lastExitSide = null;
              updateDD(ts);
              continue;
            }
          } else {
            const touched = high >= (eRe - tol);
            const confirmed = close < eRe;
            if (touched && confirmed) {
              openPosition('short', close, ts, atr);
              reentryArmed = false;
              lastExitSide = null;
              updateDD(ts);
              continue;
            }
          }
        }
      }
    }

    // Donchian breakout levels (previous window)
    const hhPrev = donchianHigh(oT, i - 1, ENTRY_LOOKBACK);
    const llPrev = donchianLow(oT, i - 1, ENTRY_LOOKBACK);
    const buf = BREAKOUT_BUFFER_ATR * atr;

    const longBreak = hhPrev != null && close > (hhPrev + buf);
    const shortBreak = llPrev != null && close < (llPrev - buf);

    if (ENTRY_MODE === 'breakout') {
      if (bias === 'long' && longBreak) openPosition('long', close, ts, atr);
      else if (bias === 'short' && shortBreak) openPosition('short', close, ts, atr);
      updateDD(ts);
      continue;
    }

    // ENTRY_MODE === 'retest'
    // Step1: set pending after breakout
    if (!pending) {
      if (bias === 'long' && longBreak) {
        pending = { side: 'long', level: hhPrev, atr, setAtI: i, expiresI: i + RETEST_WINDOW_BARS };
      } else if (bias === 'short' && shortBreak) {
        pending = { side: 'short', level: llPrev, atr, setAtI: i, expiresI: i + RETEST_WINDOW_BARS };
      }
      updateDD(ts);
      continue;
    }

    // Step2: on retest, confirm and enter
    const tol = RETEST_TOL_ATR * atr;
    if (pending.side === 'long') {
      const touched = low <= (pending.level + tol);
      const confirmed = close > pending.level;
      if (touched && confirmed && bias === 'long') {
        openPosition('long', close, ts, atr);
        pending = null;
      }
    } else {
      const touched = high >= (pending.level - tol);
      const confirmed = close < pending.level;
      if (touched && confirmed && bias === 'short') {
        openPosition('short', close, ts, atr);
        pending = null;
      }
    }

    updateDD(ts);
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
    strategy: 'v5_hf_swing',
    symbol: SYMBOL,
    days: DAYS,
    params: {
      bias: { tf: '4h', emaFast: BIAS_EMA_FAST, emaSlow: BIAS_EMA_SLOW, adxPeriod: ADX_PERIOD, adxMin: ADX_MIN },
      entry: { tf: TRADE_TF, mode: ENTRY_MODE, donchianLookback: ENTRY_LOOKBACK, cooldownBars: COOLDOWN_BARS, breakoutBufferAtr: BREAKOUT_BUFFER_ATR, retestWindowBars: RETEST_WINDOW_BARS, retestTolAtr: RETEST_TOL_ATR, reentry: { enabled: REENTRY_ENABLED, ema: REENTRY_EMA, windowBars: REENTRY_WINDOW_BARS, tolAtr: REENTRY_TOL_ATR } },
      risk: { atrTf: TRADE_TF, atrPeriod: ATR_PERIOD, stopAtrMult: STOP_ATR_MULT, trailMult: TRAIL_MULT, trailActivateAtr: TRAIL_ACTIVATE_ATR, timeoutBars: TIMEOUT_BARS },
      sizing: { mode: SIZE_MODE, startEquity: START_EQUITY, riskPct: RISK_PCT, maxLeverage: MAX_LEVERAGE, minNotional: MIN_NOTIONAL, maxNotional: MAX_NOTIONAL, throttle: { enabled: THROTTLE_ENABLED, after: THROTTLE_AFTER, riskPct: THROTTLE_RISK_PCT } },
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
      lossStreakEnd: lossStreak,
    },
    lastTrades: trades.slice(-5),
  };

  process.stdout.write(JSON.stringify(report, null, 2));
  ensureDir(path.join(process.cwd(), 'tmp'));
  fs.writeFileSync(path.join(process.cwd(), 'tmp', `perp-backtest-v5-${DAYS}d.json`), JSON.stringify({ report, trades, equitySeries }, null, 2));
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({ ok: false, error: String(e?.stack || e) }, null, 2));
  process.exit(0);
});
