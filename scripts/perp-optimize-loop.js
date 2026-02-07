#!/usr/bin/env node
/**
 * perp-optimize-loop.js
 *
 * Runs a small, bounded grid search for V4 Donchian breakout strategy parameters.
 * Writes best candidate + run history to memory/.
 *
 * Goal: find positive net PnL under fee+slippage with reasonable drawdown and enough trades.
 *
 * This script is deterministic and does NOT call any LLM.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const WORKDIR = process.cwd();
const STATE_PATH = path.join(WORKDIR, 'memory', 'v4-optimizer-state.json');
const OUT_BEST_PATH = path.join(WORKDIR, 'memory', 'perp-strategy-v4-best.json');

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

function runBacktest(env) {
  const r = spawnSync(process.execPath, ['scripts/perp-backtest-v4.js'], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  if (r.error) return { ok: false, error: String(r.error) };
  let j;
  try { j = JSON.parse(r.stdout); } catch {
    return { ok: false, error: 'parse_failed', stdout: r.stdout.slice(0, 400) };
  }
  return j;
}

function score(metrics) {
  // Higher is better.
  // Penalize drawdown a bit; encourage more trades.
  const pnl = Number(metrics?.totalPnlUsdt ?? -1e9);
  const dd = Number(metrics?.maxDrawdownUSDT ?? 1e9);
  const trades = Number(metrics?.trades ?? 0);
  return pnl - 0.15 * dd + 0.002 * trades;
}

const now = Date.now();
const state = readJson(STATE_PATH, { lastRunMs: 0, best: null, history: [] });

// Fixed baseline: costs + sizing + timeframes
const baseEnv = {
  DAYS: process.env.DAYS || '180',
  SYMBOL: process.env.SYMBOL || 'BTC/USDT:USDT',

  // sizing (rolling / compounding)
  SIZE_MODE: process.env.SIZE_MODE || 'risk',
  START_EQUITY: process.env.START_EQUITY || '20',
  RISK_PCT: process.env.RISK_PCT || '0.02',
  MAX_LEVERAGE: process.env.MAX_LEVERAGE || '10',
  MIN_NOTIONAL: process.env.MIN_NOTIONAL || '5',
  MAX_NOTIONAL: process.env.MAX_NOTIONAL || '80',
  NOTIONAL: process.env.NOTIONAL || '8',

  // costs
  FEE_PCT: process.env.FEE_PCT || '0.0004',
  SLIPPAGE_PCT: process.env.SLIPPAGE_PCT || '0.0003',

  // bias
  EMA_FAST: process.env.EMA_FAST || '50',
  EMA_SLOW: process.env.EMA_SLOW || '200',
  ADX_TF: process.env.ADX_TF || '1d',
  ADX_PERIOD: process.env.ADX_PERIOD || '14',

  // ATR
  ATR_PERIOD: process.env.ATR_PERIOD || '14',
  MAX_HOLD_BARS: process.env.MAX_HOLD_BARS || '60',
};

// Search space (bounded for 15-min cadence)
// Focus on the more promising direction from the first grid: ENTRY_LOOKBACK=55.
// If we can't get positive expectancy here, we'll revise the model (timeframe/entry/exit) instead of widening this grid.
const grid = [];
for (const ENTRY_LOOKBACK of [55]) {
  for (const EXIT_LOOKBACK of [10, 20]) {
    for (const ADX_MIN of [15, 20]) {
      for (const STOP_ATR_MULT of [2.0, 2.5]) {
        for (const TRAIL_ACTIVATE_ATR of [0.5, 1.0]) {
          for (const TRAIL_MULT of [1.5, 2.0, 2.5]) {
            grid.push({ ENTRY_LOOKBACK, EXIT_LOOKBACK, ADX_MIN, STOP_ATR_MULT, TRAIL_ACTIVATE_ATR, TRAIL_MULT });
          }
        }
      }
    }
  }
}

let best = null;
let bestReport = null;

for (const c of grid) {
  const j = runBacktest({
    ...baseEnv,
    ENTRY_LOOKBACK: String(c.ENTRY_LOOKBACK),
    EXIT_LOOKBACK: String(c.EXIT_LOOKBACK),
    ADX_MIN: String(c.ADX_MIN),
    STOP_ATR_MULT: String(c.STOP_ATR_MULT),
    TRAIL_ACTIVATE_ATR: String(c.TRAIL_ACTIVATE_ATR),
    TRAIL_MULT: String(c.TRAIL_MULT),
  });
  if (!j.ok) continue;

  // basic constraints: need enough trades to match "频率高"
  const trades = Number(j.metrics?.trades ?? 0);
  if (trades < 25) continue;

  const s = score(j.metrics);
  if (!best || s > best.score) {
    best = { ...c, score: s };
    bestReport = j;
  }
}

const runSummary = {
  atMs: now,
  days: Number(baseEnv.DAYS),
  symbol: baseEnv.SYMBOL,
  gridSize: grid.length,
  best: best ? {
    ...best,
    metrics: bestReport?.metrics,
  } : null,
};

state.lastRunMs = now;
state.history = Array.isArray(state.history) ? state.history : [];
state.history.push(runSummary);
state.history = state.history.slice(-50);

if (runSummary.best) {
  const prevBestPnl = Number(state.best?.metrics?.totalPnlUsdt ?? -1e9);
  const newBestPnl = Number(runSummary.best.metrics?.totalPnlUsdt ?? -1e9);

  // Track global best by pnl
  if (!state.best || newBestPnl > prevBestPnl) {
    state.best = runSummary.best;

    // Persist a strategy config draft
    const draft = {
      name: 'V4-best-candidate',
      updatedAtMs: now,
      symbol: baseEnv.SYMBOL,
      params: {
        entry: { lookback: runSummary.best.ENTRY_LOOKBACK },
        exit: { lookback: runSummary.best.EXIT_LOOKBACK },
        bias: { emaFast: Number(baseEnv.EMA_FAST), emaSlow: Number(baseEnv.EMA_SLOW), adxTf: baseEnv.ADX_TF, adxPeriod: Number(baseEnv.ADX_PERIOD), adxMin: runSummary.best.ADX_MIN },
        risk: { atrPeriod: Number(baseEnv.ATR_PERIOD), stopAtrMult: runSummary.best.STOP_ATR_MULT, trailMult: runSummary.best.TRAIL_MULT, trailActivateAtr: runSummary.best.TRAIL_ACTIVATE_ATR, maxHoldBars: Number(baseEnv.MAX_HOLD_BARS) },
        sizing: { mode: baseEnv.SIZE_MODE, startEquity: Number(baseEnv.START_EQUITY), riskPct: Number(baseEnv.RISK_PCT), maxLeverage: Number(baseEnv.MAX_LEVERAGE), minNotional: Number(baseEnv.MIN_NOTIONAL), maxNotional: Number(baseEnv.MAX_NOTIONAL) },
        costs: { feePct: Number(baseEnv.FEE_PCT), slippagePct: Number(baseEnv.SLIPPAGE_PCT) },
      },
      metrics: runSummary.best.metrics,
    };
    writeJson(OUT_BEST_PATH, draft);
  }
}

writeJson(STATE_PATH, state);
process.stdout.write(JSON.stringify({ ok: true, runSummary, globalBest: state.best }, null, 2));
