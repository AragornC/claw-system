#!/usr/bin/env node
/**
 * Perp engine wrapper (single-command run):
 * - runs run-perp-cycle.js -> TradePlan v1
 * - feeds it to bitget-perp-autotrade.js via stdin
 *
 * Output: JSON from bitget-perp-autotrade.js (plus debug fields on failure)
 * Side-effect: appends a decision record to memory/bitget-perp-cycle-decisions.jsonl
 *   for visualization (why we did or did not order this run).
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const WORKDIR = process.env.OPENCLAW_WORKDIR || process.cwd();
const DECISIONS_PATH = path.resolve(WORKDIR, 'memory/bitget-perp-cycle-decisions.jsonl');

function runNode(scriptRel, stdinText = null) {
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
    if (stdinText != null) p.stdin.end(stdinText);
    else p.stdin.end();
  });
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function appendDecisionRecord(record) {
  try {
    fs.mkdirSync(path.dirname(DECISIONS_PATH), { recursive: true });
    fs.appendFileSync(DECISIONS_PATH, JSON.stringify(record) + '\n');
  } catch {}
}

async function main() {
  const cycle = await runNode('scripts/run-perp-cycle.js');
  const cycleJson = safeJson(cycle.out);
  if (!cycleJson || cycleJson.ok === false) {
    appendDecisionRecord({
      ts: new Date().toISOString(),
      stage: 'run-perp-cycle',
      ok: false,
      error: 'cycle_failed',
      code: cycle.code,
      stdout: String(cycle.out || '').slice(0, 2000),
      stderr: String(cycle.err || '').slice(0, 1000),
    });
    process.stdout.write(JSON.stringify({
      ok: false,
      stage: 'run-perp-cycle',
      code: cycle.code,
      stdout: cycle.out.slice(0, 4000),
      stderr: cycle.err.slice(0, 4000),
    }, null, 2));
    return;
  }

  // ensure TradePlan v1 has a dryRun flag if env DRY_RUN=1
  if (process.env.DRY_RUN === '1' && typeof cycleJson === 'object') {
    cycleJson.dryRun = true;
  }

  const execRes = await runNode('scripts/bitget-perp-autotrade.js', JSON.stringify(cycleJson));
  const outJson = safeJson(execRes.out);
  if (!outJson) {
    appendDecisionRecord({
      ts: new Date().toISOString(),
      cycleId: cycleJson?.cycleId,
      stage: 'bitget-perp-autotrade',
      ok: false,
      error: 'executor_parse_failed',
      code: execRes.code,
      signal: {
        hasAlert: cycleJson?.decision?.hasAlert,
        plan: cycleJson?.plan,
        signalError: cycleJson?.signalError,
      },
      decision: cycleJson?.decision,
      executorStdout: String(execRes.out || '').slice(0, 1500),
    });
    process.stdout.write(JSON.stringify({
      ok: false,
      stage: 'bitget-perp-autotrade',
      code: execRes.code,
      stdout: execRes.out.slice(0, 4000),
      stderr: execRes.err.slice(0, 4000),
      cycleId: cycleJson?.cycleId,
    }, null, 2));
    return;
  }

  // Attach cycleId for traceability.
  if (outJson && typeof outJson === 'object' && cycleJson?.cycleId && outJson.cycleId == null) {
    outJson.cycleId = cycleJson.cycleId;
  }

  // Persist one decision record per run for visualization.
  const plan = cycleJson?.plan;
  const newsItems = cycleJson?.news?.items;
  appendDecisionRecord({
    ts: new Date().toISOString(),
    cycleId: cycleJson?.cycleId,
    ok: true,
    signal: {
      hasAlert: Boolean(plan || (cycleJson?.decision?.hasAlert)),
      plan: plan ? { symbol: plan.symbol, side: plan.side, level: plan.level, reason: plan.reason } : null,
      signalError: cycleJson?.signalError ?? null,
      note: cycleJson?.alerts?.length ? `alerts: ${cycleJson.alerts.length}` : (cycleJson?.note ?? null),
      algorithm: cycleJson?.signalMeta ?? null,
    },
    decision: {
      blockedByNews: cycleJson?.decision?.blockedByNews ?? false,
      newsReason: cycleJson?.decision?.newsReason ?? [],
      newsItems: Array.isArray(newsItems) ? newsItems.map((it) => ({ title: it.title, url: it.url, tsLocal: it.tsLocal })) : [],
    },
    executor: {
      ok: outJson.ok,
      skipped: outJson.skipped === true,
      reason: outJson.reason ?? (outJson.executed ? 'opened' : outJson.dryRun ? 'dry_run_open' : null),
      executed: outJson.executed === true,
      dryRun: outJson.dryRun === true || process.env.DRY_RUN === '1',
      openPosition: outJson.openPosition ?? null,
      wouldOpenPosition: outJson.wouldOpenPosition ?? null,
      dailyRealizedPnlUSDT: outJson.dailyRealizedPnlUSDT,
    },
  });

  process.stdout.write(JSON.stringify(outJson, null, 2));
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({ ok: false, error: String(e?.stack || e) }, null, 2));
  process.exit(0);
});
