#!/usr/bin/env node
/**
 * grid-v5-reentry.js
 * Grid search to increase frequency with re-entry after exits.
 */

import { spawnSync } from 'node:child_process';

const combos = [];
for (const ENTRY_LOOKBACK of [20, 15]) {
  for (const ADX_MIN of [20, 18, 15]) {
    for (const REENTRY_TOL_ATR of [0.25, 0.35, 0.5]) {
      for (const REENTRY_WINDOW_BARS of [12, 24, 36]) {
        combos.push({ ENTRY_LOOKBACK, ADX_MIN, REENTRY_TOL_ATR, REENTRY_WINDOW_BARS });
      }
    }
  }
}

function runOne(c) {
  const env = {
    ...process.env,
    DAYS: process.env.DAYS || '180',
    SYMBOL: process.env.SYMBOL || 'BTC/USDT:USDT',

    TRADE_TF: '1h',
    ENTRY_MODE: 'retest',
    ENTRY_LOOKBACK: String(c.ENTRY_LOOKBACK),
    RETEST_WINDOW_BARS: process.env.RETEST_WINDOW_BARS || '32',
    RETEST_TOL_ATR: process.env.RETEST_TOL_ATR || '0.25',

    // bias
    BIAS_EMA_FAST: process.env.BIAS_EMA_FAST || '20',
    BIAS_EMA_SLOW: process.env.BIAS_EMA_SLOW || '50',
    ADX_PERIOD: process.env.ADX_PERIOD || '14',
    ADX_MIN: String(c.ADX_MIN),

    // risk
    ATR_PERIOD: process.env.ATR_PERIOD || '14',
    STOP_ATR_MULT: process.env.STOP_ATR_MULT || '1.8',
    TRAIL_MULT: process.env.TRAIL_MULT || '2.2',
    TRAIL_ACTIVATE_ATR: process.env.TRAIL_ACTIVATE_ATR || '1.2',
    TIMEOUT_BARS: process.env.TIMEOUT_BARS || '240',

    // re-entry
    REENTRY_ENABLED: '1',
    REENTRY_EMA: process.env.REENTRY_EMA || '20',
    REENTRY_TOL_ATR: String(c.REENTRY_TOL_ATR),
    REENTRY_WINDOW_BARS: String(c.REENTRY_WINDOW_BARS),

    // sizing + costs
    SIZE_MODE: process.env.SIZE_MODE || 'risk',
    START_EQUITY: process.env.START_EQUITY || '20',
    RISK_PCT: process.env.RISK_PCT || '0.015',
    MAX_LEVERAGE: process.env.MAX_LEVERAGE || '10',
    MIN_NOTIONAL: process.env.MIN_NOTIONAL || '5',
    MAX_NOTIONAL: process.env.MAX_NOTIONAL || '80',

    THROTTLE_ENABLED: process.env.THROTTLE_ENABLED || '1',
    THROTTLE_AFTER: process.env.THROTTLE_AFTER || '3',
    THROTTLE_RISK_PCT: process.env.THROTTLE_RISK_PCT || '0.008',

    FEE_PCT: process.env.FEE_PCT || '0.0004',
    SLIPPAGE_PCT: process.env.SLIPPAGE_PCT || '0.0003',

    COOLDOWN_BARS: process.env.COOLDOWN_BARS || '2',
    BREAKOUT_BUFFER_ATR: process.env.BREAKOUT_BUFFER_ATR || '0.0'
  };

  const r = spawnSync(process.execPath, ['scripts/perp-backtest-v5.js'], { env, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  if (r.error) return { ...c, ok: false, error: String(r.error) };
  let j;
  try { j = JSON.parse(r.stdout); } catch {
    return { ...c, ok: false, error: 'parse_failed', stdout: r.stdout.slice(0, 400) };
  }
  if (!j.ok) return { ...c, ok: false, error: j.error };

  return {
    ...c,
    ok: true,
    trades: j.metrics?.trades,
    winrate: j.metrics?.winrate,
    totalPnlUsdt: j.metrics?.totalPnlUsdt,
    maxDrawdownUSDT: j.metrics?.maxDrawdownUSDT,
    endEquityUSDT: j.metrics?.endEquityUSDT,
    totalFeesUSDT: j.metrics?.totalFeesUSDT,
  };
}

function score(r) {
  if (!r.ok) return -1e18;
  const pnl = Number(r.totalPnlUsdt ?? -1e9);
  const dd = Number(r.maxDrawdownUSDT ?? 1e9);
  const trades = Number(r.trades ?? 0);
  // Encourage more trades but keep pnl primary; penalize DD.
  return pnl - 0.12 * dd + 0.003 * trades;
}

const rows = [];
for (const c of combos) {
  const row = runOne(c);
  rows.push(row);
  process.stdout.write(JSON.stringify(row) + '\n');
}

const okRows = rows.filter(x => x.ok);
okRows.sort((a, b) => score(b) - score(a));

process.stdout.write('\nSUMMARY_TOP10\n');
for (const r of okRows.slice(0, 10)) process.stdout.write(JSON.stringify(r) + '\n');
