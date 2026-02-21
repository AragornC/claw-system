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

  const audit = createAuditLog({
    filePath: options.auditPath || 'memory/runtime-audit.jsonl',
  });
  const emitAudit = (event, payload) => audit.append(event, payload);

  const sessionManager = createSessionManager({
    storePath: options.sessionStorePath || 'memory/runtime-sessions.json',
  });
  const memoryManager = createMemoryManager({
    workspaceDir,
    buildLayeredMemoryBundle,
  });
  const approvalGate = createApprovalGate({
    defaults: {
      security: options.approvalSecurity || 'allowlist',
      ask: options.approvalAsk || 'on-miss',
      allowlist: Array.isArray(options.approvalAllowlist) ? options.approvalAllowlist : [],
    },
    emitAudit,
  });
  const toolRuntime = createToolRuntime({
    executeStrategyToolCalls,
    buildMcpStyleToolManifest,
    checkMcpBridgeConnectivity,
    resolveToolAdapterMode,
    timeoutMs: options.toolTimeoutMs || 6000,
    emitAudit,
  });
  const taskEngine = createTaskEngine({
    storePath: options.taskStorePath || 'memory/runtime-tasks.json',
    executeTool: async (tool, args, context) => toolRuntime.invokeTool(tool, args, context),
  });
  const schedulerRuntime = createSchedulerRuntime({
    storePath: options.schedulerStorePath || 'memory/runtime-schedules.json',
    taskEngine,
    emitAudit,
    tickMs: options.schedulerTickMs || 1000,
  });
  schedulerRuntime.start();

  function trace(step, summary) {
    return { step, ts: nowIso(), summary: text(summary) };
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
    const clientContext = body.value?.clientContext && typeof body.value.clientContext === 'object' ? body.value.clientContext : {};
    if (!message) {
      sendJson(res, 400, { ok: false, error: 'message is required' });
      return;
    }
    const sessionKey = sessionManager.normalizeSessionKey(clientContext.sessionKey || clientContext.currentView || 'dashboard:main');
    const session = sessionManager.touch(sessionKey, { meta: { source: String(clientContext.source || 'dashboard') } });
    appendChatHistoryEvent({ source: 'dashboard', role: 'user', direction: 'inbound', text: message });

    const executionTrace = [];
    const memoryHits = memoryManager.search(message, { maxResults: 6, minScore: 0.12 });
    executionTrace.push(trace('memory_search', `hits=${memoryHits.length}`));

    if (/^(memory_search|记忆检索)\b/i.test(message)) {
      sendJson(res, 200, {
        ok: true,
        source: 'runtime',
        reply: memoryHits.length ? memoryHits.map((x, i) => `${i + 1}. ${x.path}#L${x.startLine} ${x.snippet}`).join('\n') : '未检索到相关记忆。',
        actions: [],
        executionTrace,
      });
      return;
    }

    if (/^(memory_get|读取记忆)\b/i.test(message)) {
      const p = message.split(/\s+/).slice(1).join(' ').trim() || 'MEMORY.md';
      const out = memoryManager.get(p, 1, 120);
      sendJson(res, 200, {
        ok: true,
        source: 'runtime',
        reply: out.text || '记忆文件为空或不存在。',
        actions: [],
        executionTrace,
      });
      return;
    }

    if (/^(创建任务|run task|task:)\b/i.test(message)) {
      const task = taskEngine.createTask({
        title: 'chat-task',
        tool: 'get_market_news_impact',
        args: { limit: 6 },
        sessionKey,
      });
      const out = await taskEngine.runTask(task.id);
      executionTrace.push(trace('task_execute', `${task.id}:${out?.ok ? 'success' : 'failed'}`));
      const reply =
        out?.task?.result?.summaries?.join('\n') ||
        out?.task?.result?.toolResults?.[0]?.summary ||
        (out?.ok ? '任务执行完成。' : `任务执行失败：${text(out?.error)}`);
      appendChatHistoryEvent({ source: 'runtime', role: 'bot', direction: 'outbound', text: reply });
      sendJson(res, 200, { ok: true, source: 'runtime', reply, actions: [], executionTrace, meta: { taskId: task.id } });
      return;
    }

    if (/^(创建定时|schedule:|cron:)/i.test(message)) {
      const approved = approvalGate.evaluate({ action: 'scheduler.create', summary: message });
      executionTrace.push(trace('approval', `scheduler:${approved.reason}`));
      if (!approved.allowed) {
        sendJson(res, 200, { ok: true, source: 'runtime', reply: `调度创建被拦截：${approved.reason}`, actions: [], executionTrace });
        return;
      }
      const job = schedulerRuntime.createJob({
        title: 'scheduled-news-impact',
        tool: 'get_market_news_impact',
        args: { limit: 5 },
        sessionKey,
        scheduleText: message,
      });
      sendJson(res, 200, { ok: true, source: 'runtime', reply: `已创建调度任务：${job.id}（${job.scheduleText}）`, actions: [], executionTrace, meta: { jobId: job.id } });
      return;
    }

    const memoryBundle = memoryManager.buildBundle(message);
    const trading = buildTradingContext(clientContext, memoryBundle);

    const routed = await handleNaturalLanguageToolOrchestration(message, 'dashboard');
    if (routed?.handled) {
      executionTrace.push(trace('tool_router', 'handled=true'));
      const reply = text(routed.reply || routed.summary || '') || '已处理';
      appendChatHistoryEvent({ source: String(routed.source || 'runtime'), role: 'bot', direction: 'outbound', text: reply });
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

    const approved = approvalGate.evaluate({ action: 'chat.model.invoke', summary: message });
    executionTrace.push(trace('approval', `chat:${approved.reason}`));
    if (!approved.allowed) {
      sendJson(res, 200, { ok: true, source: 'runtime', reply: `请求被安全策略拦截：${approved.reason}`, actions: [], executionTrace });
      return;
    }

    const out = await runOpenClawChat(message, trading.context);
    const reply = text(out?.reply) || '模型暂无回复。';
    appendChatHistoryEvent({ source: 'openclaw', role: 'bot', direction: 'outbound', text: reply });
    sendJson(res, 200, {
      ok: true,
      source: 'openclaw',
      reply,
      actions: [],
      contextDigest: trading.digest || null,
      executionTrace,
      meta: { sessionKey: session.key },
    });
  }

  async function handleRuntimeApi(req, res, url) {
    const pathname = String(url?.pathname || '');
    const method = String(req?.method || 'GET').toUpperCase();

    if (pathname === '/api/runtime/sessions' && method === 'GET') {
      sendJson(res, 200, { ok: true, sessions: sessionManager.list(300) });
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
        const value = parsed.value && typeof parsed.value === 'object' ? parsed.value : {};
        const task = taskEngine.createTask({
          title: text(value.title || value.tool || 'runtime-task'),
          tool: text(value.tool),
          args: value.args && typeof value.args === 'object' ? value.args : {},
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
        const job = schedulerRuntime.createJob(parsed.value || {});
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
      schedulerRuntime.stop();
      emitAudit('runtime.dispose', { at: nowIso() });
    },
  };
}
