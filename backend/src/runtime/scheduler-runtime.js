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

function createId(prefix = 'job') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function parseEveryMinutesFromText(textLike) {
  const t = String(textLike || '').trim().toLowerCase();
  const m = t.match(/every\s+(\d+)\s*(m|min|minute|minutes)/i);
  if (!m) return null;
  const n = Math.max(1, Math.min(24 * 60, Number(m[1]) || 0));
  return n > 0 ? n : null;
}

export function createSchedulerRuntime(options = {}) {
  const storePath = path.resolve(String(options.storePath || 'memory/runtime-schedules.json'));
  const taskEngine = options.taskEngine;
  const emitAudit = typeof options.emitAudit === 'function' ? options.emitAudit : () => {};
  const tickMs = Math.max(500, Number(options.tickMs || 1000) || 1000);
  let timer = null;
  let ticking = false;
  let state = {
    updatedAt: nowIso(),
    jobs: {},
  };

  function load() {
    try {
      if (!fs.existsSync(storePath)) return;
      const parsed = safeJson(fs.readFileSync(storePath, 'utf8'), null);
      if (!parsed || typeof parsed !== 'object') return;
      state = {
        updatedAt: String(parsed.updatedAt || nowIso()),
        jobs: parsed.jobs && typeof parsed.jobs === 'object' ? parsed.jobs : {},
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

  function listJobs(limitLike = 120) {
    const limit = Math.max(1, Math.min(1000, Number(limitLike || 120) || 120));
    return Object.values(state.jobs)
      .sort((a, b) => new Date(String(b?.createdAt || 0)).getTime() - new Date(String(a?.createdAt || 0)).getTime())
      .slice(0, limit);
  }

  function computeNextRunAt(intervalMinutes, fromTs = Date.now()) {
    return new Date(fromTs + intervalMinutes * 60 * 1000).toISOString();
  }

  function createJob(inputLike = {}) {
    const input = inputLike && typeof inputLike === 'object' ? inputLike : {};
    const everyMinutes =
      Math.max(1, Math.min(24 * 60, Number(input.everyMinutes || parseEveryMinutesFromText(input.scheduleText) || 0))) ||
      30;
    const id = String(input.id || createId('job'));
    const job = {
      id,
      title: String(input.title || input.tool || 'runtime-job'),
      sessionKey: String(input.sessionKey || 'dashboard:main'),
      enabled: input.enabled !== false,
      tool: String(input.tool || ''),
      args: input.args && typeof input.args === 'object' ? input.args : {},
      everyMinutes,
      scheduleText: String(input.scheduleText || `every ${everyMinutes} minutes`),
      createdAt: nowIso(),
      updatedAt: nowIso(),
      lastRunAt: null,
      nextRunAt: computeNextRunAt(everyMinutes),
      lastTaskId: null,
      lastStatus: null,
      lastError: null,
    };
    state.jobs[id] = job;
    save();
    emitAudit('scheduler.job.created', { id: job.id, sessionKey: job.sessionKey, tool: job.tool, everyMinutes });
    return job;
  }

  function getJob(idLike) {
    return state.jobs[String(idLike || '')] || null;
  }

  function patchJob(idLike, patchLike = {}) {
    const job = getJob(idLike);
    if (!job) return null;
    const patch = patchLike && typeof patchLike === 'object' ? patchLike : {};
    if (typeof patch.enabled === 'boolean') job.enabled = patch.enabled;
    if (patch.args && typeof patch.args === 'object') job.args = patch.args;
    if (typeof patch.everyMinutes === 'number' && Number.isFinite(patch.everyMinutes)) {
      job.everyMinutes = Math.max(1, Math.min(24 * 60, Number(patch.everyMinutes) || job.everyMinutes));
    }
    if (typeof patch.scheduleText === 'string' && patch.scheduleText.trim()) {
      job.scheduleText = patch.scheduleText.trim();
      const parsed = parseEveryMinutesFromText(job.scheduleText);
      if (parsed) job.everyMinutes = parsed;
    }
    job.updatedAt = nowIso();
    if (patch.resetNextRunAt) {
      job.nextRunAt = computeNextRunAt(job.everyMinutes);
    }
    save();
    return job;
  }

  function removeJob(idLike) {
    const id = String(idLike || '');
    const job = getJob(id);
    if (!job) return false;
    delete state.jobs[id];
    save();
    emitAudit('scheduler.job.removed', { id });
    return true;
  }

  async function runDueJobs() {
    if (ticking) return;
    ticking = true;
    try {
      const now = Date.now();
      const jobs = listJobs(500).filter((x) => x.enabled !== false);
      for (const job of jobs) {
        const dueAt = new Date(String(job.nextRunAt || 0)).getTime();
        if (!Number.isFinite(dueAt) || dueAt > now) continue;
        if (!taskEngine || !job.tool) {
          job.lastStatus = 'failed';
          job.lastError = 'task_engine_or_tool_missing';
          job.lastRunAt = nowIso();
          job.nextRunAt = computeNextRunAt(job.everyMinutes);
          continue;
        }
        const task = taskEngine.createTask({
          title: `scheduled:${job.title}`,
          type: 'scheduled-tool',
          tool: job.tool,
          args: job.args,
          sessionKey: job.sessionKey,
        });
        job.lastTaskId = task.id;
        const out = await taskEngine.runTask(task.id);
        job.lastStatus = out?.ok ? 'success' : 'failed';
        job.lastError = out?.ok ? null : String(out?.error || 'scheduled_task_failed');
        job.lastRunAt = nowIso();
        job.nextRunAt = computeNextRunAt(job.everyMinutes);
        job.updatedAt = nowIso();
        emitAudit('scheduler.job.executed', {
          id: job.id,
          taskId: task.id,
          status: job.lastStatus,
          error: job.lastError,
        });
      }
      save();
    } finally {
      ticking = false;
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => {
      void runDueJobs();
    }, tickMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  load();

  return {
    storePath,
    listJobs,
    createJob,
    patchJob,
    getJob,
    removeJob,
    runDueJobs,
    start,
    stop,
  };
}
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function nowMs() {
  return Date.now();
}

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

function parseNaturalSchedule(textLike = '') {
  const text = String(textLike || '').trim();
  if (!text) return null;
  const daily = text.match(/每天\s*([01]?\d|2[0-3])[:：]([0-5]\d)/);
  if (daily) {
    return {
      kind: 'daily',
      hour: Number(daily[1]),
      minute: Number(daily[2]),
      expr: `daily ${daily[1]}:${daily[2]}`,
    };
  }
  const everyMin = text.match(/每\s*(\d+)\s*分钟/);
  if (everyMin) {
    return {
      kind: 'interval',
      intervalMs: Math.max(60_000, Number(everyMin[1]) * 60_000),
      expr: `every ${everyMin[1]}m`,
    };
  }
  return null;
}

function computeNextRunMs(schedule, baseMs = nowMs()) {
  if (!schedule || typeof schedule !== 'object') return baseMs + 60_000;
  if (schedule.kind === 'interval') {
    return baseMs + Math.max(60_000, Number(schedule.intervalMs || 300_000));
  }
  if (schedule.kind === 'daily') {
    const d = new Date(baseMs);
    d.setSeconds(0, 0);
    d.setHours(Number(schedule.hour || 0), Number(schedule.minute || 0), 0, 0);
    if (d.getTime() <= baseMs) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  return baseMs + 300_000;
}

export function createSchedulerRuntime(options = {}) {
  const storePath = path.resolve(String(options.storePath || 'memory/runtime-schedules.json'));
  const taskEngine = options.taskEngine;
  const auditLog = options.auditLog || null;
  let timer = null;

  let state = {
    updatedAt: nowIso(),
    jobs: [],
  };

  function load() {
    try {
      if (!fs.existsSync(storePath)) return;
      const raw = fs.readFileSync(storePath, 'utf8');
      const parsed = parseJson(raw, null);
      if (parsed && Array.isArray(parsed.jobs)) {
        state = {
          updatedAt: String(parsed.updatedAt || nowIso()),
          jobs: parsed.jobs,
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

  function list(limitLike = 120) {
    const limit = Math.max(1, Math.min(500, Number(limitLike || 120) || 120));
    return state.jobs
      .slice()
      .sort((a, b) => Number(a?.nextRunAtMs || 0) - Number(b?.nextRunAtMs || 0))
      .slice(0, limit);
  }

  function get(jobIdLike) {
    const jobId = String(jobIdLike || '').trim();
    if (!jobId) return null;
    return state.jobs.find((x) => String(x?.jobId || '') === jobId) || null;
  }

  function createJob(paramsLike = {}) {
    const params = paramsLike && typeof paramsLike === 'object' ? paramsLike : {};
    const parsedSchedule =
      params.schedule && typeof params.schedule === 'object'
        ? params.schedule
        : parseNaturalSchedule(String(params.nl || '').trim());
    if (!parsedSchedule) {
      throw new Error('schedule_invalid');
    }
    const job = {
      jobId: crypto.randomUUID(),
      title: String(params.title || 'untitled_job'),
      enabled: params.enabled !== false,
      sessionKey: String(params.sessionKey || 'dashboard:main'),
      schedule: parsedSchedule,
      taskTemplate:
        params.taskTemplate && typeof params.taskTemplate === 'object'
          ? params.taskTemplate
          : { type: 'tool_call', payload: {} },
      createdAt: nowIso(),
      updatedAt: nowIso(),
      nextRunAtMs: computeNextRunMs(parsedSchedule),
      lastRunAtMs: null,
      lastStatus: null,
    };
    state.jobs.push(job);
    save();
    auditLog?.append?.('schedule_created', { jobId: job.jobId, expr: parsedSchedule.expr || parsedSchedule.kind });
    return job;
  }

  function updateJob(jobIdLike, patchLike = {}) {
    const jobId = String(jobIdLike || '').trim();
    const idx = state.jobs.findIndex((x) => x.jobId === jobId);
    if (idx < 0) throw new Error('schedule_not_found');
    const patch = patchLike && typeof patchLike === 'object' ? patchLike : {};
    const cur = state.jobs[idx];
    const nextSchedule =
      patch.schedule && typeof patch.schedule === 'object'
        ? patch.schedule
        : patch.nl
          ? parseNaturalSchedule(String(patch.nl))
          : cur.schedule;
    state.jobs[idx] = {
      ...cur,
      ...patch,
      schedule: nextSchedule || cur.schedule,
      updatedAt: nowIso(),
      nextRunAtMs: computeNextRunMs(nextSchedule || cur.schedule),
    };
    save();
    auditLog?.append?.('schedule_updated', { jobId });
    return state.jobs[idx];
  }

  function deleteJob(jobIdLike) {
    const jobId = String(jobIdLike || '').trim();
    const before = state.jobs.length;
    state.jobs = state.jobs.filter((x) => x.jobId !== jobId);
    if (state.jobs.length !== before) {
      save();
      auditLog?.append?.('schedule_deleted', { jobId });
      return true;
    }
    return false;
  }

  async function runDueJobs() {
    const now = nowMs();
    const due = state.jobs.filter((x) => x.enabled !== false && Number(x.nextRunAtMs || 0) <= now);
    for (const job of due) {
      try {
        if (taskEngine?.enqueue) {
          await taskEngine.enqueue({
            type: String(job?.taskTemplate?.type || 'tool_call'),
            payload: job?.taskTemplate?.payload || {},
            sessionKey: String(job.sessionKey || 'dashboard:main'),
            execution: 'async',
          });
        }
        job.lastStatus = 'success';
      } catch (err) {
        job.lastStatus = String(err?.message || err || 'failed');
      }
      job.lastRunAtMs = nowMs();
      job.nextRunAtMs = computeNextRunMs(job.schedule, nowMs());
      job.updatedAt = nowIso();
      auditLog?.append?.('schedule_triggered', { jobId: job.jobId, status: job.lastStatus });
    }
    if (due.length) save();
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => {
      void runDueJobs();
    }, Math.max(1500, Number(options.tickMs || 2500)));
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  load();

  return {
    storePath,
    list,
    get,
    createJob,
    updateJob,
    deleteJob,
    runDueJobs,
    start,
    stop,
    parseNaturalSchedule,
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

function parseIntervalMs(exprLike) {
  const expr = String(exprLike || '').trim().toLowerCase();
  if (!expr) return null;
  const m = expr.match(/^every\s+(\d+)\s*(s|sec|secs|second|seconds|m|min|minute|minutes|h|hour|hours)$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2];
  if (!Number.isFinite(n) || n <= 0) return null;
  if (/^s/.test(unit)) return n * 1000;
  if (/^(m|min|minute)/.test(unit)) return n * 60 * 1000;
  return n * 3600 * 1000;
}

export function createSchedulerRuntime(options = {}) {
  const filePath = path.resolve(String(options.filePath || 'memory/runtime-scheduler.json'));
  const taskEngine = options.taskEngine;
  const auditLog = options.auditLog;
  const sessionManager = options.sessionManager;
  const minIntervalMs = Math.max(5000, Number(options.minIntervalMs || 15000));

  function loadState() {
    return readJsonSafe(filePath, { version: 1, jobs: [], updatedAt: nowIso() });
  }

  function saveState(state) {
    const next = state && typeof state === 'object' ? state : { version: 1, jobs: [] };
    next.updatedAt = nowIso();
    writeJsonSafe(filePath, next);
    return next;
  }

  function createJob(input = {}) {
    const every = parseIntervalMs(input.schedule);
    if (!every) {
      return { ok: false, error: 'invalid_schedule', expected: 'every 10 minutes' };
    }
    const intervalMs = Math.max(minIntervalMs, every);
    const job = {
      id: crypto.randomUUID(),
      createdAt: nowIso(),
      updatedAt: nowIso(),
      status: 'active',
      sessionKey: String(input.sessionKey || 'dashboard:default'),
      title: String(input.title || 'scheduled-task').trim() || 'scheduled-task',
      schedule: String(input.schedule || ''),
      intervalMs,
      nextRunAt: Date.now() + intervalMs,
      task: input.task && typeof input.task === 'object' ? input.task : {},
      lastRunAt: null,
      lastTaskId: null,
      lastError: null,
    };
    const state = loadState();
    state.jobs.push(job);
    saveState(state);
    auditLog?.append('scheduler.job.created', { id: job.id, schedule: job.schedule });
    return { ok: true, job };
  }

  function listJobs() {
    const state = loadState();
    return state.jobs || [];
  }

  function patchJob(jobIdLike, patch = {}) {
    const jobId = String(jobIdLike || '').trim();
    if (!jobId) return null;
    const state = loadState();
    const idx = (state.jobs || []).findIndex((x) => x.id === jobId);
    if (idx < 0) return null;
    const current = state.jobs[idx];
    const next = { ...current };
    if (typeof patch.status === 'string') next.status = patch.status;
    if (typeof patch.title === 'string') next.title = patch.title;
    if (typeof patch.schedule === 'string') {
      const ms = parseIntervalMs(patch.schedule);
      if (ms) {
        next.schedule = patch.schedule;
        next.intervalMs = Math.max(minIntervalMs, ms);
        next.nextRunAt = Date.now() + next.intervalMs;
      }
    }
    next.updatedAt = nowIso();
    state.jobs[idx] = next;
    saveState(state);
    return next;
  }

  function removeJob(jobIdLike) {
    const jobId = String(jobIdLike || '').trim();
    if (!jobId) return false;
    const state = loadState();
    const before = state.jobs.length;
    state.jobs = (state.jobs || []).filter((x) => x.id !== jobId);
    saveState(state);
    return state.jobs.length < before;
  }

  async function tick() {
    const jobs = listJobs();
    const now = Date.now();
    for (const job of jobs) {
      if (job.status !== 'active') continue;
      if (!Number.isFinite(Number(job.nextRunAt)) || Number(job.nextRunAt) > now) continue;
      const task = taskEngine.enqueue({
        type: 'tool_call',
        sessionKey: job.sessionKey,
        payload: {
          tool: String(job.task?.tool || ''),
          arguments: job.task?.arguments && typeof job.task.arguments === 'object' ? job.task.arguments : {},
          source: 'scheduler',
          rawMessage: `scheduled:${job.id}`,
        },
      });
      patchJob(job.id, {});
      const state = loadState();
      const idx = (state.jobs || []).findIndex((x) => x.id === job.id);
      if (idx >= 0) {
        state.jobs[idx].lastRunAt = nowIso();
        state.jobs[idx].lastTaskId = task.id;
        state.jobs[idx].nextRunAt = now + Number(job.intervalMs || minIntervalMs);
        state.jobs[idx].updatedAt = nowIso();
        saveState(state);
      }
      sessionManager?.appendEvent(job.sessionKey, {
        type: 'scheduler',
        stage: 'triggered',
        jobId: job.id,
        detail: `调度触发任务：${job.title}`,
      });
      auditLog?.append('scheduler.job.triggered', { id: job.id, taskId: task.id });
    }
  }

  return {
    createJob,
    listJobs,
    patchJob,
    removeJob,
    tick,
    filePath,
  };
}
