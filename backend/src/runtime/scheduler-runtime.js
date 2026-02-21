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

function parseEveryExpr(textLike) {
  const text = String(textLike || '').trim().toLowerCase();
  const m = text.match(/^every\s+(\d+)\s*(s|sec|secs|second|seconds|m|min|minute|minutes|h|hour|hours)$/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2].toLowerCase();
  if (unit.startsWith('s')) return { kind: 'interval', intervalMs: n * 1000, expr: `every ${n}s` };
  if (unit.startsWith('m')) return { kind: 'interval', intervalMs: n * 60 * 1000, expr: `every ${n}m` };
  return { kind: 'interval', intervalMs: n * 3600 * 1000, expr: `every ${n}h` };
}

function parseNaturalExpr(textLike) {
  const text = String(textLike || '').trim();
  if (!text) return null;

  const zhMin = text.match(/每\s*(\d+)\s*分钟/);
  if (zhMin) {
    const n = Math.max(1, Number(zhMin[1]) || 1);
    return { kind: 'interval', intervalMs: n * 60 * 1000, expr: `every ${n}m` };
  }

  const daily = text.match(/每天\s*([01]?\d|2[0-3])[:：]([0-5]\d)/);
  if (daily) {
    const hh = Number(daily[1]);
    const mm = Number(daily[2]);
    return { kind: 'daily', hour: hh, minute: mm, expr: `daily ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}` };
  }

  return parseEveryExpr(text);
}

function parseCronExpr(textLike) {
  const text = String(textLike || '').trim();
  if (!text) return null;
  const parts = text.split(/\s+/);
  if (parts.length !== 5) return null;
  if (parts.some((x) => !/^(\*|\d+|\/|,|-)+$/.test(x))) return null;
  return {
    kind: 'cron',
    expr: text,
    parts,
  };
}

function computeNextRunMs(spec, baseMs = Date.now()) {
  if (!spec || typeof spec !== 'object') return baseMs + 30_000;

  if (spec.kind === 'interval') {
    const intervalMs = Math.max(5_000, Number(spec.intervalMs || 60_000) || 60_000);
    return baseMs + intervalMs;
  }

  if (spec.kind === 'daily') {
    const d = new Date(baseMs);
    d.setSeconds(0, 0);
    d.setHours(Number(spec.hour || 0), Number(spec.minute || 0), 0, 0);
    if (d.getTime() <= baseMs) d.setDate(d.getDate() + 1);
    return d.getTime();
  }

  if (spec.kind === 'cron') {
    // Minimal cron support: m h * * *
    const [m, h] = spec.parts;
    const now = new Date(baseMs + 1000);
    const minute = m === '*' ? now.getMinutes() : Number(m);
    const hour = h === '*' ? now.getHours() : Number(h);
    const next = new Date(now);
    next.setSeconds(0, 0);
    next.setMinutes(Number.isFinite(minute) ? minute : 0);
    next.setHours(Number.isFinite(hour) ? hour : 0);
    if (next.getTime() <= baseMs) {
      if (h === '*') next.setHours(next.getHours() + 1);
      else next.setDate(next.getDate() + 1);
    }
    return next.getTime();
  }

  return baseMs + 60_000;
}

function resolveScheduleSpec(input = {}) {
  if (input.scheduleSpec && typeof input.scheduleSpec === 'object') return input.scheduleSpec;
  if (typeof input.everySeconds === 'number' && Number.isFinite(input.everySeconds) && input.everySeconds > 0) {
    return { kind: 'interval', intervalMs: Number(input.everySeconds) * 1000, expr: `every ${Number(input.everySeconds)}s` };
  }
  if (typeof input.everyMinutes === 'number' && Number.isFinite(input.everyMinutes) && input.everyMinutes > 0) {
    return { kind: 'interval', intervalMs: Number(input.everyMinutes) * 60 * 1000, expr: `every ${Number(input.everyMinutes)}m` };
  }
  const cron = parseCronExpr(input.cron || input.schedule);
  if (cron) return cron;
  return parseNaturalExpr(input.scheduleText || input.schedule || '');
}

export function createSchedulerRuntime(options = {}) {
  const storePath = path.resolve(String(options.storePath || options.filePath || 'memory/runtime-schedules.json'));
  const taskEngine = options.taskEngine;
  const emitAudit = typeof options.emitAudit === 'function' ? options.emitAudit : () => {};
  const tickMs = Math.max(800, Number(options.tickMs || 1000) || 1000);

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

  function getJob(idLike) {
    return state.jobs[String(idLike || '')] || null;
  }

  function listJobs(limitLike = 120, filterLike = {}) {
    const limit = Math.max(1, Math.min(1000, Number(limitLike || 120) || 120));
    const filter = filterLike && typeof filterLike === 'object' ? filterLike : {};
    let rows = Object.values(state.jobs);
    if (filter.sessionKey) rows = rows.filter((x) => x.sessionKey === String(filter.sessionKey));
    if (filter.enabled !== undefined) rows = rows.filter((x) => Boolean(x.enabled) === Boolean(filter.enabled));
    return rows
      .sort((a, b) => new Date(String(b?.createdAt || 0)).getTime() - new Date(String(a?.createdAt || 0)).getTime())
      .slice(0, limit);
  }

  function createJob(inputLike = {}) {
    const input = inputLike && typeof inputLike === 'object' ? inputLike : {};
    const spec = resolveScheduleSpec(input);
    if (!spec) {
      return {
        ok: false,
        error: 'schedule_invalid',
        expected: 'every 10 minutes | 每10分钟 | 每天 09:30 | */5 * * * *',
      };
    }
    const id = String(input.id || createId('job'));
    const nextRunMs = computeNextRunMs(spec, Date.now());
    const job = {
      id,
      title: String(input.title || input.tool || 'runtime-job'),
      sessionKey: String(input.sessionKey || 'dashboard:main'),
      enabled: input.enabled !== false,
      tool: String(input.tool || ''),
      args: input.args && typeof input.args === 'object' ? input.args : {},
      scheduleText: String(input.scheduleText || input.schedule || spec.expr || ''),
      scheduleSpec: spec,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      lastRunAt: null,
      nextRunAt: new Date(nextRunMs).toISOString(),
      lastTaskId: null,
      lastStatus: null,
      lastError: null,
    };
    state.jobs[id] = job;
    save();
    emitAudit('scheduler.job.created', { id: job.id, sessionKey: job.sessionKey, tool: job.tool, schedule: spec.expr || spec.kind });
    return job;
  }

  function patchJob(idLike, patchLike = {}) {
    const job = getJob(idLike);
    if (!job) return null;
    const patch = patchLike && typeof patchLike === 'object' ? patchLike : {};
    if (typeof patch.enabled === 'boolean') job.enabled = patch.enabled;
    if (patch.args && typeof patch.args === 'object') job.args = patch.args;
    if (typeof patch.title === 'string' && patch.title.trim()) job.title = patch.title.trim();
    if (typeof patch.tool === 'string' && patch.tool.trim()) job.tool = patch.tool.trim();

    const maybeSpec = resolveScheduleSpec({
      scheduleSpec: patch.scheduleSpec,
      scheduleText: patch.scheduleText,
      schedule: patch.schedule,
      cron: patch.cron,
      everyMinutes: patch.everyMinutes,
      everySeconds: patch.everySeconds,
    });
    if (maybeSpec) {
      job.scheduleSpec = maybeSpec;
      job.scheduleText = String(patch.scheduleText || patch.schedule || maybeSpec.expr || job.scheduleText || '');
      job.nextRunAt = new Date(computeNextRunMs(maybeSpec)).toISOString();
    } else if (patch.resetNextRunAt) {
      job.nextRunAt = new Date(computeNextRunMs(job.scheduleSpec)).toISOString();
    }

    job.updatedAt = nowIso();
    save();
    emitAudit('scheduler.job.patched', { id: job.id });
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
      const jobs = listJobs(500, { enabled: true });
      for (const job of jobs) {
        const dueAt = new Date(String(job.nextRunAt || 0)).getTime();
        if (!Number.isFinite(dueAt) || dueAt > now) continue;

        if (!taskEngine || !job.tool) {
          job.lastStatus = 'failed';
          job.lastError = 'task_engine_or_tool_missing';
          job.lastRunAt = nowIso();
          job.nextRunAt = new Date(computeNextRunMs(job.scheduleSpec)).toISOString();
          job.updatedAt = nowIso();
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
        job.nextRunAt = new Date(computeNextRunMs(job.scheduleSpec)).toISOString();
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
