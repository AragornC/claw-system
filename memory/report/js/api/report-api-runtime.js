(function(globalObj) {
  async function readJsonResponse(resp) {
    const payload = await resp.json().catch(function() { return null; });
    if (!resp.ok || !payload || payload.ok !== true) {
      throw new Error(String(payload?.error || ("HTTP " + resp.status)));
    }
    return payload;
  }

  async function fetchStrategyFeatures(paramsLike) {
    const params = paramsLike && typeof paramsLike === "object" ? paramsLike : {};
    const q = String(params.q || "").trim();
    const mainCategory = String(params.mainCategory || "").trim();
    const tag = String(params.tag || "").trim();
    const source = String(params.source || "").trim();
    const enabled = String(params.enabled || "").trim();
    const sortBy = String(params.sortBy || "updatedAt").trim() || "updatedAt";
    const sortOrder = String(params.sortOrder || "desc").trim() || "desc";
    const page = Math.max(1, Number(params.page || 1) || 1);
    const pageSize = Math.max(10, Math.min(120, Number(params.pageSize || 40) || 40));
    const url = "/api/strategy/features"
      + "?q=" + encodeURIComponent(q)
      + "&mainCategory=" + encodeURIComponent(mainCategory)
      + "&tag=" + encodeURIComponent(tag)
      + "&source=" + encodeURIComponent(source)
      + "&enabled=" + encodeURIComponent(enabled)
      + "&sortBy=" + encodeURIComponent(sortBy)
      + "&sortOrder=" + encodeURIComponent(sortOrder)
      + "&page=" + encodeURIComponent(String(page))
      + "&pageSize=" + encodeURIComponent(String(pageSize));
    const resp = await fetch(url, { cache: "no-store" });
    return readJsonResponse(resp);
  }

  async function fetchStrategyVersions(limitLike) {
    const limit = Math.max(1, Math.min(200, Number(limitLike || 80) || 80));
    const resp = await fetch("/api/strategy/versions?limit=" + encodeURIComponent(String(limit)), { cache: "no-store" });
    return readJsonResponse(resp);
  }

  async function fetchStrategyEntities(paramsLike) {
    const params = paramsLike && typeof paramsLike === "object" ? paramsLike : {};
    const q = String(params.q || "").trim();
    const status = String(params.status || "").trim();
    const sortBy = String(params.sortBy || "updatedAt").trim() || "updatedAt";
    const sortOrder = String(params.sortOrder || "desc").trim() || "desc";
    const page = Math.max(1, Number(params.page || 1) || 1);
    const pageSize = Math.max(5, Math.min(100, Number(params.pageSize || 20) || 20));
    const url = "/api/strategy/entities"
      + "?q=" + encodeURIComponent(q)
      + "&status=" + encodeURIComponent(status)
      + "&sortBy=" + encodeURIComponent(sortBy)
      + "&sortOrder=" + encodeURIComponent(sortOrder)
      + "&page=" + encodeURIComponent(String(page))
      + "&pageSize=" + encodeURIComponent(String(pageSize));
    const resp = await fetch(url, { cache: "no-store" });
    return readJsonResponse(resp);
  }

  async function fetchStrategyEntityDetail(paramsLike) {
    const params = paramsLike && typeof paramsLike === "object" ? paramsLike : {};
    const strategyId = String(params.strategyId || "").trim();
    const strategyVersionId = String(params.strategyVersionId || "").trim();
    const rangeDays = Math.max(1, Math.min(365, Number(params.rangeDays || 30) || 30));
    const tradeType = String(params.tradeType || "all").trim() || "all";
    if (!strategyId) throw new Error("strategyId is required");
    const url = "/api/strategy/entities/detail"
      + "?strategyId=" + encodeURIComponent(strategyId)
      + "&strategyVersionId=" + encodeURIComponent(strategyVersionId)
      + "&rangeDays=" + encodeURIComponent(String(rangeDays))
      + "&tradeType=" + encodeURIComponent(tradeType);
    const resp = await fetch(url, { cache: "no-store" });
    return readJsonResponse(resp);
  }

  async function fetchStrategyEntityAudits(paramsLike) {
    const params = paramsLike && typeof paramsLike === "object" ? paramsLike : {};
    const strategyId = String(params.strategyId || "").trim();
    const limit = Math.max(1, Math.min(300, Number(params.limit || 120) || 120));
    if (!strategyId) throw new Error("strategyId is required");
    const url = "/api/strategy/entities/audits"
      + "?strategyId=" + encodeURIComponent(strategyId)
      + "&limit=" + encodeURIComponent(String(limit));
    const resp = await fetch(url, { cache: "no-store" });
    return readJsonResponse(resp);
  }

  async function postStrategyDraftSave(payloadLike) {
    const payload = payloadLike && typeof payloadLike === "object" ? payloadLike : {};
    const resp = await fetch("/api/strategy/entities/save-draft", {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return readJsonResponse(resp);
  }

  async function postStrategyPublish(payloadLike) {
    const payload = payloadLike && typeof payloadLike === "object" ? payloadLike : {};
    const resp = await fetch("/api/strategy/entities/publish", {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return readJsonResponse(resp);
  }

  async function postStrategyStatus(payloadLike) {
    const payload = payloadLike && typeof payloadLike === "object" ? payloadLike : {};
    const resp = await fetch("/api/strategy/entities/status", {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return readJsonResponse(resp);
  }

  globalObj.reportApiRuntime = {
    readJsonResponse: readJsonResponse,
    fetchStrategyFeatures: fetchStrategyFeatures,
    fetchStrategyVersions: fetchStrategyVersions,
    fetchStrategyEntities: fetchStrategyEntities,
    fetchStrategyEntityDetail: fetchStrategyEntityDetail,
    fetchStrategyEntityAudits: fetchStrategyEntityAudits,
    postStrategyDraftSave: postStrategyDraftSave,
    postStrategyPublish: postStrategyPublish,
    postStrategyStatus: postStrategyStatus,
  };
})(typeof window !== "undefined" ? window : this);
