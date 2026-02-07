#!/usr/bin/env node
/**
 * market-perp-signal-v5.js
 * V5 live signal (approx of backtest logic):
 * - Bias: 4h EMA20/50 + ADX>=min
 * - Entry primary: 1h Donchian lookback breakout then retest-confirm on current bar
 *   (stateless scan: find most recent breakout within window; if current bar retests level and closes back in direction -> signal)
 * - Entry secondary (re-entry): in-trend retest of 1h EMA20 with ATR tolerance
 *
 * Output (legacy alerts format, consumed by run-perp-cycle.js):
 * { ok:true, alerts:[{key:'BTC',symbol:'BTCUSDT',side:'long'|'short',level:'strong',reason:string}] }
 */

import ccxt from 'ccxt';

const SYMBOL = process.env.SYMBOL || 'BTC/USDT:USDT';

// Bias
const BIAS_EMA_FAST = Number(process.env.BIAS_EMA_FAST || 20);
const BIAS_EMA_SLOW = Number(process.env.BIAS_EMA_SLOW || 50);
const ADX_PERIOD = Number(process.env.ADX_PERIOD || 14);
const ADX_MIN = Number(process.env.ADX_MIN || 15);

// Trade TF
const TRADE_TF = '1h';
const ENTRY_LOOKBACK = Number(process.env.ENTRY_LOOKBACK || 15);
const RETEST_WINDOW_BARS = Number(process.env.RETEST_WINDOW_BARS || 32);
const RETEST_TOL_ATR = Number(process.env.RETEST_TOL_ATR || 0.25);

// Re-entry
const REENTRY_ENABLED = String(process.env.REENTRY_ENABLED || '1') === '1';
const REENTRY_EMA = Number(process.env.REENTRY_EMA || 20);
const REENTRY_TOL_ATR = Number(process.env.REENTRY_TOL_ATR || 0.35);

// Risk measure
const ATR_PERIOD = Number(process.env.ATR_PERIOD || 14);

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
  const ex = new ccxt.bitget({ enableRateLimit: true, timeout: 30000, options: { defaultType: 'swap' } });

  const limit4h = 300;
  const limit1h = 600;
  const o4h = await ex.fetchOHLCV(SYMBOL, '4h', undefined, limit4h);
  const o1h = await ex.fetchOHLCV(SYMBOL, '1h', undefined, limit1h);

  if (!Array.isArray(o4h) || o4h.length < 100 || !Array.isArray(o1h) || o1h.length < 200) {
    process.stdout.write(JSON.stringify({ ok: true, alerts: [], note: 'insufficient_ohlcv' }, null, 2));
    return;
  }

  const c4h = o4h.map(x => Number(x[4]));
  const emaF4 = emaSeries(c4h, BIAS_EMA_FAST);
  const emaS4 = emaSeries(c4h, BIAS_EMA_SLOW);
  const adx4 = adxSeries(o4h, ADX_PERIOD);

  const i4 = o4h.length - 1;
  const eF = emaF4[i4];
  const eS = emaS4[i4];
  const adx = adx4[i4];
  if (!(Number.isFinite(eF) && Number.isFinite(eS) && Number.isFinite(adx)) || adx < ADX_MIN) {
    process.stdout.write(JSON.stringify({ ok: true, alerts: [], note: 'bias_filtered', bias: { eF, eS, adx } }, null, 2));
    return;
  }
  const bias = eF > eS ? 'long' : (eF < eS ? 'short' : 'none');
  if (bias === 'none') {
    process.stdout.write(JSON.stringify({ ok: true, alerts: [], note: 'bias_none' }, null, 2));
    return;
  }

  const atr1h = atrSeries(o1h, ATR_PERIOD);
  const c1h = o1h.map(x => Number(x[4]));
  const ema20 = emaSeries(c1h, REENTRY_EMA);

  const i = o1h.length - 1;
  const ts = Number(o1h[i][0]);
  const high = Number(o1h[i][2]);
  const low = Number(o1h[i][3]);
  const close = Number(o1h[i][4]);
  const atr = atr1h[i];

  if (!(Number.isFinite(close) && Number.isFinite(atr))) {
    process.stdout.write(JSON.stringify({ ok: true, alerts: [], note: 'atr_unavailable' }, null, 2));
    return;
  }

  // Primary: breakout then retest on current bar
  const start = Math.max(ENTRY_LOOKBACK + 2, i - RETEST_WINDOW_BARS);

  let breakout = null; // { side, level, atI }
  for (let j = i - 1; j >= start; j--) {
    const hhPrev = donchianHigh(o1h, j - 1, ENTRY_LOOKBACK);
    const llPrev = donchianLow(o1h, j - 1, ENTRY_LOOKBACK);
    const cl = Number(o1h[j][4]);
    if (!Number.isFinite(cl)) continue;
    if (bias === 'long' && hhPrev != null && cl > hhPrev) { breakout = { side: 'long', level: hhPrev, atI: j }; break; }
    if (bias === 'short' && llPrev != null && cl < llPrev) { breakout = { side: 'short', level: llPrev, atI: j }; break; }
  }

  if (breakout) {
    const tol = RETEST_TOL_ATR * atr;
    if (breakout.side === 'long') {
      const touched = low <= (breakout.level + tol);
      const confirmed = close > breakout.level;
      if (touched && confirmed) {
        process.stdout.write(JSON.stringify({
          ok: true,
          alerts: [{ key: 'BTC', symbol: 'BTCUSDT', side: 'long', level: 'strong', reason: `v5 retest: bias=long; breakout@${new Date(Number(o1h[breakout.atI][0])).toISOString()}; level=${breakout.level.toFixed(2)}; tol=${tol.toFixed(2)}` }],
          meta: { bias, adx, breakout }
        }, null, 2));
        return;
      }
    } else {
      const touched = high >= (breakout.level - tol);
      const confirmed = close < breakout.level;
      if (touched && confirmed) {
        process.stdout.write(JSON.stringify({
          ok: true,
          alerts: [{ key: 'BTC', symbol: 'BTCUSDT', side: 'short', level: 'strong', reason: `v5 retest: bias=short; breakout@${new Date(Number(o1h[breakout.atI][0])).toISOString()}; level=${breakout.level.toFixed(2)}; tol=${tol.toFixed(2)}` }],
          meta: { bias, adx, breakout }
        }, null, 2));
        return;
      }
    }
  }

  // Secondary: EMA re-entry
  if (REENTRY_ENABLED) {
    const e = ema20[i];
    if (Number.isFinite(e)) {
      const tol = REENTRY_TOL_ATR * atr;
      if (bias === 'long') {
        const touched = low <= (e + tol);
        const confirmed = close > e;
        if (touched && confirmed) {
          process.stdout.write(JSON.stringify({
            ok: true,
            alerts: [{ key: 'BTC', symbol: 'BTCUSDT', side: 'long', level: 'strong', reason: `v5 reentry: bias=long; ema${REENTRY_EMA}=${e.toFixed(2)}; tol=${tol.toFixed(2)}` }],
            meta: { bias, adx }
          }, null, 2));
          return;
        }
      } else {
        const touched = high >= (e - tol);
        const confirmed = close < e;
        if (touched && confirmed) {
          process.stdout.write(JSON.stringify({
            ok: true,
            alerts: [{ key: 'BTC', symbol: 'BTCUSDT', side: 'short', level: 'strong', reason: `v5 reentry: bias=short; ema${REENTRY_EMA}=${e.toFixed(2)}; tol=${tol.toFixed(2)}` }],
            meta: { bias, adx }
          }, null, 2));
          return;
        }
      }
    }
  }

  process.stdout.write(JSON.stringify({ ok: true, alerts: [], note: 'no_setup', meta: { bias, adx, ts } }, null, 2));
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({ ok: false, error: String(e?.stack || e) }, null, 2));
  process.exit(0);
});
