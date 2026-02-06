#!/usr/bin/env node
/**
 * 1-min position guard for Bitget perp.
 * - If openPosition exists, check last price and close on TP/SL or timeout.
 * - Updates state + appends trades log.
 *
 * Output JSON (for cron agent to optionally notify):
 * { ok:true, action:"hold"|"closed", reason, closeOrderId, pnlEstUSDT }
 * reason may be: take_profit | stop_loss | timeout | trailing_stop | reverse_signal
 */

import fs from 'node:fs';
import path from 'node:path';
import ccxt from 'ccxt';
import { spawn } from 'node:child_process';

const WORKDIR = process.env.OPENCLAW_WORKDIR || process.cwd();
const CONFIG_PATH = path.resolve(WORKDIR, 'memory/bitget-perp-autotrade-config.json');
const STATE_PATH = path.resolve(WORKDIR, 'memory/bitget-perp-autotrade-state.json');
const TRADES_PATH = path.resolve(WORKDIR, 'memory/bitget-perp-autotrade-trades.jsonl');
const HEALTH_PATH = path.resolve(WORKDIR, 'memory/bitget-perp-guard-health.json');

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}
function appendJsonl(p, obj) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(obj) + '\n');
  } catch {}
}
function todayCN() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

function readHealth() {
  try { return JSON.parse(fs.readFileSync(HEALTH_PATH, 'utf8')); } catch { return { consecutiveErrors: 0, lastErrorAtMs: 0, lastError: null }; }
}
function writeHealth(h) {
  try {
    fs.mkdirSync(path.dirname(HEALTH_PATH), { recursive: true });
    fs.writeFileSync(HEALTH_PATH, JSON.stringify(h, null, 2));
  } catch {}
}

async function makeExchange() {
  const apiKey = process.env.BITGET_API_KEY || '';
  const secret = process.env.BITGET_API_SECRET || '';
  const password = process.env.BITGET_API_PASSPHRASE || '';
  if (!apiKey || !secret || !password) throw new Error('Missing BITGET env vars');

  return new ccxt.bitget({
    apiKey,
    secret,
    password,
    enableRateLimit: true,
    timeout: 25000,
    options: { defaultType: 'swap' },
  });
}

function runPerpSignal() {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.resolve(WORKDIR, 'scripts/market-perp-signal.js')], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (c) => (out += c));
    p.on('close', () => {
      try {
        const j = JSON.parse(out);
        resolve(j);
      } catch {
        resolve(null);
      }
    });
  });
}

function estimatePnlUSDT(pos, last) {
  const qty = Number(pos.amount || 0);
  const entry = Number(pos.entryPrice || 0);
  if (!(qty > 0 && entry > 0 && last > 0)) return null;
  const delta = (pos.side === 'long') ? (last - entry) : (entry - last);
  return delta * qty;
}

async function reconcileIfExchangeClosed(ex, state, pos, last) {
  // CCXT Bitget currently doesn't support fetchPositions() in our environment.
  // To avoid "local thinks position exists" getting stuck, we reconcile via recent trades.
  // If we observe a close trade after openedAtMs, we clear local state.
  try {
    const since = Math.max(0, Number(pos.openedAtMs || 0) - 10 * 60 * 1000);
    const trades = await ex.fetchMyTrades(pos.symbol, since, 50);
    const closes = trades
      .filter(t => t?.info?.tradeSide === 'close')
      .filter(t => Number(t?.timestamp || 0) >= Number(pos.openedAtMs || 0));

    if (!closes.length) return false;

    const close = closes[closes.length - 1];
    const closePx = Number(close?.price || last);
    const pnlEst = estimatePnlUSDT(pos, closePx);

    // prefer exchange reported profit when present
    const exProfit = safeNumber(close?.info?.profit);
    const pnlFinal = exProfit != null ? exProfit : pnlEst;

    if (pnlFinal != null) state.dailyRealizedPnlUSDT = Number(state.dailyRealizedPnlUSDT || 0) + pnlFinal;

    const tsUtc = new Date(Number(close.timestamp)).toISOString();
    const tsLocal = new Date(Number(close.timestamp)).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }) + '+08:00';

    appendJsonl(TRADES_PATH, {
      ts: tsLocal,
      tsUtc,
      event: 'close',
      symbol: pos.symbol,
      side: pos.side,
      amount: pos.amount,
      entryPrice: pos.entryPrice,
      closePrice: closePx,
      reason: 'exchange_auto_close',
      pnlEstUSDT: pnlFinal,
      openOrderId: pos.orderId,
      closeOrderId: close?.order || close?.info?.orderId || null,
      note: {
        enterPointSource: close?.info?.enterPointSource || null,
        tradeId: close?.id || null,
      },
    });

    state.openPosition = null;
    writeJson(STATE_PATH, state);

    process.stdout.write(JSON.stringify({
      ok: true,
      action: 'closed',
      reason: 'exchange_auto_close',
      note: 'reconciled from exchange trades; cleared local openPosition',
      closeOrderId: close?.order || close?.info?.orderId || null,
      pnlEstUSDT: pnlFinal,
      closePrice: closePx,
      entryPrice: pos.entryPrice,
    }, null, 2));

    return true;
  } catch {
    // Best-effort only; never block guard loop on reconciliation.
    return false;
  }
}

function safeNumber(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

async function main() {
  const cfg = readJson(CONFIG_PATH, null);
  const state = readJson(STATE_PATH, { date: null, tradesToday: 0, dailyRealizedPnlUSDT: 0, lastTradeAtMs: 0, openPosition: null });

  const today = todayCN();
  if (state.date !== today) {
    state.date = today;
    state.tradesToday = 0;
    state.dailyRealizedPnlUSDT = 0;
    state.lastTradeAtMs = 0;
    state.openPosition = null;
    writeJson(STATE_PATH, state);
  }

  const pos = state.openPosition;
  if (!pos) {
    process.stdout.write(JSON.stringify({ ok: true, action: 'hold', reason: 'no_position' }, null, 2));
    return;
  }

  const health = readHealth();
  const ex = await makeExchange();

  // If ATR-mode, ensure we have atrAtEntry stored (for trailing calc).
  try {
    const riskMode = String(cfg?.risk?.mode || 'percent');
    if (riskMode === 'atr' && pos?.trailing && (pos.trailing.atrAtEntry == null)) {
      // compute ATR from recent candles
      const tf = String(cfg?.risk?.atr?.tf || '1h');
      const period = Number(cfg?.risk?.atr?.period || 14);
      const ohlcv = await ex.fetchOHLCV(pos.symbol, tf, undefined, Math.max(50, period + 5));
      // inline Wilder ATR
      const tr = [];
      for (let i = 1; i < ohlcv.length; i++) {
        const prevClose = Number(ohlcv[i - 1][4]);
        const high = Number(ohlcv[i][2]);
        const low = Number(ohlcv[i][3]);
        const t = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
        tr.push(t);
      }
      let atr = null;
      if (tr.length >= period) {
        let a = tr.slice(0, period).reduce((x, y) => x + y, 0) / period;
        for (let i = period; i < tr.length; i++) a = (a * (period - 1) + tr[i]) / period;
        atr = a;
      }
      if (Number.isFinite(atr) && atr > 0) {
        pos.trailing.atrAtEntry = atr;
        state.openPosition = pos;
        writeJson(STATE_PATH, state);
      }
    }
  } catch {}

  // Network resilience:
  // CCXT Bitget sometimes tries to hit spot/margin endpoints during loadMarkets()/fetchTicker().
  // We (1) avoid loadMarkets here, and (2) retry on transient network failures.
  async function withRetries(fn, tries = 3) {
    let lastErr = null;
    for (let i = 0; i < tries; i++) {
      try {
        return await fn();
      } catch (e) {
        lastErr = e;
        const msg = String(e?.message || e);
        const transient = msg.includes('fetch failed') || msg.includes('NetworkError') || msg.includes('ETIMEDOUT') || msg.includes('ECONNRESET');
        if (!transient) break;
        // small backoff: 400ms, 900ms
        await new Promise(r => setTimeout(r, 400 + i * 500));
      }
    }
    throw lastErr;
  }

  // Best-effort ensure exchange settings are consistent (hedge/oneway can drift).
  try {
    if (cfg?.positionMode === 'hedge') await withRetries(() => ex.setPositionMode(true, pos.symbol), 2);
    else if (cfg?.positionMode === 'oneway') await withRetries(() => ex.setPositionMode(false, pos.symbol), 2);
  } catch {}
  try { if (cfg?.marginMode) await withRetries(() => ex.setMarginMode(cfg.marginMode, pos.symbol), 2); } catch {}
  try { if (cfg?.leverage) await withRetries(() => ex.setLeverage(cfg.leverage, pos.symbol), 2); } catch {}

  let ticker;
  try {
    ticker = await withRetries(() => ex.fetchTicker(pos.symbol), 3);
  } catch (e) {
    // Only alarm after N consecutive transient errors to avoid noise.
    const msg = String(e?.message || e);
    const transient = msg.includes('RequestTimeout') || msg.includes('fetch failed') || msg.includes('NetworkError') || msg.includes('ETIMEDOUT') || msg.includes('ECONNRESET');

    const next = {
      consecutiveErrors: Number(health.consecutiveErrors || 0) + 1,
      lastErrorAtMs: Date.now(),
      lastError: msg.slice(0, 400),
    };
    writeHealth(next);

    const threshold = Number(process.env.GUARD_ERROR_THRESHOLD || 3);
    if (transient && next.consecutiveErrors < threshold) {
      process.stdout.write(JSON.stringify({
        ok: true,
        action: 'hold',
        reason: 'transient_error',
        consecutiveErrors: next.consecutiveErrors,
        threshold,
        note: 'temporary network timeout; will only alert after threshold',
        error: msg.slice(0, 200),
      }, null, 2));
      return;
    }

    // Non-transient or exceeded threshold: escalate
    process.stdout.write(JSON.stringify({ ok: false, error: msg }, null, 2));
    return;
  }

  // success -> reset health counter
  writeHealth({ consecutiveErrors: 0, lastErrorAtMs: 0, lastError: null });

  const last = Number(ticker?.last);
  if (!Number.isFinite(last) || last <= 0) throw new Error('last_price_unavailable');

  // Reconcile first: if exchange already closed the position (TP/SL/sys/manual),
  // clear local state so we don't get stuck in position_open forever.
  if (await reconcileIfExchangeClosed(ex, state, pos, last)) return;

  const now = Date.now();
  const heldMin = (now - Number(pos.openedAtMs || now)) / 60000;

  let shouldClose = false;
  let reason = '';

  // Trailing stop (software).
  // Supports percent-mode (legacy) and atr-mode (preferred).
  const trailingCfg = cfg?.risk?.trailing || {};
  const trailingEnabled = Boolean(trailingCfg.enabled);
  const riskMode = String(cfg?.risk?.mode || 'percent');
  if (trailingEnabled) {
    const activationProfitPct = Number(cfg?.risk?.fallback?.activationProfitPct ?? trailingCfg.activationProfitPct ?? 0);
    const trailPct = Number(cfg?.risk?.fallback?.trailPct ?? trailingCfg.trailPct ?? 0);
    const activateAtAtr = Number(trailingCfg.activateAtAtr ?? 0);
    const trailAtrMult = Number(trailingCfg.trailAtrMult ?? 0);

    // Initialize trailing state if missing (handles positions opened before trailing was enabled)
    if (!pos.trailing || typeof pos.trailing !== 'object') {
      pos.trailing = { enabled: true, activationProfitPct, trailPct, activateAtAtr, trailAtrMult, atrAtEntry: null, bestPrice: pos.entryPrice, stopPrice: null, active: false, mode: riskMode };
    }
    // keep fields in sync
    pos.trailing.activationProfitPct = activationProfitPct;
    pos.trailing.trailPct = trailPct;
    pos.trailing.activateAtAtr = activateAtAtr;
    pos.trailing.trailAtrMult = trailAtrMult;
    pos.trailing.mode = pos.trailing.mode || riskMode;
    const useAtr = (riskMode === 'atr') && Number.isFinite(pos?.trailing?.atrAtEntry) && Number(pos.trailing.atrAtEntry) > 0 && Number.isFinite(activateAtAtr) && Number.isFinite(trailAtrMult) && trailAtrMult > 0;

    if (pos.side === 'long') {
      if (last > Number(pos.trailing.bestPrice || pos.entryPrice)) pos.trailing.bestPrice = last;

      if (useAtr) {
        const favorable = Number(pos.trailing.bestPrice) - Number(pos.entryPrice);
        if (!pos.trailing.active && favorable >= Number(pos.trailing.atrAtEntry) * activateAtAtr) pos.trailing.active = true;
        if (pos.trailing.active) {
          const newStop = Number(pos.trailing.bestPrice) - Number(pos.trailing.atrAtEntry) * trailAtrMult;
          pos.trailing.stopPrice = Math.max(Number(pos.slPrice), newStop);
          if (last <= pos.trailing.stopPrice) { shouldClose = true; reason = 'trailing_stop'; }
        }
      } else {
        const profitPct = (last - pos.entryPrice) / pos.entryPrice;
        if (!pos.trailing.active && profitPct >= activationProfitPct) pos.trailing.active = true;
        if (pos.trailing.active) {
          const newStop = Number(pos.trailing.bestPrice) * (1 - trailPct);
          pos.trailing.stopPrice = Math.max(Number(pos.slPrice), newStop);
          if (last <= pos.trailing.stopPrice) { shouldClose = true; reason = 'trailing_stop'; }
        }
      }
    } else {
      if (last < Number(pos.trailing.bestPrice || pos.entryPrice)) pos.trailing.bestPrice = last;

      if (useAtr) {
        const favorable = Number(pos.entryPrice) - Number(pos.trailing.bestPrice);
        if (!pos.trailing.active && favorable >= Number(pos.trailing.atrAtEntry) * activateAtAtr) pos.trailing.active = true;
        if (pos.trailing.active) {
          const newStop = Number(pos.trailing.bestPrice) + Number(pos.trailing.atrAtEntry) * trailAtrMult;
          pos.trailing.stopPrice = Math.min(Number(pos.slPrice), newStop);
          if (last >= pos.trailing.stopPrice) { shouldClose = true; reason = 'trailing_stop'; }
        }
      } else {
        const profitPct = (pos.entryPrice - last) / pos.entryPrice;
        if (!pos.trailing.active && profitPct >= activationProfitPct) pos.trailing.active = true;
        if (pos.trailing.active) {
          const newStop = Number(pos.trailing.bestPrice) * (1 + trailPct);
          pos.trailing.stopPrice = Math.min(Number(pos.slPrice), newStop);
          if (last >= pos.trailing.stopPrice) { shouldClose = true; reason = 'trailing_stop'; }
        }
      }
    }

    // Persist trailing state updates even if we don't close.
    state.openPosition = pos;
    writeJson(STATE_PATH, state);
  }

  if (pos.side === 'long') {
    if (last >= pos.tpPrice) { shouldClose = true; reason = 'take_profit'; }
    else if (last <= pos.slPrice) { shouldClose = true; reason = 'stop_loss'; }
  } else {
    if (last <= pos.tpPrice) { shouldClose = true; reason = 'take_profit'; }
    else if (last >= pos.slPrice) { shouldClose = true; reason = 'stop_loss'; }
  }

  // Reverse-signal exit with confirmation count.
  // Only close after N consecutive opposite signals (default 2) to reduce noise.
  if (!shouldClose) {
    const confirmations = Math.max(1, Number(cfg?.risk?.reverseSignal?.confirmations || 2));
    const sig = await runPerpSignal();
    const a = Array.isArray(sig?.alerts) ? sig.alerts.find(x => x?.key === 'BTC') : null;
    const gotSignal = a && (a.side === 'long' || a.side === 'short');
    const opposite = gotSignal && ((pos.side === 'long' && a.side === 'short') || (pos.side === 'short' && a.side === 'long'));

    pos.reverseSignal = pos.reverseSignal && typeof pos.reverseSignal === 'object'
      ? pos.reverseSignal
      : { count: 0, lastSide: null, confirmations };

    if (opposite) {
      pos.reverseSignal.count = Number(pos.reverseSignal.count || 0) + 1;
      pos.reverseSignal.lastSide = a.side;
      pos.reverseSignal.confirmations = confirmations;
      state.openPosition = pos;
      writeJson(STATE_PATH, state);

      if (pos.reverseSignal.count >= confirmations) {
        shouldClose = true;
        reason = 'reverse_signal';
      } else {
        process.stdout.write(JSON.stringify({ ok: true, action: 'hold', reason: 'reverse_signal_pending', last, heldMin, pnlEstUSDT: estimatePnlUSDT(pos, last), reverseSignal: pos.reverseSignal }, null, 2));
        return;
      }
    } else {
      // reset when not opposite
      if (pos.reverseSignal.count !== 0) {
        pos.reverseSignal.count = 0;
        pos.reverseSignal.lastSide = gotSignal ? a.side : null;
        state.openPosition = pos;
        writeJson(STATE_PATH, state);
      }
    }
  }

  if (!shouldClose && cfg?.risk?.maxHoldMinutes && heldMin >= cfg.risk.maxHoldMinutes) {
    const pnlNow = estimatePnlUSDT(pos, last);

    // 更激进趋势友好版：盈利永不因 timeout 平仓，只收紧 trailing；亏损才 timeout 平仓。
    if (pnlNow != null && pnlNow > 0) {
      const tt = Number(cfg?.risk?.trailing?.timeoutTrailPct || 0);
      if (trailingEnabled && tt > 0) {
        pos.trailing.active = true;
        pos.trailing.trailPct = tt;
        // update stopPrice immediately based on current bestPrice
        if (pos.side === 'long') {
          const newStop = Number(pos.trailing.bestPrice) * (1 - tt);
          pos.trailing.stopPrice = Math.max(Number(pos.slPrice), newStop);
        } else {
          const newStop = Number(pos.trailing.bestPrice) * (1 + tt);
          pos.trailing.stopPrice = Math.min(Number(pos.slPrice), newStop);
        }
        state.openPosition = pos;
        writeJson(STATE_PATH, state);
      }
      process.stdout.write(JSON.stringify({ ok: true, action: 'hold', reason: 'timeout_tighten_trailing', last, heldMin, pnlEstUSDT: pnlNow, trailing: pos.trailing || null }, null, 2));
      return;
    }

    // 亏损/不盈利：按 timeout 兜底平仓
    shouldClose = true;
    reason = 'timeout';
  }

  if (!shouldClose) {
    const pnlNow = estimatePnlUSDT(pos, last);
    process.stdout.write(JSON.stringify({ ok: true, action: 'hold', reason: 'in_range', last, heldMin, pnlEstUSDT: pnlNow, trailing: pos.trailing || null }, null, 2));
    return;
  }

  const closeSide = pos.side === 'long' ? 'sell' : 'buy';

  let closeOrder;
  try {
    // CCXT Bitget: params.hedged is a MODE FLAG (true=hedge mode, false=one-way), not side.
    // In hedge mode, CCXT will set posSide based on order side (buy->short when reduceOnly, sell->long, etc.).
    const params = { reduceOnly: true };
    if (cfg?.positionMode === 'hedge') params.hedged = true;

    closeOrder = await ex.createOrder(pos.symbol, 'market', closeSide, pos.amount, undefined, params);
  } catch (e) {
    const msg = String(e?.message || e);
    // Bitget: {"code":"22002","msg":"No position to close"}
    // This typically means the position was already closed on the exchange side
    // (TP/SL trigger, manual close, etc.). Reconcile local state to avoid repeated failures.
    if (msg.includes('22002') || msg.toLowerCase().includes('no position to close')) {
      const tsUtc = new Date().toISOString();
      const tsLocal = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace(' ', ' ') + '+08:00';
      const closePx = last;
      const pnlEst = estimatePnlUSDT(pos, closePx);

      appendJsonl(TRADES_PATH, {
        ts: tsLocal,
        tsUtc,
        event: 'close',
        symbol: pos.symbol,
        side: pos.side,
        amount: pos.amount,
        entryPrice: pos.entryPrice,
        closePrice: closePx,
        reason: 'exchange_no_position',
        pnlEstUSDT: pnlEst,
        openOrderId: pos.orderId,
        closeOrderId: null,
      });

      state.openPosition = null;
      writeJson(STATE_PATH, state);

      process.stdout.write(JSON.stringify({
        ok: true,
        action: 'closed',
        reason: 'exchange_no_position',
        note: 'exchange reported no position; reconciled local state',
        pnlEstUSDT: pnlEst,
        closePrice: closePx,
        entryPrice: pos.entryPrice,
      }, null, 2));
      return;
    }

    throw e;
  }

  const closePx = Number(closeOrder?.average || closeOrder?.price || last);
  const pnlEst = estimatePnlUSDT(pos, closePx);

  // Update daily pnl estimate (best-effort)
  if (pnlEst != null) state.dailyRealizedPnlUSDT = Number(state.dailyRealizedPnlUSDT || 0) + pnlEst;

  const tsUtc = new Date().toISOString();
  const tsLocal = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace(' ', ' ') + '+08:00';

  appendJsonl(TRADES_PATH, {
    ts: tsLocal,
    tsUtc,
    event: 'close',
    symbol: pos.symbol,
    side: pos.side,
    amount: pos.amount,
    entryPrice: pos.entryPrice,
    closePrice: closePx,
    reason,
    pnlEstUSDT: pnlEst,
    openOrderId: pos.orderId,
    closeOrderId: closeOrder?.id || null,
  });

  state.openPosition = null;
  writeJson(STATE_PATH, state);

  process.stdout.write(JSON.stringify({ ok: true, action: 'closed', reason, closeOrderId: closeOrder?.id || null, pnlEstUSDT: pnlEst, closePrice: closePx, entryPrice: pos.entryPrice }, null, 2));
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({ ok: false, error: String(e?.stack || e) }, null, 2));
  process.exit(0);
});
