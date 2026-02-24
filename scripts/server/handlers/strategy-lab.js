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
  const getCurrentRuntimeModelRefFromStore = deps.getCurrentRuntimeModelRefFromStore;

  if (typeof readJsonBody !== "function") throw new Error("readJsonBody is required");
  if (typeof sendJson !== "function") throw new Error("sendJson is required");
  if (!strategyLabStore || typeof strategyLabStore !== "object") throw new Error("strategyLabStore is required");
  if (typeof extractTradingIntentCandidates !== "function") throw new Error("extractTradingIntentCandidates is required");
  if (typeof getCurrentRuntimeModelRefFromStore !== "function") throw new Error("getCurrentRuntimeModelRefFromStore is required");

  async function handleStrategyFeatures(req, res) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const q = toText(url.searchParams.get("q") || "");
    const group = toText(url.searchParams.get("group") || "");
    const kind = toText(url.searchParams.get("kind") || "");
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
      source,
      enabled,
      sortBy,
      sortOrder,
      page,
      pageSize,
    });
    const facets = typeof strategyLabStore.getFeatureFacets === "function"
      ? strategyLabStore.getFeatureFacets()
      : { groups: [], kinds: [], sources: [], enabledCount: 0, disabledCount: 0 };
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
        : toText(applied?.version?.title || "");
      const state = {
        features: strategyLabStore.listFeatures({ limit: 120 }).features,
        versions: strategyLabStore.listVersions({ limit: 120 }).versions,
      };
      sendJson(res, 200, {
        ok: true,
        applied,
        reply: `${kindText}已加入虾策：${nameText}${applied?.created ? "" : "（已存在，已更新）"}`,
        stats: strategyLabStore.getStats(),
        state,
      });
    } catch (error) {
      sendJson(res, 400, {
        ok: false,
        error: String(error?.message || error || "apply candidate failed"),
      });
    }
  }

  return {
    handleStrategyFeatures,
    handleStrategyVersions,
    handleStrategyVersionsPropose,
    handleStrategyVersionsEvaluate,
    handleStrategyArtifactReport,
    handleStrategyIntentCandidates,
    handleStrategyIntentApply,
  };
}
