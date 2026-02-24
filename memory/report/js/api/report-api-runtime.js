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

  globalObj.reportApiRuntime = {
    readJsonResponse: readJsonResponse,
    fetchStrategyFeatures: fetchStrategyFeatures,
    fetchStrategyVersions: fetchStrategyVersions,
  };
})(typeof window !== "undefined" ? window : this);
