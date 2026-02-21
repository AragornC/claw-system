import fs from 'node:fs';
import path from 'node:path';

function nowIso() {
  return new Date().toISOString();
}

function safeJson(raw, fallback) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function createId(prefix = 'task') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createTaskEngine(options = {}) {
  const storePath = path.resolve(String(options.storePath || 'memory/runtime-tasks.json'));
  const executeTool =
    typeof options.executeTool === 'function'
      ? options.executeTool
      : async () => ({ ok: false, error: 'tool_executor_missing' });

  let state = {
    updatedAt: nowIso(),
    tasks: {},
  };

  function load() {
    try {
      if (!fs.existsSync(storePath)) return;
      const parsed = safeJson(fs.readFileSync(storePath, 'utf8'), null);
      if (!parsed || typeof parsed !== 'object') return;
      state = {
        updatedAt: String(parsed.updatedAt || nowIso()),
        tasks: parsed.tasks && typeof parsed.tasks === 'object' ? parsed.tasks : {},
      };
    } catch {}
  }

  function save() {
    state.updatedAt = nowIso();
    try {
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      fs.writeFileSync(storePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    } catch {}
  }

  function createTask(inputLike = {}) {
    const input = inputLike && typeof inputLike === 'object' ? inputLike : {};
    const id = String(input.id || createId('task'));
    const task = {
      id,
      title: String(input.title || input.tool || 'runtime-task'),
      type: String(input.type || 'tool'),
      tool: String(input.tool || ''),
      args: input.args && typeof input.args === 'object' ? input.args : {},
      sessionKey: String(input.sessionKey || 'dashboard:main'),
      status: 'queued',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      startedAt: null,
      finishedAt: null,
      retries: 0,
      maxRetries: Math.max(0, Number(input.maxRetries || 1) || 1),
      result: null,
      error: null,
    };
    state.tasks[id] = task;
    save();
    return task;
  }

  function getTask(idLike) {
    return state.tasks[String(idLike || '')] || null;
  }

  function listTasks(limitLike = 120) {
    const limit = Math.max(1, Math.min(1000, Number(limitLike || 120) || 120));
    return Object.values(state.tasks)
      .sort((a, b) => new Date(String(b?.createdAt || 0)).getTime() - new Date(String(a?.createdAt || 0)).getTime())
      .slice(0, limit);
  }

  async function runTask(idLike) {
    const task = getTask(idLike);
    if (!task) return { ok: false, error: 'task_not_found' };
    if (!task.tool) {
      task.status = 'failed';
      task.error = 'task_tool_required';
      task.updatedAt = nowIso();
      task.finishedAt = nowIso();
      save();
      return { ok: false, error: task.error };
    }
    task.status = 'running';
    task.startedAt = nowIso();
    task.updatedAt = nowIso();
    save();
    try {
      const out = await executeTool(task.tool, task.args, { taskId: task.id, sessionKey: task.sessionKey });
      task.status = out?.ok === false ? 'failed' : 'success';
      task.result = out || null;
      task.error = out?.ok === false ? String(out.error || 'task_failed') : null;
      task.updatedAt = nowIso();
      task.finishedAt = nowIso();
      save();
      return { ok: task.status === 'success', task };
    } catch (err) {
      task.status = 'failed';
      task.error = String(err?.message || err || 'task_failed');
      task.updatedAt = nowIso();
      task.finishedAt = nowIso();
      save();
      return { ok: false, error: task.error, task };
    }
  }

  async function retryTask(idLike) {
    const task = getTask(idLike);
    if (!task) return { ok: false, error: 'task_not_found' };
    if (Number(task.retries || 0) >= Number(task.maxRetries || 0)) {
      return { ok: false, error: 'task_retry_exceeded', task };
    }
    task.retries = Number(task.retries || 0) + 1;
    task.status = 'queued';
    task.error = null;
    task.result = null;
    task.updatedAt = nowIso();
    save();
    return runTask(task.id);
  }

  load();

  return {
    storePath,
    createTask,
    getTask,
    listTasks,
    runTask,
    retryTask,
  };
}
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function nowIso() {
  return new Date().toISOString();
}

function parseJson(raw, fallback) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function createTaskEngine(options = {}) {
  const storePath = path.resolve(String(options.storePath || 'memory/runtime-tasks.json'));
  const handlers = options.handlers && typeof options.handlers === 'object' ? options.handlers : {};
  const auditLog = options.auditLog || null;

  let state = {
    updatedAt: nowIso(),
    tasks: [],
  };

  function load() {
    try {
      if (!fs.existsSync(storePath)) return;
      const raw = fs.readFileSync(storePath, 'utf8');
      const parsed = parseJson(raw, null);
      if (parsed && Array.isArray(parsed.tasks)) {
        state = {
          updatedAt: String(parsed.updatedAt || nowIso()),
          tasks: parsed.tasks,
        };
      }
    } catch {}
  }

  function save() {
    state.updatedAt = nowIso();
    try {
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      fs.writeFileSync(storePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    } catch {}
  }

  function list(optionsLike = {}) {
    const limit = Math.max(1, Math.min(300, Number(optionsLike.limit || 80) || 80));
    const sessionKey = String(optionsLike.sessionKey || '').trim();
    const rows = sessionKey ? state.tasks.filter((x) => String(x?.sessionKey || '') === sessionKey) : state.tasks;
    return rows
      .slice()
      .sort((a, b) => new Date(String(b?.updatedAt || 0)).getTime() - new Date(String(a?.updatedAt || 0)).getTime())
      .slice(0, limit);
  }

  function get(taskIdLike) {
    const taskId = String(taskIdLike || '').trim();
    if (!taskId) return null;
    return state.tasks.find((x) => String(x?.taskId || '') === taskId) || null;
  }

  async function executeTask(task) {
    const target = task && typeof task === 'object' ? task : null;
    if (!target) return null;
    const idx = state.tasks.findIndex((x) => x.taskId === target.taskId);
    if (idx < 0) return null;
    state.tasks[idx] = {
      ...state.tasks[idx],
      status: 'running',
      startedAt: nowIso(),
      updatedAt: nowIso(),
      attempts: Number(state.tasks[idx].attempts || 0) + 1,
    };
    save();
    auditLog?.append?.('task_started', { taskId: target.taskId, type: target.type });
    const handler = handlers[target.type];
    if (typeof handler !== 'function') {
      state.tasks[idx] = {
        ...state.tasks[idx],
        status: 'failed',
        finishedAt: nowIso(),
        updatedAt: nowIso(),
        error: `task_handler_missing:${target.type}`,
      };
      save();
      auditLog?.append?.('task_failed', { taskId: target.taskId, reason: 'handler_missing' });
      return state.tasks[idx];
    }
    try {
      const out = await handler(target.payload || {}, target);
      state.tasks[idx] = {
        ...state.tasks[idx],
        status: 'success',
        finishedAt: nowIso(),
        updatedAt: nowIso(),
        result: out && typeof out === 'object' ? out : { value: out },
        error: null,
      };
      save();
      auditLog?.append?.('task_succeeded', { taskId: target.taskId });
      return state.tasks[idx];
    } catch (err) {
      state.tasks[idx] = {
        ...state.tasks[idx],
        status: 'failed',
        finishedAt: nowIso(),
        updatedAt: nowIso(),
        error: String(err?.message || err || 'task_failed'),
      };
      save();
      auditLog?.append?.('task_failed', { taskId: target.taskId, reason: state.tasks[idx].error });
      return state.tasks[idx];
    }
  }

  async function enqueue(paramsLike = {}) {
    const params = paramsLike && typeof paramsLike === 'object' ? paramsLike : {};
    const type = String(params.type || '').trim();
    if (!type) throw new Error('task_type_required');
    const task = {
      taskId: crypto.randomUUID(),
      type,
      sessionKey: String(params.sessionKey || 'dashboard:main'),
      payload: params.payload && typeof params.payload === 'object' ? params.payload : {},
      status: 'queued',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      startedAt: null,
      finishedAt: null,
      attempts: 0,
      error: null,
      result: null,
    };
    state.tasks.push(task);
    save();
    auditLog?.append?.('task_enqueued', { taskId: task.taskId, type: task.type });
    const mode = String(params.execution || 'async');
    if (mode === 'sync') {
      return await executeTask(task);
    }
    void executeTask(task);
    return task;
  }

  async function retry(taskIdLike) {
    const task = get(taskIdLike);
    if (!task) throw new Error('task_not_found');
    if (task.status === 'running') throw new Error('task_running');
    return await enqueue({
      type: task.type,
      sessionKey: task.sessionKey,
      payload: task.payload || {},
      execution: 'async',
    });
  }

  load();

  return {
    storePath,
    enqueue,
    executeTask,
    retry,
    get,
    list,
  };
}
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function nowIso() {
  return new Date().toISOString();
}

function readJsonSafe(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonSafe(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function createTaskEngine(options = {}) {
  const filePath = path.resolve(String(options.filePath || 'memory/runtime-tasks.json'));
  const toolRuntime = options.toolRuntime;
  const sessionManager = options.sessionManager;
  const auditLog = options.auditLog;
  let running = false;

  function loadState() {
    return readJsonSafe(filePath, { version: 1, tasks: [], updatedAt: nowIso() });
  }

  function saveState(state) {
    const next = state && typeof state === 'object' ? state : { version: 1, tasks: [] };
    next.updatedAt = nowIso();
    writeJsonSafe(filePath, next);
    return next;
  }

  function enqueue(taskLike = {}) {
    const task = {
      id: crypto.randomUUID(),
      createdAt: nowIso(),
      updatedAt: nowIso(),
      status: 'queued',
      type: String(taskLike.type || 'tool_call'),
      sessionKey: String(taskLike.sessionKey || 'dashboard:default'),
      payload: taskLike.payload && typeof taskLike.payload === 'object' ? taskLike.payload : {},
      attempts: 0,
      error: null,
      result: null,
    };
    const state = loadState();
    state.tasks.push(task);
    saveState(state);
    auditLog?.append('task.enqueued', { id: task.id, type: task.type, sessionKey: task.sessionKey });
    return task;
  }

  function list(params = {}) {
    const state = loadState();
    let rows = state.tasks || [];
    if (params.status) rows = rows.filter((x) => x.status === params.status);
    if (params.sessionKey) rows = rows.filter((x) => x.sessionKey === params.sessionKey);
    const limit = Math.max(1, Math.min(200, Number(params.limit || 60)));
    return rows.slice(-limit).reverse();
  }

  function get(taskIdLike) {
    const taskId = String(taskIdLike || '').trim();
    if (!taskId) return null;
    const state = loadState();
    return (state.tasks || []).find((x) => x.id === taskId) || null;
  }

  function updateTask(taskId, patch) {
    const state = loadState();
    const idx = (state.tasks || []).findIndex((x) => x.id === taskId);
    if (idx < 0) return null;
    const current = state.tasks[idx];
    const next = { ...current, ...patch, updatedAt: nowIso() };
    state.tasks[idx] = next;
    saveState(state);
    return next;
  }

  async function runTask(task) {
    const payload = task.payload || {};
    if (task.type !== 'tool_call') {
      return { ok: false, error: 'unsupported_task_type' };
    }
    const tool = String(payload.tool || '').trim();
    const args = payload.arguments && typeof payload.arguments === 'object' ? payload.arguments : {};
    return toolRuntime.invoke(tool, args, {
      source: String(payload.source || 'dashboard'),
      rawMessage: String(payload.rawMessage || ''),
    });
  }

  async function pumpOnce() {
    if (running) return;
    running = true;
    try {
      const queued = list({ status: 'queued', limit: 1 })[0];
      if (!queued) return;
      updateTask(queued.id, { status: 'running', attempts: Number(queued.attempts || 0) + 1 });
      sessionManager?.appendEvent(queued.sessionKey, {
        type: 'task',
        stage: 'running',
        taskId: queued.id,
        detail: `任务执行中：${queued.type}`,
      });
      const out = await runTask(queued);
      if (out?.ok === false) {
        updateTask(queued.id, { status: 'failed', error: String(out.error || 'task_failed') });
        sessionManager?.appendEvent(queued.sessionKey, {
          type: 'task',
          stage: 'failed',
          taskId: queued.id,
          detail: String(out.error || 'task_failed'),
        });
        auditLog?.append('task.failed', { id: queued.id, error: String(out.error || 'task_failed') });
        return;
      }
      updateTask(queued.id, { status: 'success', result: out || null, error: null });
      sessionManager?.appendEvent(queued.sessionKey, {
        type: 'task',
        stage: 'success',
        taskId: queued.id,
        detail: String(out?.summary || '任务完成'),
      });
      auditLog?.append('task.success', { id: queued.id });
    } finally {
      running = false;
    }
  }

  async function retry(taskIdLike) {
    const taskId = String(taskIdLike || '').trim();
    if (!taskId) return null;
    const task = get(taskId);
    if (!task) return null;
    if (task.status !== 'failed') return task;
    return updateTask(task.id, { status: 'queued', error: null });
  }

  return {
    enqueue,
    list,
    get,
    retry,
    pumpOnce,
    filePath,
  };
}
