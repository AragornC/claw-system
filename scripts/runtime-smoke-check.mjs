#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKDIR = process.env.OPENCLAW_WORKDIR || path.resolve(__dirname, '..');
const PORT = Number(process.env.RUNTIME_SMOKE_PORT || 8886);
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

async function post(pathname, body) {
  return requestJson(pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
}

async function postRpc(method, params, opts = {}) {
  const mode = String(opts.mode || 'jsonrpc').trim().toLowerCase();
  if (mode === 'frame') {
    return post('/api/runtime/rpc', {
      type: 'req',
      id: opts.id || 'smoke-frame-' + Date.now(),
      method,
      params: params && typeof params === 'object' ? params : {},
    });
  }
  return post('/api/runtime/rpc', {
    jsonrpc: '2.0',
    id: opts.id || 'smoke-rpc-' + Date.now(),
    method,
    params: params && typeof params === 'object' ? params : {},
  });
}

async function waitUntilReady(maxMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < maxMs) {
    try {
      const out = await requestJson('/api/ai/health');
      if (out.ok && out.payload?.ok === true) return true;
    } catch {}
    await sleep(450);
  }
  return false;
}

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}

async function runChecks() {
  const sessions = await requestJson('/api/runtime/sessions');
  assertCondition(sessions.ok && sessions.payload?.ok === true, 'GET /api/runtime/sessions 失败');

  const manifest = await requestJson('/api/runtime/tools/manifest');
  assertCondition(manifest.ok && manifest.payload?.ok === true, 'GET /api/runtime/tools/manifest 失败');
  assertCondition(Array.isArray(manifest.payload?.manifest?.tools), 'tools manifest 非法');

  const approvals = await requestJson('/api/runtime/approvals');
  assertCondition(approvals.ok && approvals.payload?.ok === true, 'GET /api/runtime/approvals 失败');

  const rpcMethods = await requestJson('/api/runtime/methods');
  assertCondition(rpcMethods.ok && rpcMethods.payload?.ok === true, 'GET /api/runtime/methods 失败');
  assertCondition(Array.isArray(rpcMethods.payload?.methods), 'runtime methods 列表非法');

  const rpcSessionList = await postRpc('sessions.list', { limit: 4 });
  assertCondition(rpcSessionList.ok, 'RPC sessions.list 调用失败');
  assertCondition(Array.isArray(rpcSessionList.payload?.result?.sessions), 'RPC sessions.list 响应非法');

  const rpcAlias = await post('/api/openclaw/rpc', {
    type: 'req',
    id: 'smoke-openclaw-alias',
    method: 'sessions.list',
    params: { limit: 2 },
  });
  assertCondition(rpcAlias.ok, 'RPC /api/openclaw/rpc 别名调用失败');
  assertCondition(rpcAlias.payload?.ok === true, 'RPC /api/openclaw/rpc 返回格式非法');

  const rpcChat = await postRpc(
    'chat.send',
    { message: 'memory_search runtime', sessionKey: 'smoke:rpc', source: 'smoke' },
    { mode: 'frame' },
  );
  assertCondition(rpcChat.ok, 'RPC chat.send 调用失败');
  assertCondition(rpcChat.payload?.ok === true, 'RPC chat.send 未返回 ok=true');
  assertCondition(typeof rpcChat.payload?.payload?.reply === 'string', 'RPC chat.send reply 非法');

  const createdTask = await post('/api/runtime/tasks', {
    title: 'smoke-task',
    tool: 'get_market_news_impact',
    args: { limit: 1 },
    sessionKey: 'smoke:runtime',
    runNow: false,
  });
  assertCondition(createdTask.ok && createdTask.payload?.ok === true, 'POST /api/runtime/tasks 失败');
  assertCondition(Boolean(createdTask.payload?.task?.id), 'task.id 缺失');

  const retryBad = await post('/api/runtime/tasks/retry', { id: '__not_exist__' });
  assertCondition(retryBad.status === 400, 'POST /api/runtime/tasks/retry 非法 id 未返回 400');

  const createdSchedule = await post('/api/runtime/schedules', {
    title: 'smoke-schedule',
    tool: 'get_market_news_impact',
    args: { limit: 1 },
    sessionKey: 'smoke:runtime',
    scheduleText: 'every 15 minutes',
  });
  assertCondition(createdSchedule.ok && createdSchedule.payload?.ok === true, 'POST /api/runtime/schedules 失败');
  assertCondition(Boolean(createdSchedule.payload?.job?.id), 'schedule job.id 缺失');
}

async function main() {
  const child = spawn(process.execPath, ['scripts/serve-report.js', String(PORT)], {
    cwd: WORKDIR,
    env: {
      ...process.env,
      THUNDERCLAW_CHAT_RUNTIME_MODE: 'openclaw-native',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (buf) => {
    stdout = (stdout + String(buf || '')).slice(-8000);
  });
  child.stderr.on('data', (buf) => {
    stderr = (stderr + String(buf || '')).slice(-8000);
  });

  try {
    const ready = await waitUntilReady();
    assertCondition(ready, 'serve-report 启动超时，未就绪');
    await runChecks();
    console.log('[smoke:runtime] PASS');
  } catch (err) {
    console.error('[smoke:runtime] FAIL:', String(err?.message || err));
    if (stdout.trim()) console.error('[smoke:runtime] stdout tail:\n' + stdout);
    if (stderr.trim()) console.error('[smoke:runtime] stderr tail:\n' + stderr);
    process.exitCode = 1;
  } finally {
    if (!child.killed) child.kill();
    await sleep(250);
  }
}

await main();
