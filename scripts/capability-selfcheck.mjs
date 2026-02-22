#!/usr/bin/env node

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKDIR = process.env.OPENCLAW_WORKDIR || path.resolve(__dirname, '..');
const PORT = Number(process.env.CAPABILITY_CHECK_PORT || 8891);
const BASE = `http://127.0.0.1:${PORT}`;
const USE_MOCK = String(process.env.CAPABILITY_CHECK_USE_MOCK || '1') !== '0';
const MOCK_BIN = path.resolve(WORKDIR, 'scripts/openclaw-cli-mock.mjs');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitReady(maxMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const resp = await fetch(`${BASE}/api/ai/health`);
      if (resp.ok) return true;
    } catch {}
    await sleep(250);
  }
  return false;
}

async function getJson(pathname) {
  const resp = await fetch(`${BASE}${pathname}`);
  let payload = null;
  try {
    payload = await resp.json();
  } catch {
    payload = null;
  }
  return { status: resp.status, ok: resp.ok, payload };
}

async function postChat(message, sessionKey) {
  const resp = await fetch(`${BASE}/api/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      clientContext: {
        source: 'dashboard',
        currentView: 'dashboard',
        sessionKey,
      },
    }),
  });
  let payload = null;
  try {
    payload = await resp.json();
  } catch {
    payload = null;
  }
  return { status: resp.status, ok: resp.ok, payload };
}

function logResult(name, status, detail = '') {
  const suffix = detail ? ` - ${detail}` : '';
  console.log(`[${status}] ${name}${suffix}`);
}

function evaluateCase(task, out) {
  const reply = String(out?.payload?.reply || '').trim();
  const actions = Array.isArray(out?.payload?.actions) ? out.payload.actions : [];
  const codeOk = out.status === 200 && out.payload?.ok === true;
  const replyOk = reply.length >= 12;
  let pass = codeOk && replyOk;
  const reasons = [];
  if (!codeOk) reasons.push(`HTTP ${out.status}`);
  if (!replyOk) reasons.push('reply too short');
  if (task.expectAction && actions.length === 0) {
    pass = false;
    reasons.push('actions missing');
  }
  if (task.expectContains && !reply.includes(task.expectContains)) {
    pass = false;
    reasons.push(`missing "${task.expectContains}"`);
  }
  return {
    pass,
    detail: pass ? `reply=${reply.slice(0, 70)}${reply.length > 70 ? '...' : ''}` : reasons.join(', '),
    reply,
    actions,
  };
}

async function main() {
  const env = {
    ...process.env,
    THUNDERCLAW_CHAT_RUNTIME_MODE: 'openclaw-native',
    THUNDERCLAW_LEGACY_CHAT_INTENTS: '0',
    THUNDERCLAW_TRADING_PLUGIN_ENABLED: '1',
  };
  if (USE_MOCK) {
    env.OPENCLAW_CLI_BIN = MOCK_BIN;
  }

  const child = spawn(process.execPath, ['scripts/serve-report.js', String(PORT)], {
    cwd: WORKDIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdoutTail = '';
  let stderrTail = '';
  child.stdout.on('data', (buf) => {
    stdoutTail = (stdoutTail + String(buf || '')).slice(-8000);
  });
  child.stderr.on('data', (buf) => {
    stderrTail = (stderrTail + String(buf || '')).slice(-8000);
  });

  const generalTasks = [
    { id: 'general-news', message: '请看下今天BTC新闻，并给一句风险结论。' },
    { id: 'general-weather', message: '上海今天天气怎么样？查不到就给我可执行查询命令。' },
    { id: 'general-code-fix', message: 'Node 报错 Cannot find module ws，我该怎么排查？' },
    { id: 'general-shell-help', message: '给我一个命令：统计当前目录 js 文件数量。' },
  ];

  const tradingTasks = [
    { id: 'trading-novice-plan', message: '我是交易小白，帮我给出稳健起步方案。' },
    {
      id: 'trading-risk-config',
      message: '我只有1万U，最多亏2%，帮我做BTC策略并告诉我下一步怎么操作。',
      expectAction: true,
    },
    {
      id: 'trading-compare',
      message: '请对比稳健策略，直接给执行动作。',
      expectAction: true,
    },
    {
      id: 'trading-memory-followup',
      message: '你还记得我刚才说的最大亏损比例吗？',
      expectContains: '2%',
    },
  ];

  try {
    const ready = await waitReady();
    if (!ready) {
      throw new Error('serve-report 未在超时内启动');
    }

    const health = await getJson('/api/ai/health');
    logResult(
      'health',
      health.ok && health.payload?.ok === true ? 'PASS' : 'FAIL',
      `commandSource=${String(health.payload?.commandSource || '-')}, useMock=${USE_MOCK ? 'yes' : 'no'}`,
    );

    let failed = 0;
    const generalSession = 'selfcheck:general';
    const tradingSession = 'selfcheck:trading';

    for (const task of generalTasks) {
      const out = await postChat(task.message, generalSession);
      const judged = evaluateCase(task, out);
      logResult(task.id, judged.pass ? 'PASS' : 'FAIL', judged.detail);
      if (!judged.pass) failed += 1;
    }

    for (const task of tradingTasks) {
      const out = await postChat(task.message, tradingSession);
      const judged = evaluateCase(task, out);
      logResult(task.id, judged.pass ? 'PASS' : 'FAIL', judged.detail);
      if (!judged.pass) failed += 1;
    }

    if (failed > 0) {
      console.error(`[capability-selfcheck] FAIL, failed=${failed}`);
      process.exitCode = 1;
    } else {
      console.log('[capability-selfcheck] PASS');
    }
  } catch (err) {
    console.error('[capability-selfcheck] FAIL:', String(err?.message || err));
    if (stdoutTail.trim()) console.error('[capability-selfcheck] stdout tail:\n' + stdoutTail);
    if (stderrTail.trim()) console.error('[capability-selfcheck] stderr tail:\n' + stderrTail);
    process.exitCode = 1;
  } finally {
    if (!child.killed) child.kill();
    await sleep(300);
  }
}

await main();
