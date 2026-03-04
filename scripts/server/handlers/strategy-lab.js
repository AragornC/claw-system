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
  const generateFromClarification = typeof deps.generateFromClarification === "function" ? deps.generateFromClarification : null;
  const generateWithAgentLoop = typeof deps.generateWithAgentLoop === "function" ? deps.generateWithAgentLoop : null;
  const getCurrentRuntimeModelRefFromStore = deps.getCurrentRuntimeModelRefFromStore;
  const updateChatCardStatus = typeof deps.updateChatCardStatus === "function" ? deps.updateChatCardStatus : null;
  const backtestEngine = deps.backtestEngine || null;
  const conversationContext = deps.conversationContext || null;

  if (typeof readJsonBody !== "function") throw new Error("readJsonBody is required");
  if (typeof sendJson !== "function") throw new Error("sendJson is required");
  if (!strategyLabStore || typeof strategyLabStore !== "object") throw new Error("strategyLabStore is required");
  if (typeof extractTradingIntentCandidates !== "function") throw new Error("extractTradingIntentCandidates is required");
  if (typeof generateFeatureCodeForCandidate !== "function") throw new Error("generateFeatureCodeForCandidate is required");
  if (typeof getCurrentRuntimeModelRefFromStore !== "function") throw new Error("getCurrentRuntimeModelRefFromStore is required");

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
      // L4: Write to OpenClaw memory for long-term retrieval
      const ml = deps.memoryLayer || null;
      if (ml && applied?.kind === "feature" && applied?.feature) {
        ml.recordFeatureCreation(applied.feature);
      }
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

    // Ensure features have generatedCode — fallback from params.pythonIndicator
    features = features.map((f) => {
      const feature = f && typeof f === "object" ? { ...f } : {};
      if (feature.generatedCode && toText(feature.generatedCode.indicatorCode)) return feature;
      // Try to construct generatedCode from params
      const params = feature.params && typeof feature.params === "object" ? feature.params : {};
      const pythonIndicator = toText(params.pythonIndicator || params.runtime?.pythonIndicator || "");
      if (pythonIndicator) {
        feature.generatedCode = {
          indicatorCode: pythonIndicator,
          entryConditionCode: "",
          exitConditionCode: "",
          codeSource: toText(params.codeSource || params.codegen?.codeSource || "legacy"),
          columnNames: [],
          description: "",
        };
      }
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
      const result = backtestEngine.runFeatureEvaluation({ features, rangeDays, pair, timeframe });
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
        conversationHistory: conversationContext ? conversationContext.getRecentHistory(10) : [],
      });

      // If initial generation succeeded AND agent loop is available,
      // run the agent loop to verify code quality with real evaluation
      let finalResult = result;
      if (result.ok && result.generatedCode?.indicatorCode && generateWithAgentLoop && backtestEngine) {
        try {
          const loopResult = await generateWithAgentLoop({
            feature: {
              ...result.feature,
              generatedCode: result.generatedCode,
            },
            backtestEngine,
            maxRounds: 3,
            userConfig: body.userConfig || {},
          });
          if (loopResult.ok) {
            // Agent loop produced a verified version
            finalResult = {
              ...result,
              generatedCode: loopResult.code,
              resultSummary: toText(result.resultSummary, "") +
                (loopResult.rounds > 1 ? `\n（经过 ${loopResult.rounds} 轮验证优化）` : "") +
                (loopResult.evalResult?.stats ? `\n特征统计：均值=${loopResult.evalResult.stats.mean?.toFixed(4) || "-"}, 标准差=${loopResult.evalResult.stats.std?.toFixed(4) || "-"}` : ""),
              source: toText(loopResult.code?.codeSource || result.source, ""),
            };
          } else if (loopResult.status === "needs_user_input") {
            // Code needs user-provided config — return partial result with config prompt
            finalResult = {
              ok: false,
              feature: result.feature,
              generatedCode: loopResult.code,
              resultSummary: toText(result.resultSummary, "") +
                `\n\n⚠️ 此特征需要额外配置才能运行：${(loopResult.requiredConfig || []).map((c) => c.label || c.key).join("、")}`,
              source: "needs_config",
              error: loopResult.error || "",
              requiredConfig: loopResult.requiredConfig || [],
            };
          }
          // If loop failed but initial generation was ok, keep original result
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
  };
}
