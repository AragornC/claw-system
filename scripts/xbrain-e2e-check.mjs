#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKDIR = process.env.OPENCLAW_WORKDIR || path.resolve(__dirname, '..');
const PORT = Number(process.env.XBRAIN_E2E_PORT || 8877);
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

function logStep(name, status, detail = '') {
  const extra = detail ? ' - ' + detail : '';
  console.log('[' + status + '] ' + name + extra);
}

async function post(pathname, body) {
  return requestJson(pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
}

async function runChecks() {
  const results = [];

  const stateOut = await requestJson('/api/xbrain/state?refresh=1');
  if (!(stateOut.ok && stateOut.payload?.ok === true && stateOut.payload?.state)) {
    throw new Error('GET /api/xbrain/state 失败');
  }
  const state = stateOut.payload.state;
  results.push(['state', 'PASS', 'state 拉取成功']);

  const base = state?.base && typeof state.base === 'object' ? state.base : {};
  const modelId = String(base.modelId || '').trim();
  const modelProvider = String(base.modelProvider || '').trim();
  const modelRegistry = Array.isArray(base.modelRegistry) ? base.modelRegistry.slice() : [];

  const updateNoop = await post('/api/xbrain/update', {
    section: 'base',
    values: { modelRegistry },
    password: '',
  });
  if (updateNoop.ok && updateNoop.payload?.ok === true) {
    results.push(['update:base-modelRegistry-noop', 'PASS', '配置更新链路可用']);
  } else if (updateNoop.status === 423 || updateNoop.status === 403) {
    results.push(['update:base-modelRegistry-noop', 'GUARDED', '基础配置被锁，保护生效']);
  } else {
    results.push(['update:base-modelRegistry-noop', 'FAIL', 'HTTP ' + updateNoop.status]);
  }

  if (modelId) {
    const switchOut = await post('/api/xbrain/model/switch', {
      modelId,
      modelProvider,
    });
    if (switchOut.ok && switchOut.payload?.ok === true) {
      results.push(['model-switch-current', 'PASS', '模型切换链路可用']);
    } else if (switchOut.status === 400) {
      const reason = String(switchOut.payload?.error || '');
      if (/未上线|未在当前厂商可用列表/.test(reason)) {
        results.push(['model-switch-current', 'GUARDED', '模型未上线保护生效']);
      } else {
        results.push(['model-switch-current', 'FAIL', reason || ('HTTP ' + switchOut.status)]);
      }
    } else {
      results.push(['model-switch-current', 'FAIL', 'HTTP ' + switchOut.status]);
    }
  } else {
    results.push(['model-switch-current', 'GUARDED', '当前无 modelId，跳过']);
  }

  const lockInvalid = await post('/api/xbrain/lock', {
    section: 'base',
    action: '__invalid__',
  });
  if (lockInvalid.status === 400) {
    results.push(['lock-invalid-action', 'PASS', '锁管理参数校验生效']);
  } else {
    results.push(['lock-invalid-action', 'FAIL', 'HTTP ' + lockInvalid.status]);
  }

  return results;
}

async function main() {
  const child = spawn(process.execPath, ['scripts/serve-report.js', String(PORT)], {
    cwd: WORKDIR,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (buf) => { stdout = (stdout + String(buf || '')).slice(-6000); });
  child.stderr.on('data', (buf) => { stderr = (stderr + String(buf || '')).slice(-6000); });

  try {
    const ready = await waitUntilReady();
    if (!ready) throw new Error('serve-report 启动超时，未就绪');
    const results = await runChecks();
    let failed = 0;
    for (const [name, status, detail] of results) {
      logStep(name, status, detail);
      if (status === 'FAIL') failed += 1;
    }
    if (failed > 0) {
      console.error('[e2e:xbrain] FAIL, failed=' + failed);
      process.exitCode = 1;
    } else {
      console.log('[e2e:xbrain] PASS');
    }
  } catch (err) {
    console.error('[e2e:xbrain] FAIL:', String(err?.message || err));
    if (stdout.trim()) console.error('[e2e:xbrain] stdout tail:\n' + stdout);
    if (stderr.trim()) console.error('[e2e:xbrain] stderr tail:\n' + stderr);
    process.exitCode = 1;
  } finally {
    if (!child.killed) child.kill();
    await sleep(200);
  }
}

await main();
