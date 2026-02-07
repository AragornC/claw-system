#!/usr/bin/env node
/**
 * market-perp-signal-v2.js
 * 三维动量金字塔（可执行版本，胜率优先）：
 * - 1D：EMA50/100/200 金字塔 + ADX>阈值 → 只定方向（bias）
 * - 4H：MACD动量 + RSI位置 + 成交量突破 → setup 区域过滤
 * - 1H：布林带突破 + 随机指标反转 → 入场
 *
 * 输出格式兼容 run-perp-cycle：
 * { ok:true, nowMs, alerts:[{key:"BTC", symbol:"BTCUSDT", side, level, reason, metrics}] }
 */

import ccxt from 'ccxt';
import fs from 'node:fs';
import path from 'node:path';

function safeParseJsonFile(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
function pickNum(v, fb) { const n = Number(v); return Number.isFinite(n) ? n : fb; }
function pickBool(v, fb) { return typeof v === 'boolean' ? v : fb; }
function pickAllowSides(v) {
  if (!Array.isArray(v)) return { long: true, short: true };
  const s = new Set(v.map(String));
  return { long: s.has('long'), short: s.has('short') };
}

function emaSeries(values, period) {
  const out = Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let e = sum / period;
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

function sma(values, period) {
  if (values.length < period) return null;
  let s = 0;
  for (let i = values.length - period; i < values.length; i++) s += values[i];
  return s / period;
}

function std(values, period) {
  if (values.length < period) return null;
  const m = sma(values, period);
  let v = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const d = values[i] - m;
    v += d * d;
  }
  return Math.sqrt(v / period);
}

function boll(values, period = 20, mult = 2) {
  const mid = sma(values, period);
  const sd = std(values, period);
  if (mid == null || sd == null) return null;
  return { mid, upper: mid + mult * sd, lower: mid - mult * sd };
}

function macd(values, fast = 12, slow = 26, signal = 9) {
  const eFast = emaSeries(values, fast);
  const eSlow = emaSeries(values, slow);
  const line = values.map((_, i) => (eFast[i] != null && eSlow[i] != null) ? (eFast[i] - eSlow[i]) : null);
  const valid = line.filter((x) => Number.isFinite(x));
  if (valid.length < signal + 5) return { line, signal: null, hist: null };
  const sig = emaSeries(line.map((x) => (x == null ? 0 : x)), signal); // ok for tail usage
  const hist = line.map((x, i) => (x != null && sig[i] != null) ? (x - sig[i]) : null);
  return { line, signal: sig, hist };
}

function adx(ohlcv, period = 14) {
  // Returns last ADX value (Wilder)
  if (!Array.isArray(ohlcv) || ohlcv.length < period + 2) return null;
  const highs = ohlcv.map(x => Number(x[2]));
  const lows = ohlcv.map(x => Number(x[3]));
  const closes = ohlcv.map(x => Number(x[4]));
  const len = ohlcv.length;

  const tr = Array(len).fill(null);
  const plusDM = Array(len).fill(null);
  const minusDM = Array(len).fill(null);
  for (let i = 1; i < len; i++) {
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];
    plusDM[i] = (upMove > downMove && upMove > 0) ? upMove : 0;
    minusDM[i] = (downMove > upMove && downMove > 0) ? downMove : 0;
    const tr0 = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    tr[i] = tr0;
  }

  // Wilder smoothing
  function wilderSum(arr, start, p) {
    let s = 0;
    for (let i = start; i < start + p; i++) s += arr[i] || 0;
    return s;
  }

  let tr14 = wilderSum(tr, 1, period);
  let pDM14 = wilderSum(plusDM, 1, period);
  let mDM14 = wilderSum(minusDM, 1, period);

  let adxVal = null;
  let dxPrev = null;

  for (let i = period + 1; i < len; i++) {
    // smooth
    tr14 = tr14 - (tr14 / period) + (tr[i] || 0);
    pDM14 = pDM14 - (pDM14 / period) + (plusDM[i] || 0);
    mDM14 = mDM14 - (mDM14 / period) + (minusDM[i] || 0);

    if (!(tr14 > 0)) continue;
    const pDI = 100 * (pDM14 / tr14);
    const mDI = 100 * (mDM14 / tr14);
    const dx = (pDI + mDI === 0) ? 0 : (100 * Math.abs(pDI - mDI) / (pDI + mDI));

    // ADX is Wilder smoothing of DX
    if (dxPrev == null) {
      dxPrev = dx;
      adxVal = dx; // seed (rough)
    } else {
      adxVal = ((adxVal * (period - 1)) + dx) / period;
    }
  }

  return adxVal;
}

function stochK(ohlcv, kPeriod = 14, smooth = 3) {
  // returns last smoothed %K
  if (!Array.isArray(ohlcv) || ohlcv.length < kPeriod + smooth) return null;
  const closes = ohlcv.map(x => Number(x[4]));
  const highs = ohlcv.map(x => Number(x[2]));
  const lows = ohlcv.map(x => Number(x[3]));

  const rawK = [];
  for (let i = kPeriod - 1; i < ohlcv.length; i++) {
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
  // smooth %K with SMA(smooth)
  if (rawK.length < smooth) return null;
  const kSm = rawK.slice(-smooth).reduce((a, b) => a + b, 0) / smooth;
  return kSm;
}

function stochD(ohlcv, kPeriod = 14, dPeriod = 3, smooth = 3) {
  // compute last %D (SMA of smoothed %K)
  if (!Array.isArray(ohlcv) || ohlcv.length < kPeriod + smooth + dPeriod) return null;
  const closes = ohlcv.map(x => Number(x[4]));
  const highs = ohlcv.map(x => Number(x[2]));
  const lows = ohlcv.map(x => Number(x[3]));

  const smK = [];
  for (let i = kPeriod - 1; i < ohlcv.length; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      hh = Math.max(hh, highs[j]);
      ll = Math.min(ll, lows[j]);
    }
    const c = closes[i];
    const k = (hh === ll) ? 50 : (100 * (c - ll) / (hh - ll));
    smK.push(k);
  }
  // smooth K
  const k2 = [];
  for (let i = smooth - 1; i < smK.length; i++) {
    const w = smK.slice(i - smooth + 1, i + 1);
    k2.push(w.reduce((a, b) => a + b, 0) / smooth);
  }
  if (k2.length < dPeriod) return null;
  const d = k2.slice(-dPeriod).reduce((a, b) => a + b, 0) / dPeriod;
  return d;
}

async function makeExchange() {
  return new ccxt.bitget({ enableRateLimit: true, timeout: 20000, options: { defaultType: 'swap' } });
}

async function main() {
  const nowMs = Date.now();
  const WORKDIR = process.env.OPENCLAW_WORKDIR || process.cwd();
  const cfgPath = path.resolve(WORKDIR, 'memory/perp-strategy-v2.json');
  const cfg = safeParseJsonFile(cfgPath) || {};
  if (cfg.enabled === false) {
    process.stdout.write(JSON.stringify({ ok: true, nowMs, alerts: [], skipped: true, reason: 'strategy_disabled' }, null, 2));
    return;
  }

  const symbol = typeof cfg.symbol === 'string' ? cfg.symbol : 'BTC/USDT:USDT';
  const allow = pickAllowSides(cfg.allowSides);

  const tfMacro = cfg?.timeframes?.macro || '1d';
  const tfSetup = cfg?.timeframes?.setup || '4h';
  const tfEntry = cfg?.timeframes?.entry || '1h';

  const emaFast = pickNum(cfg?.macro?.ema?.fast, 50);
  const emaMid = pickNum(cfg?.macro?.ema?.mid, 100);
  const emaSlow = pickNum(cfg?.macro?.ema?.slow, 200);
  const adxPeriod = pickNum(cfg?.macro?.adx?.period, 14);
  const adxMin = pickNum(cfg?.macro?.adx?.min, 25);

  const macdFast = pickNum(cfg?.setup?.macd?.fast, 12);
  const macdSlow = pickNum(cfg?.setup?.macd?.slow, 26);
  const macdSignal = pickNum(cfg?.setup?.macd?.signal, 9);
  const rsiPeriod = pickNum(cfg?.setup?.rsi?.period, 14);
  const rsiLongMin = pickNum(cfg?.setup?.rsi?.longMin, 50);
  const rsiShortMax = pickNum(cfg?.setup?.rsi?.shortMax, 50);
  const volLookback = pickNum(cfg?.setup?.volumeBreakout?.lookback, 20);
  const volMult = pickNum(cfg?.setup?.volumeBreakout?.mult, 1.8);

  const bollPeriod = pickNum(cfg?.entry?.boll?.period, 20);
  const bollMult = pickNum(cfg?.entry?.boll?.mult, 2);
  const stochKp = pickNum(cfg?.entry?.stoch?.k, 14);
  const stochDp = pickNum(cfg?.entry?.stoch?.d, 3);
  const stochSmooth = pickNum(cfg?.entry?.stoch?.smooth, 3);
  const stochOS = pickNum(cfg?.entry?.stoch?.oversold, 20);
  const stochOB = pickNum(cfg?.entry?.stoch?.overbought, 80);
  const requirePrevInsideBand = pickBool(cfg?.entry?.requirePrevInsideBand, true);

  const ex = await makeExchange();
  await ex.loadMarkets();

  // Fetch enough candles
  const o1d = await ex.fetchOHLCV(symbol, tfMacro, undefined, Math.max(emaSlow + 50, 260));
  const o4h = await ex.fetchOHLCV(symbol, tfSetup, undefined, 300);
  const o1h = await ex.fetchOHLCV(symbol, tfEntry, undefined, 300);

  const c1d = o1d.map(x => Number(x[4])).filter(Number.isFinite);
  const c4h = o4h.map(x => Number(x[4])).filter(Number.isFinite);
  const c1h = o1h.map(x => Number(x[4])).filter(Number.isFinite);

  const eFast1d = emaSeries(c1d, emaFast).at(-1);
  const eMid1d = emaSeries(c1d, emaMid).at(-1);
  const eSlow1d = emaSeries(c1d, emaSlow).at(-1);
  const adx1d = adx(o1d, adxPeriod);

  let bias = 'none';
  if ([eFast1d, eMid1d, eSlow1d].every(Number.isFinite) && Number.isFinite(adx1d) && adx1d >= adxMin) {
    if (eFast1d > eMid1d && eMid1d > eSlow1d) bias = 'long';
    else if (eFast1d < eMid1d && eMid1d < eSlow1d) bias = 'short';
  }

  // 4H setup
  const macd4h = macd(c4h, macdFast, macdSlow, macdSignal);
  const macdLine = macd4h.line.at(-1);
  const macdSig = macd4h.signal?.at(-1);
  const macdHist = macd4h.hist?.at(-1);
  const rsi4h = rsiSeries(c4h, rsiPeriod).at(-1);

  const vols4h = o4h.map(x => Number(x[5])).filter(Number.isFinite);
  const lastVol4h = vols4h.at(-1);
  const avgVol4h = vols4h.length >= volLookback ? (vols4h.slice(-volLookback).reduce((a,b)=>a+b,0)/volLookback) : null;
  const volBreak = (Number.isFinite(lastVol4h) && Number.isFinite(avgVol4h)) ? (lastVol4h >= avgVol4h * volMult) : false;

  const setupLong = (Number.isFinite(macdLine) && Number.isFinite(macdSig) && macdLine > macdSig && (macdHist == null || macdHist >= 0))
    && (Number.isFinite(rsi4h) ? (rsi4h >= rsiLongMin) : false)
    && volBreak;

  const setupShort = (Number.isFinite(macdLine) && Number.isFinite(macdSig) && macdLine < macdSig && (macdHist == null || macdHist <= 0))
    && (Number.isFinite(rsi4h) ? (rsi4h <= rsiShortMax) : false)
    && volBreak;

  // 1H entry
  const last1h = c1h.at(-1);
  const prev1h = c1h.at(-2);
  const b = boll(c1h, bollPeriod, bollMult);
  const kNow = stochK(o1h, stochKp, stochSmooth);
  const dNow = stochD(o1h, stochKp, stochDp, stochSmooth);

  let entryLong = false;
  let entryShort = false;
  if (Number.isFinite(last1h) && b && Number.isFinite(kNow) && Number.isFinite(dNow)) {
    // Breakout + reversal confirmation:
    // - long: close breaks above upper band AND stoch coming up from oversold-ish (K>D and K<50)
    // - short: close breaks below lower band AND stoch rolling down from overbought-ish (K<D and K>50)
    entryLong = (last1h > b.upper) && (kNow > dNow) && (kNow <= 55) && (kNow >= stochOS);
    entryShort = (last1h < b.lower) && (kNow < dNow) && (kNow >= 45) && (kNow <= stochOB);

    // Extra: require breakout is real (prev close was inside band)
    if (requirePrevInsideBand && Number.isFinite(prev1h)) {
      if (entryLong && !(prev1h <= b.upper)) entryLong = false;
      if (entryShort && !(prev1h >= b.lower)) entryShort = false;
    }
  }

  const alerts = [];

  const canLong = allow.long && bias === 'long' && setupLong && entryLong;
  const canShort = allow.short && bias === 'short' && setupShort && entryShort;

  if (canLong) {
    alerts.push({
      key: 'BTC',
      symbol: 'BTCUSDT',
      side: 'long',
      level: 'strong',
      reason: 'macro_1d_ema_pyramid+adx && setup_4h_macd_rsi_vol && entry_1h_boll_break+stoch_reversal',
      metrics: {
        bias,
        macro: { ema: { fast: eFast1d, mid: eMid1d, slow: eSlow1d }, adx: adx1d, adxMin },
        setup: { macdLine, macdSig, macdHist, rsi4h, rsiLongMin, volBreak, lastVol4h, avgVol4h, volMult },
        entry: { last1h, prev1h, boll: b, stochK: kNow, stochD: dNow, stochOS, stochOB },
      }
    });
  } else if (canShort) {
    alerts.push({
      key: 'BTC',
      symbol: 'BTCUSDT',
      side: 'short',
      level: 'strong',
      reason: 'macro_1d_ema_pyramid+adx && setup_4h_macd_rsi_vol && entry_1h_boll_break+stoch_reversal',
      metrics: {
        bias,
        macro: { ema: { fast: eFast1d, mid: eMid1d, slow: eSlow1d }, adx: adx1d, adxMin },
        setup: { macdLine, macdSig, macdHist, rsi4h, rsiShortMax, volBreak, lastVol4h, avgVol4h, volMult },
        entry: { last1h, prev1h, boll: b, stochK: kNow, stochD: dNow, stochOS, stochOB },
      }
    });
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    nowMs,
    strategy: {
      version: 2,
      path: cfgPath,
      effective: {
        symbol,
        allowSides: { long: allow.long, short: allow.short },
        timeframes: { macro: tfMacro, setup: tfSetup, entry: tfEntry },
        macro: { emaFast, emaMid, emaSlow, adxPeriod, adxMin },
        setup: { macdFast, macdSlow, macdSignal, rsiPeriod, rsiLongMin, rsiShortMax, volLookback, volMult },
        entry: { bollPeriod, bollMult, stochKp, stochDp, stochSmooth, stochOS, stochOB, requirePrevInsideBand }
      }
    },
    alerts,
    debug: {
      bias,
      setupLong,
      setupShort,
      entryLong,
      entryShort,
      volBreak,
    }
  }, null, 2));
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({ ok: false, error: String(e?.stack || e) }, null, 2));
  process.exit(0);
});
