#!/usr/bin/env node
/**
 * Perp engine wrapper (single-command run):
 * - runs run-perp-cycle.js -> TradePlan v1
 * - feeds it to bitget-perp-autotrade.js via stdin
 *
 * Output: JSON from bitget-perp-autotrade.js (plus debug fields on failure)
 */

import { spawn } from 'node:child_process';
import path from 'node:path';

const WORKDIR = process.env.OPENCLAW_WORKDIR || process.cwd();

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

async function main() {
  const cycle = await runNode('scripts/run-perp-cycle.js');
  const cycleJson = safeJson(cycle.out);
  if (!cycleJson || cycleJson.ok === false) {
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

  process.stdout.write(JSON.stringify(outJson, null, 2));
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({ ok: false, error: String(e?.stack || e) }, null, 2));
  process.exit(0);
});
