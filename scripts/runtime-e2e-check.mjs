#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKDIR = process.env.OPENCLAW_WORKDIR || path.resolve(__dirname, '..');
const PORT = Number(process.env.RUNTIME_E2E_PORT || 8887);
const BASE = 'http://127.0.0.1:' + PORT;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logStep(name, status, detail = '') {
  const extra = detail ? ' - ' + detail : '';
  console.log('[' + status + '] ' + name + extra);
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
      id: opts.id || 'e2e-frame-' + Date.now(),
      method,
      params: params && typeof params === 'object' ? params : {},
    });
  }
  return post('/api/runtime/rpc', {
    jsonrpc: '2.0',
    id: opts.id || 'e2e-rpc-' + Date.now(),
    method,
    params: params && typeof params === 'object' ? params : {},
  });
}

function waitWsOpen(ws, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ws_open_timeout')), timeoutMs);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function waitWsFrame(ws, predicate, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error('ws_frame_timeout'));
    }, timeoutMs);
    const onMessage = (buf) => {
      const raw = String(buf || '').trim();
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
      if (!parsed || typeof parsed !== 'object') return;
      if (!predicate(parsed)) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve(parsed);
    };
    ws.on('message', onMessage);
  });
}

async function postChat(message, sessionKey = 'e2e:runtime') {
  return post('/api/ai/chat', {
    message,
    clientContext: {
      source: 'dashboard',
      sessionKey,
    },
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

async function runChecks() {
  const results = [];
  const sessionKey = 'e2e:runtime';

  const rpcSessionList = await postRpc('sessions.list', { limit: 3 });
  if (rpcSessionList.ok && Array.isArray(rpcSessionList.payload?.result?.sessions)) {
    results.push(['rpc-sessions-list', 'PASS', 'gateway method 路由可用']);
  } else {
    results.push(['rpc-sessions-list', 'FAIL', 'HTTP ' + rpcSessionList.status]);
  }

  const rpcChatSend = await postRpc(
    'chat.send',
    { message: 'memory_search runtime', sessionKey, source: 'e2e' },
    { mode: 'frame' },
  );
  if (rpcChatSend.ok && rpcChatSend.payload?.ok === true && typeof rpcChatSend.payload?.payload?.reply === 'string') {
    results.push(['rpc-chat-send', 'PASS', 'frame 协议可用']);
  } else {
    results.push(['rpc-chat-send', 'FAIL', 'HTTP ' + rpcChatSend.status]);
  }

  try {
    const ws = new WebSocket(BASE.replace('http://', 'ws://') + '/api/openclaw/ws');
    await waitWsOpen(ws);
    ws.send(JSON.stringify({ type: 'hello', id: 'e2e-hello' }));
    const hello = await waitWsFrame(ws, (frame) => frame?.type === 'res' && frame?.id === 'e2e-hello');
    if (hello?.ok === true) {
      ws.send(
        JSON.stringify({
          type: 'req',
          id: 'e2e-ws-chat',
          method: 'chat.send',
          params: { message: 'memory_search runtime', sessionKey, source: 'e2e-ws' },
        }),
      );
      const out = await waitWsFrame(ws, (frame) => frame?.type === 'res' && frame?.id === 'e2e-ws-chat', 12000);
      if (out?.ok === true && typeof out?.payload?.reply === 'string') {
        results.push(['ws-chat-send', 'PASS', 'ws req/res 可用']);
      } else {
        results.push(['ws-chat-send', 'FAIL', 'ws 返回结构异常']);
      }
    } else {
      results.push(['ws-chat-send', 'FAIL', 'ws hello 失败']);
    }
    ws.close();
  } catch (err) {
    results.push(['ws-chat-send', 'FAIL', String(err?.message || err)]);
  }

  const memGet = await postChat('memory_get USER.md 1 8', sessionKey);
  if (memGet.ok && memGet.payload?.ok === true && typeof memGet.payload?.reply === 'string') {
    results.push(['chat-memory-get', 'PASS', 'memory_get 分支可用']);
  } else {
    results.push(['chat-memory-get', 'FAIL', 'HTTP ' + memGet.status]);
  }

  const scheduleCreate = await postChat('创建定时 每15分钟', sessionKey);
  const jobId = String(scheduleCreate.payload?.meta?.jobId || '').trim();
  if (scheduleCreate.ok && scheduleCreate.payload?.ok === true && jobId) {
    results.push(['chat-schedule-create', 'PASS', 'jobId=' + jobId]);
  } else {
    results.push(['chat-schedule-create', 'FAIL', 'HTTP ' + scheduleCreate.status]);
  }

  const rpcCronStatus = await postRpc('cron.status', {});
  if (rpcCronStatus.ok && rpcCronStatus.payload?.result?.ok === true) {
    results.push(['rpc-cron-status', 'PASS', 'cron.status 可用']);
  } else {
    results.push(['rpc-cron-status', 'FAIL', 'HTTP ' + rpcCronStatus.status]);
  }

  if (jobId) {
    const rpcRun = await postRpc('cron.run', { id: jobId });
    if (rpcRun.ok && rpcRun.payload?.result?.ok !== false) {
      results.push(['rpc-cron-run', 'PASS', 'cron.run 可触发执行']);
    } else {
      results.push(['rpc-cron-run', 'FAIL', 'HTTP ' + rpcRun.status]);
    }

    const patchOut = await post('/api/runtime/schedules/patch', {
      id: jobId,
      patch: { enabled: false, resetNextRunAt: true },
    });
    if (patchOut.ok && patchOut.payload?.ok === true) {
      results.push(['schedule-patch', 'PASS', 'disable 成功']);
    } else {
      results.push(['schedule-patch', 'FAIL', 'HTTP ' + patchOut.status]);
    }
  } else {
    results.push(['schedule-patch', 'GUARDED', '无可用 jobId，跳过']);
  }

  const compactOut = await post('/api/runtime/sessions/compact', {
    sessionKey,
    keepEvents: 40,
  });
  if (compactOut.ok && compactOut.payload?.ok === true) {
    results.push(['session-compact', 'PASS', 'compact 成功']);
  } else {
    results.push(['session-compact', 'FAIL', 'HTTP ' + compactOut.status]);
  }

  const approvalConfig = await post('/api/runtime/approvals/config', {
    security: 'allowlist',
    ask: 'always',
  });
  if (approvalConfig.ok && approvalConfig.payload?.ok === true) {
    results.push(['approvals-config', 'PASS', 'ask=always 已生效']);
  } else {
    results.push(['approvals-config', 'FAIL', 'HTTP ' + approvalConfig.status]);
  }

  const blockedChat = await postChat('你好，给我一个状态总结', sessionKey);
  const approvalId = String(blockedChat.payload?.meta?.approvalId || '').trim();
  if (blockedChat.status === 200 && blockedChat.payload?.ok === true && approvalId) {
    results.push(['chat-approval-block', 'PASS', 'approvalId=' + approvalId.slice(0, 8)]);
  } else {
    results.push(['chat-approval-block', 'FAIL', '未返回 approvalId']);
  }

  if (approvalId) {
    const decisionOut = await post('/api/runtime/approvals/decide', {
      approvalId,
      decision: 'allow',
    });
    if (decisionOut.ok && decisionOut.payload?.ok === true && decisionOut.payload?.approval?.decision === 'allow') {
      results.push(['approval-decide', 'PASS', 'allow 决策成功']);
    } else {
      results.push(['approval-decide', 'FAIL', 'HTTP ' + decisionOut.status]);
    }
  } else {
    results.push(['approval-decide', 'GUARDED', '无 approvalId，跳过']);
  }

  const allowlistAdd = await post('/api/runtime/approvals/allowlist/add', {
    pattern: 'chat.model.invoke',
  });
  if (allowlistAdd.ok && allowlistAdd.payload?.ok === true) {
    results.push(['approval-allowlist-add', 'PASS', 'allowlist 新增成功']);
  } else {
    results.push(['approval-allowlist-add', 'FAIL', 'HTTP ' + allowlistAdd.status]);
  }

  const auditOut = await requestJson('/api/runtime/audit?limit=30');
  if (auditOut.ok && auditOut.payload?.ok === true && Array.isArray(auditOut.payload?.rows)) {
    results.push(['runtime-audit-list', 'PASS', '审计日志可查询']);
  } else {
    results.push(['runtime-audit-list', 'FAIL', 'HTTP ' + auditOut.status]);
  }

  if (jobId) {
    const deleteOut = await post('/api/runtime/schedules/delete', { id: jobId });
    if (deleteOut.ok && deleteOut.payload?.ok === true) {
      results.push(['schedule-delete', 'PASS', 'job 删除成功']);
    } else {
      results.push(['schedule-delete', 'FAIL', 'HTTP ' + deleteOut.status]);
    }
  } else {
    results.push(['schedule-delete', 'GUARDED', '无可用 jobId，跳过']);
  }

  const resetOut = await post('/api/runtime/sessions/reset', { sessionKey });
  if (resetOut.ok && resetOut.payload?.ok === true) {
    results.push(['session-reset', 'PASS', 'reset 成功']);
  } else {
    results.push(['session-reset', 'FAIL', 'HTTP ' + resetOut.status]);
  }

  const resumeOut = await post('/api/runtime/sessions/resume', { sessionKey });
  if (resumeOut.ok && resumeOut.payload?.ok === true) {
    results.push(['session-resume', 'PASS', 'resume 成功']);
  } else {
    results.push(['session-resume', 'FAIL', 'HTTP ' + resumeOut.status]);
  }

  return results;
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
    if (!ready) throw new Error('serve-report 启动超时，未就绪');
    const results = await runChecks();
    let failed = 0;
    for (const [name, status, detail] of results) {
      logStep(name, status, detail);
      if (status === 'FAIL') failed += 1;
    }
    if (failed > 0) {
      console.error('[e2e:runtime] FAIL, failed=' + failed);
      process.exitCode = 1;
    } else {
      console.log('[e2e:runtime] PASS');
    }
  } catch (err) {
    console.error('[e2e:runtime] FAIL:', String(err?.message || err));
    if (stdout.trim()) console.error('[e2e:runtime] stdout tail:\n' + stdout);
    if (stderr.trim()) console.error('[e2e:runtime] stderr tail:\n' + stderr);
    process.exitCode = 1;
  } finally {
    if (!child.killed) child.kill();
    await sleep(250);
  }
}

await main();
