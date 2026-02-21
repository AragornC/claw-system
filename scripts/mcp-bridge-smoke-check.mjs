#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKDIR = process.env.OPENCLAW_WORKDIR || path.resolve(__dirname, '..');
const PORT = Number(process.env.MCP_BRIDGE_SMOKE_PORT || 9011);
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

async function waitUntilReady(maxMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < maxMs) {
    try {
      const out = await requestJson('/healthz');
      if (out.ok && out.payload?.ok === true) return true;
    } catch {}
    await sleep(300);
  }
  return false;
}

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}

async function runChecks() {
  const tools = await requestJson('/tools');
  assertCondition(tools.ok && tools.payload?.ok === true, 'GET /tools 失败');
  assertCondition(String(tools.payload?.schemaVersion || '') === 'mcp-tool-manifest-v2', 'manifest 版本不正确');
  assertCondition(Array.isArray(tools.payload?.tools) && tools.payload.tools.length >= 4, 'tools 清单为空');

  const invokeUnknown = await post('/tool/invoke', {
    tool: '__unknown__',
    arguments: {},
    traceId: 'smoke-trace-id',
    timeoutMs: 3000,
    retry: 1,
    fallback: 'internal',
  });
  assertCondition(invokeUnknown.ok && invokeUnknown.payload?.ok === false, '未知工具未返回标准错误体');
  assertCondition(String(invokeUnknown.payload?.traceId || '') === 'smoke-trace-id', 'traceId 未透传');
  assertCondition(Array.isArray(invokeUnknown.payload?.attempts), 'attempts 字段缺失');
}

async function main() {
  const child = spawn(process.execPath, ['scripts/mcp-bridge-local.js', String(PORT)], {
    cwd: WORKDIR,
    env: {
      ...process.env,
      THUNDERCLAW_MCP_BRIDGE_TARGET: 'http://127.0.0.1:8765',
    },
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
    assertCondition(ready, 'mcp-bridge-local 启动超时');
    await runChecks();
    console.log('[smoke:mcp-bridge] PASS');
  } catch (err) {
    console.error('[smoke:mcp-bridge] FAIL:', String(err?.message || err));
    if (stdout.trim()) console.error('[smoke:mcp-bridge] stdout tail:\n' + stdout);
    if (stderr.trim()) console.error('[smoke:mcp-bridge] stderr tail:\n' + stderr);
    process.exitCode = 1;
  } finally {
    if (!child.killed) child.kill();
    await sleep(180);
  }
}

await main();
