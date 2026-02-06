#!/usr/bin/env node
/**
 * grid-v5-retest.js
 * Small grid search for V5 retest-mode parameters.
 * Outputs JSONL and a SUMMARY_TOP10.
 */

import { spawnSync } from 'node:child_process';

const combos = [];
for (const ENTRY_LOOKBACK of [12, 15, 20]) {
  for (const RETEST_WINDOW_BARS of [16, 24, 32]) {
    for (const ADX_MIN of [15, 18, 20]) {
      combos.push({ ENTRY_LOOKBACK, RETEST_WINDOW_BARS, ADX_MIN });
    }
  }
}

function runOne(c) {
  const env = {
    ...process.env,
    DAYS: process.env.DAYS || '180',
    SYMBOL: process.env.SYMBOL || 'BTC/USDT:USDT',

    // choose mode
    TRADE_TF: process.env.TRADE_TF || '1h',
    ENTRY_MODE: 'retest',
    ENTRY_LOOKBACK: String(c.ENTRY_LOOKBACK),
    RETEST_WINDOW_BARS: String(c.RETEST_WINDOW_BARS),
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

    // not used in retest, but keep deterministic
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

function score(row) {
  if (!row.ok) return -1e18;
  const pnl = Number(row.totalPnlUsdt ?? -1e9);
  const dd = Number(row.maxDrawdownUSDT ?? 1e9);
  const trades = Number(row.trades ?? 0);
  // Prefer positive pnl, then smaller dd, then higher trades.
  return pnl - 0.1 * dd + 0.001 * trades;
}

const rows = [];
for (const c of combos) {
  const row = runOne(c);
  rows.push(row);
  process.stdout.write(JSON.stringify(row) + '\n');
}

const okRows = rows.filter(r => r.ok);
okRows.sort((a, b) => score(b) - score(a));

process.stdout.write('\nSUMMARY_TOP10\n');
for (const r of okRows.slice(0, 10)) {
  process.stdout.write(JSON.stringify(r) + '\n');
}
