#!/usr/bin/env node
/**
 * One perp cycle:
 * - market-perp-signal.js (BTC long/short) -> alerts
 * - blockbeats-news-signal.js -> news allow/block
 * Output combined JSON for bitget-perp-autotrade.js
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { installStdoutEpipeGuard } from './_stdout-epipe-guard.js';

installStdoutEpipeGuard();

const WORKDIR = process.env.OPENCLAW_WORKDIR || process.cwd();

function runNode(scriptRel) {
  const script = path.resolve(WORKDIR, scriptRel);
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.setEncoding('utf8');
    p.stderr.setEncoding('utf8');
    p.stdout.on('data', (c) => (out += c));
    p.stderr.on('data', (c) => (err += c));
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

function safeParseJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

async function main() {
  // Signal selection:
  // - v1: legacy short-term (15m/5m/1m)
  // - v2: 三维动量金字塔（1D/4H/1H）
  // - v3: S1短波段（1D EMA200 bias + 4H回撤/再启动）
  const mode = (process.env.PERP_SIGNAL || 'v2');
  const sigScript = mode === 'v1'
    ? 'scripts/market-perp-signal.js'
    : (mode === 'v3'
        ? 'scripts/market-perp-signal-v3.js'
        : (mode === 'v5' ? 'scripts/market-perp-signal-v5.js' : 'scripts/market-perp-signal-v2.js'));

  const sig = await runNode(sigScript);
  const sigJson = safeParseJson(sig.out);
  const nowMs = Date.now();

  // Never fail the whole cycle on signal errors; degrade to no_plan and keep ok=true
  // so the scheduler won't spam alerts for transient exchange timeouts.
  if (!sigJson || sigJson.ok === false) {
    const cycleId = String(nowMs);
    process.stdout.write(JSON.stringify({
      ok: true,
      nowMs,
      tradePlanVersion: 1,
      cycleId,
      plan: null,
      decision: { hasAlert: false, blockedByNews: false, newsReason: [] },
      signalError: {
        stage: 'market-perp-signal',
        stdout: String(sig.out || '').slice(0, 2000),
        stderr: String(sig.err || '').slice(0, 2000),
      }
    }, null, 2));
    return;
  }

  const newsRun = await runNode('scripts/blockbeats-news-signal.js');
  const newsJson = safeParseJson(newsRun.out);

  const alerts = sigJson.alerts || [];
  const news = (newsJson && newsJson.ok === true)
    ? {
        ok: true,
        allow: newsJson.allow,
        block: newsJson.block,
        reasons: newsJson.reasons,
        blockReasons: newsJson.blockReasons,
        windowHours: newsJson.windowHours,
        recencyMinutes: newsJson.recencyMinutes,
        items: Array.isArray(newsJson.items) ? newsJson.items.slice(0, 50) : [],
      }
    : { ok: false, error: newsJson?.error || 'news_unavailable' };

  // Pick first BTC alert and map to TradePlan v1.
  const a = Array.isArray(alerts) ? alerts.find((x) => x?.key === 'BTC') : null;

  // Determine whether this intent should be blocked by news.
  let blockedByNews = false;
  let newsReason = [];
  if (news?.ok === true && a) {
    const allow = news?.allow || {};
    const block = news?.block || {};
    const reasons = news?.reasons || {};
    const blockReasons = news?.blockReasons || {};
    if (a.side === 'long' && block?.BTC === true) {
      blockedByNews = true;
      newsReason = blockReasons?.BTC || [];
    }
    if (a.side === 'short' && allow?.BTC === true) {
      blockedByNews = true;
      newsReason = reasons?.BTC || [];
    }
  }

  const tradePlan = {
    ok: true,
    nowMs,
    tradePlanVersion: 1,
    cycleId: String(nowMs),
    plan: a
      ? {
          symbol: a.symbol || 'BTCUSDT',
          side: a.side,
          level: a.level,
          reason: a.reason,
        }
      : null,
    decision: {
      hasAlert: Boolean(a),
      blockedByNews,
      newsReason,
    },
    // Keep raw context for debug/audit. Execution layer can choose to ignore.
    news,
    alerts,
    signalMeta: sigJson ? { note: sigJson.note, bias: sigJson.bias, meta: sigJson.meta } : null,
  };

  process.stdout.write(JSON.stringify(tradePlan, null, 2));
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({ ok: false, error: String(e?.message || e) }, null, 2));
});
