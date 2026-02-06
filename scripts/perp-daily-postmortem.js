#!/usr/bin/env node
/**
 * Daily post-mortem for Bitget perp autotrade.
 * Reads:
 * - memory/bitget-perp-autotrade-trades.jsonl
 * - memory/bitget-perp-autotrade-state.json
 * - memory/bitget-perp-autotrade-cycles.jsonl (optional)
 *
 * Outputs a concise TEXT report (Telegram-friendly).
 */

import fs from 'node:fs';
import path from 'node:path';

const WORKDIR = process.env.OPENCLAW_WORKDIR || process.cwd();
const STATE_PATH = path.resolve(WORKDIR, 'memory/bitget-perp-autotrade-state.json');
const TRADES_PATH = path.resolve(WORKDIR, 'memory/bitget-perp-autotrade-trades.jsonl');
const CYCLES_PATH = path.resolve(WORKDIR, 'memory/bitget-perp-autotrade-cycles.jsonl');

function todayCN(d = new Date()) {
  return d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

function safeReadJson(p, fallback = null) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function readJsonl(p) {
  try {
    const s = fs.readFileSync(p, 'utf8');
    return s.split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function fmt(n, digits = 4) {
  if (n == null || !Number.isFinite(Number(n))) return 'NA';
  const x = Number(n);
  const d = Math.max(0, digits);
  return (Math.abs(x) >= 1 ? x.toFixed(Math.min(2, d)) : x.toFixed(d));
}

function groupCount(arr, keyFn) {
  const m = new Map();
  for (const x of arr) {
    const k = keyFn(x);
    m.set(k, (m.get(k) || 0) + 1);
  }
  return Object.fromEntries([...m.entries()].sort((a, b) => b[1] - a[1]));
}

function summarizeDay(trades, date) {
  const dayTrades = trades.filter(t => (t?.tsLocal || t?.ts || '').startsWith(date));
  const opens = dayTrades.filter(t => t.event === 'open');
  const closes = dayTrades.filter(t => t.event === 'close');

  const pnlVals = closes.map(c => Number(c.pnlEstUSDT)).filter(Number.isFinite);
  const pnlSum = pnlVals.reduce((a, b) => a + b, 0);
  const wins = pnlVals.filter(x => x > 0).length;
  const losses = pnlVals.filter(x => x < 0).length;
  const flat = pnlVals.filter(x => x === 0).length;

  // Pair by openOrderId to compute hold minutes.
  const openById = new Map();
  for (const o of opens) {
    if (o.orderId) openById.set(String(o.orderId), o);
  }
  const holdMins = [];
  for (const c of closes) {
    const oid = c.openOrderId ? String(c.openOrderId) : null;
    const o = oid ? openById.get(oid) : null;
    if (o?.openedAtMs && c.tsUtc) {
      const closeMs = Date.parse(c.tsUtc);
      if (Number.isFinite(closeMs)) {
        holdMins.push((closeMs - Number(o.openedAtMs)) / 60000);
      }
    }
  }
  const holdAvg = holdMins.length ? holdMins.reduce((a, b) => a + b, 0) / holdMins.length : null;

  return {
    opens,
    closes,
    pnlSum,
    wins,
    losses,
    flat,
    holdAvg,
    reasons: groupCount(closes, c => c.reason || 'unknown'),
    sides: groupCount(opens, o => o.side || 'unknown'),
    levels: groupCount(opens, o => o.level || 'unknown'),
  };
}

function summarizeCycles(cycles, date) {
  const day = cycles.filter(x => (x?.date === date) || (String(x?.ts || '').startsWith(date)));
  const counts = groupCount(day, x => x.summary || 'unknown');
  return { total: day.length, counts };
}

function main() {
  const state = safeReadJson(STATE_PATH, {});
  const date = state?.date || todayCN();

  const trades = readJsonl(TRADES_PATH);
  const cycles = readJsonl(CYCLES_PATH);

  const t = summarizeDay(trades, date);
  const c = summarizeCycles(cycles, date);

  const realized = Number(state?.dailyRealizedPnlUSDT);
  const realizedOk = Number.isFinite(realized);

  const lines = [];
  lines.push(`## 今日概览（Bitget 永续合约自动交易复盘 | ${date}）`);
  lines.push(`- **开仓次数**：${t.opens.length}`);
  lines.push(`- **平仓次数**：${t.closes.length}`);
  lines.push(`- **方向分布**：${Object.entries(t.sides).map(([k, v]) => `${k}:${v}`).join('，') || '无'}`);
  lines.push(`- **信号强度**：${Object.entries(t.levels).map(([k, v]) => `${k}:${v}`).join('，') || '无'}`);
  lines.push(`- **已实现 PnL（估算）**：${realizedOk ? fmt(realized, 4) : fmt(t.pnlSum, 4)} USDT`);
  lines.push(`- **胜/负/平**：${t.wins}/${t.losses}/${t.flat}`);
  lines.push(`- **平均持仓时长**：${t.holdAvg == null ? 'NA' : `${fmt(t.holdAvg, 2)} 分钟`}`);

  lines.push('');
  lines.push('## 平仓原因分布');
  if (t.closes.length === 0) {
    lines.push('- 无（今日无平仓记录）');
  } else {
    for (const [k, v] of Object.entries(t.reasons)) {
      lines.push(`- ${k}: ${v}`);
    }
  }

  lines.push('');
  lines.push('## 轮询/信号统计（cycles）');
  lines.push(`- cycles 记录条数：${c.total}`);
  const topKeys = Object.entries(c.counts).slice(0, 6);
  if (!topKeys.length) lines.push('- 无');
  else topKeys.forEach(([k, v]) => lines.push(`- ${k}: ${v}`));

  // Quick hints
  lines.push('');
  lines.push('## 备注');
  lines.push('- 若出现“交易所侧已平仓但本地仍认为有仓”的情况，守护脚本会自动对账并同步状态（并会触发一次同步提示）。');

  process.stdout.write(lines.join('\n'));
}

main();
