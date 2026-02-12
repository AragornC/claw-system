#!/usr/bin/env node
/**
 * Dry-run integration bridge:
 * - runs perp-engine in dry-run mode using real market/news data
 * - refreshes report data/viewer output for dashboard
 *
 * Usage:
 *   node scripts/perp-dryrun-live-bridge.js [cycles=1] [intervalSec=15] [maxDecisions=400]
 *
 * Env:
 *   PERP_SIGNAL=v5
 *   PERP_CHART_SYMBOL=BTC/USDT:USDT
 */

import { spawn } from 'node:child_process';
import path from 'node:path';

const WORKDIR = process.env.OPENCLAW_WORKDIR || process.cwd();

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function runNode(scriptRel, args = [], extraEnv = {}) {
  const script = path.resolve(WORKDIR, scriptRel);
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [script, ...args], {
      cwd: WORKDIR,
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    p.stdout.setEncoding('utf8');
    p.stderr.setEncoding('utf8');
    p.stdout.on('data', (c) => (out += c));
    p.stderr.on('data', (c) => (err += c));
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

function nArg(i, fallback, min, max) {
  const n = Number(process.argv[i]);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

async function main() {
  const cycles = nArg(2, 1, 1, 50);
  const intervalSec = nArg(3, 15, 0, 3600);
  const maxDecisions = nArg(4, 400, 50, 1000);
  const signal = process.env.PERP_SIGNAL || 'v5';

  const runs = [];
  for (let i = 0; i < cycles; i++) {
    const r = await runNode('scripts/perp-engine.js', [], {
      DRY_RUN: '1',
      DRY_RUN_FORCE: '1',
      PERP_SIGNAL: signal,
    });
    const parsed = safeJson(r.out);
    runs.push({
      idx: i + 1,
      code: r.code,
      ok: parsed?.ok === true,
      skipped: parsed?.skipped === true,
      executed: parsed?.executed === true,
      dryRunRequested: true,
      dryRunResult: parsed?.dryRun === true ? true : null,
      reason: parsed?.reason || null,
      cycleId: parsed?.cycleId || null,
      error: parsed?.error || null,
      stderr: String(r.err || '').slice(0, 300),
      stdout: parsed ? null : String(r.out || '').slice(0, 300),
    });
    if (i < cycles - 1 && intervalSec > 0) await sleep(intervalSec * 1000);
  }

  const dataRun = await runNode('scripts/perp-report.js', ['data', String(maxDecisions)]);
  const viewerRun = await runNode('scripts/perp-report.js', ['viewer']);

  const out = {
    ok: runs.every((x) => x.code === 0) && dataRun.code === 0 && viewerRun.code === 0,
    mode: 'dryrun_live_bridge',
    signal,
    cycles,
    intervalSec,
    reportMaxDecisions: maxDecisions,
    runs,
    report: {
      dataCode: dataRun.code,
      viewerCode: viewerRun.code,
      dataErr: String(dataRun.err || '').slice(0, 500),
      viewerErr: String(viewerRun.err || '').slice(0, 500),
    },
    next: [
      'node scripts/perp-report.js serve',
      'open http://localhost:8765',
    ],
  };

  process.stdout.write(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({ ok: false, error: String(e?.stack || e) }, null, 2));
  process.exit(1);
});
