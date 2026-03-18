function toText(valueLike, fallback = "") {
  const s = String(valueLike ?? "").trim();
  return s || fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function cloneStructured(valueLike) {
  if (valueLike == null) return null;
  try {
    return JSON.parse(JSON.stringify(valueLike));
  } catch {
    return null;
  }
}

export function createTaskRuntime() {
  function createTask(params = {}) {
    const taskType = toText(params.taskType, "task");
    return {
      taskId: toText(params.taskId, `${taskType}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
      sessionId: toText(params.sessionId, ""),
      taskType,
      plan: toText(params.plan, ""),
      currentStage: toText(params.currentStage, "created"),
      attempts: Math.max(0, Number(params.attempts || 0) || 0),
      finalStatus: toText(params.finalStatus, "running"),
      resultRef: params.resultRef && typeof params.resultRef === "object" ? { ...params.resultRef } : null,
      planArtifact: cloneStructured(params.planArtifact),
      specArtifact: cloneStructured(params.specArtifact),
      failureType: toText(params.failureType, ""),
      repairSummary: cloneStructured(params.repairSummary),
      codeDiff: cloneStructured(params.codeDiff),
      runArtifacts: cloneStructured(params.runArtifacts),
      traces: [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
  }

  function addTrace(taskLike, params = {}) {
    const task = taskLike && typeof taskLike === "object" ? taskLike : null;
    if (!task) return null;
    const trace = {
      taskId: toText(task.taskId, ""),
      taskType: toText(task.taskType, "task"),
      phase: toText(params.phase || params.step, "step"),
      status: toText(params.status, "running").toLowerCase(),
      message: toText(params.message || params.summary, ""),
      ts: nowIso(),
    };
    const attempt = Number(params.attempt);
    if (Number.isFinite(attempt) && attempt > 0) trace.attempt = attempt;
    const kind = toText(params.kind, "");
    if (kind) trace.kind = kind;
    const moduleId = toText(params.moduleId, "");
    if (moduleId) trace.moduleId = moduleId;
    const seq = Number(params.seq);
    if (Number.isFinite(seq) && seq > 0) trace.seq = Math.floor(seq);
    const title = toText(params.title, "");
    if (title) trace.title = title;
    const details = cloneStructured(params.details);
    if (details && typeof details === "object" && Object.keys(details).length) {
      trace.details = details;
    }
    if (params.specArtifact !== undefined) task.specArtifact = cloneStructured(params.specArtifact);
    if (params.failureType != null) task.failureType = toText(params.failureType, task.failureType || "");
    if (params.repairSummary !== undefined) task.repairSummary = cloneStructured(params.repairSummary);
    if (params.codeDiff !== undefined) task.codeDiff = cloneStructured(params.codeDiff);
    if (params.runArtifacts !== undefined) task.runArtifacts = cloneStructured(params.runArtifacts);
    task.currentStage = trace.phase;
    task.updatedAt = trace.ts;
    if (!Array.isArray(task.traces)) task.traces = [];
    task.traces.push(trace);
    if (task.traces.length > 80) {
      task.traces = task.traces.slice(-80);
    }
    return trace;
  }

  function updateTask(taskLike, params = {}) {
    const task = taskLike && typeof taskLike === "object" ? taskLike : null;
    if (!task) return task;
    if (params.plan != null) task.plan = toText(params.plan, task.plan || "");
    if (params.currentStage != null) task.currentStage = toText(params.currentStage, task.currentStage || "");
    if (params.finalStatus != null) task.finalStatus = toText(params.finalStatus, task.finalStatus || "");
    if (params.resultRef && typeof params.resultRef === "object") task.resultRef = { ...params.resultRef };
    if (params.planArtifact !== undefined) task.planArtifact = cloneStructured(params.planArtifact);
    if (params.specArtifact !== undefined) task.specArtifact = cloneStructured(params.specArtifact);
    if (params.failureType !== undefined) task.failureType = toText(params.failureType, "");
    if (params.repairSummary !== undefined) task.repairSummary = cloneStructured(params.repairSummary);
    if (params.codeDiff !== undefined) task.codeDiff = cloneStructured(params.codeDiff);
    if (params.runArtifacts !== undefined) task.runArtifacts = cloneStructured(params.runArtifacts);
    if (params.attempts != null && Number.isFinite(Number(params.attempts))) {
      task.attempts = Math.max(0, Number(params.attempts) || 0);
    }
    task.updatedAt = nowIso();
    return task;
  }

  function snapshotTask(taskLike) {
    const task = taskLike && typeof taskLike === "object" ? taskLike : null;
    if (!task) return null;
    return {
      taskId: toText(task.taskId, ""),
      sessionId: toText(task.sessionId, ""),
      taskType: toText(task.taskType, "task"),
      plan: toText(task.plan, ""),
      currentStage: toText(task.currentStage, ""),
      attempts: Math.max(0, Number(task.attempts || 0) || 0),
      finalStatus: toText(task.finalStatus, ""),
      resultRef: task.resultRef && typeof task.resultRef === "object" ? { ...task.resultRef } : null,
      planArtifact: cloneStructured(task.planArtifact),
      specArtifact: cloneStructured(task.specArtifact),
      failureType: toText(task.failureType, ""),
      repairSummary: cloneStructured(task.repairSummary),
      codeDiff: cloneStructured(task.codeDiff),
      runArtifacts: cloneStructured(task.runArtifacts),
      createdAt: toText(task.createdAt, nowIso()),
      updatedAt: toText(task.updatedAt, nowIso()),
      traces: Array.isArray(task.traces) ? task.traces.map((item) => cloneStructured(item) || null).filter(Boolean) : [],
    };
  }

  return {
    createTask,
    addTrace,
    updateTask,
    snapshotTask,
  };
}
