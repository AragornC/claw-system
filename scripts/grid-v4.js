#!/usr/bin/env node
/**
 * Grid runner for perp-backtest-v4.js
 * Prints JSONL rows and a final markdown-ish summary.
 */

import { spawnSync } from 'node:child_process';

const combos = [];
for (const ENTRY_LOOKBACK of [20, 55]) {
  for (const EXIT_LOOKBACK of [10, 20]) {
    for (const ADX_MIN of [15, 20, 25]) {
      for (const STOP_ATR_MULT of [2.0, 2.5]) {
        combos.push({ ENTRY_LOOKBACK, EXIT_LOOKBACK, ADX_MIN, STOP_ATR_MULT });
      }
    }
  }
}

function runOne(c) {
  const env = {
    ...process.env,
    DAYS: process.env.DAYS || '180',
    SYMBOL: process.env.SYMBOL || 'BTC/USDT:USDT',
    // sizing/costs fixed
    SIZE_MODE: process.env.SIZE_MODE || 'risk',
    START_EQUITY: process.env.START_EQUITY || '20',
    RISK_PCT: process.env.RISK_PCT || '0.02',
    MAX_LEVERAGE: process.env.MAX_LEVERAGE || '10',
    MIN_NOTIONAL: process.env.MIN_NOTIONAL || '5',
    MAX_NOTIONAL: process.env.MAX_NOTIONAL || '80',
    NOTIONAL: process.env.NOTIONAL || '8',
    FEE_PCT: process.env.FEE_PCT || '0.0004',
    SLIPPAGE_PCT: process.env.SLIPPAGE_PCT || '0.0003',

    EMA_FAST: process.env.EMA_FAST || '50',
    EMA_SLOW: process.env.EMA_SLOW || '200',
    ADX_TF: process.env.ADX_TF || '1d',
    ADX_PERIOD: process.env.ADX_PERIOD || '14',

    ENTRY_LOOKBACK: String(c.ENTRY_LOOKBACK),
    EXIT_LOOKBACK: String(c.EXIT_LOOKBACK),
    ADX_MIN: String(c.ADX_MIN),

    ATR_PERIOD: process.env.ATR_PERIOD || '14',
    STOP_ATR_MULT: String(c.STOP_ATR_MULT),
    TRAIL_MULT: process.env.TRAIL_MULT || '2.0',
    TRAIL_ACTIVATE_ATR: process.env.TRAIL_ACTIVATE_ATR || '1.0',
    MAX_HOLD_BARS: process.env.MAX_HOLD_BARS || '60',
  };

  const r = spawnSync(process.execPath, ['scripts/perp-backtest-v4.js'], { env, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  if (r.error) {
    return { ...c, ok: false, error: String(r.error) };
  }
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

const rows = [];
for (const c of combos) {
  const row = runOne(c);
  rows.push(row);
  process.stdout.write(JSON.stringify(row) + '\n');
}

const okRows = rows.filter(r => r.ok);
okRows.sort((a, b) => (b.totalPnlUsdt ?? -1e9) - (a.totalPnlUsdt ?? -1e9));

process.stdout.write('\nSUMMARY_TOP5\n');
for (const r of okRows.slice(0, 5)) {
  process.stdout.write(JSON.stringify(r) + '\n');
}
