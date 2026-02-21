import fs from 'node:fs';
import path from 'node:path';
import { createAuditLog } from './audit-log.js';
import { createApprovalGate } from './approval-gate.js';
import { createMemoryManager } from './memory-manager.js';
import { createSessionManager } from './session-manager.js';
import { createTaskEngine } from './task-engine.js';
import { createToolRuntime } from './tool-runtime.js';
import { createSchedulerRuntime } from './scheduler-runtime.js';

function nowIso() {
  return new Date().toISOString();
}

function text(v) {
  return String(v || '').trim();
}

function safeObj(v) {
  return v && typeof v === 'object' ? v : {};
}

function safeJsonParse(rawLike, fallback = null) {
  try {
    return JSON.parse(String(rawLike || ''));
  } catch {
    return fallback;
  }
}

function trace(step, summary, extra = {}) {
  return {
    step: text(step),
    ts: nowIso(),
    summary: text(summary),
    ...(extra && typeof extra === 'object' ? extra : {}),
  };
}

function parseTaskIntent(messageLike = '') {
  const message = text(messageLike);
  if (!message) return null;
  const patterns = [
    /^task:\s*([a-zA-Z0-9_:/.-]+)(?:\s+(.+))?$/i,
    /^run\s+task\s+([a-zA-Z0-9_:/.-]+)(?:\s+(.+))?$/i,
    /^创建任务\s+([a-zA-Z0-9_:/.-]+)(?:\s+(.+))?$/i,
  ];
  for (const re of patterns) {
    const m = message.match(re);
    if (!m) continue;
    const tool = text(m[1]);
    const argsRaw = text(m[2] || '');
    const args = argsRaw ? safeJsonParse(argsRaw, {}) || {} : {};
    if (!tool) return null;
    return { tool, args: safeObj(args), title: `task:${tool}` };
  }
  return null;
}

function parseScheduleIntent(messageLike = '') {
  const message = text(messageLike);
  if (!message) return null;

  const mCron = message.match(/^cron:\s*(.+)$/i);
  if (mCron) {
    return {
      tool: 'get_market_news_impact',
      args: { limit: 5 },
      title: 'scheduled:get_market_news_impact',
      cron: text(mCron[1]),
      scheduleText: `cron ${text(mCron[1])}`,
    };
  }

  const mSchedule = message.match(/^schedule:\s*(.+)$/i);
  if (mSchedule) {
    return {
      tool: 'get_market_news_impact',
      args: { limit: 5 },
      title: 'scheduled:get_market_news_impact',
      scheduleText: text(mSchedule[1]),
    };
  }

  const mCn = message.match(/^(?:创建定时|创建调度|定时任务)\s+(.+)$/i);
  if (mCn) {
    return {
      tool: 'get_market_news_impact',
      args: { limit: 5 },
      title: 'scheduled:get_market_news_impact',
      scheduleText: text(mCn[1]),
    };
  }

  return null;
}

function formatTaskReply(out) {
  const task = out?.task;
  if (!task) return out?.ok ? '任务执行完成。' : `任务执行失败：${text(out?.error) || 'unknown_error'}`;
  const summaryFromResult =
    task?.result?.summaries?.join('\n') ||
    task?.result?.summary ||
    task?.result?.toolResults?.[0]?.summary ||
    '';
  if (summaryFromResult) return summaryFromResult;
  return task.status === 'success' ? '任务执行完成。' : `任务执行失败：${text(task.error) || 'unknown_error'}`;
}

export function createConversationRuntime(options = {}) {
  const sendJson =
    typeof options.sendJson === 'function'
      ? options.sendJson
      : (res, code, body) => {
          res.statusCode = Number(code || 200);
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify(body || {}));
        };
  const readJsonBody =
    typeof options.readJsonBody === 'function'
      ? options.readJsonBody
      : async () => ({ ok: false, error: 'json_reader_missing' });
  const appendChatHistoryEvent =
    typeof options.appendChatHistoryEvent === 'function' ? options.appendChatHistoryEvent : () => {};
  const runOpenClawChat =
    typeof options.runOpenClawChat === 'function'
      ? options.runOpenClawChat
      : async () => ({ reply: 'OpenClaw runtime unavailable.' });
  const buildTradingContext =
    typeof options.buildTradingContext === 'function'
      ? options.buildTradingContext
      : () => ({ digest: null, context: {} });
  const buildLayeredMemoryBundle =
    typeof options.buildLayeredMemoryBundle === 'function' ? options.buildLayeredMemoryBundle : () => ({});
  const handleNaturalLanguageToolOrchestration =
    typeof options.handleNaturalLanguageToolOrchestration === 'function'
      ? options.handleNaturalLanguageToolOrchestration
      : async () => ({ handled: false });
  const executeStrategyToolCalls =
    typeof options.executeStrategyToolCalls === 'function'
      ? options.executeStrategyToolCalls
      : async () => ({ summaries: [], actions: [], toolResults: [] });
  const buildMcpStyleToolManifest =
    typeof options.buildMcpStyleToolManifest === 'function'
      ? options.buildMcpStyleToolManifest
      : () => ({ tools: [] });
  const checkMcpBridgeConnectivity =
    typeof options.checkMcpBridgeConnectivity === 'function'
      ? options.checkMcpBridgeConnectivity
      : async () => ({ ok: false });
  const resolveToolAdapterMode =
    typeof options.resolveToolAdapterMode === 'function' ? options.resolveToolAdapterMode : () => 'internal';
  const workspaceDir = String(options.workspaceDir || process.cwd());

  const audit =
    options.audit && typeof options.audit.append === 'function'
      ? options.audit
      : createAuditLog({
          filePath: options.auditPath || 'memory/runtime-audit.jsonl',
        });
  const emitAudit = typeof options.emitAudit === 'function' ? options.emitAudit : (event, payload) => audit.append(event, payload);

  const sessionManager =
    options.sessionManager ||
    createSessionManager({
      storePath: options.sessionStorePath || 'memory/runtime-sessions.json',
    });
  const memoryManager =
    options.memoryManager ||
    createMemoryManager({
      workspaceDir,
      buildLayeredMemoryBundle,
    });
  const approvalGate =
    options.approvalGate ||
    createApprovalGate({
      defaults: {
        security: options.approvalSecurity || 'allowlist',
        ask: options.approvalAsk || 'on-miss',
        allowlist: Array.isArray(options.approvalAllowlist) ? options.approvalAllowlist : [],
      },
      emitAudit,
    });
  const toolRuntime =
    options.toolRuntime ||
    createToolRuntime({
      executeStrategyToolCalls,
      buildMcpStyleToolManifest,
      checkMcpBridgeConnectivity,
      resolveToolAdapterMode,
      timeoutMs: options.toolTimeoutMs || 6000,
      retry: options.toolRetry || 1,
      emitAudit,
    });
  const taskEngine =
    options.taskEngine ||
    createTaskEngine({
      storePath: options.taskStorePath || 'memory/runtime-tasks.json',
      executeTool: async (tool, args, context) => toolRuntime.invokeTool(tool, args, context),
      emitAudit,
      appendSessionEvent: (sessionKey, event) => sessionManager.appendEvent?.(sessionKey, event),
    });
  const schedulerRuntime =
    options.schedulerRuntime ||
    createSchedulerRuntime({
      storePath: options.schedulerStorePath || 'memory/runtime-schedules.json',
      taskEngine,
      emitAudit,
      tickMs: options.schedulerTickMs || 1000,
    });

  const ownsScheduler = !options.schedulerRuntime;
  if (ownsScheduler || options.startScheduler === true) {
    schedulerRuntime.start?.();
  }
  const learningPath = path.resolve(workspaceDir, 'memory/runtime-learning.md');

  function rememberConversation(sessionKeyLike, userTextLike, assistantTextLike, sourceLike = 'runtime') {
    const userText = text(userTextLike);
    const assistantText = text(assistantTextLike);
    if (!userText || !assistantText) return;
    const sessionKey = text(sessionKeyLike || 'dashboard:main');
    const source = text(sourceLike || 'runtime');
    try {
      fs.mkdirSync(path.dirname(learningPath), { recursive: true });
      const line =
        '\n## ' +
        nowIso() +
        ' [' +
        source +
        ']' +
        '\n- session: ' +
        sessionKey +
        '\n- user: ' +
        userText.replace(/\n+/g, ' ') +
        '\n- assistant: ' +
        assistantText.replace(/\n+/g, ' ') +
        '\n';
      fs.appendFileSync(learningPath, line, 'utf8');
      emitAudit('memory.remember.turn', { sessionKey, source, path: learningPath });
    } catch {}
  }

  async function handleChatApi(req, res) {
    if (String(req.method || 'GET').toUpperCase() !== 'POST') {
      res.statusCode = 405;
      res.setHeader('Allow', 'POST');
      res.end('Method Not Allowed');
      return;
    }

    const body = await readJsonBody(req);
    if (!body.ok) {
      sendJson(res, body.error === 'payload too large' ? 413 : 400, { ok: false, error: body.error || 'invalid_json' });
      return;
    }

    const message = text(body.value?.message);
    const clientContext = safeObj(body.value?.clientContext);
    if (!message) {
      sendJson(res, 400, { ok: false, error: 'message is required' });
      return;
    }

    const sessionKey = sessionManager.normalizeSessionKey(clientContext.sessionKey || clientContext.currentView || 'dashboard:main');
    const session = sessionManager.touch(sessionKey, { meta: { source: String(clientContext.source || 'dashboard') } });
    sessionManager.appendEvent?.(sessionKey, {
      type: 'chat',
      role: 'user',
      detail: message,
    });
    appendChatHistoryEvent({ source: 'dashboard', role: 'user', direction: 'inbound', text: message });

    const executionTrace = [];
    const memoryHits = memoryManager.search(message, { maxResults: 8, minScore: 0.12 });
    executionTrace.push(trace('memory_search', `hits=${memoryHits.length}`));

    if (/^(memory_search|记忆检索)(?:\s|$)/i.test(message)) {
      const reply = memoryHits.length
        ? memoryHits.map((x, i) => `${i + 1}. ${x.path}#L${x.startLine} ${x.snippet}`).join('\n')
        : '未检索到相关记忆。';
      sessionManager.appendEvent?.(sessionKey, { type: 'memory', stage: 'search', detail: reply });
      rememberConversation(sessionKey, message, reply, 'runtime-memory');
      sendJson(res, 200, {
        ok: true,
        source: 'runtime',
        reply,
        actions: [],
        executionTrace,
      });
      return;
    }

    if (/^(memory_get|读取记忆)(?:\s|$)/i.test(message)) {
      const m = message.match(/^(?:memory_get|读取记忆)\s+(\S+)(?:\s+(\d+))?(?:\s+(\d+))?/i);
      const targetPath = text(m?.[1] || 'MEMORY.md');
      const from = Number(m?.[2] || 1) || 1;
      const lines = Number(m?.[3] || 120) || 120;
      const out = memoryManager.get(targetPath, from, lines);
      const reply = out.text || '记忆文件为空或不存在。';
      rememberConversation(sessionKey, message, reply, 'runtime-memory');
      sendJson(res, 200, {
        ok: true,
        source: 'runtime',
        reply,
        actions: [],
        executionTrace,
        meta: {
          path: out.path || targetPath,
          error: out.error || null,
        },
      });
      return;
    }

    if (/^(reset session|会话重置)(?:\s|$)/i.test(message)) {
      const next = sessionManager.reset(sessionKey);
      const reply = `会话已重置：${next.key}`;
      rememberConversation(sessionKey, message, reply, 'runtime-session');
      sendJson(res, 200, {
        ok: true,
        source: 'runtime',
        reply,
        actions: [],
        executionTrace,
        meta: { sessionKey: next.key },
      });
      return;
    }

    const memoryBundle = memoryManager.buildBundle(message);
    const sessionPreview = Array.isArray(session?.events)
      ? session.events.slice(-10).map((x) => ({
          ts: x?.ts || null,
          type: x?.type || null,
          detail: text(x?.detail || x?.text || ''),
        }))
      : [];
    const trading = buildTradingContext(
      {
        ...clientContext,
        sessionKey,
        sessionPreview,
      },
      memoryBundle,
    );

    const routed = await handleNaturalLanguageToolOrchestration(
      message,
      String(clientContext.source || 'dashboard'),
      {
        currentView: String(clientContext.currentView || 'dashboard'),
        sessionKey,
        sessionPreview,
      },
    );
    if (routed?.handled) {
      executionTrace.push(trace('tool_router', 'handled=true'));
      const reply = text(routed.reply || routed.summary || '') || '已处理';
      sessionManager.appendEvent?.(sessionKey, { type: 'tool_router', role: 'bot', detail: reply });
      appendChatHistoryEvent({ source: String(routed.source || 'runtime'), role: 'bot', direction: 'outbound', text: reply });
      rememberConversation(sessionKey, message, reply, String(routed.source || 'runtime'));
      sendJson(res, 200, {
        ok: true,
        source: String(routed.source || 'runtime'),
        reply,
        actions: Array.isArray(routed.actions) ? routed.actions : [],
        contextDigest: trading?.digest || null,
        executionTrace,
      });
      return;
    }

    const taskIntent = parseTaskIntent(message);
    if (taskIntent) {
      const approved = approvalGate.evaluate({
        action: `task.execute:${taskIntent.tool}`,
        summary: message,
      });
      executionTrace.push(trace('approval', `task:${approved.reason}`, { approvalId: approved.approvalId || null }));
      if (!approved.allowed) {
        sendJson(res, 200, {
          ok: true,
          source: 'runtime',
          reply: `任务执行被拦截：${approved.reason}`,
          actions: [],
          executionTrace,
          meta: { approvalId: approved.approvalId || null },
        });
        return;
      }

      const task = taskEngine.createTask({
        title: taskIntent.title,
        type: 'tool',
        tool: taskIntent.tool,
        args: taskIntent.args,
        sessionKey,
      });
      const out = await taskEngine.runTask(task.id);
      executionTrace.push(trace('task_execute', `${task.id}:${out?.ok ? 'success' : 'failed'}`));
      const reply = formatTaskReply(out);
      sessionManager.appendEvent?.(sessionKey, { type: 'task', role: 'bot', detail: reply });
      appendChatHistoryEvent({ source: 'runtime', role: 'bot', direction: 'outbound', text: reply });
      rememberConversation(sessionKey, message, reply, 'runtime-task');
      sendJson(res, 200, {
        ok: true,
        source: 'runtime',
        reply,
        actions: [],
        executionTrace,
        meta: { taskId: task.id, task: out?.task || null },
      });
      return;
    }

    const scheduleIntent = parseScheduleIntent(message);
    if (scheduleIntent) {
      const approved = approvalGate.evaluate({ action: 'scheduler.create', summary: message });
      executionTrace.push(trace('approval', `scheduler:${approved.reason}`, { approvalId: approved.approvalId || null }));
      if (!approved.allowed) {
        sendJson(res, 200, {
          ok: true,
          source: 'runtime',
          reply: `调度创建被拦截：${approved.reason}`,
          actions: [],
          executionTrace,
          meta: { approvalId: approved.approvalId || null },
        });
        return;
      }

      const job = schedulerRuntime.createJob({
        title: scheduleIntent.title,
        tool: scheduleIntent.tool,
        args: scheduleIntent.args,
        sessionKey,
        scheduleText: scheduleIntent.scheduleText,
        cron: scheduleIntent.cron,
      });
      if (job?.ok === false || !job?.id) {
        sendJson(res, 400, {
          ok: false,
          error: job?.error || 'schedule_invalid',
          expected: job?.expected || null,
          executionTrace,
        });
        return;
      }
      const reply = `已创建调度任务：${job.id}（${job.scheduleText || job.scheduleSpec?.expr || 'unknown'}）`;
      sessionManager.appendEvent?.(sessionKey, { type: 'scheduler', stage: 'created', detail: reply });
      rememberConversation(sessionKey, message, reply, 'runtime-scheduler');
      sendJson(res, 200, {
        ok: true,
        source: 'runtime',
        reply,
        actions: [],
        executionTrace,
        meta: { jobId: job.id, job },
      });
      return;
    }

    const approved = approvalGate.evaluate({ action: 'chat.model.invoke', summary: message });
    executionTrace.push(trace('approval', `chat:${approved.reason}`, { approvalId: approved.approvalId || null }));
    if (!approved.allowed) {
      const blockedReply = `请求被安全策略拦截：${approved.reason}`;
      rememberConversation(sessionKey, message, blockedReply, 'runtime-approval');
      sendJson(res, 200, {
        ok: true,
        source: 'runtime',
        reply: blockedReply,
        actions: [],
        executionTrace,
        meta: { approvalId: approved.approvalId || null },
      });
      return;
    }

    try {
      const out = await runOpenClawChat(message, trading.context);
      const reply = text(out?.reply) || '模型暂无回复。';
      sessionManager.appendEvent?.(sessionKey, { type: 'chat', role: 'bot', detail: reply });
      appendChatHistoryEvent({ source: 'openclaw', role: 'bot', direction: 'outbound', text: reply });
      rememberConversation(sessionKey, message, reply, 'openclaw');
      sendJson(res, 200, {
        ok: true,
        source: 'openclaw',
        reply,
        actions: [],
        contextDigest: trading.digest || null,
        executionTrace,
        meta: { sessionKey: session.key },
      });
    } catch (err) {
      const messageText = text(err?.message || err) || 'model_invoke_failed';
      sessionManager.appendEvent?.(sessionKey, { type: 'chat', role: 'bot', detail: `调用失败：${messageText}` });
      rememberConversation(sessionKey, message, `调用失败：${messageText}`, 'openclaw-error');
      sendJson(res, 502, {
        ok: false,
        source: 'openclaw',
        error: messageText,
        executionTrace,
      });
    }
  }

  async function handleRuntimeApi(req, res, url) {
    const pathname = String(url?.pathname || '');
    const method = String(req?.method || 'GET').toUpperCase();

    if (pathname === '/api/runtime/sessions' && method === 'GET') {
      sendJson(res, 200, { ok: true, sessions: sessionManager.list(300) });
      return true;
    }

    if (pathname === '/api/runtime/sessions/reset') {
      if (method !== 'POST') {
        res.statusCode = 405;
        res.setHeader('Allow', 'POST');
        res.end('Method Not Allowed');
        return true;
      }
      const parsed = await readJsonBody(req);
      if (!parsed.ok) {
        sendJson(res, 400, { ok: false, error: parsed.error || 'invalid_json' });
        return true;
      }
      const sessionKey = sessionManager.normalizeSessionKey(parsed.value?.sessionKey);
      const session = sessionManager.reset(sessionKey);
      sendJson(res, 200, { ok: true, session });
      return true;
    }

    if (pathname === '/api/runtime/sessions/compact') {
      if (method !== 'POST') {
        res.statusCode = 405;
        res.setHeader('Allow', 'POST');
        res.end('Method Not Allowed');
        return true;
      }
      const parsed = await readJsonBody(req);
      if (!parsed.ok) {
        sendJson(res, 400, { ok: false, error: parsed.error || 'invalid_json' });
        return true;
      }
      const sessionKey = sessionManager.normalizeSessionKey(parsed.value?.sessionKey);
      const keepEvents = Number(parsed.value?.keepEvents || 160) || 160;
      const session = sessionManager.compact(sessionKey, { keepEvents });
      sendJson(res, 200, { ok: true, session });
      return true;
    }

    if (pathname === '/api/runtime/sessions/resume') {
      if (method !== 'POST') {
        res.statusCode = 405;
        res.setHeader('Allow', 'POST');
        res.end('Method Not Allowed');
        return true;
      }
      const parsed = await readJsonBody(req);
      if (!parsed.ok) {
        sendJson(res, 400, { ok: false, error: parsed.error || 'invalid_json' });
        return true;
      }
      const sessionKey = sessionManager.normalizeSessionKey(parsed.value?.sessionKey);
      const session = sessionManager.resume(sessionKey);
      sendJson(res, 200, { ok: true, session });
      return true;
    }

    if (pathname === '/api/runtime/tasks') {
      if (method === 'GET') {
        sendJson(res, 200, { ok: true, tasks: taskEngine.listTasks(500) });
        return true;
      }
      if (method === 'POST') {
        const parsed = await readJsonBody(req);
        if (!parsed.ok) {
          sendJson(res, 400, { ok: false, error: parsed.error || 'invalid_json' });
          return true;
        }
        const value = safeObj(parsed.value);
        const approval = approvalGate.evaluate({
          type: 'tool_call',
          action: `task.execute:${text(value.tool)}`,
          tool: text(value.tool),
          summary: `runtime_api_task:${text(value.tool)}:${JSON.stringify(safeObj(value.args))}`,
        });
        if (!approval.allowed) {
          sendJson(res, 403, {
            ok: false,
            error: 'approval_required',
            reason: approval.reason || 'approval_required',
            approvalId: approval.approvalId || null,
          });
          return true;
        }
        const task = taskEngine.createTask({
          title: text(value.title || value.tool || 'runtime-task'),
          type: text(value.type || 'tool'),
          tool: text(value.tool),
          args: safeObj(value.args),
          sessionKey: text(value.sessionKey || 'dashboard:main'),
          maxRetries: Number(value.maxRetries || 1) || 1,
        });
        if (value.runNow !== false) {
          await taskEngine.runTask(task.id);
        }
        sendJson(res, 200, { ok: true, task: taskEngine.getTask(task.id) });
        return true;
      }
      res.statusCode = 405;
      res.setHeader('Allow', 'GET,POST');
      res.end('Method Not Allowed');
      return true;
    }

    if (pathname === '/api/runtime/tasks/retry') {
      if (method !== 'POST') {
        res.statusCode = 405;
        res.setHeader('Allow', 'POST');
        res.end('Method Not Allowed');
        return true;
      }
      const parsed = await readJsonBody(req);
      if (!parsed.ok) {
        sendJson(res, 400, { ok: false, error: parsed.error || 'invalid_json' });
        return true;
      }
      const id = text(parsed.value?.id);
      const existing = taskEngine.getTask?.(id);
      if (existing) {
        const approval = approvalGate.evaluate({
          type: 'tool_call',
          action: `task.retry:${existing.tool || ''}`,
          tool: existing.tool || '',
          summary: `runtime_api_task_retry:${existing.id || id}`,
        });
        if (!approval.allowed) {
          sendJson(res, 403, {
            ok: false,
            error: 'approval_required',
            reason: approval.reason || 'approval_required',
            approvalId: approval.approvalId || null,
            task: existing,
          });
          return true;
        }
      }
      const out = await taskEngine.retryTask(id);
      sendJson(res, out.ok ? 200 : 400, { ok: out.ok, error: out.error || null, task: out.task || null });
      return true;
    }

    if (pathname === '/api/runtime/schedules') {
      if (method === 'GET') {
        sendJson(res, 200, { ok: true, jobs: schedulerRuntime.listJobs(500) });
        return true;
      }
      if (method === 'POST') {
        const parsed = await readJsonBody(req);
        if (!parsed.ok) {
          sendJson(res, 400, { ok: false, error: parsed.error || 'invalid_json' });
          return true;
        }
        const value = safeObj(parsed.value);
        const approval = approvalGate.evaluate({
          type: 'scheduler',
          action: 'scheduler.create',
          tool: text(value.tool),
          summary: `runtime_api_schedule:${text(value.scheduleText || value.schedule || value.cron || '')}`,
        });
        if (!approval.allowed) {
          sendJson(res, 403, {
            ok: false,
            error: 'approval_required',
            reason: approval.reason || 'approval_required',
            approvalId: approval.approvalId || null,
          });
          return true;
        }
        const job = schedulerRuntime.createJob(value);
        if (job?.ok === false || !job?.id) {
          sendJson(res, 400, { ok: false, error: job?.error || 'schedule_invalid', expected: job?.expected || null });
          return true;
        }
        sendJson(res, 200, { ok: true, job });
        return true;
      }
      res.statusCode = 405;
      res.setHeader('Allow', 'GET,POST');
      res.end('Method Not Allowed');
      return true;
    }

    if (pathname === '/api/runtime/schedules/patch') {
      if (method !== 'POST') {
        res.statusCode = 405;
        res.setHeader('Allow', 'POST');
        res.end('Method Not Allowed');
        return true;
      }
      const parsed = await readJsonBody(req);
      if (!parsed.ok) {
        sendJson(res, 400, { ok: false, error: parsed.error || 'invalid_json' });
        return true;
      }
      const id = text(parsed.value?.id);
      const job = schedulerRuntime.patchJob(id, parsed.value?.patch || {});
      sendJson(res, job ? 200 : 404, { ok: Boolean(job), error: job ? null : 'job_not_found', job });
      return true;
    }

    if (pathname === '/api/runtime/schedules/delete') {
      if (method !== 'POST') {
        res.statusCode = 405;
        res.setHeader('Allow', 'POST');
        res.end('Method Not Allowed');
        return true;
      }
      const parsed = await readJsonBody(req);
      if (!parsed.ok) {
        sendJson(res, 400, { ok: false, error: parsed.error || 'invalid_json' });
        return true;
      }
      const id = text(parsed.value?.id);
      const removed = schedulerRuntime.removeJob(id);
      sendJson(res, removed ? 200 : 404, { ok: removed, error: removed ? null : 'job_not_found' });
      return true;
    }

    if (pathname === '/api/runtime/tools/manifest' && method === 'GET') {
      sendJson(res, 200, { ok: true, manifest: toolRuntime.getManifest() });
      return true;
    }

    if (pathname === '/api/runtime/tools/bridge-check' && method === 'GET') {
      const check = await toolRuntime.checkBridge();
      sendJson(res, 200, { ok: true, check });
      return true;
    }

    if (pathname === '/api/runtime/approvals' && method === 'GET') {
      sendJson(res, 200, {
        ok: true,
        config: approvalGate.getSnapshot?.() || {},
        pending: approvalGate.listPending?.(200) || [],
      });
      return true;
    }

    if (pathname === '/api/runtime/approvals/decide') {
      if (method !== 'POST') {
        res.statusCode = 405;
        res.setHeader('Allow', 'POST');
        res.end('Method Not Allowed');
        return true;
      }
      const parsed = await readJsonBody(req);
      if (!parsed.ok) {
        sendJson(res, 400, { ok: false, error: parsed.error || 'invalid_json' });
        return true;
      }
      const row = approvalGate.decide?.(parsed.value?.approvalId, parsed.value?.decision);
      sendJson(res, row ? 200 : 404, { ok: Boolean(row), approval: row || null, error: row ? null : 'approval_not_found' });
      return true;
    }

    if (pathname === '/api/runtime/approvals/allowlist/add') {
      if (method !== 'POST') {
        res.statusCode = 405;
        res.setHeader('Allow', 'POST');
        res.end('Method Not Allowed');
        return true;
      }
      const parsed = await readJsonBody(req);
      if (!parsed.ok) {
        sendJson(res, 400, { ok: false, error: parsed.error || 'invalid_json' });
        return true;
      }
      const ok = approvalGate.grantAlways?.(parsed.value?.pattern);
      sendJson(res, ok ? 200 : 400, {
        ok: Boolean(ok),
        config: approvalGate.getSnapshot?.() || {},
        error: ok ? null : 'pattern_required',
      });
      return true;
    }

    if (pathname === '/api/runtime/approvals/config') {
      if (method !== 'POST') {
        res.statusCode = 405;
        res.setHeader('Allow', 'POST');
        res.end('Method Not Allowed');
        return true;
      }
      const parsed = await readJsonBody(req);
      if (!parsed.ok) {
        sendJson(res, 400, { ok: false, error: parsed.error || 'invalid_json' });
        return true;
      }
      const config = approvalGate.updateConfig?.(safeObj(parsed.value)) || approvalGate.getSnapshot?.() || {};
      sendJson(res, 200, { ok: true, config });
      return true;
    }

    if (pathname === '/api/runtime/audit' && method === 'GET') {
      const limit = Math.max(1, Math.min(1000, Number(url?.searchParams?.get('limit') || '120') || 120));
      const event = text(url?.searchParams?.get('event') || '');
      const rows = typeof audit?.list === 'function' ? audit.list({ limit, event }) : [];
      sendJson(res, 200, {
        ok: true,
        filePath: audit?.filePath || null,
        total: Array.isArray(rows) ? rows.length : 0,
        rows: Array.isArray(rows) ? rows : [],
      });
      return true;
    }

    return false;
  }

  return {
    handleChatApi,
    handleRuntimeApi,
    managers: {
      sessionManager,
      memoryManager,
      taskEngine,
      schedulerRuntime,
      toolRuntime,
      approvalGate,
      audit,
    },
    dispose() {
      if (ownsScheduler) schedulerRuntime.stop?.();
      emitAudit('runtime.dispose', { at: nowIso() });
    },
  };
}
