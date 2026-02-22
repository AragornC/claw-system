import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
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

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : Number(fallback || 0);
}

function toPosInt(v, fallback, min = 1, max = 1000) {
  const n = Math.floor(toNum(v, fallback));
  return Math.max(min, Math.min(max, n));
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

  function normalizeRpcRequest(payloadLike = {}) {
    const payload = safeObj(payloadLike);
    const protocol =
      String(payload.jsonrpc || '').trim() === '2.0'
        ? 'jsonrpc'
        : String(payload.type || '').trim().toLowerCase() === 'req'
          ? 'frame'
          : 'plain';
    const id = payload.id ?? null;
    const method = text(payload.method);
    let params = payload.params;
    if (params == null) params = {};
    if (typeof params === 'string') {
      params = { message: params };
    }
    if (!params || typeof params !== 'object') {
      params = {};
    }
    return { protocol, id, method, params };
  }

  function buildRpcSuccess(protocol, id, result) {
    if (protocol === 'jsonrpc') {
      return { jsonrpc: '2.0', id, result };
    }
    if (protocol === 'frame') {
      return { type: 'res', id, ok: true, payload: result };
    }
    return { ok: true, id, payload: result };
  }

  function buildRpcError(protocol, id, errorLike = {}) {
    const error = safeObj(errorLike);
    const code = text(error.code || 'runtime_error') || 'runtime_error';
    const message = text(error.message || 'runtime_error') || 'runtime_error';
    const statusCode = toPosInt(error.statusCode, 400, 200, 599);
    const details = error.data && typeof error.data === 'object' ? error.data : null;
    if (protocol === 'jsonrpc') {
      const numericCode =
        code === 'invalid_request'
          ? -32600
          : code === 'method_not_found'
            ? -32601
            : code === 'invalid_params'
              ? -32602
              : -32000;
      return {
        statusCode,
        body: { jsonrpc: '2.0', id, error: { code: numericCode, message, data: details } },
      };
    }
    if (protocol === 'frame') {
      return {
        statusCode,
        body: { type: 'res', id, ok: false, error: { code, message, details } },
      };
    }
    return {
      statusCode,
      body: { ok: false, id, error: { code, message, details } },
    };
  }

  function normalizeChatSendParams(paramsLike = {}) {
    const params = safeObj(paramsLike);
    const message = text(params.message || params.text || params.prompt);
    const mergedClientContext = {
      ...(safeObj(params.clientContext) || {}),
    };
    const sessionKey = text(params.sessionKey || params.key || mergedClientContext.sessionKey || '');
    const source = text(params.source || mergedClientContext.source || 'gateway-rpc');
    const currentView = text(params.currentView || mergedClientContext.currentView || 'dashboard');
    if (sessionKey) mergedClientContext.sessionKey = sessionKey;
    if (source) mergedClientContext.source = source;
    if (currentView) mergedClientContext.currentView = currentView;
    return {
      message,
      clientContext: mergedClientContext,
    };
  }

  async function invokeChatThroughRuntime(messageLike, clientContextLike = {}) {
    const message = text(messageLike);
    if (!message) {
      return { statusCode: 400, body: { ok: false, error: 'message is required' } };
    }
    const req = new EventEmitter();
    req.method = 'POST';
    req.headers = { 'content-type': 'application/json' };
    req.destroy = () => {};
    let ended = false;
    let statusCode = 200;
    let rawBody = '';
    let resolveDone = null;
    const done = new Promise((resolve) => {
      resolveDone = resolve;
    });
    const res = {
      statusCode: 200,
      setHeader() {},
      end(chunkLike) {
        if (ended) return;
        ended = true;
        statusCode = toPosInt(this.statusCode, 200, 100, 599);
        rawBody = chunkLike == null ? '' : String(chunkLike);
        resolveDone?.();
      },
    };

    const pending = handleChatApi(req, res).catch((err) => {
      if (ended) return;
      ended = true;
      statusCode = 500;
      rawBody = JSON.stringify({ ok: false, error: text(err?.message || err) || 'chat_send_failed' });
      resolveDone?.();
    });
    process.nextTick(() => {
      const body = JSON.stringify({
        message,
        clientContext: safeObj(clientContextLike),
      });
      req.emit('data', Buffer.from(body, 'utf8'));
      req.emit('end');
    });
    await done;
    await pending;
    return {
      statusCode,
      body: safeJsonParse(rawBody, { ok: statusCode < 400, raw: rawBody }),
    };
  }

  async function runJobNow(jobIdLike) {
    const id = text(jobIdLike);
    if (!id) {
      return { ok: false, error: 'job_id_required' };
    }
    const job = schedulerRuntime.getJob?.(id);
    if (!job) {
      return { ok: false, error: 'job_not_found' };
    }
    if (!job.tool) {
      return { ok: false, error: 'job_tool_required', job };
    }
    const task = taskEngine.createTask({
      title: `scheduled:${text(job.title || 'runtime-job')}`,
      type: 'scheduled-tool',
      tool: text(job.tool),
      args: safeObj(job.args),
      sessionKey: text(job.sessionKey || 'dashboard:main'),
    });
    const out = await taskEngine.runTask(task.id);
    job.lastTaskId = task.id;
    job.lastRunAt = nowIso();
    job.lastStatus = out?.ok ? 'success' : 'failed';
    job.lastError = out?.ok ? null : text(out?.error || 'scheduled_task_failed');
    job.updatedAt = nowIso();
    schedulerRuntime.patchJob?.(job.id, { resetNextRunAt: true });
    emitAudit('scheduler.job.run_manual', {
      id: job.id,
      taskId: task.id,
      status: job.lastStatus,
      error: job.lastError,
    });
    return {
      ok: out?.ok !== false,
      error: out?.ok ? null : text(out?.error || ''),
      job,
      task: taskEngine.getTask?.(task.id) || null,
    };
  }

  async function dispatchGatewayMethod(methodLike, paramsLike = {}) {
    const method = text(methodLike);
    const params = safeObj(paramsLike);
    if (!method) {
      throw { code: 'invalid_request', message: 'method is required', statusCode: 400 };
    }

    if (method === 'chat.send') {
      const normalized = normalizeChatSendParams(params);
      if (!normalized.message) {
        throw { code: 'invalid_params', message: 'chat.send requires message', statusCode: 400 };
      }
      const out = await invokeChatThroughRuntime(normalized.message, normalized.clientContext);
      if (!out.body || out.body.ok === false || out.statusCode >= 400) {
        throw {
          code: 'runtime_error',
          message: text(out.body?.error || 'chat_send_failed'),
          statusCode: toPosInt(out.statusCode, 502, 200, 599),
          data: out.body || null,
        };
      }
      return {
        ok: true,
        reply: text(out.body?.reply || ''),
        source: text(out.body?.source || 'runtime'),
        actions: Array.isArray(out.body?.actions) ? out.body.actions : [],
        executionTrace: Array.isArray(out.body?.executionTrace) ? out.body.executionTrace : [],
        contextDigest: out.body?.contextDigest || null,
        meta: out.body?.meta && typeof out.body.meta === 'object' ? out.body.meta : {},
      };
    }

    if (method === 'sessions.list') {
      const limit = toPosInt(params.limit, 120, 1, 800);
      return { ts: Date.now(), sessions: sessionManager.list(limit) };
    }
    if (method === 'sessions.get') {
      const key = sessionManager.normalizeSessionKey(params.key || params.sessionKey);
      const session = sessionManager.get?.(key);
      if (!session) {
        throw { code: 'not_found', message: 'session_not_found', statusCode: 404 };
      }
      return { key, session };
    }
    if (method === 'sessions.resolve') {
      const key = sessionManager.normalizeSessionKey(params.key || params.sessionKey || params.label);
      return { ok: true, key };
    }
    if (method === 'sessions.patch') {
      const key = sessionManager.normalizeSessionKey(params.key || params.sessionKey);
      const patch = safeObj(params.patch || params);
      const session = sessionManager.ensureSession?.(key, {
        meta: safeObj(patch.meta),
        status: patch.status ? text(patch.status) : undefined,
      });
      return { ok: true, key, session };
    }
    if (method === 'sessions.reset') {
      const key = sessionManager.normalizeSessionKey(params.key || params.sessionKey);
      const session = sessionManager.reset(key);
      return { ok: true, key, session };
    }
    if (method === 'sessions.compact') {
      const key = sessionManager.normalizeSessionKey(params.key || params.sessionKey);
      const keepEvents = toPosInt(params.keepEvents, 160, 10, 1200);
      const session = sessionManager.compact(key, { keepEvents });
      return { ok: true, key, session };
    }
    if (method === 'sessions.resume') {
      const key = sessionManager.normalizeSessionKey(params.key || params.sessionKey);
      const session = sessionManager.resume(key);
      return { ok: true, key, session };
    }

    if (method === 'tasks.list') {
      const limit = toPosInt(params.limit, 120, 1, 1000);
      const filter = {
        sessionKey: text(params.sessionKey || ''),
        status: text(params.status || ''),
      };
      return { tasks: taskEngine.listTasks(limit, filter) };
    }
    if (method === 'tasks.create') {
      const input = safeObj(params);
      const tool = text(input.tool);
      if (!tool) {
        throw { code: 'invalid_params', message: 'tasks.create requires tool', statusCode: 400 };
      }
      const approval = approvalGate.evaluate({
        type: 'tool_call',
        action: `task.execute:${tool}`,
        tool,
        summary: `gateway_rpc_task:${tool}:${JSON.stringify(safeObj(input.args))}`,
      });
      if (!approval.allowed) {
        throw {
          code: 'approval_required',
          message: text(approval.reason || 'approval_required'),
          statusCode: 403,
          data: { approvalId: approval.approvalId || null },
        };
      }
      const task = taskEngine.createTask({
        title: text(input.title || tool || 'runtime-task'),
        type: text(input.type || 'tool'),
        tool,
        args: safeObj(input.args),
        sessionKey: text(input.sessionKey || 'dashboard:main'),
        maxRetries: toPosInt(input.maxRetries, 1, 0, 12),
      });
      if (input.runNow !== false) {
        await taskEngine.runTask(task.id);
      }
      return { ok: true, task: taskEngine.getTask(task.id) };
    }
    if (method === 'tasks.retry') {
      const id = text(params.id || params.taskId);
      if (!id) {
        throw { code: 'invalid_params', message: 'tasks.retry requires id', statusCode: 400 };
      }
      const existing = taskEngine.getTask?.(id);
      if (existing) {
        const approval = approvalGate.evaluate({
          type: 'tool_call',
          action: `task.retry:${existing.tool || ''}`,
          tool: existing.tool || '',
          summary: `gateway_rpc_task_retry:${existing.id || id}`,
        });
        if (!approval.allowed) {
          throw {
            code: 'approval_required',
            message: text(approval.reason || 'approval_required'),
            statusCode: 403,
            data: { approvalId: approval.approvalId || null },
          };
        }
      }
      const out = await taskEngine.retryTask(id);
      if (!out.ok) {
        throw { code: 'runtime_error', message: text(out.error || 'task_retry_failed'), statusCode: 400, data: out };
      }
      return { ok: true, task: out.task || null };
    }

    if (method === 'cron.list') {
      const limit = toPosInt(params.limit, 120, 1, 1000);
      const includeDisabled = params.includeDisabled === true;
      const jobs = includeDisabled
        ? schedulerRuntime.listJobs(limit)
        : schedulerRuntime.listJobs(limit).filter((job) => job?.enabled !== false);
      return { jobs };
    }
    if (method === 'cron.status') {
      const jobs = schedulerRuntime.listJobs(1000);
      const now = Date.now();
      const dueJobs = jobs.filter((job) => {
        const dueAt = new Date(String(job?.nextRunAt || 0)).getTime();
        return job?.enabled !== false && Number.isFinite(dueAt) && dueAt <= now;
      });
      return {
        ok: true,
        jobs: jobs.length,
        enabledJobs: jobs.filter((x) => x?.enabled !== false).length,
        dueJobs: dueJobs.length,
      };
    }
    if (method === 'cron.add') {
      const input = safeObj(params);
      const approval = approvalGate.evaluate({
        type: 'scheduler',
        action: 'scheduler.create',
        tool: text(input.tool),
        summary: `gateway_rpc_schedule:${text(input.scheduleText || input.schedule || input.cron || '')}`,
      });
      if (!approval.allowed) {
        throw {
          code: 'approval_required',
          message: text(approval.reason || 'approval_required'),
          statusCode: 403,
          data: { approvalId: approval.approvalId || null },
        };
      }
      const job = schedulerRuntime.createJob({
        id: text(input.id || input.jobId || ''),
        title: text(input.title || input.tool || 'runtime-job'),
        tool: text(input.tool || ''),
        args: safeObj(input.args),
        sessionKey: text(input.sessionKey || 'dashboard:main'),
        scheduleText: text(input.scheduleText || input.schedule || ''),
        schedule: text(input.schedule || ''),
        cron: text(input.cron || ''),
        everyMinutes: toNum(input.everyMinutes, 0) || undefined,
        everySeconds: toNum(input.everySeconds, 0) || undefined,
      });
      if (job?.ok === false || !job?.id) {
        throw {
          code: 'invalid_params',
          message: text(job?.error || 'schedule_invalid'),
          statusCode: 400,
          data: job?.expected ? { expected: job.expected } : null,
        };
      }
      return { job };
    }
    if (method === 'cron.update') {
      const id = text(params.id || params.jobId);
      if (!id) throw { code: 'invalid_params', message: 'cron.update requires id', statusCode: 400 };
      const patch = safeObj(params.patch || params);
      const job = schedulerRuntime.patchJob(id, patch);
      if (!job) throw { code: 'not_found', message: 'job_not_found', statusCode: 404 };
      return { job };
    }
    if (method === 'cron.remove') {
      const id = text(params.id || params.jobId);
      if (!id) throw { code: 'invalid_params', message: 'cron.remove requires id', statusCode: 400 };
      const ok = schedulerRuntime.removeJob(id);
      if (!ok) throw { code: 'not_found', message: 'job_not_found', statusCode: 404 };
      return { ok: true, id };
    }
    if (method === 'cron.run') {
      const id = text(params.id || params.jobId);
      const out = await runJobNow(id);
      if (!out.ok) {
        throw { code: 'runtime_error', message: text(out.error || 'cron_run_failed'), statusCode: 400, data: out };
      }
      return out;
    }
    if (method === 'cron.runs') {
      const id = text(params.id || params.jobId);
      if (!id) throw { code: 'invalid_params', message: 'cron.runs requires id', statusCode: 400 };
      const limit = toPosInt(params.limit, 20, 1, 120);
      const rows = typeof audit?.list === 'function' ? audit.list({ limit: Math.max(limit * 8, 120) }) : [];
      const entries = rows
        .filter((row) => {
          const event = text(row?.event || '');
          const payload = safeObj(row?.payload);
          return (
            (event === 'scheduler.job.executed' || event === 'scheduler.job.run_manual') &&
            text(payload.id || payload.jobId) === id
          );
        })
        .slice(0, limit);
      return { entries };
    }

    if (method === 'tools.manifest') {
      return { manifest: toolRuntime.getManifest() };
    }
    if (method === 'tools.bridge-check') {
      return { check: await toolRuntime.checkBridge() };
    }

    if (method === 'approvals.list') {
      return {
        config: approvalGate.getSnapshot?.() || {},
        pending: approvalGate.listPending?.(200) || [],
      };
    }
    if (method === 'approvals.decide') {
      const approvalId = text(params.approvalId || params.id);
      const decision = text(params.decision || 'deny');
      if (!approvalId) {
        throw { code: 'invalid_params', message: 'approvals.decide requires approvalId', statusCode: 400 };
      }
      const approval = approvalGate.decide?.(approvalId, decision);
      if (!approval) {
        throw { code: 'not_found', message: 'approval_not_found', statusCode: 404 };
      }
      return { approval };
    }
    if (method === 'approvals.allowlist.add') {
      const pattern = text(params.pattern);
      if (!pattern) {
        throw { code: 'invalid_params', message: 'approvals.allowlist.add requires pattern', statusCode: 400 };
      }
      const ok = approvalGate.grantAlways?.(pattern);
      if (!ok) {
        throw { code: 'invalid_params', message: 'pattern_required', statusCode: 400 };
      }
      return { ok: true, config: approvalGate.getSnapshot?.() || {} };
    }
    if (method === 'approvals.config') {
      const config = approvalGate.updateConfig?.(safeObj(params)) || approvalGate.getSnapshot?.() || {};
      return { config };
    }

    if (method === 'audit.list' || method === 'runtime.audit.list') {
      const limit = toPosInt(params.limit, 120, 1, 1000);
      const event = text(params.event || '');
      const rows = typeof audit?.list === 'function' ? audit.list({ limit, event }) : [];
      return {
        filePath: audit?.filePath || null,
        total: Array.isArray(rows) ? rows.length : 0,
        rows: Array.isArray(rows) ? rows : [],
      };
    }

    throw { code: 'method_not_found', message: `unknown method: ${method}`, statusCode: 404 };
  }

  async function handleRuntimeRpc(req, res) {
    if (String(req?.method || 'GET').toUpperCase() !== 'POST') {
      res.statusCode = 405;
      res.setHeader('Allow', 'POST');
      res.end('Method Not Allowed');
      return true;
    }
    const parsed = await readJsonBody(req);
    if (!parsed.ok) {
      const err = buildRpcError('plain', null, {
        code: 'invalid_request',
        message: parsed.error || 'invalid_json',
        statusCode: parsed.error === 'payload too large' ? 413 : 400,
      });
      sendJson(res, err.statusCode, err.body);
      return true;
    }
    const request = normalizeRpcRequest(parsed.value);
    if (!request.method) {
      const err = buildRpcError(request.protocol, request.id, {
        code: 'invalid_request',
        message: 'method is required',
        statusCode: 400,
      });
      sendJson(res, err.statusCode, err.body);
      return true;
    }
    try {
      const result = await dispatchGatewayMethod(request.method, request.params);
      sendJson(res, 200, buildRpcSuccess(request.protocol, request.id, result));
      return true;
    } catch (errorLike) {
      const err = buildRpcError(request.protocol, request.id, errorLike);
      sendJson(res, err.statusCode, err.body);
      return true;
    }
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

    if (
      (pathname === '/api/runtime/rpc' || pathname === '/api/openclaw/rpc' || pathname === '/api/gateway/rpc') &&
      method === 'GET'
    ) {
      sendJson(res, 200, {
        ok: true,
        protocol: 'gateway-rpc-v1',
        accepts: ['plain', 'jsonrpc', 'openclaw-frame'],
        endpoint: pathname,
      });
      return true;
    }

    if (pathname === '/api/runtime/rpc' || pathname === '/api/openclaw/rpc' || pathname === '/api/gateway/rpc') {
      return handleRuntimeRpc(req, res);
    }

    if (pathname === '/api/runtime/methods' && method === 'GET') {
      sendJson(res, 200, {
        ok: true,
        methods: [
          'chat.send',
          'sessions.list',
          'sessions.get',
          'sessions.resolve',
          'sessions.patch',
          'sessions.reset',
          'sessions.compact',
          'sessions.resume',
          'tasks.list',
          'tasks.create',
          'tasks.retry',
          'cron.list',
          'cron.status',
          'cron.add',
          'cron.update',
          'cron.remove',
          'cron.run',
          'cron.runs',
          'tools.manifest',
          'tools.bridge-check',
          'approvals.list',
          'approvals.decide',
          'approvals.allowlist.add',
          'approvals.config',
          'audit.list',
          'runtime.audit.list',
        ],
      });
      return true;
    }

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
