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
