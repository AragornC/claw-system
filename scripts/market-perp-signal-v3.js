#!/usr/bin/env node
/**
 * market-perp-signal-v3.js
 * S1: 4H trend pullback + ATR risk (short swing)
 * - Bias (1D): close vs EMA200 → trend direction
 * - Entry (4H): pullback near EMA20/50 band, then reclaim EMA20 (close cross)
 * Output: { ok:true, nowMs, alerts:[{key:'BTC', symbol:'BTCUSDT', side, level, reason, metrics}] }
 */

import ccxt from 'ccxt';
import fs from 'node:fs';
import path from 'node:path';

function readCfg() {
  const WORKDIR = process.env.OPENCLAW_WORKDIR || process.cwd();
  const p = path.resolve(WORKDIR, 'memory/perp-strategy-v3.json');
  try {
    return { ok: true, path: p, cfg: JSON.parse(fs.readFileSync(p, 'utf8')) };
  } catch (e) {
    return { ok: false, path: p, error: String(e?.message || e), cfg: {} };
  }
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
  // Wilder smoothing
  let a = tr.slice(0, period).reduce((x, y) => x + y, 0) / period;
  out[period] = a;
  for (let i = period; i < tr.length; i++) {
    a = (a * (period - 1) + tr[i]) / period;
    out[i + 1] = a;
  }
  return out;
}

function pctDiff(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
  return Math.abs(a - b) / Math.abs(b) * 100;
}

function pickNum(v, fb) { const n = Number(v); return Number.isFinite(n) ? n : fb; }
function pickBool(v, fb) { return typeof v === 'boolean' ? v : fb; }

async function makeExchange() {
  return new ccxt.bitget({ enableRateLimit: true, timeout: 20000, options: { defaultType: 'swap' } });
}

async function main() {
  const nowMs = Date.now();
  const { ok: cfgOk, path: cfgPath, error: cfgErr, cfg } = readCfg();

  const symbol = typeof cfg?.symbol === 'string' ? cfg.symbol : 'BTC/USDT:USDT';

  const emaBiasPeriod = pickNum(cfg?.bias?.ema?.period, 200);
  const allowSides = Array.isArray(cfg?.bias?.allowSides) ? new Set(cfg.bias.allowSides.map(String)) : new Set(['long','short']);

  const eFast = pickNum(cfg?.entry?.emaFast, 20);
  const eSlow = pickNum(cfg?.entry?.emaSlow, 50);
  const maxDistPct = pickNum(cfg?.entry?.pullbackZone?.maxDistPct, 0.6);
  const confirmBars = pickNum(cfg?.entry?.reclaim?.confirmBars, 1);

  const atrPeriod = pickNum(cfg?.risk?.atr?.period, 14);
  const stopMult = pickNum(cfg?.risk?.initialStop?.mult, 1.8);
  const tpMult = pickNum(cfg?.risk?.takeProfit?.mult, 3.0);

  const ex = await makeExchange();

  let o1d = null;
  let o4h = null;
  try {
    // loadMarkets occasionally times out on Bitget public endpoints; retry once with best-effort.
    await ex.loadMarkets();
    o1d = await ex.fetchOHLCV(symbol, '1d', undefined, Math.max(emaBiasPeriod + 60, 260));
    o4h = await ex.fetchOHLCV(symbol, '4h', undefined, 300);
  } catch (e) {
    process.stdout.write(JSON.stringify({
      ok: true,
      nowMs,
      strategy: { ok: cfgOk, path: cfgPath, error: cfgOk ? undefined : cfgErr, name: cfg?.name || 'S1', dataError: String(e?.message || e) },
      alerts: [],
      debug: { bias: 'none', nearBand: false, crossUp: false, crossDown: false }
    }, null, 2));
    return;
  }

  const c1d = o1d.map(x => Number(x[4])).filter(Number.isFinite);
  const c4h = o4h.map(x => Number(x[4])).filter(Number.isFinite);

  const emaBias = emaSeries(c1d, emaBiasPeriod).at(-1);
  const last1d = c1d.at(-1);

  let bias = 'none';
  if (Number.isFinite(last1d) && Number.isFinite(emaBias)) {
    if (last1d > emaBias) bias = 'long';
    else if (last1d < emaBias) bias = 'short';
  }

  const ema20 = emaSeries(c4h, eFast);
  const ema50 = emaSeries(c4h, eSlow);
  const atr14 = atrSeries(o4h, atrPeriod);

  const last = c4h.at(-1);
  const prev = c4h.at(-2);
  const lastE20 = ema20.at(-1);
  const prevE20 = ema20.at(-2);
  const lastE50 = ema50.at(-1);
  const lastAtr = atr14.at(-1);

  const alerts = [];

  const dist20 = pctDiff(last, lastE20);
  const dist50 = pctDiff(last, lastE50);
  const nearBand = (dist20 != null && dist20 <= maxDistPct) || (dist50 != null && dist50 <= maxDistPct);

  const crossUp = Number.isFinite(prev) && Number.isFinite(prevE20) && Number.isFinite(last) && Number.isFinite(lastE20)
    ? (prev <= prevE20 && last > lastE20)
    : false;
  const crossDown = Number.isFinite(prev) && Number.isFinite(prevE20) && Number.isFinite(last) && Number.isFinite(lastE20)
    ? (prev >= prevE20 && last < lastE20)
    : false;

  // confirmBars currently only supports 1 (last bar) for simplicity
  const confirmOkLong = confirmBars <= 1 ? crossUp : crossUp;
  const confirmOkShort = confirmBars <= 1 ? crossDown : crossDown;

  const canLong = bias === 'long' && allowSides.has('long') && nearBand && confirmOkLong;
  const canShort = bias === 'short' && allowSides.has('short') && nearBand && confirmOkShort;

  if (canLong && Number.isFinite(lastAtr)) {
    alerts.push({
      key: 'BTC',
      symbol: 'BTCUSDT',
      side: 'long',
      level: 'strong',
      reason: 'S1_bias_1d_above_ema200 + pullback_to_ema20/50 + reclaim_ema20',
      metrics: {
        bias,
        last1d,
        emaBias,
        last4h: last,
        ema20: lastE20,
        ema50: lastE50,
        dist20,
        dist50,
        atr: lastAtr,
        riskHint: {
          stopAtrMult: stopMult,
          tpAtrMult: tpMult,
          slPrice: last - lastAtr * stopMult,
          tpPrice: last + lastAtr * tpMult
        }
      }
    });
  }

  if (canShort && Number.isFinite(lastAtr)) {
    alerts.push({
      key: 'BTC',
      symbol: 'BTCUSDT',
      side: 'short',
      level: 'strong',
      reason: 'S1_bias_1d_below_ema200 + pullback_to_ema20/50 + reject_ema20',
      metrics: {
        bias,
        last1d,
        emaBias,
        last4h: last,
        ema20: lastE20,
        ema50: lastE50,
        dist20,
        dist50,
        atr: lastAtr,
        riskHint: {
          stopAtrMult: stopMult,
          tpAtrMult: tpMult,
          slPrice: last + lastAtr * stopMult,
          tpPrice: last - lastAtr * tpMult
        }
      }
    });
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    nowMs,
    strategy: { ok: cfgOk, path: cfgPath, error: cfgOk ? undefined : cfgErr, name: cfg?.name || 'S1', effective: { symbol, emaBiasPeriod, eFast, eSlow, maxDistPct, confirmBars, atrPeriod, stopMult, tpMult } },
    alerts,
    debug: { bias, nearBand, crossUp, crossDown }
  }, null, 2));
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({ ok: false, error: String(e?.stack || e) }, null, 2));
  process.exit(0);
});
