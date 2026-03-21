function toText(valueLike, fallback = "") {
  const s = String(valueLike ?? "").trim();
  return s || fallback;
}

function parsePositiveInt(raw, fallback, min, max) {
  const n = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  if (Number.isFinite(min) && n < min) return fallback;
  if (Number.isFinite(max) && n > max) return max;
  return n;
}

export function createStrategyLabHandlers(deps = {}) {
  const readJsonBody = deps.readJsonBody;
  const sendJson = deps.sendJson;
  const strategyLabStore = deps.strategyLabStore;
  const extractTradingIntentCandidates = deps.extractTradingIntentCandidates;
  const generateFeatureCodeForCandidate = deps.generateFeatureCodeForCandidate;
  const detectAndClarify = typeof deps.detectAndClarify === "function" ? deps.detectAndClarify : null;
  const reasonFromClarification = typeof deps.reasonFromClarification === "function" ? deps.reasonFromClarification : null;
  const planFromReasoning = typeof deps.planFromReasoning === "function" ? deps.planFromReasoning : null;
  const generateFromClarification = typeof deps.generateFromClarification === "function" ? deps.generateFromClarification : null;
  const generateWithAgentLoop = typeof deps.generateWithAgentLoop === "function" ? deps.generateWithAgentLoop : null;
  const getCurrentRuntimeModelRefFromStore = deps.getCurrentRuntimeModelRefFromStore;
  const updateChatCardStatus = typeof deps.updateChatCardStatus === "function" ? deps.updateChatCardStatus : null;
  const updateChatEvent = typeof deps.updateChatEvent === "function" ? deps.updateChatEvent : null;
  const backtestEngine = deps.backtestEngine || null;
  const conversationContext = deps.conversationContext || null;
  const taskRuntime = deps.taskRuntime || null;

  if (typeof readJsonBody !== "function") throw new Error("readJsonBody is required");
  if (typeof sendJson !== "function") throw new Error("sendJson is required");
  if (!strategyLabStore || typeof strategyLabStore !== "object") throw new Error("strategyLabStore is required");
  if (typeof extractTradingIntentCandidates !== "function") throw new Error("extractTradingIntentCandidates is required");
  if (typeof generateFeatureCodeForCandidate !== "function") throw new Error("generateFeatureCodeForCandidate is required");
  if (typeof getCurrentRuntimeModelRefFromStore !== "function") throw new Error("getCurrentRuntimeModelRefFromStore is required");

  const activeTaskGates = new Map();

  function createAckGate(taskIdLike) {
    const taskId = toText(taskIdLike, "");
    if (!taskId) return null;
    const gate = {
      taskId,
      ackedSeqs: new Set(),
      waiters: new Map(),
      lastAckSeq: 0,
    };
    activeTaskGates.set(taskId, gate);
    return gate;
  }

  function resolveAckWaiter(taskIdLike, seqLike, metaLike = {}) {
    const taskId = toText(taskIdLike, "");
    const seq = Math.max(0, Math.floor(Number(seqLike) || 0));
    const meta = metaLike && typeof metaLike === "object" ? metaLike : {};
    if (!taskId || seq <= 0) return false;
    const gate = activeTaskGates.get(taskId);
    if (!gate) return false;
    gate.ackedSeqs.add(seq);
    if (seq > gate.lastAckSeq) gate.lastAckSeq = seq;
    const waiter = gate.waiters.get(seq);
    if (!waiter) return true;
    gate.waiters.delete(seq);
    if (waiter.timer) clearTimeout(waiter.timer);
    waiter.resolve({
      ok: true,
      taskId,
      seq,
      moduleId: toText(meta.moduleId, ""),
      ackTs: new Date().toISOString(),
    });
    return true;
  }

  function waitForAck(taskIdLike, seqLike, options = {}) {
    const taskId = toText(taskIdLike, "");
    const seq = Math.max(0, Math.floor(Number(seqLike) || 0));
    const timeoutMs = Math.max(200, Math.min(3000, Number(options.timeoutMs || 1800) || 1800));
    if (!taskId || seq <= 0) return Promise.resolve({ ok: false, reason: "invalid_ack_target" });
    const gate = activeTaskGates.get(taskId);
    if (!gate) return Promise.resolve({ ok: false, reason: "missing_gate" });
    if (gate.ackedSeqs.has(seq)) {
      return Promise.resolve({ ok: true, taskId, seq, reason: "already_acked" });
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        gate.waiters.delete(seq);
        resolve({ ok: false, taskId, seq, reason: "ack_timeout" });
      }, timeoutMs);
      gate.waiters.set(seq, { resolve, timer });
    });
  }

  function destroyAckGate(taskIdLike) {
    const taskId = toText(taskIdLike, "");
    if (!taskId) return;
    const gate = activeTaskGates.get(taskId);
    if (!gate) return;
    gate.waiters.forEach((waiter) => {
      if (waiter && waiter.timer) clearTimeout(waiter.timer);
      if (waiter && typeof waiter.resolve === "function") {
        waiter.resolve({ ok: false, taskId, reason: "gate_destroyed" });
      }
    });
    activeTaskGates.delete(taskId);
  }

  function syncStrategyCardStatus(strategyLike, statusLike, reasonLike) {
    if (!updateChatCardStatus) return;
    const strategy = strategyLike && typeof strategyLike === "object" ? strategyLike : {};
    const cardBinding = strategy.cardBinding && typeof strategy.cardBinding === "object" ? strategy.cardBinding : null;
    if (!cardBinding) return;
    const eventId = Number(cardBinding.eventId);
    const cardId = toText(cardBinding.cardId || "");
    if (!Number.isFinite(eventId) || eventId <= 0 || !cardId) return;
    const status = toText(statusLike || strategy.status || "draft", "draft");
    updateChatCardStatus({
      eventId,
      cardId,
      status: "registered",
      message: "策略状态：" + status,
      extra: {
        strategyId: toText(strategy.strategyId || ""),
        strategyStatus: status,
        strategyStatusReason: toText(reasonLike || ""),
        strategyUpdatedAt: toText(strategy.updatedAt || ""),
      },
      strategy: {
        strategyId: toText(strategy.strategyId || ""),
        name: toText(strategy.name || ""),
        status,
      },
    });
  }

  function createTaskTracker(params = {}) {
    const runtime = taskRuntime && typeof taskRuntime.createTask === "function" ? taskRuntime : null;
    const task = runtime
      ? runtime.createTask(params)
      : {
          taskId: `${String(params.taskType || "task")}-${Date.now()}`,
          taskType: String(params.taskType || "task"),
          sessionId: String(params.sessionId || ""),
          plan: String(params.plan || ""),
          currentStage: "created",
          attempts: 0,
          finalStatus: "running",
          resultRef: null,
          planArtifact: null,
          specArtifact: null,
          failureType: "",
          repairSummary: null,
          codeDiff: null,
          runArtifacts: null,
          traces: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
    const traces = [];
    return {
      emit(sendLike, phase, message, status = "running", extra = {}) {
        const trace = runtime
          ? runtime.addTrace(task, { phase, message, status, ...extra })
          : {
              taskId: task.taskId,
              taskType: task.taskType,
              phase,
              status,
              message,
              ts: new Date().toISOString(),
            };
        if (trace && extra.moduleId) trace.moduleId = toText(extra.moduleId, "");
        if (trace && Number.isFinite(Number(extra.seq)) && Number(extra.seq) > 0) trace.seq = Math.floor(Number(extra.seq));
        if (trace) traces.push({ ...trace });
        if (typeof sendLike === "function") {
          sendLike("thinking", {
            ...trace,
            step: trace?.phase || phase,
            task: runtime ? runtime.snapshotTask(task) : { ...task, traces: traces.slice() },
          });
        }
        return trace;
      },
      finalize(status, resultRef) {
        if (runtime) runtime.updateTask(task, { finalStatus: status, resultRef, currentStage: status });
        else {
          task.finalStatus = status;
          task.resultRef = resultRef || null;
          task.currentStage = status;
        }
      },
      update(fields = {}) {
        if (runtime) runtime.updateTask(task, fields);
        else {
          if (fields.plan != null) task.plan = String(fields.plan || "");
          if (fields.currentStage != null) task.currentStage = String(fields.currentStage || "");
          if (fields.finalStatus != null) task.finalStatus = String(fields.finalStatus || "");
          if (fields.planArtifact !== undefined) task.planArtifact = fields.planArtifact || null;
          if (fields.specArtifact !== undefined) task.specArtifact = fields.specArtifact || null;
          if (fields.failureType !== undefined) task.failureType = String(fields.failureType || "");
          if (fields.repairSummary !== undefined) task.repairSummary = fields.repairSummary || null;
          if (fields.codeDiff !== undefined) task.codeDiff = fields.codeDiff || null;
          if (fields.runArtifacts !== undefined) task.runArtifacts = fields.runArtifacts || null;
          if (fields.resultRef && typeof fields.resultRef === "object") task.resultRef = { ...fields.resultRef };
        }
      },
      snapshot() {
        return runtime ? runtime.snapshotTask(task) : { ...task, traces: traces.slice() };
      },
      getTraces() {
        return traces.slice();
      },
    };
  }

  function persistClarificationTaskResult(cardEventIdLike, payloadLike) {
    const cardEventId = Number(cardEventIdLike);
    const payload = payloadLike && typeof payloadLike === "object" ? payloadLike : {};
    if (Number.isFinite(cardEventId) && cardEventId > 0 && updateChatEvent) {
      updateChatEvent(cardEventId, (event) => {
        const currentMeta = event?.meta && typeof event.meta === "object" ? event.meta : {};
        const currentCardData = currentMeta.cardData && typeof currentMeta.cardData === "object" ? currentMeta.cardData : {};
        return {
          meta: {
            ...currentMeta,
            type: "clarification_card",
            cardData: {
              ...currentCardData,
              ...payload,
            },
          },
          traces: Array.isArray(payload.traces) ? payload.traces : (Array.isArray(event?.traces) ? event.traces : []),
        };
      });
    }
    if (conversationContext && typeof conversationContext.updateLatestClarificationCard === "function") {
      conversationContext.updateLatestClarificationCard(payload);
    }
  }

  function summarizePlanArtifact(planLike) {
    const plan = planLike && typeof planLike === "object" ? planLike : null;
    if (!plan) return "";
    const approach = Array.isArray(plan.approach) ? plan.approach.filter(Boolean) : [];
    const validation = Array.isArray(plan.validation) ? plan.validation.filter(Boolean) : [];
    return [
      toText(plan.goal || "", ""),
      approach[0] ? `技术路线：${approach[0]}` : "",
      validation[0] ? `验证方式：${validation[0]}` : "",
    ].filter(Boolean).join("；");
  }

  function normalizePlanList(planLike, keyLike) {
    const plan = planLike && typeof planLike === "object" ? planLike : null;
    const key = toText(keyLike, "");
    if (!plan || !key || !Array.isArray(plan[key])) return [];
    return plan[key].map((item) => toText(item, "")).filter(Boolean);
  }

  function buildPlanBuildSequence(planLike) {
    const plan = planLike && typeof planLike === "object" ? planLike : null;
    if (!plan) return [];
    const approach = normalizePlanList(plan, "approach");
    const validation = normalizePlanList(plan, "validation");
    const repairStrategy = normalizePlanList(plan, "repairStrategy");
    const inputs = normalizePlanList(plan, "inputs");
    const outputs = normalizePlanList(plan, "outputs");
    return [
      {
        stage: "refining",
        key: "goal",
        status: "refining",
        message: "开始回填计划目标...",
        text: toText(plan.goal || plan.summary, "正在明确本轮计划目标。"),
      },
      {
        stage: "refining",
        key: "approach",
        status: "refining",
        message: "计划细化中...",
        text: [
          approach[0] || "",
          inputs[0] ? `输入：${inputs[0]}` : "",
          outputs[0] ? `输出：${outputs[0]}` : "",
        ].filter(Boolean).join("；"),
      },
      {
        stage: "refining",
        key: "validation",
        status: "refining",
        message: "补充验证方式...",
        text: validation.join("；") || "检查长度、空值、方差以及目标区间的区分效果。",
      },
      {
        stage: "refining",
        key: "repair",
        status: "refining",
        message: "补充修复策略...",
        text: repairStrategy.join("；") || "如运行失败或结果异常，则回调参数和归一化方式后重跑。",
      },
    ].filter((item) => toText(item.text, ""));
  }

  function normalizeChoiceValues(choiceLike) {
    if (Array.isArray(choiceLike)) {
      return choiceLike.map((item) => toText(
        item && typeof item === "object"
          ? (item.value || item.id || item.label || item.title || item.text || "")
          : item,
        "",
      )).filter(Boolean);
    }
    const one = toText(
      choiceLike && typeof choiceLike === "object"
        ? (choiceLike.value || choiceLike.id || choiceLike.label || choiceLike.title || choiceLike.text || "")
        : choiceLike,
      "",
    );
    return one ? [one] : [];
  }

  function buildUnderstandOptionTokens(userChoicesLike, clarifyingQuestionsLike) {
    const userChoices = userChoicesLike && typeof userChoicesLike === "object" ? userChoicesLike : {};
    const questions = Array.isArray(clarifyingQuestionsLike) ? clarifyingQuestionsLike : [];
    const tokens = [];
    Object.keys(userChoices).forEach((choiceKey) => {
      const question = questions.find((itemLike) => toText(itemLike && itemLike.id, "") === choiceKey) || null;
      const label = toText(
        question && (question.label || question.title || question.question || question.headline),
        choiceKey,
      );
      const options = Array.isArray(question && question.options) ? question.options : [];
      normalizeChoiceValues(userChoices[choiceKey]).forEach((valueText) => {
        const selected = options.find((optLike) => {
          const opt = optLike && typeof optLike === "object" ? optLike : {};
          return [opt.value, opt.id, opt.label, opt.title, opt.text]
            .map((item) => toText(item, ""))
            .filter(Boolean)
            .includes(valueText);
        }) || null;
        const selectedLabel = toText(
          selected && (selected.label || selected.title || selected.text || selected.value || selected.id),
          valueText,
        );
        tokens.push("✅ " + label + ": " + selectedLabel);
      });
    });
    if (tokens.length) return tokens;
    return ["✅ 使用默认选项"];
  }

  function buildUnderstandPayloads(params = {}) {
    const payload = {
      schema: "understand_cards_v1",
      taskLabel: "任务分配",
      taskToken: "📝 特征生成任务",
      optionLabel: "选项加载",
      optionTokens: buildUnderstandOptionTokens(params.userChoices, params.clarifyingQuestions),
    };
    return {
      task: {
        ...payload,
        stage: "task",
        optionTokens: [],
      },
      options: {
        ...payload,
        stage: "options",
      },
    };
  }

  function buildFeatureResultSummary(baseSummaryLike, loopResultLike) {
    const baseSummary = toText(baseSummaryLike, "");
    const loopResult = loopResultLike && typeof loopResultLike === "object" ? loopResultLike : {};
    const parts = [baseSummary];
    const rounds = Number(loopResult.rounds || 0);
    if (rounds > 1) {
      parts.push(`经过 ${rounds} 轮编写/运行/检测/修复后通过验证。`);
    }
    if (loopResult.evalResult?.stats) {
      const stats = loopResult.evalResult.stats;
      parts.push(`特征统计：均值=${Number.isFinite(Number(stats.mean)) ? Number(stats.mean).toFixed(4) : "-"}，标准差=${Number.isFinite(Number(stats.std)) ? Number(stats.std).toFixed(4) : "-"}`);
    }
    return parts.filter(Boolean).join("\n");
  }

  async function handleStrategyFeatures(req, res) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const q = toText(url.searchParams.get("q") || "");
    const group = toText(url.searchParams.get("group") || "");
    const kind = toText(url.searchParams.get("kind") || "");
    const mainCategory = toText(url.searchParams.get("mainCategory") || "");
    const tag = toText(url.searchParams.get("tag") || "");
    const source = toText(url.searchParams.get("source") || "");
    const enabled = toText(url.searchParams.get("enabled") || "");
    const sortBy = toText(url.searchParams.get("sortBy") || "updatedAt");
    const sortOrder = toText(url.searchParams.get("sortOrder") || "desc");
    const page = parsePositiveInt(url.searchParams.get("page"), 1, 1, 9999);
    const pageSize = parsePositiveInt(url.searchParams.get("pageSize"), 40, 10, 120);
    const result = strategyLabStore.listFeatures({
      q,
      group,
      kind,
      mainCategory,
      tag,
      source,
      enabled,
      sortBy,
      sortOrder,
      page,
      pageSize,
    });
    const facets = typeof strategyLabStore.getFeatureFacets === "function"
      ? strategyLabStore.getFeatureFacets()
      : {
        groups: [],
        kinds: [],
        mainCategories: [],
        tags: [],
        outputTypes: [],
        sources: [],
        taxonomy: null,
        enabledCount: 0,
        disabledCount: 0,
      };
    sendJson(res, 200, {
      ok: true,
      total: Number(result?.total || 0),
      page: Number(result?.page || page),
      pageSize: Number(result?.pageSize || pageSize),
      totalPages: Number(result?.totalPages || 1),
      sortBy: toText(result?.sortBy || sortBy),
      sortOrder: toText(result?.sortOrder || sortOrder),
      features: Array.isArray(result?.features) ? result.features : [],
      facets,
      stats: strategyLabStore.getStats(),
    });
  }


  async function handleStrategyFeatureDelete(req, res) {
    if (typeof strategyLabStore.deleteFeature !== "function") {
      sendJson(res, 500, { ok: false, error: "feature deletion is not available" });
      return;
    }
    const body = await readJsonBody(req);
    const payload = body && typeof body === "object" ? body : {};
    const featureId = toText(payload.featureId || payload.id || "");
    const featureName = toText(payload.featureName || payload.name || payload.featureRef || "");
    if (!featureId && !featureName) {
      sendJson(res, 400, { ok: false, error: "featureId or featureName is required" });
      return;
    }
    try {
      const result = strategyLabStore.deleteFeature(payload, {
        operator: toText(payload.operator || payload.createdBy || "ThunderClaw"),
        reason: toText(payload.reason || "删除交易特征"),
      });
      sendJson(res, 200, {
        ok: true,
        ...result,
        stats: strategyLabStore.getStats(),
      });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: String(error?.message || error || "feature delete failed") });
    }
  }

  async function handleStrategyEntityDelete(req, res) {
    if (typeof strategyLabStore.deleteStrategy !== "function") {
      sendJson(res, 500, { ok: false, error: "strategy deletion is not available" });
      return;
    }
    const body = await readJsonBody(req);
    const payload = body && typeof body === "object" ? body : {};
    const strategyId = toText(payload.strategyId || payload.id || "");
    if (!strategyId) {
      sendJson(res, 400, { ok: false, error: "strategyId is required" });
      return;
    }
    try {
      const result = strategyLabStore.deleteStrategy(payload, {
        operator: toText(payload.operator || payload.createdBy || "ThunderClaw"),
        reason: toText(payload.reason || "删除策略"),
      });
      sendJson(res, 200, {
        ok: true,
        ...result,
        stats: strategyLabStore.getStats(),
      });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: String(error?.message || error || "strategy delete failed") });
    }
  }

  async function handleStrategyVersions(req, res) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const limit = parsePositiveInt(url.searchParams.get("limit"), 80, 1, 300);
    const result = strategyLabStore.listVersions({ limit });
    sendJson(res, 200, {
      ok: true,
      total: Number(result?.total || 0),
      versions: Array.isArray(result?.versions) ? result.versions : [],
      stats: strategyLabStore.getStats(),
    });
  }

  async function handleStrategyVersionsPropose(req, res) {
    const body = await readJsonBody(req);
    const message = toText(body.message || "");
    const baseVersionId = toText(body.baseVersionId || "");
    if (!message) {
      sendJson(res, 400, { ok: false, error: "message is required" });
      return;
    }
    try {
      const result = strategyLabStore.proposeVersionsFromMessage({ message, baseVersionId });
      sendJson(res, 200, {
        ok: true,
        proposals: Array.isArray(result?.proposals) ? result.proposals : [],
        stats: strategyLabStore.getStats(),
      });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: String(error?.message || error || "propose failed") });
    }
  }

  async function handleStrategyVersionsEvaluate(req, res) {
    const body = await readJsonBody(req);
    const versionId = toText(body.versionId || "");
    const metrics = body.metrics && typeof body.metrics === "object" ? body.metrics : {};
    if (!versionId) {
      sendJson(res, 400, { ok: false, error: "versionId is required" });
      return;
    }
    try {
      const result = strategyLabStore.evaluateVersion({ versionId, metrics });
      sendJson(res, 200, {
        ok: true,
        report: result?.report || null,
        version: result?.version || null,
        stats: strategyLabStore.getStats(),
      });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: String(error?.message || error || "evaluate failed") });
    }
  }

  async function handleStrategyArtifactReport(req, res) {
    const body = await readJsonBody(req);
    try {
      const result = strategyLabStore.reportArtifact(body || {});
      sendJson(res, 200, {
        ok: true,
        artifactId: String(result?.artifactId || ""),
        version: Number(result?.version || 1),
        artifact: result?.artifact || null,
      });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: String(error?.message || error || "artifact report failed") });
    }
  }

  async function handleStrategyIntentCandidates(req, res) {
    const body = await readJsonBody(req);
    const userMessage = toText(body.userMessage || body.message || "");
    const assistantReply = toText(body.assistantReply || body.reply || "");
    const sessionId = toText(body.sessionId || "thunderclaw-main", "thunderclaw-main");
    const runtimeModelRef = toText(body.runtimeModelRef || getCurrentRuntimeModelRefFromStore() || "");
    if (!userMessage && !assistantReply) {
      sendJson(res, 200, {
        ok: true,
        intentDetected: false,
        confidence: 0,
        candidates: [],
      });
      return;
    }
    const result = await extractTradingIntentCandidates({
      userMessage,
      assistantReply,
      sessionId,
      runtimeModelRef,
      clientContext: body.clientContext && typeof body.clientContext === "object" ? body.clientContext : {},
    }).catch((error) => ({
      ok: false,
      intentDetected: false,
      confidence: 0,
      candidates: [],
      reasoning: "",
      error: String(error?.message || error || "intent skill failed"),
    }));

    if (!result.ok) {
      sendJson(res, 200, {
        ok: true,
        intentDetected: false,
        confidence: 0,
        candidates: [],
        error: toText(result.error || "intent skill failed"),
      });
      return;
    }

    sendJson(res, 200, {
      ok: true,
      intentDetected: Boolean(result.intentDetected),
      confidence: Number(result.confidence || 0),
      reasoning: toText(result.reasoning || ""),
      candidates: Array.isArray(result.candidates) ? result.candidates : [],
      modelRef: toText(result.modelRef || runtimeModelRef),
      sessionId: toText(result.sessionId || sessionId),
    });
  }

  async function handleStrategyIntentApply(req, res) {
    const body = await readJsonBody(req);
    const candidate = body.candidate && typeof body.candidate === "object" ? body.candidate : null;
    if (!candidate) {
      sendJson(res, 400, { ok: false, error: "candidate is required" });
      return;
    }
    if (toText(candidate.kind || "").toLowerCase() === "strategy") {
      sendJson(res, 400, {
        ok: false,
        error: "strategy candidate apply is disabled. confirm feature cards first and generate executable feature code.",
      });
      return;
    }
    const meta = {
      source: toText(body.source || "chat_intent"),
      query: toText(body.query || body.userMessage || ""),
      reply: toText(body.reply || body.assistantReply || ""),
      parentVersionId: toText(body.parentVersionId || ""),
      conversationId: toText(body.conversationId || body.sessionId || "thunderclaw-main"),
      eventId: Number(body.eventId),
      cardId: toText(body.cardId || ""),
    };
    try {
      const applied = strategyLabStore.applyIntentCandidate(candidate, meta);
      const kindText = applied?.kind === "feature" ? "交易特征" : "交易策略";
      const nameText = applied?.kind === "feature"
        ? toText(applied?.feature?.name || "")
        : toText(applied?.strategy?.name || applied?.version?.title || "");
      if (applied?.kind === "strategy" && applied?.strategy) {
        syncStrategyCardStatus(applied.strategy, toText(applied.strategy.status || "draft"), "候选策略已写入");
      }
      // Track asset in conversation context for session history
      if (conversationContext && nameText) {
        conversationContext.trackAsset(
          applied?.kind || "feature",
          toText(applied?.feature?.featureId || applied?.strategy?.strategyId || nameText),
          nameText,
        );
        // Track card event for context continuity
        if (typeof conversationContext.addCardEvent === "function") {
          conversationContext.addCardEvent("card_applied", {
            success: true,
            featureName: nameText,
            kind: applied?.kind || "feature",
          });
        }
      }
      // Feature creation tracked in conversation context (above)
      const state = {
        features: strategyLabStore.listFeatures({ limit: 120 }).features,
        versions: strategyLabStore.listVersions({ limit: 120 }).versions,
        strategies: typeof strategyLabStore.listStrategies === "function"
          ? strategyLabStore.listStrategies({ page: 1, pageSize: 120 }).strategies
          : [],
      };
      sendJson(res, 200, {
        ok: true,
        applied,
        reply: `${kindText}已加入虾策：${nameText}${applied?.created ? "" : "（已存在，已更新）"}`,
        stats: strategyLabStore.getStats(),
        state,
      });
    } catch (error) {
      const errorMsg = String(error?.message || error || "apply candidate failed");
      // Track failure in conversation context
      if (conversationContext && typeof conversationContext.addCardEvent === "function") {
        const candName = toText(candidate?.feature?.name || candidate?.title || "");
        conversationContext.addCardEvent("card_applied", {
          success: false,
          featureName: candName,
          kind: toText(candidate?.kind || "feature"),
          error: errorMsg,
        });
      }
      sendJson(res, 400, {
        ok: false,
        error: errorMsg,
      });
    }
  }

  async function handleStrategyIntentGenerateCode(req, res) {
    const body = await readJsonBody(req);
    const candidate = body.candidate && typeof body.candidate === "object" ? body.candidate : null;
    if (!candidate) {
      sendJson(res, 400, { ok: false, error: "candidate is required" });
      return;
    }
    const runtimeModelRef = toText(body.runtimeModelRef || getCurrentRuntimeModelRefFromStore() || "");
    const out = await generateFeatureCodeForCandidate({
      candidate,
      userMessage: toText(body.userMessage || body.query || ""),
      assistantReply: toText(body.assistantReply || body.reply || ""),
      sessionId: toText(body.sessionId || body.conversationId || "thunderclaw-main", "thunderclaw-main"),
      runtimeModelRef,
      refineInstruction: toText(body.refineInstruction || ""),
    }).catch((error) => ({ ok: false, error: String(error?.message || error || "generate feature code failed") }));
    if (!out.ok) {
      sendJson(res, 200, { ok: false, error: toText(out.error || "generate feature code failed") });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      candidate: out.candidate,
      modelRef: toText(out.modelRef || runtimeModelRef),
      sessionId: toText(out.sessionId || body.sessionId || ""),
    });
  }

  async function handleStrategyEntities(req, res) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const q = toText(url.searchParams.get("q") || "");
    const status = toText(url.searchParams.get("status") || "");
    const sortBy = toText(url.searchParams.get("sortBy") || "updatedAt");
    const sortOrder = toText(url.searchParams.get("sortOrder") || "desc");
    const page = parsePositiveInt(url.searchParams.get("page"), 1, 1, 9999);
    const pageSize = parsePositiveInt(url.searchParams.get("pageSize"), 20, 5, 100);
    if (typeof strategyLabStore.listStrategies !== "function") {
      sendJson(res, 500, { ok: false, error: "strategy lifecycle is not available" });
      return;
    }
    const result = strategyLabStore.listStrategies({
      q,
      status,
      sortBy,
      sortOrder,
      page,
      pageSize,
    });
    sendJson(res, 200, {
      ok: true,
      ...result,
      stats: strategyLabStore.getStats(),
    });
  }

  async function handleStrategyEntityDetail(req, res) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const strategyId = toText(url.searchParams.get("strategyId") || "");
    const strategyVersionId = toText(url.searchParams.get("strategyVersionId") || "");
    const rangeDays = parsePositiveInt(url.searchParams.get("rangeDays"), 30, 1, 365);
    const tradeType = toText(url.searchParams.get("tradeType") || "all", "all");
    const tradingMode = toText(url.searchParams.get("tradingMode") || url.searchParams.get("marketMode") || "", "");
    const playbackId = toText(url.searchParams.get("playbackId") || "");
    if (!strategyId) {
      sendJson(res, 200, { ok: false, error: "strategyId is required" });
      return;
    }
    if (typeof strategyLabStore.getStrategyDetail !== "function") {
      sendJson(res, 500, { ok: false, error: "strategy lifecycle is not available" });
      return;
    }
    try {
      const detail = strategyLabStore.getStrategyDetail({
        strategyId,
        strategyVersionId,
        rangeDays,
        tradeType,
        tradingMode,
        playbackId,
      });
      const audits = typeof strategyLabStore.listStrategyAudits === "function"
        ? strategyLabStore.listStrategyAudits({ strategyId, limit: 80 })
        : { total: 0, audits: [] };
      sendJson(res, 200, {
        ok: true,
        ...detail,
        audits: audits.audits,
        auditTotal: audits.total,
      });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: String(error?.message || error || "strategy detail failed") });
    }
  }

  async function handleStrategyEntityDraftSave(req, res) {
    if (typeof strategyLabStore.saveStrategyDraft !== "function") {
      sendJson(res, 500, { ok: false, error: "strategy lifecycle is not available" });
      return;
    }
    const body = await readJsonBody(req);
    const payload = body && typeof body === "object" ? body : {};
    try {
      const result = strategyLabStore.saveStrategyDraft(payload, {
        source: toText(payload.source || "strategy_console"),
        reason: toText(payload.reason || "保存策略草稿"),
        createdBy: toText(payload.operator || payload.createdBy || "ThunderClaw"),
        conversationId: toText(payload.conversationId || ""),
        eventId: Number(payload.eventId),
        cardId: toText(payload.cardId || ""),
      });
      syncStrategyCardStatus(result.strategy, toText(result?.strategy?.status || "draft"), "草稿已保存");
      sendJson(res, 200, {
        ok: true,
        created: Boolean(result?.created),
        strategy: result?.strategy || null,
      });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: String(error?.message || error || "save draft failed") });
    }
  }

  async function handleStrategyEntityPublish(req, res) {
    if (typeof strategyLabStore.publishStrategyVersion !== "function") {
      sendJson(res, 500, { ok: false, error: "strategy lifecycle is not available" });
      return;
    }
    const body = await readJsonBody(req);
    const payload = body && typeof body === "object" ? body : {};
    const strategyId = toText(payload.strategyId || "");
    if (!strategyId) {
      sendJson(res, 200, { ok: false, error: "strategyId is required" });
      return;
    }
    try {
      const result = strategyLabStore.publishStrategyVersion(payload, {
        source: toText(payload.source || "strategy_console"),
        reason: toText(payload.note || payload.reason || "发布新版本"),
        createdBy: toText(payload.operator || payload.createdBy || "ThunderClaw"),
      });
      syncStrategyCardStatus(result.strategy, toText(result?.strategy?.status || ""), "发布新版本");
      sendJson(res, 200, {
        ok: true,
        strategy: result?.strategy || null,
        version: result?.version || null,
      });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: String(error?.message || error || "publish failed") });
    }
  }

  async function handleStrategyEntityStatus(req, res) {
    if (typeof strategyLabStore.updateStrategyStatus !== "function") {
      sendJson(res, 500, { ok: false, error: "strategy lifecycle is not available" });
      return;
    }
    const body = await readJsonBody(req);
    const payload = body && typeof body === "object" ? body : {};
    const strategyId = toText(payload.strategyId || "");
    const targetStatus = toText(payload.targetStatus || payload.status || "");
    if (!strategyId || !targetStatus) {
      sendJson(res, 400, { ok: false, error: "strategyId and targetStatus are required" });
      return;
    }
    try {
      const result = strategyLabStore.updateStrategyStatus(payload, {
        source: toText(payload.source || "strategy_console"),
        reason: toText(payload.reason || ""),
        createdBy: toText(payload.operator || payload.createdBy || "ThunderClaw"),
      });
      syncStrategyCardStatus(result.strategy, toText(result?.strategy?.status || ""), toText(payload.reason || ""));
      sendJson(res, 200, {
        ok: true,
        strategy: result?.strategy || null,
      });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: String(error?.message || error || "status update failed") });
    }
  }

  async function handleStrategyEntityAudits(req, res) {
    if (typeof strategyLabStore.listStrategyAudits !== "function") {
      sendJson(res, 500, { ok: false, error: "strategy lifecycle is not available" });
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const strategyId = toText(url.searchParams.get("strategyId") || "");
    const limit = parsePositiveInt(url.searchParams.get("limit"), 120, 1, 300);
    if (!strategyId) {
      sendJson(res, 200, { ok: false, error: "strategyId is required" });
      return;
    }
    const result = strategyLabStore.listStrategyAudits({ strategyId, limit });
    sendJson(res, 200, {
      ok: true,
      strategyId,
      total: Number(result?.total || 0),
      audits: Array.isArray(result?.audits) ? result.audits : [],
    });
  }

  async function handleStrategyEntityReplay(req, res) {
    if (typeof strategyLabStore.runStrategyReplay !== "function") {
      sendJson(res, 500, { ok: false, error: "strategy replay is not available" });
      return;
    }
    const body = await readJsonBody(req);
    const payload = body && typeof body === "object" ? body : {};
    const strategyId = toText(payload.strategyId || "");
    if (!strategyId) {
      sendJson(res, 200, { ok: false, error: "strategyId is required" });
      return;
    }
    try {
      const result = strategyLabStore.runStrategyReplay(payload, {
        source: toText(payload.source || "strategy_console_replay"),
        label: toText(payload.label || ""),
        query: toText(payload.query || ""),
      });
      sendJson(res, 200, {
        ok: true,
        ...result,
      });
    } catch (error) {
      sendJson(res, 200, { ok: false, error: String(error?.message || error || "strategy replay failed") });
    }
  }

  /**
   * Feature evaluation — compute feature indicator values on OHLCV data.
   * Returns per-bar feature values and statistics (not trades).
   * Used by "查看详情" to display feature output.
   */
  async function handleStrategyFeatureEvaluate(req, res) {
    const body = await readJsonBody(req);
    const payload = body && typeof body === "object" ? body : {};
    // Accept either featureIds (look up from store) or candidates (direct)
    const featureIds = Array.isArray(payload.featureIds) ? payload.featureIds.map(String).filter(Boolean) : [];
    const directCandidates = Array.isArray(payload.candidates) ? payload.candidates : [];
    const rangeDays = parsePositiveInt(payload.rangeDays, 30, 1, 365);
    const pair = toText(payload.pair || "BTC/USDT", "BTC/USDT");
    const timeframe = toText(payload.timeframe || "1h", "1h");
    const bars = Array.isArray(payload.bars) ? payload.bars : [];

    // Collect features with generated code
    let features = [];
    if (directCandidates.length > 0) {
      features = directCandidates.map((c) => {
        const cand = c && typeof c === "object" ? c : {};
        return cand.feature || cand;
      }).filter(Boolean);
    } else if (featureIds.length > 0 && typeof strategyLabStore.listFeatures === "function") {
      const allFeatures = strategyLabStore.listFeatures({ limit: 500 }).features || [];
      // Match by featureId, name, or slugified variants (handle hyphens vs underscores)
      const normalizeForMatch = (s) => toText(s).toLowerCase().replace(/[-_]/g, "");
      const featureIdSet = new Set(featureIds.map(normalizeForMatch));
      features = allFeatures.filter((f) =>
        featureIdSet.has(normalizeForMatch(f.featureId || "")) || featureIdSet.has(normalizeForMatch(f.name || "")),
      );
    }

    features = features.map((f) => {
      const feature = f && typeof f === "object" ? { ...f } : {};
      if (feature.generatedCode && toText(feature.generatedCode.featureCode)) return feature;
      return feature;
    });

    if (!features.length) {
      sendJson(res, 200, { ok: false, error: "No features specified or found" });
      return;
    }

    if (!backtestEngine || typeof backtestEngine.runFeatureEvaluation !== "function") {
      sendJson(res, 200, { ok: false, error: "Feature evaluation not available (backtestEngine not configured)" });
      return;
    }

    try {
      const result = await backtestEngine.runFeatureEvaluation({ features, rangeDays, pair, timeframe, bars });
      if (!result.ok) {
        sendJson(res, 200, { ok: false, error: toText(result.error, "feature evaluation failed") });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        featureTimeSeries: result.featureTimeSeries || [],
        featureStats: result.featureStats || {},
        featureColumns: result.featureColumns || [],
        barCount: result.barCount || 0,
        generatedCode: result.generatedCode || [],
        pair: result.pair || pair,
        timeframe: result.timeframe || timeframe,
        rangeDays: result.rangeDays || rangeDays,
      });
    } catch (error) {
      sendJson(res, 200, { ok: false, error: String(error?.message || error || "feature evaluation failed") });
    }
  }

  /**
   * Intent Clarification — detect one feature concept and return AI-generated questions.
   * Fast: no code generation, just 1 LLM call.
   */
  async function handleStrategyIntentClarify(req, res) {
    if (!detectAndClarify) {
      sendJson(res, 200, { ok: false, error: "Intent clarification not available" });
      return;
    }
    const body = await readJsonBody(req);
    const userMessage = toText(body.userMessage || body.message || "");
    const assistantReply = toText(body.assistantReply || body.reply || "");
    if (!userMessage && !assistantReply) {
      sendJson(res, 200, { ok: true, intentDetected: false, headline: "", featureConcept: null, clarifyingQuestions: [] });
      return;
    }
    try {
      const result = await detectAndClarify({ userMessage, assistantReply });
      sendJson(res, 200, {
        ok: true,
        intentDetected: Boolean(result.intentDetected),
        confidence: Number(result.confidence || 0),
        headline: toText(result.headline, ""),
        featureConcept: result.featureConcept || null,
        clarifyingQuestions: Array.isArray(result.clarifyingQuestions) ? result.clarifyingQuestions : [],
        source: toText(result.source, ""),
      });
    } catch (error) {
      sendJson(res, 200, { ok: false, intentDetected: false, error: String(error?.message || error || "clarification failed") });
    }
  }

  /**
   * Intent Confirm — generate feature from user's clarification choices.
   * Heavy: LLM code generation + validation. Returns result description.
   */
  async function handleStrategyIntentConfirm(req, res) {
    if (!generateFromClarification) {
      sendJson(res, 200, { ok: false, error: "Feature generation from clarification not available" });
      return;
    }
    const body = await readJsonBody(req);
    const featureConcept = body.featureConcept && typeof body.featureConcept === "object" ? body.featureConcept : null;
    const userChoices = body.userChoices && typeof body.userChoices === "object" ? body.userChoices : {};
    const clarifyingQuestions = Array.isArray(body.clarifyingQuestions) ? body.clarifyingQuestions : [];
    if (!featureConcept) {
      sendJson(res, 400, { ok: false, error: "featureConcept is required" });
      return;
    }
    try {
      // Build memory context for code generation
      const ml = deps.memoryLayer || null;
      const memoryContext = ml ? await ml.buildFullMemoryContext(toText(body.userMessage || "")).catch(() => "") : "";
      // Track user choices in conversation context
      if (conversationContext && typeof conversationContext.addCardEvent === "function") {
        conversationContext.addCardEvent("card_choices", { userChoices });
      }
      const result = await generateFromClarification({
        featureConcept,
        userChoices,
        userMessage: toText(body.userMessage || body.originalMessage || ""),
        assistantReply: toText(body.assistantReply || ""),
        memoryContext,
        skipValidation: true,
        conversationHistory: conversationContext ? conversationContext.getRecentHistory(10) : [],
      });

      // If initial generation succeeded AND agent loop is available,
      // run the agent loop to verify code quality with real evaluation
      let finalResult = result;
      if (result.ok && result.generatedCode?.featureCode && generateWithAgentLoop && backtestEngine) {
        try {
          const loopResult = await generateWithAgentLoop({
            feature: {
              ...result.feature,
              generatedCode: result.generatedCode,
            },
            backtestEngine,
            maxRounds: 3,
            userConfig: body.userConfig || {},
            bars: Array.isArray(body.bars) ? body.bars : [],
            pair: toText(body.pair || "BTC/USDT", "BTC/USDT"),
            timeframe: toText(body.timeframe || "1h", "1h"),
            rangeDays: parsePositiveInt(body.rangeDays, 14, 1, 365),
          });
          if (loopResult.ok) {
            // Agent loop produced a verified version
            finalResult = {
              ...result,
              feature: {
                ...(result.feature || {}),
                specArtifact: loopResult.specArtifact || result.specArtifact || result.feature?.specArtifact || null,
              },
              generatedCode: loopResult.code,
              resultSummary: toText(result.resultSummary, "") +
                (loopResult.rounds > 1 ? `\n（经过 ${loopResult.rounds} 轮验证优化）` : "") +
                (loopResult.evalResult?.stats ? `\n特征统计：均值=${loopResult.evalResult.stats.mean?.toFixed(4) || "-"}, 标准差=${loopResult.evalResult.stats.std?.toFixed(4) || "-"}` : ""),
              source: toText(loopResult.code?.codeSource || result.source, ""),
              specArtifact: loopResult.specArtifact || result.specArtifact || result.feature?.specArtifact || null,
              failureType: "",
              repairSummary: loopResult.code?.repairSummary || null,
              codeDiff: loopResult.code?.codeDiff || null,
              runArtifacts: loopResult.code?.runArtifacts || null,
            };
          } else if (loopResult.status === "needs_user_input") {
            // Code needs user-provided config — return partial result with config prompt
            finalResult = {
              ok: false,
              feature: {
                ...(result.feature || {}),
                specArtifact: loopResult.specArtifact || result.specArtifact || result.feature?.specArtifact || null,
              },
              generatedCode: loopResult.code,
              resultSummary: toText(result.resultSummary, "") +
                `\n\n⚠️ 此特征需要额外配置才能运行：${(loopResult.requiredConfig || []).map((c) => c.label || c.key).join("、")}`,
              source: "needs_config",
              error: loopResult.error || "",
              requiredConfig: loopResult.requiredConfig || [],
              specArtifact: loopResult.specArtifact || result.specArtifact || result.feature?.specArtifact || null,
              failureType: toText(loopResult.code?.failureType, ""),
              repairSummary: loopResult.code?.repairSummary || null,
              codeDiff: loopResult.code?.codeDiff || null,
              runArtifacts: loopResult.code?.runArtifacts || null,
            };
          } else {
            finalResult = {
              ok: false,
              feature: {
                ...(result.feature || {}),
                specArtifact: loopResult.specArtifact || result.specArtifact || result.feature?.specArtifact || null,
              },
              generatedCode: loopResult.code || result.generatedCode || null,
              resultSummary: toText(result.resultSummary, "") || "首版代码已生成，但后续验证未通过。",
              source: toText(loopResult.code?.codeSource || result.source, ""),
              error: toText(loopResult.error, "经过多轮修复后仍未通过验证"),
              requiredConfig: [],
              specArtifact: loopResult.specArtifact || result.specArtifact || result.feature?.specArtifact || null,
              failureType: toText(loopResult.code?.failureType, ""),
              repairSummary: loopResult.code?.repairSummary || null,
              codeDiff: loopResult.code?.codeDiff || null,
              runArtifacts: loopResult.code?.runArtifacts || null,
            };
          }
        } catch {}
      }

      // Track generation result in conversation context
      if (conversationContext && typeof conversationContext.addCardEvent === "function") {
        conversationContext.addCardEvent("card_generated", {
          success: Boolean(finalResult.ok),
          featureName: toText(finalResult.feature?.name || featureConcept?.name || ""),
          resultSummary: toText(finalResult.resultSummary, ""),
          error: finalResult.ok ? "" : toText(finalResult.error, ""),
        });
      }
      sendJson(res, 200, {
        ok: Boolean(finalResult.ok),
        feature: finalResult.feature || null,
        generatedCode: finalResult.generatedCode || null,
        resultSummary: toText(finalResult.resultSummary, ""),
        source: toText(finalResult.source, ""),
        error: finalResult.ok ? "" : toText(finalResult.error, "feature generation failed"),
        requiredConfig: finalResult.requiredConfig || [],
        specArtifact: finalResult.specArtifact || finalResult.feature?.specArtifact || null,
        failureType: toText(finalResult.failureType || finalResult.generatedCode?.failureType, ""),
        repairSummary: finalResult.repairSummary || finalResult.generatedCode?.repairSummary || null,
        codeDiff: finalResult.codeDiff || finalResult.generatedCode?.codeDiff || null,
        runArtifacts: finalResult.runArtifacts || finalResult.generatedCode?.runArtifacts || null,
      });
    } catch (error) {
      // Track error in conversation context
      if (conversationContext && typeof conversationContext.addCardEvent === "function") {
        conversationContext.addCardEvent("card_error", {
          error: String(error?.message || error || "confirm failed"),
        });
      }
      sendJson(res, 200, { ok: false, error: String(error?.message || error || "confirm failed") });
    }
  }

  async function handleStrategyIntentConfirmStream(req, res) {
    if (!generateFromClarification) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Feature generation from clarification not available" }));
      return;
    }
    const body = await readJsonBody(req);
    const featureConcept = body.featureConcept && typeof body.featureConcept === "object" ? body.featureConcept : null;
    const userChoices = body.userChoices && typeof body.userChoices === "object" ? body.userChoices : {};
    const clarifyingQuestions = Array.isArray(body.clarifyingQuestions) ? body.clarifyingQuestions : [];
    if (!featureConcept) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "featureConcept is required" }));
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });

    function sendSSE(event, data) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }

    const tracker = createTaskTracker({
      taskType: "feature_generation",
      sessionId: conversationContext && typeof conversationContext.getActiveSessionId === "function"
        ? conversationContext.getActiveSessionId()
        : "",
      plan: "先整理用户选择，再产出特征加工计划，接着生成首版代码，并进入编写/运行/检测/修复闭环直到成功或失败。",
    });
    const taskId = toText(tracker.snapshot()?.taskId, "");
    createAckGate(taskId);
    let planArtifact = null;
    let snapshotTimer = null;
    let pendingSnapshot = null;
    let seqCounter = 0;
    const progressState = {
      lastWriteSnippet: "",
    };
    const waitMs = (msLike) => new Promise((resolve) => {
      const ms = Math.max(0, Math.floor(Number(msLike) || 0));
      setTimeout(resolve, ms);
    });
    function buildAckPolicy(moduleIdLike, extraLike = {}) {
      const moduleId = toText(moduleIdLike, "");
      const extra = extraLike && typeof extraLike === "object" ? extraLike : {};
      const requestedTimeoutMs = Math.max(200, Math.floor(Number(extra.ackTimeoutMs || 0) || 0));
      const strictOverride = extra.strictAck === true ? true : (extra.strictAck === false ? false : null);
      const isStrictModule = strictOverride != null
        ? strictOverride
        : (
          moduleId.indexOf("understand.") === 0
          || moduleId.indexOf("plan.") === 0
          || moduleId === "spec_lock.finalize"
        );
      return {
        strict: isStrictModule,
        timeoutMs: requestedTimeoutMs || (isStrictModule ? 2600 : 1800),
        maxRetries: isStrictModule ? 2 : 0,
        retryDelayMs: isStrictModule ? 120 : 0,
      };
    }
    async function waitForAckWithPolicy(taskIdLike, seqLike, moduleIdLike, extraLike = {}) {
      const taskId = toText(taskIdLike, "");
      const seq = Math.max(0, Math.floor(Number(seqLike) || 0));
      const moduleId = toText(moduleIdLike, "");
      const policy = buildAckPolicy(moduleId, extraLike);
      let attempt = 0;
      let lastResult = { ok: false, taskId, seq, moduleId, reason: "ack_not_started" };
      while (attempt <= policy.maxRetries) {
        lastResult = await waitForAck(taskId, seq, { timeoutMs: policy.timeoutMs });
        if (lastResult.ok) {
          return {
            ...lastResult,
            moduleId,
            strict: policy.strict,
            retryCount: attempt,
            timeoutMs: policy.timeoutMs,
          };
        }
        if (!policy.strict || lastResult.reason !== "ack_timeout" || attempt >= policy.maxRetries) break;
        attempt += 1;
        if (policy.retryDelayMs > 0) await waitMs(policy.retryDelayMs);
      }
      return {
        ...lastResult,
        moduleId,
        strict: policy.strict,
        retryCount: attempt,
        timeoutMs: policy.timeoutMs,
      };
    }

    function flushPersistSnapshot(force = false, extraLike = {}) {
      const extra = extraLike && typeof extraLike === "object" ? extraLike : {};
      pendingSnapshot = {
        ...pendingSnapshot,
        task: tracker.snapshot(),
        traces: tracker.getTraces(),
        planArtifact: planArtifact || tracker.snapshot()?.planArtifact || null,
        ...extra,
      };
      const cardEventId = Number(body.cardEventId);
      if (!Number.isFinite(cardEventId) || cardEventId <= 0) return;
      if (!force) {
        if (snapshotTimer) return;
        snapshotTimer = setTimeout(() => {
          snapshotTimer = null;
          const payload = pendingSnapshot;
          pendingSnapshot = null;
          if (payload) persistClarificationTaskResult(cardEventId, payload);
        }, 240);
        return;
      }
      if (snapshotTimer) {
        clearTimeout(snapshotTimer);
        snapshotTimer = null;
      }
      const payload = pendingSnapshot;
      pendingSnapshot = null;
      if (payload) persistClarificationTaskResult(cardEventId, payload);
    }

    function emitTrace(phase, message, status = "running", extra = {}) {
      const trace = tracker.emit(sendSSE, phase, message, status, extra);
      flushPersistSnapshot(false);
      return trace;
    }

    async function emitModuleTrace(phase, moduleId, message, status = "done", extra = {}) {
      seqCounter += 1;
      const seq = seqCounter;
      const details = extra.details && typeof extra.details === "object" ? { ...extra.details } : {};
      if (details.payload === undefined) {
        const payload = {};
        if (details.streamMode) payload.streamMode = details.streamMode;
        if (details.thinkingText) payload.thinkingText = details.thinkingText;
        if (details.planBuild && typeof details.planBuild === "object") payload.planBuild = details.planBuild;
        if (details.planStatus) payload.planStatus = details.planStatus;
        if (Object.keys(payload).length) details.payload = payload;
      }
      const trace = emitTrace(phase, message, status, {
        ...extra,
        moduleId,
        seq,
        details,
      });
      const ackResult = await waitForAckWithPolicy(taskId, seq, moduleId, extra);
      if (!ackResult.ok) {
        const ackLog = {
          taskId,
          moduleId,
          seq,
          strict: Boolean(ackResult.strict),
          retryCount: Number(ackResult.retryCount || 0),
          timeoutMs: Number(ackResult.timeoutMs || 0),
          reason: toText(ackResult.reason, "unknown"),
        };
        console.warn("[strategy-lab][ack-timeout]", JSON.stringify(ackLog));
        if (ackResult.strict) {
          throw new Error("前端未及时确认关键阶段，已中止后续步骤：" + moduleId);
        }
      }
      return { trace, seq, ackResult };
    }

    function mapProgressModule(progressLike) {
      const progress = progressLike && typeof progressLike === "object" ? progressLike : {};
      const phase = toText(progress.phase, "step");
      const status = toText(progress.status, "running");
      const details = progress.details && typeof progress.details === "object" ? progress.details : {};
      const actionLabel = toText(details.actionLabel, "");
      const streamMode = toText(details.streamMode, "");
      if (phase === "spec_lock") return { moduleId: "spec_lock.finalize" };
      if (phase === "write") {
        if (streamMode === "code_accumulate" && status === "done") return { moduleId: "write.ready", ackTimeoutMs: 3200 };
        if (streamMode === "code_accumulate") return { moduleId: "write.stream", ackTimeoutMs: 3200 };
        if (actionLabel === "code_generation_start") return { moduleId: "write.start" };
        if (actionLabel === "code_generation_done" || actionLabel === "code_ready") return { moduleId: "write.ready" };
        if (status === "error") return { moduleId: "write.error" };
        return { moduleId: "write.update" };
      }
      if (phase === "repair") {
        if (actionLabel === "code_repair") return { moduleId: "repair.start" };
        if (actionLabel === "repair_ready") return { moduleId: "repair.ready" };
        if (status === "error") return { moduleId: "repair.error" };
        return { moduleId: "repair.update" };
      }
      if (phase === "run") {
        if (actionLabel === "mock_eval_start") return { moduleId: "run.mockStart" };
        if (actionLabel === "feature_eval_start") return { moduleId: "run.realStart" };
        if (actionLabel === "feature_eval_done") return { moduleId: "run.realDone" };
        return { moduleId: "run.update" };
      }
      if (phase === "detect") {
        if (actionLabel === "spec_and_quality_check") return { moduleId: "detect.qualityCheck" };
        if (status === "done") return { moduleId: "detect.done" };
        if (status === "error") return { moduleId: "detect.error" };
        return { moduleId: "detect.update" };
      }
      if (phase === "summarize") return { moduleId: "summarize.finalize" };
      return { moduleId: phase + ".update" };
    }

    async function emitProgressTrace(progressLike) {
      const progress = progressLike && typeof progressLike === "object" ? progressLike : {};
      const details = progress.details && typeof progress.details === "object" ? progress.details : {};
      const phase = toText(progress.phase, "step");
      const status = toText(progress.status, "running");
      const attempt = Number.isFinite(Number(progress.attempt)) ? Number(progress.attempt) : undefined;
      const snippet = toText(details.codeSnippet, "");
      if (phase === "write" && toText(details.streamMode, "") === "code_accumulate") {
        const deltaSize = snippet.length - progressState.lastWriteSnippet.length;
        const forceEmit = status === "done" || deltaSize >= 120 || /\n/.test(snippet.slice(progressState.lastWriteSnippet.length));
        if (!forceEmit) return;
        progressState.lastWriteSnippet = snippet;
      }
      tracker.update({
        attempts: attempt && attempt > 0 ? attempt : tracker.snapshot()?.attempts || 0,
        currentStage: phase,
        specArtifact: details.specArtifact !== undefined ? details.specArtifact : tracker.snapshot()?.specArtifact || null,
        failureType: toText(details.failureType, tracker.snapshot()?.failureType || ""),
        repairSummary: details.repairSummary !== undefined ? details.repairSummary : tracker.snapshot()?.repairSummary || null,
        codeDiff: details.codeDiff !== undefined ? details.codeDiff : tracker.snapshot()?.codeDiff || null,
        runArtifacts: details.runArtifacts !== undefined ? details.runArtifacts : tracker.snapshot()?.runArtifacts || null,
      });
      const moduleMeta = mapProgressModule(progress);
      await emitModuleTrace(
        phase,
        moduleMeta.moduleId,
        toText(progress.message, "处理中"),
        status,
        {
          attempt,
          title: toText(progress.title, ""),
          details: Object.keys(details).length ? details : undefined,
          specArtifact: details.specArtifact,
          failureType: details.failureType,
          repairSummary: details.repairSummary,
          codeDiff: details.codeDiff,
          runArtifacts: details.runArtifacts,
          ackTimeoutMs: moduleMeta.ackTimeoutMs,
        },
      );
    }

    try {
      const ml = deps.memoryLayer || null;
      const memoryContext = ml ? await ml.buildFullMemoryContext(toText(body.userMessage || "")).catch(() => "") : "";
      const understandPayloads = buildUnderstandPayloads({
        userChoices,
        clarifyingQuestions,
      });
      await emitModuleTrace("understand", "understand.collectContext", "任务分配已确认。", "done", {
        title: "理解需求",
        ackTimeoutMs: 4200,
        details: {
          payload: understandPayloads.task,
        },
      });
      if (conversationContext && typeof conversationContext.addCardEvent === "function") {
        conversationContext.addCardEvent("card_choices", { userChoices });
      }
      await emitModuleTrace("understand", "understand.lockConstraints", "选项已加载。", "done", {
        title: "理解需求",
        ackTimeoutMs: 5200,
        details: {
          payload: understandPayloads.options,
        },
      });
      let streamedPlanThinkingText = "";
      let streamedPlanThinkingIndex = 0;
      async function emitPlanThinkingChunk(textLike, planStatusLike = "drafting", done = false) {
        const text = String(textLike ?? "");
        if (!text && !done) return;
        streamedPlanThinkingText = text;
        streamedPlanThinkingIndex += 1;
        await emitModuleTrace("plan", "plan.reasoning", "正在推导计划...", "running", {
          title: "生成计划",
          details: {
            streamMode: "thinking_stream",
            thinkingText: streamedPlanThinkingText,
            thinkingIndex: streamedPlanThinkingIndex,
            chunkDone: done,
            planStatus: toText(planStatusLike, "drafting"),
          },
        });
      }
      if (!reasonFromClarification || !planFromReasoning) {
        throw new Error("reasoning-plan pipeline not available");
      }
      const reasoningResult = await reasonFromClarification({
        featureConcept,
        userChoices,
        userMessage: toText(body.userMessage || body.originalMessage || ""),
        assistantReply: toText(body.assistantReply || ""),
        memoryContext,
        conversationHistory: conversationContext ? conversationContext.getRecentHistory(10) : [],
        async onChunk(chunkLike) {
          const chunk = chunkLike && typeof chunkLike === "object" ? chunkLike : {};
          const thinkingText = toText(chunk.text, "");
          if (!thinkingText) return;
          await emitPlanThinkingChunk(thinkingText, toText(chunk.done ? "refining" : "drafting", "drafting"), Boolean(chunk.done));
        },
      });
      if (!reasoningResult?.ok || !reasoningResult.reasoningArtifact || typeof reasoningResult.reasoningArtifact !== "object") {
        throw new Error(toText(reasoningResult?.error, "reasoning generation failed"));
      }
      const reasoningArtifact = reasoningResult.reasoningArtifact;
      const reasoningLines = Array.isArray(reasoningArtifact.lines)
        ? reasoningArtifact.lines.map((line) => toText(line, "")).filter(Boolean)
        : [];
      if (!reasoningLines.length) {
        throw new Error("reasoning lines is empty");
      }
      const planResult = await planFromReasoning({
        featureConcept,
        userChoices,
        userMessage: toText(body.userMessage || body.originalMessage || ""),
        assistantReply: toText(body.assistantReply || ""),
        memoryContext,
        reasoningArtifact,
        conversationHistory: conversationContext ? conversationContext.getRecentHistory(10) : [],
      });
      if (!planResult?.ok || !planResult.planArtifact || typeof planResult.planArtifact !== "object") {
        throw new Error(toText(planResult?.error, "plan generation from reasoning failed"));
      }
      planArtifact = planResult.planArtifact;
      tracker.update({
        plan: summarizePlanArtifact(planArtifact),
        planArtifact,
        specArtifact: null,
        currentStage: "plan",
      });
      const planBuildSequence = buildPlanBuildSequence(planArtifact);
      for (let i = 0; i < planBuildSequence.length; i += 1) {
        const item = planBuildSequence[i];
        const moduleId = item.key === "goal" ? "plan.buildGoal"
          : item.key === "approach" ? "plan.buildApproach"
          : item.key === "validation" ? "plan.buildValidation"
          : "plan.buildRepair";
        await emitModuleTrace("plan", moduleId, toText(item.message, "计划生成中..."), item.status === "finalized" ? "done" : "running", {
          title: "生成计划",
          details: {
            planArtifact,
            planStatus: toText(item.status, "drafting"),
            reasoningSummary: toText(reasoningArtifact.summary, ""),
            planBuild: {
              stage: toText(item.stage, "drafting"),
              key: toText(item.key, ""),
              text: toText(item.text, ""),
              status: toText(item.status, "drafting"),
              order: i + 1,
              total: planBuildSequence.length,
            },
          },
        });
        await waitMs(180);
      }
      await emitModuleTrace("plan", "plan.finalize", "计划已定稿，准备进入下一阶段。", "done", {
        title: "生成计划",
        details: {
          planArtifact,
          planStatus: "finalized",
          reasoningSummary: toText(reasoningArtifact.summary, ""),
          payload: {
            planStatus: "finalized",
          },
        },
      });
      const draftResult = await generateFromClarification({
        featureConcept,
        userChoices,
        userMessage: toText(body.userMessage || body.originalMessage || ""),
        assistantReply: toText(body.assistantReply || ""),
        memoryContext,
        generationPlan: planArtifact,
        skipValidation: true,
        async onProgress(progressLike) {
          await emitProgressTrace(progressLike);
        },
        conversationHistory: conversationContext ? conversationContext.getRecentHistory(10) : [],
      });

      let finalResult = {
        ok: false,
        feature: draftResult.feature || featureConcept || null,
        generatedCode: draftResult.generatedCode || null,
        resultSummary: toText(draftResult.resultSummary, ""),
        source: toText(draftResult.source, ""),
        error: toText(draftResult.error, "feature generation failed"),
        requiredConfig: draftResult.requiredConfig || [],
        planArtifact,
        specArtifact: draftResult.specArtifact || draftResult.feature?.specArtifact || null,
        failureType: toText(draftResult.generatedCode?.failureType, ""),
        repairSummary: draftResult.generatedCode?.repairSummary || null,
        codeDiff: draftResult.generatedCode?.codeDiff || null,
        runArtifacts: draftResult.generatedCode?.runArtifacts || null,
      };
      const draftSpecArtifact = draftResult.specArtifact || draftResult.feature?.specArtifact || null;

      if (!draftResult.ok || !draftResult.generatedCode?.featureCode) {
        await emitModuleTrace("write", "write.error", toText(draftResult.error || "首版特征代码生成失败"), "error", {
          attempt: 1,
          title: "首版代码",
          details: {
            codeSource: toText(draftResult.generatedCode?.codeSource || draftResult.source, "llm"),
            specArtifact: draftSpecArtifact,
          },
          specArtifact: draftSpecArtifact,
        });
      } else {
        try {
          const loopResult = await generateWithAgentLoop({
            feature: {
              ...draftResult.feature,
              generatedCode: draftResult.generatedCode,
            },
            initialCode: draftResult.generatedCode,
            suppressInitialWriteProgress: true,
            backtestEngine,
            maxRounds: 3,
            userConfig: body.userConfig || {},
            bars: Array.isArray(body.bars) ? body.bars : [],
            pair: toText(body.pair || "BTC/USDT", "BTC/USDT"),
            timeframe: toText(body.timeframe || "1h", "1h"),
            rangeDays: parsePositiveInt(body.rangeDays, 14, 1, 365),
            async onProgress(progressLike) {
              await emitProgressTrace(progressLike);
            },
          });
          if (loopResult.ok) {
            finalResult = {
              ok: true,
              feature: {
                ...(draftResult.feature || {}),
                specArtifact: loopResult.specArtifact || draftResult.specArtifact || draftResult.feature?.specArtifact || null,
              },
              generatedCode: loopResult.code,
              resultSummary: buildFeatureResultSummary(draftResult.resultSummary, loopResult),
              source: toText(loopResult.code?.codeSource || draftResult.source, ""),
              error: "",
              requiredConfig: [],
              planArtifact,
              specArtifact: loopResult.specArtifact || draftResult.specArtifact || draftResult.feature?.specArtifact || null,
              failureType: "",
              repairSummary: loopResult.code?.repairSummary || null,
              codeDiff: loopResult.code?.codeDiff || null,
              runArtifacts: loopResult.code?.runArtifacts || null,
            };
          } else if (loopResult.status === "needs_user_input") {
            finalResult = {
              ok: false,
              feature: {
                ...(draftResult.feature || {}),
                specArtifact: loopResult.specArtifact || draftResult.specArtifact || draftResult.feature?.specArtifact || null,
              },
              generatedCode: loopResult.code,
              resultSummary: toText(draftResult.resultSummary, "") +
                `\n\n⚠️ 此特征需要额外配置才能运行：${(loopResult.requiredConfig || []).map((c) => c.label || c.key).join("、")}`,
              source: "needs_config",
              error: loopResult.error || "",
              requiredConfig: loopResult.requiredConfig || [],
              planArtifact,
              specArtifact: loopResult.specArtifact || draftResult.specArtifact || draftResult.feature?.specArtifact || null,
              failureType: toText(loopResult.code?.failureType, ""),
              repairSummary: loopResult.code?.repairSummary || null,
              codeDiff: loopResult.code?.codeDiff || null,
              runArtifacts: loopResult.code?.runArtifacts || null,
            };
          } else {
            finalResult = {
              ok: false,
              feature: {
                ...(draftResult.feature || {}),
                specArtifact: loopResult.specArtifact || draftResult.specArtifact || draftResult.feature?.specArtifact || null,
              },
              generatedCode: loopResult.code || draftResult.generatedCode || null,
              resultSummary: toText(draftResult.resultSummary, "") || "首版代码已生成，但后续验证未通过。",
              source: toText(loopResult.code?.codeSource || draftResult.source, ""),
              error: toText(loopResult.error, "经过多轮修复后仍未通过验证"),
              requiredConfig: [],
              planArtifact,
              specArtifact: loopResult.specArtifact || draftResult.specArtifact || draftResult.feature?.specArtifact || null,
              failureType: toText(loopResult.code?.failureType, ""),
              repairSummary: loopResult.code?.repairSummary || null,
              codeDiff: loopResult.code?.codeDiff || null,
              runArtifacts: loopResult.code?.runArtifacts || null,
            };
          }
        } catch (err) {
          finalResult = {
            ok: false,
            feature: draftResult.feature,
            generatedCode: draftResult.generatedCode || null,
            resultSummary: toText(draftResult.resultSummary, ""),
            source: toText(draftResult.source, ""),
            error: `验证阶段异常：${String(err?.message || err || "unknown error")}`,
            requiredConfig: [],
            planArtifact,
            specArtifact: draftResult.specArtifact || draftResult.feature?.specArtifact || null,
            failureType: "runtime_contract_error",
            repairSummary: null,
            codeDiff: null,
            runArtifacts: null,
          };
          await emitModuleTrace("detect", "detect.error", finalResult.error, "error", { attempt: 1 });
        }
      }

      if (conversationContext && typeof conversationContext.addCardEvent === "function") {
        conversationContext.addCardEvent("card_generated", {
          success: Boolean(finalResult.ok),
          featureName: toText(finalResult.feature?.name || featureConcept?.name || ""),
          resultSummary: toText(finalResult.resultSummary, ""),
          error: finalResult.ok ? "" : toText(finalResult.error, ""),
        });
      }

      await emitModuleTrace(
        "summarize",
        "summarize.finalize",
        finalResult.ok
          ? "已完成特征生成，准备展示结果并允许加入特征库。"
          : (finalResult.requiredConfig?.length
            ? "当前特征还需要补充配置后才能继续。"
            : "本次特征生成未完成，请根据错误信息调整后重试。"),
        finalResult.ok ? "done" : "error",
      );
      tracker.finalize(finalResult.ok ? "completed" : "failed", {
        type: "feature_generation",
        featureName: toText(finalResult.feature?.name || ""),
      });
      tracker.update({
        specArtifact: finalResult.specArtifact || finalResult.feature?.specArtifact || tracker.snapshot()?.specArtifact || null,
        failureType: toText(finalResult.failureType || finalResult.generatedCode?.failureType, ""),
        repairSummary: finalResult.repairSummary || finalResult.generatedCode?.repairSummary || null,
        codeDiff: finalResult.codeDiff || finalResult.generatedCode?.codeDiff || null,
        runArtifacts: finalResult.runArtifacts || finalResult.generatedCode?.runArtifacts || null,
      });
      const payload = {
        ok: Boolean(finalResult.ok),
        feature: finalResult.feature || null,
        generatedCode: finalResult.generatedCode || null,
        resultSummary: toText(finalResult.resultSummary, ""),
        source: toText(finalResult.source, ""),
        error: finalResult.ok ? "" : toText(finalResult.error, "feature generation failed"),
        requiredConfig: finalResult.requiredConfig || [],
        planArtifact,
        specArtifact: finalResult.specArtifact || finalResult.feature?.specArtifact || null,
        failureType: toText(finalResult.failureType || finalResult.generatedCode?.failureType, ""),
        repairSummary: finalResult.repairSummary || finalResult.generatedCode?.repairSummary || null,
        codeDiff: finalResult.codeDiff || finalResult.generatedCode?.codeDiff || null,
        runArtifacts: finalResult.runArtifacts || finalResult.generatedCode?.runArtifacts || null,
        task: tracker.snapshot(),
        traces: tracker.getTraces(),
      };
      flushPersistSnapshot(true, {
        result: payload,
        status: payload.ok ? "generated" : (payload.requiredConfig?.length ? "needs_config" : "failed"),
        resultSummary: payload.resultSummary,
      });
      sendSSE("result", payload);
      sendSSE("done", payload);
      res.end();
    } catch (error) {
      await emitModuleTrace("summarize", "summarize.finalize", `任务异常：${String(error?.message || error || "confirm failed")}`, "error");
      tracker.finalize("failed", { type: "feature_generation" });
      if (conversationContext && typeof conversationContext.addCardEvent === "function") {
        conversationContext.addCardEvent("card_error", {
          error: String(error?.message || error || "confirm failed"),
        });
      }
      const payload = {
        ok: false,
        error: String(error?.message || error || "confirm failed"),
        task: tracker.snapshot(),
        traces: tracker.getTraces(),
      };
      flushPersistSnapshot(true, {
        result: payload,
        status: "failed",
      });
      sendSSE("result", payload);
      sendSSE("done", payload);
      res.end();
    } finally {
      destroyAckGate(taskId);
    }
  }

  async function handleStrategyTaskAck(req, res) {
    const body = await readJsonBody(req);
    const taskId = toText(body?.taskId, "");
    const moduleId = toText(body?.moduleId, "");
    const seq = Math.max(0, Math.floor(Number(body?.seq) || 0));
    if (!taskId || seq <= 0) {
      sendJson(res, 400, { ok: false, error: "taskId and seq are required" });
      return;
    }
    const accepted = resolveAckWaiter(taskId, seq, { moduleId });
    sendJson(res, 200, {
      ok: true,
      accepted,
      taskId,
      seq,
      moduleId,
    });
  }

  /**
   * Update user-provided config for a feature (API keys, URLs, etc.).
   */
  async function handleStrategyFeatureUpdateConfig(req, res) {
    const body = await readJsonBody(req);
    const featureName = toText(body.featureName || body.featureId || body.name || "");
    const configValues = body.configValues && typeof body.configValues === "object" ? body.configValues : {};
    if (!featureName) {
      sendJson(res, 400, { ok: false, error: "featureName is required" });
      return;
    }
    if (!Object.keys(configValues).length) {
      sendJson(res, 400, { ok: false, error: "configValues is required" });
      return;
    }
    try {
      const result = strategyLabStore.updateFeatureConfig(featureName, configValues);
      sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: String(error?.message || error || "config update failed") });
    }
  }

  return {
    handleStrategyFeatures,
    handleStrategyFeatureDelete,
    handleStrategyVersions,
    handleStrategyVersionsPropose,
    handleStrategyVersionsEvaluate,
    handleStrategyArtifactReport,
    handleStrategyIntentCandidates,
    handleStrategyIntentGenerateCode,
    handleStrategyIntentApply,
    handleStrategyEntities,
    handleStrategyEntityDetail,
    handleStrategyEntityDraftSave,
    handleStrategyEntityPublish,
    handleStrategyEntityStatus,
    handleStrategyEntityAudits,
    handleStrategyEntityReplay,
    handleStrategyEntityDelete,
    handleStrategyFeatureEvaluate,
    handleStrategyIntentClarify,
    handleStrategyIntentConfirm,
    handleStrategyIntentConfirmStream,
    handleStrategyTaskAck,
    handleStrategyFeatureUpdateConfig,
  };
}
