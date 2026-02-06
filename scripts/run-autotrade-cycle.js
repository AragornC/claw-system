#!/usr/bin/env node
/**
 * Orchestrate one auto-trade cycle:
 * - run market-alert-check.js (technical strong/very-strong)
 * - run blockbeats-news-signal.js (news bullish gate)
 * - combine into one JSON and pipe to bitget-autotrade.js
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { installStdoutEpipeGuard } from './_stdout-epipe-guard.js';

installStdoutEpipeGuard();

const WORKDIR = process.env.OPENCLAW_WORKDIR || process.cwd();

function runNode(scriptRel, { stdinStr } = {}) {
  const script = path.resolve(WORKDIR, scriptRel);
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [script], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.setEncoding('utf8');
    p.stderr.setEncoding('utf8');
    p.stdout.on('data', (c) => (out += c));
    p.stderr.on('data', (c) => (err += c));
    p.on('close', (code) => resolve({ code, out, err }));
    if (stdinStr) p.stdin.write(stdinStr);
    p.stdin.end();
  });
}

function safeParseJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

async function main() {
  const tech = await runNode('scripts/market-alert-check.js');
  const techJson = safeParseJson(tech.out);
  if (!techJson || techJson.ok === false) {
    process.stdout.write(JSON.stringify({ ok: false, stage: 'market-alert-check', stdout: tech.out.slice(0, 2000), stderr: tech.err.slice(0, 2000) }, null, 2));
    return;
  }

  const news = await runNode('scripts/blockbeats-news-signal.js');
  const newsJson = safeParseJson(news.out);
  if (!newsJson || newsJson.ok === false) {
    // News failure should NOT block trading.
    const combined = {
      ok: true,
      nowMs: Date.now(),
      alerts: techJson.alerts || [],
      news: { ok: false, error: newsJson?.error || 'parse_failed' },
    };
    process.stdout.write(JSON.stringify(combined, null, 2));
    return;
  }

  const combined = {
    ok: true,
    nowMs: Date.now(),
    alerts: techJson.alerts || [],
    news: {
      ok: true,
      allow: newsJson.allow || { BTC: false, ETH: false },
      block: newsJson.block || { BTC: false, ETH: false },
      reasons: newsJson.reasons || {},
      blockReasons: newsJson.blockReasons || {},
      windowHours: newsJson.windowHours,
      recencyMinutes: newsJson.recencyMinutes,
    },
  };

  process.stdout.write(JSON.stringify(combined, null, 2));
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({ ok: false, error: String(e?.message || e) }, null, 2));
});
