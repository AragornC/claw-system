#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKDIR = process.env.OPENCLAW_WORKDIR || path.resolve(__dirname, '..');
const PORT = Number(process.env.XBRAIN_SMOKE_PORT || 8876);
const BASE = 'http://127.0.0.1:' + PORT;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestJson(pathname, init) {
  const resp = await fetch(BASE + pathname, init);
  let payload = null;
  try {
    payload = await resp.json();
  } catch {}
  return { status: resp.status, ok: resp.ok, payload };
}

async function waitUntilReady(maxMs = 25000) {
  const started = Date.now();
  while (Date.now() - started < maxMs) {
    try {
      const out = await requestJson('/api/xbrain/state?refresh=0');
      if (out.ok && out.payload?.ok === true) return true;
    } catch {}
    await sleep(400);
  }
  return false;
}

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}

async function runChecks() {
  const state = await requestJson('/api/xbrain/state?refresh=0');
  assertCondition(state.ok && state.payload?.ok === true, 'GET /api/xbrain/state 失败');

  const authStatus = await requestJson('/api/xbrain/auth/status');
  assertCondition(authStatus.ok && authStatus.payload?.ok === true, 'GET /api/xbrain/auth/status 失败');

  const badUpdate = await requestJson('/api/xbrain/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ section: '__invalid__', values: {} }),
  });
  assertCondition(badUpdate.status === 400, 'POST /api/xbrain/update 非法 section 未返回 400');

  const badSwitch = await requestJson('/api/xbrain/model/switch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ modelId: '' }),
  });
  assertCondition(badSwitch.status === 400, 'POST /api/xbrain/model/switch 空 modelId 未返回 400');

  const badDisconnect = await requestJson('/api/xbrain/auth/disconnect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: '__invalid__' }),
  });
  assertCondition(badDisconnect.status === 400, 'POST /api/xbrain/auth/disconnect 非法 provider 未返回 400');

  const badLock = await requestJson('/api/xbrain/lock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ section: 'base', action: '__invalid__' }),
  });
  assertCondition(badLock.status === 400, 'POST /api/xbrain/lock 非法 action 未返回 400');
}

async function main() {
  const child = spawn(process.execPath, ['scripts/serve-report.js', String(PORT)], {
    cwd: WORKDIR,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (buf) => {
    stdout = (stdout + String(buf || '')).slice(-6000);
  });
  child.stderr.on('data', (buf) => {
    stderr = (stderr + String(buf || '')).slice(-6000);
  });

  try {
    const ready = await waitUntilReady();
    assertCondition(ready, 'serve-report 启动超时，未就绪');
    await runChecks();
    console.log('[smoke:xbrain] PASS');
  } catch (err) {
    console.error('[smoke:xbrain] FAIL:', String(err?.message || err));
    if (stdout.trim()) console.error('[smoke:xbrain] stdout tail:\n' + stdout);
    if (stderr.trim()) console.error('[smoke:xbrain] stderr tail:\n' + stderr);
    process.exitCode = 1;
  } finally {
    if (!child.killed) child.kill();
    await sleep(200);
  }
}

await main();
