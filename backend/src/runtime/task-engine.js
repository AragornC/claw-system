import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

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
  const storePath = path.resolve(String(options.storePath || options.filePath || 'memory/runtime-tasks.json'));
  const executeTool =
    typeof options.executeTool === 'function'
      ? options.executeTool
      : async () => ({ ok: false, error: 'tool_executor_missing' });
  const emitAudit = typeof options.emitAudit === 'function' ? options.emitAudit : () => {};
  const appendSessionEvent =
    typeof options.appendSessionEvent === 'function' ? options.appendSessionEvent : () => {};

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
      traceId: crypto.randomUUID(),
    };
    state.tasks[id] = task;
    save();
    emitAudit('task.created', { id: task.id, type: task.type, sessionKey: task.sessionKey, tool: task.tool });
    return task;
  }

  function getTask(idLike) {
    return state.tasks[String(idLike || '')] || null;
  }

  function listTasks(limitLike = 120, filterLike = {}) {
    const limit = Math.max(1, Math.min(1000, Number(limitLike || 120) || 120));
    const filter = filterLike && typeof filterLike === 'object' ? filterLike : {};
    let rows = Object.values(state.tasks);
    if (filter.sessionKey) rows = rows.filter((x) => x.sessionKey === String(filter.sessionKey));
    if (filter.status) rows = rows.filter((x) => x.status === String(filter.status));
    return rows
      .sort((a, b) => new Date(String(b?.createdAt || 0)).getTime() - new Date(String(a?.createdAt || 0)).getTime())
      .slice(0, limit);
  }

  async function runTask(idLike) {
    const task = getTask(idLike);
    if (!task) return { ok: false, error: 'task_not_found' };
    if (task.status === 'running') return { ok: false, error: 'task_already_running', task };
    if (!task.tool) {
      task.status = 'failed';
      task.error = 'task_tool_required';
      task.updatedAt = nowIso();
      task.finishedAt = nowIso();
      save();
      return { ok: false, error: task.error, task };
    }

    task.status = 'running';
    task.startedAt = nowIso();
    task.updatedAt = nowIso();
    task.error = null;
    save();
    appendSessionEvent(task.sessionKey, {
      type: 'task',
      stage: 'running',
      taskId: task.id,
      detail: `任务执行中：${task.tool}`,
    });
    emitAudit('task.running', { id: task.id, tool: task.tool });

    try {
      const out = await executeTool(task.tool, task.args, {
        taskId: task.id,
        sessionKey: task.sessionKey,
      });
      task.status = out?.ok === false ? 'failed' : 'success';
      task.result = out || null;
      task.error = out?.ok === false ? String(out.error || 'task_failed') : null;
      task.updatedAt = nowIso();
      task.finishedAt = nowIso();
      save();
      appendSessionEvent(task.sessionKey, {
        type: 'task',
        stage: task.status,
        taskId: task.id,
        detail: task.error || '任务执行完成',
      });
      emitAudit('task.finished', { id: task.id, status: task.status, error: task.error });
      return { ok: task.status === 'success', task, error: task.error };
    } catch (err) {
      task.status = 'failed';
      task.error = String(err?.message || err || 'task_failed');
      task.updatedAt = nowIso();
      task.finishedAt = nowIso();
      save();
      appendSessionEvent(task.sessionKey, {
        type: 'task',
        stage: 'failed',
        taskId: task.id,
        detail: task.error,
      });
      emitAudit('task.failed', { id: task.id, error: task.error });
      return { ok: false, error: task.error, task };
    }
  }

  async function retryTask(idLike) {
    const task = getTask(idLike);
    if (!task) return { ok: false, error: 'task_not_found' };
    if (task.status === 'running') return { ok: false, error: 'task_already_running', task };
    if (Number(task.retries || 0) >= Number(task.maxRetries || 0)) {
      return { ok: false, error: 'task_retry_exceeded', task };
    }
    task.retries = Number(task.retries || 0) + 1;
    task.status = 'queued';
    task.error = null;
    task.result = null;
    task.updatedAt = nowIso();
    save();
    emitAudit('task.retry', { id: task.id, retries: task.retries, maxRetries: task.maxRetries });
    return runTask(task.id);
  }

  function enqueue(inputLike = {}) {
    return createTask(inputLike);
  }

  load();

  return {
    storePath,
    createTask,
    enqueue,
    getTask,
    listTasks,
    runTask,
    retryTask,
  };
}
