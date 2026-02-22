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

function looksLikeTradingDomainMessage(messageLike = '') {
  const message = text(messageLike).toLowerCase();
  if (!message) return false;
  return (
    /(交易|策略|回测|回验|复盘|仓位|杠杆|止盈|止损|开仓|平仓|风险|收益|胜率|做多|做空|行情|币圈|现货|合约|永续|资金费率|btc|eth|sol|x线|虾线|虾策|虾海|虾脑)/i.test(
      message,
    ) ||
    /\b(run_backtest|run_custom_backtest|run_backtest_compare|run_strategy_dsl)\b/i.test(message)
  );
}

function parseStructuredModelReply(replyLike = '') {
  const raw = text(replyLike);
  if (!raw) return { reply: '', actions: [] };
  let parsed = safeJsonParse(raw, null);
  if (!parsed || typeof parsed !== 'object') {
    const block = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (block?.[1]) parsed = safeJsonParse(String(block[1]).trim(), null);
  }
  if (parsed && typeof parsed === 'object') {
    const reply = text(parsed.reply) || raw;
    const actions = Array.isArray(parsed.actions)
      ? parsed.actions.filter((x) => x && typeof x === 'object').slice(0, 8)
      : [];
    return { reply, actions };
  }
  return { reply: raw, actions: [] };
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

const OPENCLAW_BASE_METHODS = [
  'health',
  'logs.tail',
  'channels.status',
  'channels.logout',
  'status',
  'usage.status',
  'usage.cost',
  'tts.status',
  'tts.providers',
  'tts.enable',
  'tts.disable',
  'tts.convert',
  'tts.setProvider',
  'config.get',
  'config.set',
  'config.apply',
  'config.patch',
  'config.schema',
  'exec.approvals.get',
  'exec.approvals.set',
  'exec.approvals.node.get',
  'exec.approvals.node.set',
  'exec.approval.request',
  'exec.approval.waitDecision',
  'exec.approval.resolve',
  'wizard.start',
  'wizard.next',
  'wizard.cancel',
  'wizard.status',
  'talk.config',
  'talk.mode',
  'models.list',
  'agents.list',
  'agents.create',
  'agents.update',
  'agents.delete',
  'agents.files.list',
  'agents.files.get',
  'agents.files.set',
  'skills.status',
  'skills.bins',
  'skills.install',
  'skills.update',
  'update.run',
  'voicewake.get',
  'voicewake.set',
  'sessions.list',
  'sessions.preview',
  'sessions.patch',
  'sessions.reset',
  'sessions.delete',
  'sessions.compact',
  'last-heartbeat',
  'set-heartbeats',
  'wake',
  'node.pair.request',
  'node.pair.list',
  'node.pair.approve',
  'node.pair.reject',
  'node.pair.verify',
  'device.pair.list',
  'device.pair.approve',
  'device.pair.reject',
  'device.pair.remove',
  'device.token.rotate',
  'device.token.revoke',
  'node.rename',
  'node.list',
  'node.describe',
  'node.invoke',
  'node.invoke.result',
  'node.event',
  'cron.list',
  'cron.status',
  'cron.add',
  'cron.update',
  'cron.remove',
  'cron.run',
  'cron.runs',
  'system-presence',
  'system-event',
  'send',
  'agent',
  'agent.identity.get',
  'agent.wait',
  'browser.request',
  'chat.history',
  'chat.abort',
  'chat.send',
];

const THUNDERCLAW_EXTRA_METHODS = [
  'sessions.get',
  'sessions.resolve',
  'tasks.list',
  'tasks.create',
  'tasks.retry',
  'tools.manifest',
  'tools.bridge-check',
  'approvals.list',
  'approvals.decide',
  'approvals.allowlist.add',
  'approvals.config',
  'audit.list',
  'runtime.audit.list',
];

const OPENCLAW_COMPAT_METHODS = Array.from(
  new Set([...OPENCLAW_BASE_METHODS, ...THUNDERCLAW_EXTRA_METHODS]),
);

function deepGet(objLike, pathLike) {
  const obj = objLike && typeof objLike === 'object' ? objLike : null;
  const path = String(pathLike || '').trim();
  if (!obj || !path) return undefined;
  const parts = path.split('.').filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (!cur || typeof cur !== 'object' || !(p in cur)) return undefined;
    cur = cur[p];
  }
  return cur;
}

function deepSet(objLike, pathLike, value) {
  const obj = objLike && typeof objLike === 'object' ? objLike : {};
  const path = String(pathLike || '').trim();
  if (!path) return obj;
  const parts = path.split('.').filter(Boolean);
  if (!parts.length) return obj;
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const p = parts[i];
    if (!cur[p] || typeof cur[p] !== 'object') cur[p] = {};
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
  return obj;
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
  const sendOutboundMessage =
    typeof options.sendOutboundMessage === 'function'
      ? options.sendOutboundMessage
      : async () => ({ ok: false, error: 'send_not_configured' });
  const getChannelStatus =
    typeof options.getChannelStatus === 'function'
      ? options.getChannelStatus
      : async () => ({
          dashboard: { connected: true, available: true },
        });
  const tailLogs =
    typeof options.tailLogs === 'function'
      ? options.tailLogs
      : async (paramsLike = {}) => {
          const limit = toPosInt(paramsLike?.limit, 80, 1, 200);
          const rows = typeof audit?.list === 'function' ? audit.list({ limit }) : [];
          return rows.map((row) => ({
            ts: row?.ts || nowIso(),
            event: row?.event || '',
            text: JSON.stringify(row?.payload || {}),
          }));
        };
  const workspaceDir = String(options.workspaceDir || process.cwd());
  const legacyChatIntents = Boolean(options.legacyChatIntents);
  const tradingPluginEnabled = options.tradingPluginEnabled !== false;

  const compatState = {
    config: {
      runtime: {
        mode: 'openclaw-native',
      },
      models: {
        mode: 'merge',
      },
    },
    tts: {
      enabled: false,
      provider: 'system',
    },
    talk: {
      mode: 'default',
      config: {},
    },
    heartbeats: {
      last: null,
      presets: [],
    },
    voicewake: {
      triggers: ['hey claw'],
    },
    skills: {
      bins: ['node', 'npm'],
      installed: [],
    },
    agents: {
      main: {
        agentId: 'main',
        name: 'Main Agent',
        workspace: workspaceDir,
        files: {},
        updatedAt: nowIso(),
      },
    },
    wizard: {
      running: false,
      sessionId: null,
      step: 0,
      flow: null,
      updatedAt: nowIso(),
    },
    nodePairs: [],
    devicePairs: [],
    nodeInvocations: [],
    systemPresence: [],
    systemEvents: [],
  };

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
    const runId = text(params.runId || params.requestId || params.id || '');
    return {
      message,
      clientContext: mergedClientContext,
      runId: runId || createCompatId('run'),
    };
  }

  async function invokeChatThroughRuntime(messageLike, clientContextLike = {}, runIdLike = '') {
    const message = text(messageLike);
    const runId = text(runIdLike || createCompatId('run'));
    if (!message) {
      return { statusCode: 400, body: { ok: false, error: 'message is required' } };
    }
    chatRuns.set(runId, {
      runId,
      status: 'in_flight',
      startedAt: nowIso(),
      sessionKey: text(clientContextLike?.sessionKey || ''),
      aborted: false,
    });
    pruneChatRuns();
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
    const run = chatRuns.get(runId);
    if (run) {
      run.status = statusCode >= 400 ? 'failed' : 'completed';
      run.finishedAt = nowIso();
      chatRuns.set(runId, run);
      pruneChatRuns();
    }
    return {
      statusCode,
      runId,
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

  const chatRuns = new Map();

  function pruneChatRuns(max = 500) {
    if (chatRuns.size <= max) return;
    const rows = Array.from(chatRuns.values())
      .sort((a, b) => Date.parse(String(b?.startedAt || 0)) - Date.parse(String(a?.startedAt || 0)))
      .slice(0, max);
    chatRuns.clear();
    rows.forEach((row) => {
      if (row?.runId) chatRuns.set(String(row.runId), row);
    });
  }

  function createCompatId(prefix = 'req') {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function normalizeGatewayMethod(methodLike) {
    const method = text(methodLike);
    const aliasMap = {
      'exec.approvals.get': 'approvals.list',
      'exec.approvals.set': 'approvals.config',
      'exec.approvals.node.get': 'approvals.list',
      'exec.approvals.node.set': 'approvals.config',
      'exec.approval.resolve': 'approvals.decide',
    };
    return aliasMap[method] || method;
  }

  function buildSessionPreviewItems(sessionLike, limitLike = 12, maxCharsLike = 240) {
    const session = sessionLike && typeof sessionLike === 'object' ? sessionLike : null;
    const limit = toPosInt(limitLike, 12, 1, 120);
    const maxChars = toPosInt(maxCharsLike, 240, 40, 2000);
    const events = Array.isArray(session?.events) ? session.events : [];
    return events.slice(-limit).map((event) => ({
      ts: event?.ts || null,
      role:
        event?.role === 'user' ||
        String(event?.role || '').toLowerCase() === 'user' ||
        String(event?.type || '').toLowerCase() === 'chat'
          ? 'user'
          : 'assistant',
      text: text(event?.detail || event?.text || '').slice(0, maxChars),
      type: event?.type || 'event',
      id: event?.id || null,
    }));
  }

  function buildChatHistoryPayload(paramsLike = {}) {
    const params = safeObj(paramsLike);
    const sessionKey = sessionManager.normalizeSessionKey(params.sessionKey || params.key || 'dashboard:main');
    const session = sessionManager.get?.(sessionKey);
    if (!session) {
      return { ok: true, key: sessionKey, messages: [] };
    }
    const limit = toPosInt(params.limit, 40, 1, 400);
    const maxChars = toPosInt(params.maxChars, 2400, 80, 24_000);
    const afterTs = toNum(params.afterTs, 0);
    const items = buildSessionPreviewItems(session, Math.max(limit * 2, 80), maxChars)
      .filter((item) => {
        if (!afterTs) return true;
        const ts = Date.parse(String(item?.ts || ''));
        return Number.isFinite(ts) && ts > afterTs;
      })
      .slice(-limit);
    return { ok: true, key: sessionKey, messages: items };
  }

  async function dispatchGatewayMethod(methodLike, paramsLike = {}) {
    const rawMethod = text(methodLike);
    const method = normalizeGatewayMethod(rawMethod);
    const params = safeObj(paramsLike);
    if (!method) {
      throw { code: 'invalid_request', message: 'method is required', statusCode: 400 };
    }

    if (method === 'health') {
      return {
        ok: true,
        ts: Date.now(),
        runtime: 'openclaw-native',
        status: 'healthy',
      };
    }

    if (method === 'status') {
      const jobs = schedulerRuntime.listJobs(1000);
      const tasks = taskEngine.listTasks(1000);
      return {
        ok: true,
        ts: Date.now(),
        runtime: 'openclaw-native',
        sessions: sessionManager.list(1000).length,
        jobs: jobs.length,
        tasks: tasks.length,
        pendingApprovals: approvalGate.listPending?.(500)?.length || 0,
      };
    }

    if (method === 'logs.tail') {
      const limit = toPosInt(params.limit, 80, 1, 400);
      const rows = await tailLogs({ limit, file: text(params.file || '') });
      return { ok: true, rows: Array.isArray(rows) ? rows.slice(0, limit) : [] };
    }

    if (method === 'usage.status') {
      const tasks = taskEngine.listTasks(1200);
      const success = tasks.filter((x) => x?.status === 'success').length;
      const failed = tasks.filter((x) => x?.status === 'failed').length;
      return {
        ok: true,
        tasksTotal: tasks.length,
        tasksSuccess: success,
        tasksFailed: failed,
        successRate: tasks.length ? Number((success / tasks.length).toFixed(4)) : 1,
      };
    }

    if (method === 'usage.cost') {
      const tasks = taskEngine.listTasks(1200);
      const modelCalls = tasks.filter((x) => x?.type === 'chat' || x?.tool === 'chat.model.invoke').length;
      return {
        ok: true,
        currency: 'USD',
        estimated: {
          total: Number((modelCalls * 0.002).toFixed(6)),
          modelCalls,
        },
      };
    }

    if (method === 'channels.status') {
      const status = await getChannelStatus();
      return {
        ok: true,
        channels: status && typeof status === 'object' ? status : {},
      };
    }

    if (method === 'channels.logout') {
      const channel = text(params.channel || params.channelId || '');
      return {
        ok: true,
        channel,
        loggedOut: Boolean(channel),
        note: channel ? 'logout requested' : 'channel required',
      };
    }

    if (method === 'tts.status') {
      return {
        enabled: compatState.tts.enabled === true,
        provider: compatState.tts.provider || 'system',
      };
    }
    if (method === 'tts.providers') {
      return {
        providers: [
          { id: 'system', name: 'System TTS', available: true },
          { id: 'none', name: 'Disabled', available: true },
        ],
      };
    }
    if (method === 'tts.enable') {
      compatState.tts.enabled = true;
      return { enabled: true, provider: compatState.tts.provider || 'system' };
    }
    if (method === 'tts.disable') {
      compatState.tts.enabled = false;
      return { enabled: false, provider: compatState.tts.provider || 'system' };
    }
    if (method === 'tts.setProvider') {
      const provider = text(params.provider || params.id || 'system') || 'system';
      compatState.tts.provider = provider;
      return { provider, enabled: compatState.tts.enabled === true };
    }
    if (method === 'tts.convert') {
      const textValue = text(params.text || '');
      if (!textValue) {
        throw { code: 'invalid_params', message: 'tts.convert requires text', statusCode: 400 };
      }
      return {
        ok: true,
        provider: compatState.tts.provider || 'system',
        text: textValue,
        audioUrl: null,
      };
    }

    if (method === 'config.get') {
      const key = text(params.key || '');
      if (!key) {
        return { config: compatState.config };
      }
      return { key, value: deepGet(compatState.config, key) };
    }
    if (method === 'config.set') {
      const key = text(params.key || '');
      if (!key) {
        throw { code: 'invalid_params', message: 'config.set requires key', statusCode: 400 };
      }
      deepSet(compatState.config, key, params.value);
      return { ok: true, key, value: deepGet(compatState.config, key) };
    }
    if (method === 'config.patch' || method === 'config.apply') {
      const patch = safeObj(params.patch || params.config || params);
      const merged = { ...compatState.config, ...patch };
      compatState.config = merged;
      return { ok: true, config: compatState.config };
    }
    if (method === 'config.schema') {
      return {
        schemaVersion: 1,
        type: 'object',
        properties: {
          runtime: { type: 'object' },
          models: { type: 'object' },
          channels: { type: 'object' },
        },
      };
    }

    if (method === 'exec.approval.waitDecision') {
      const approvalId = text(params.id || params.approvalId || '');
      const pending = approvalGate.listPending?.(500) || [];
      const row = pending.find((x) => text(x?.approvalId || '') === approvalId) || null;
      return {
        ok: true,
        approval: row,
        decision: row?.decision || null,
        pending: row?.status === 'pending',
      };
    }

    if (method === 'wizard.start') {
      compatState.wizard.running = true;
      compatState.wizard.sessionId = createCompatId('wizard');
      compatState.wizard.step = 1;
      compatState.wizard.flow = text(params.flow || 'default') || 'default';
      compatState.wizard.updatedAt = nowIso();
      return {
        ok: true,
        sessionId: compatState.wizard.sessionId,
        step: compatState.wizard.step,
        flow: compatState.wizard.flow,
      };
    }
    if (method === 'wizard.next') {
      if (!compatState.wizard.running) {
        throw { code: 'invalid_request', message: 'wizard_not_running', statusCode: 400 };
      }
      compatState.wizard.step += 1;
      compatState.wizard.updatedAt = nowIso();
      return {
        ok: true,
        sessionId: compatState.wizard.sessionId,
        step: compatState.wizard.step,
      };
    }
    if (method === 'wizard.cancel') {
      const sessionId = compatState.wizard.sessionId;
      compatState.wizard.running = false;
      compatState.wizard.updatedAt = nowIso();
      return { ok: true, sessionId, cancelled: true };
    }
    if (method === 'wizard.status') {
      return {
        running: compatState.wizard.running === true,
        sessionId: compatState.wizard.sessionId,
        step: compatState.wizard.step,
        flow: compatState.wizard.flow,
      };
    }

    if (method === 'talk.config') {
      return { config: compatState.talk.config || {} };
    }
    if (method === 'talk.mode') {
      const mode = text(params.mode || '');
      if (mode) compatState.talk.mode = mode;
      return { mode: compatState.talk.mode };
    }

    if (method === 'models.list') {
      return {
        providers: [
          {
            id: 'openclaw',
            models: [
              { id: 'default', name: 'OpenClaw Default' },
            ],
          },
        ],
      };
    }

    if (method === 'agents.list') {
      return {
        agents: Object.values(compatState.agents || {}),
      };
    }
    if (method === 'agents.create') {
      const agentId = text(params.agentId || params.id || params.name);
      if (!agentId) {
        throw { code: 'invalid_params', message: 'agents.create requires agentId', statusCode: 400 };
      }
      if (compatState.agents[agentId]) {
        throw { code: 'invalid_request', message: 'agent_exists', statusCode: 400 };
      }
      compatState.agents[agentId] = {
        agentId,
        name: text(params.name || agentId),
        workspace: text(params.workspace || workspaceDir),
        files: {},
        updatedAt: nowIso(),
      };
      return { ok: true, agentId, agent: compatState.agents[agentId] };
    }
    if (method === 'agents.update') {
      const agentId = text(params.agentId || params.id);
      if (!agentId || !compatState.agents[agentId]) {
        throw { code: 'not_found', message: 'agent_not_found', statusCode: 404 };
      }
      compatState.agents[agentId] = {
        ...compatState.agents[agentId],
        name: text(params.name || compatState.agents[agentId].name),
        workspace: text(params.workspace || compatState.agents[agentId].workspace),
        updatedAt: nowIso(),
      };
      return { ok: true, agentId, agent: compatState.agents[agentId] };
    }
    if (method === 'agents.delete') {
      const agentId = text(params.agentId || params.id);
      if (!agentId || !compatState.agents[agentId]) {
        throw { code: 'not_found', message: 'agent_not_found', statusCode: 404 };
      }
      if (agentId === 'main') {
        throw { code: 'invalid_request', message: 'main_agent_protected', statusCode: 400 };
      }
      delete compatState.agents[agentId];
      return { ok: true, agentId };
    }
    if (method === 'agents.files.list') {
      const agentId = text(params.agentId || params.id || 'main');
      const agent = compatState.agents[agentId];
      if (!agent) throw { code: 'not_found', message: 'agent_not_found', statusCode: 404 };
      return { agentId, files: Object.keys(agent.files || {}) };
    }
    if (method === 'agents.files.get') {
      const agentId = text(params.agentId || params.id || 'main');
      const file = text(params.file || params.name);
      const agent = compatState.agents[agentId];
      if (!agent) throw { code: 'not_found', message: 'agent_not_found', statusCode: 404 };
      if (!file) throw { code: 'invalid_params', message: 'file required', statusCode: 400 };
      return { agentId, file, content: String(agent.files?.[file] || '') };
    }
    if (method === 'agents.files.set') {
      const agentId = text(params.agentId || params.id || 'main');
      const file = text(params.file || params.name);
      const content = String(params.content || '');
      const agent = compatState.agents[agentId];
      if (!agent) throw { code: 'not_found', message: 'agent_not_found', statusCode: 404 };
      if (!file) throw { code: 'invalid_params', message: 'file required', statusCode: 400 };
      agent.files[file] = content;
      agent.updatedAt = nowIso();
      return { ok: true, agentId, file };
    }

    if (method === 'skills.status') {
      return {
        ok: true,
        installed: compatState.skills.installed,
      };
    }
    if (method === 'skills.bins') {
      return { bins: compatState.skills.bins };
    }
    if (method === 'skills.install' || method === 'skills.update') {
      const skillKey = text(params.skillKey || params.name || '');
      if (!skillKey) throw { code: 'invalid_params', message: 'skillKey required', statusCode: 400 };
      if (!compatState.skills.installed.includes(skillKey)) {
        compatState.skills.installed.push(skillKey);
      }
      return { ok: true, skillKey };
    }

    if (method === 'update.run') {
      return { ok: true, started: true, note: 'update.run accepted' };
    }

    if (method === 'voicewake.get') {
      return { triggers: compatState.voicewake.triggers };
    }
    if (method === 'voicewake.set') {
      const triggers = Array.isArray(params.triggers)
        ? params.triggers.map((x) => text(x)).filter(Boolean).slice(0, 24)
        : [];
      if (!triggers.length) {
        throw { code: 'invalid_params', message: 'voicewake.set requires triggers', statusCode: 400 };
      }
      compatState.voicewake.triggers = triggers;
      return { triggers };
    }

    if (method === 'chat.send') {
      const normalized = normalizeChatSendParams(params);
      if (!normalized.message) {
        throw { code: 'invalid_params', message: 'chat.send requires message', statusCode: 400 };
      }
      const out = await invokeChatThroughRuntime(normalized.message, normalized.clientContext, normalized.runId);
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
        runId: out.runId || normalized.runId,
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
    if (method === 'sessions.preview') {
      const keys = Array.isArray(params.keys)
        ? params.keys.map((x) => sessionManager.normalizeSessionKey(x)).filter(Boolean).slice(0, 64)
        : [];
      const limit = toPosInt(params.limit, 12, 1, 120);
      const maxChars = toPosInt(params.maxChars, 240, 40, 2000);
      const targetKeys = keys.length ? keys : sessionManager.list(64).map((x) => x?.key).filter(Boolean);
      const previews = targetKeys.map((key) => {
        const session = sessionManager.get?.(key);
        if (!session) return { key, status: 'missing', items: [] };
        const items = buildSessionPreviewItems(session, limit, maxChars);
        return { key, status: items.length ? 'ok' : 'empty', items };
      });
      return { ts: Date.now(), previews };
    }
    if (method === 'sessions.delete') {
      const key = sessionManager.normalizeSessionKey(params.key || params.sessionKey);
      const ok = sessionManager.remove?.(key) || false;
      if (!ok) throw { code: 'not_found', message: 'session_not_found', statusCode: 404 };
      return { ok: true, key };
    }

    if (method === 'chat.history') {
      return buildChatHistoryPayload(params);
    }
    if (method === 'chat.abort') {
      const runId = text(params.runId || params.id || '');
      if (runId && chatRuns.has(runId)) {
        const row = chatRuns.get(runId);
        row.aborted = true;
        row.status = 'aborted';
        row.finishedAt = nowIso();
        chatRuns.set(runId, row);
        return { ok: true, aborted: true, runIds: [runId] };
      }
      const sessionKey = text(params.sessionKey || params.key || '');
      const candidates = Array.from(chatRuns.values()).filter(
        (x) => sessionKey && text(x?.sessionKey || '') === sessionKey && x?.status === 'in_flight',
      );
      candidates.forEach((row) => {
        row.aborted = true;
        row.status = 'aborted';
        row.finishedAt = nowIso();
        if (row?.runId) chatRuns.set(String(row.runId), row);
      });
      return {
        ok: true,
        aborted: candidates.length > 0,
        runIds: candidates.map((x) => x?.runId).filter(Boolean),
      };
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

    if (method === 'exec.approval.request') {
      const action = text(params.action || params.command || 'manual.request');
      const summary = text(params.summary || params.message || action);
      const approval = approvalGate.evaluate({
        action,
        summary,
        type: text(params.type || 'manual'),
        tool: text(params.tool || ''),
        command: text(params.command || ''),
        url: text(params.url || ''),
        ask: 'always',
      });
      return {
        ok: true,
        approvalId: approval.approvalId || null,
        needApproval: approval.needApproval === true,
        reason: approval.reason || 'approval_requested',
      };
    }

    if (method === 'approvals.list') {
      return {
        config: approvalGate.getSnapshot?.() || {},
        pending: approvalGate.listPending?.(200) || [],
      };
    }
    if (method === 'approvals.decide') {
      const approvalId = text(params.approvalId || params.requestId || params.id);
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

    if (method === 'last-heartbeat') {
      return {
        ts: Date.now(),
        last: compatState.heartbeats.last,
        presets: compatState.heartbeats.presets,
      };
    }
    if (method === 'set-heartbeats') {
      const presets = Array.isArray(params.items) ? params.items : Array.isArray(params.heartbeats) ? params.heartbeats : [];
      compatState.heartbeats.presets = presets.slice(0, 24);
      compatState.heartbeats.last = nowIso();
      return { ok: true, presets: compatState.heartbeats.presets };
    }
    if (method === 'wake' || method === 'system-event') {
      const payload = {
        ts: nowIso(),
        mode: text(params.mode || 'now') || 'now',
        text: text(params.text || params.message || ''),
      };
      compatState.heartbeats.last = payload.ts;
      compatState.systemEvents.unshift(payload);
      compatState.systemEvents = compatState.systemEvents.slice(0, 400);
      return { ok: true, wake: payload };
    }

    if (method === 'system-presence') {
      const entry = {
        ts: nowIso(),
        status: text(params.status || 'online') || 'online',
        note: text(params.note || ''),
      };
      compatState.systemPresence.unshift(entry);
      compatState.systemPresence = compatState.systemPresence.slice(0, 240);
      return {
        ok: true,
        latest: entry,
        rows: compatState.systemPresence.slice(0, 40),
      };
    }

    if (method === 'node.pair.request') {
      const requestId = createCompatId('node-pair');
      const row = {
        requestId,
        nodeId: text(params.nodeId || params.id || createCompatId('node')),
        displayName: text(params.displayName || params.name || 'Remote Node'),
        status: 'pending',
        createdAt: nowIso(),
      };
      compatState.nodePairs.unshift(row);
      compatState.nodePairs = compatState.nodePairs.slice(0, 200);
      return { requestId, node: row };
    }
    if (method === 'node.pair.list') {
      return { requests: compatState.nodePairs.slice(0, 120) };
    }
    if (method === 'node.pair.approve' || method === 'node.pair.reject' || method === 'node.pair.verify') {
      const requestId = text(params.requestId || params.id || '');
      const row = compatState.nodePairs.find((x) => text(x?.requestId || '') === requestId);
      if (!row) throw { code: 'not_found', message: 'request_not_found', statusCode: 404 };
      row.status = method.endsWith('approve') ? 'approved' : method.endsWith('reject') ? 'rejected' : 'verified';
      row.updatedAt = nowIso();
      return { requestId, node: row };
    }

    if (method === 'device.pair.list') {
      return { requests: compatState.devicePairs.slice(0, 120) };
    }
    if (method === 'device.pair.approve' || method === 'device.pair.reject') {
      const requestId = text(params.requestId || params.id || '');
      const row = compatState.devicePairs.find((x) => text(x?.requestId || '') === requestId);
      if (!row) throw { code: 'not_found', message: 'request_not_found', statusCode: 404 };
      row.status = method.endsWith('approve') ? 'approved' : 'rejected';
      row.updatedAt = nowIso();
      return { requestId, device: row };
    }
    if (method === 'device.pair.remove') {
      const deviceId = text(params.deviceId || params.id || '');
      const before = compatState.devicePairs.length;
      compatState.devicePairs = compatState.devicePairs.filter((x) => text(x?.deviceId || '') !== deviceId);
      if (before === compatState.devicePairs.length) {
        throw { code: 'not_found', message: 'device_not_found', statusCode: 404 };
      }
      return { ok: true, deviceId };
    }
    if (method === 'device.token.rotate' || method === 'device.token.revoke') {
      const deviceId = text(params.deviceId || params.id || '');
      if (!deviceId) throw { code: 'invalid_params', message: 'deviceId required', statusCode: 400 };
      return {
        ok: true,
        deviceId,
        token:
          method === 'device.token.rotate'
            ? createCompatId('token')
            : null,
      };
    }

    if (method === 'node.rename') {
      const nodeId = text(params.nodeId || params.id || '');
      const displayName = text(params.displayName || params.name || '');
      if (!nodeId || !displayName) throw { code: 'invalid_params', message: 'nodeId/displayName required', statusCode: 400 };
      return { nodeId, displayName };
    }
    if (method === 'node.list') {
      const rows = compatState.nodePairs
        .filter((x) => x?.status === 'approved' || x?.status === 'verified')
        .map((x) => ({
          nodeId: x.nodeId,
          displayName: x.displayName || x.nodeId,
          status: x.status,
          connected: true,
        }));
      return { ts: Date.now(), nodes: rows };
    }
    if (method === 'node.describe') {
      const nodeId = text(params.nodeId || params.id || '');
      const row = compatState.nodePairs.find((x) => text(x?.nodeId || '') === nodeId);
      if (!row) throw { code: 'not_found', message: 'node_not_found', statusCode: 404 };
      return {
        node: {
          nodeId: row.nodeId,
          displayName: row.displayName || row.nodeId,
          status: row.status,
          connected: row.status === 'approved' || row.status === 'verified',
        },
      };
    }
    if (method === 'node.invoke') {
      const nodeId = text(params.nodeId || '');
      const command = text(params.command || '');
      if (!nodeId || !command) throw { code: 'invalid_params', message: 'nodeId and command required', statusCode: 400 };
      const requestId = createCompatId('node-invoke');
      const item = {
        requestId,
        nodeId,
        command,
        status: 'accepted',
        createdAt: nowIso(),
      };
      compatState.nodeInvocations.unshift(item);
      compatState.nodeInvocations = compatState.nodeInvocations.slice(0, 400);
      return { requestId, accepted: true };
    }
    if (method === 'node.invoke.result') {
      const requestId = text(params.requestId || params.id || '');
      const row = compatState.nodeInvocations.find((x) => text(x?.requestId || '') === requestId);
      if (!row) throw { code: 'not_found', message: 'request_not_found', statusCode: 404 };
      return {
        requestId,
        ok: true,
        result: {
          output: '',
          status: row.status || 'accepted',
        },
      };
    }
    if (method === 'node.event') {
      const payload = {
        ts: nowIso(),
        nodeId: text(params.nodeId || ''),
        event: text(params.event || ''),
        payload: safeObj(params.payload),
      };
      compatState.systemEvents.unshift(payload);
      compatState.systemEvents = compatState.systemEvents.slice(0, 400);
      return { ok: true };
    }

    if (method === 'send') {
      const textValue = text(params.text || params.message || '');
      const channel = text(params.channel || 'telegram') || 'telegram';
      const to = text(params.to || params.chatId || '');
      if (!textValue) throw { code: 'invalid_params', message: 'send requires text', statusCode: 400 };
      const out = await sendOutboundMessage({
        channel,
        to,
        text: textValue,
        params,
      });
      if (out?.ok === false) {
        throw { code: 'runtime_error', message: text(out.error || 'send_failed'), statusCode: 502, data: out };
      }
      return {
        ok: true,
        channel,
        to,
        text: textValue,
        delivery: out || { ok: true },
      };
    }

    if (method === 'agent') {
      const prompt = text(params.prompt || params.message || params.text);
      const out = await dispatchGatewayMethod('chat.send', {
        message: prompt,
        sessionKey: text(params.sessionKey || 'agent:main'),
        source: text(params.source || 'gateway-agent'),
      });
      return {
        ok: true,
        reply: out.reply || '',
        actions: out.actions || [],
      };
    }
    if (method === 'agent.identity.get') {
      return {
        agentId: 'main',
        name: 'ThunderClaw Main',
        workspace: workspaceDir,
      };
    }
    if (method === 'agent.wait') {
      return { ok: true, done: true };
    }

    if (method === 'browser.request') {
      return {
        ok: false,
        disabled: true,
        message: 'browser proxy is not enabled in thunderclaw runtime',
      };
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

    if (legacyChatIntents && /^(memory_search|记忆检索)(?:\s|$)/i.test(message)) {
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

    if (legacyChatIntents && /^(memory_get|读取记忆)(?:\s|$)/i.test(message)) {
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

    if (legacyChatIntents && /^(reset session|会话重置)(?:\s|$)/i.test(message)) {
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

    const shouldRouteTools = legacyChatIntents || (tradingPluginEnabled && looksLikeTradingDomainMessage(message));
    if (shouldRouteTools) {
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
        appendChatHistoryEvent({
          source: String(routed.source || 'runtime'),
          role: 'bot',
          direction: 'outbound',
          text: reply,
        });
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
    }

    const taskIntent = legacyChatIntents ? parseTaskIntent(message) : null;
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

    const scheduleIntent = legacyChatIntents ? parseScheduleIntent(message) : null;
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
      const structured = parseStructuredModelReply(out?.reply);
      const reply = text(structured.reply) || '模型暂无回复。';
      const actions = Array.isArray(structured.actions) ? structured.actions : [];
      sessionManager.appendEvent?.(sessionKey, { type: 'chat', role: 'bot', detail: reply });
      appendChatHistoryEvent({ source: 'openclaw', role: 'bot', direction: 'outbound', text: reply });
      rememberConversation(sessionKey, message, reply, 'openclaw');
      sendJson(res, 200, {
        ok: true,
        source: 'openclaw',
        reply,
        actions,
        contextDigest: trading.digest || null,
        executionTrace,
        meta: {
          sessionKey: session.key,
          provider: text(out?.agentMeta?.provider || ''),
          model: text(out?.agentMeta?.model || ''),
          elapsedMs: toNum(out?.elapsedMs, 0),
          commandSource: text(out?.commandSource || ''),
        },
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
        methods: OPENCLAW_COMPAT_METHODS,
      });
      return true;
    }

    if (pathname === '/api/runtime/chat/history') {
      if (method !== 'GET') {
        res.statusCode = 405;
        res.setHeader('Allow', 'GET');
        res.end('Method Not Allowed');
        return true;
      }
      const payload = buildChatHistoryPayload({
        sessionKey: text(url?.searchParams?.get('sessionKey') || ''),
        key: text(url?.searchParams?.get('key') || ''),
        limit: toPosInt(url?.searchParams?.get('limit'), 40, 1, 400),
        maxChars: toPosInt(url?.searchParams?.get('maxChars'), 2400, 80, 24_000),
        afterTs: toNum(url?.searchParams?.get('afterTs'), 0),
      });
      sendJson(res, 200, { ok: true, ...payload });
      return true;
    }

    if (pathname === '/api/runtime/chat/abort') {
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
      const out = await dispatchGatewayMethod('chat.abort', safeObj(parsed.value));
      sendJson(res, 200, { ok: true, ...safeObj(out) });
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

    if (pathname === '/api/runtime/sessions/delete') {
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
      const sessionKey = sessionManager.normalizeSessionKey(parsed.value?.sessionKey || parsed.value?.key);
      const ok = sessionManager.remove?.(sessionKey) || false;
      sendJson(res, ok ? 200 : 404, { ok, key: sessionKey, error: ok ? null : 'session_not_found' });
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
    listGatewayMethods() {
      return OPENCLAW_COMPAT_METHODS.slice();
    },
    async invokeGatewayMethod(methodLike, paramsLike = {}) {
      return dispatchGatewayMethod(methodLike, paramsLike);
    },
    async handleGatewayFrame(frameLike = {}) {
      const frame = safeObj(frameLike);
      const id = frame.id ?? null;
      const method = text(frame.method);
      try {
        const payload = await dispatchGatewayMethod(method, safeObj(frame.params));
        return { type: 'res', id, ok: true, payload };
      } catch (errorLike) {
        const err = safeObj(errorLike);
        return {
          type: 'res',
          id,
          ok: false,
          error: {
            code: text(err.code || 'runtime_error') || 'runtime_error',
            message: text(err.message || 'runtime_error') || 'runtime_error',
            details: err.data && typeof err.data === 'object' ? err.data : null,
          },
        };
      }
    },
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
