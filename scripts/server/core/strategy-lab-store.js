import fs from "node:fs";
import path from "node:path";
import {
  FEATURE_TAXONOMY,
  MAIN_CATEGORY_CONFIG,
  TAG_CONFIG,
  OUTPUT_TYPE_CONFIG,
  buildFeatureProductProfile,
  buildFeatureVersionInfo,
} from "../domain/feature-taxonomy.js";

import {
  FEATURE_GROUPS,
  FEATURE_KINDS,
  toText,
  slugify,
  uniqStrings,
  pickEnum,
  nowIso,
  parsePositiveInt,
  normalizeSortField,
  normalizeSortOrder,
  normalizeEnabledFilter,
  normalizeMainCategoryFilter,
  normalizeTagFilter,
  buildSeedStore,
  normalizeFeatureCandidate,
  normalizeStrategyCandidate,
  computeScore,
  applyProvenanceMeta,
  applyFeatureProductMeta,
  migrateStoreShape,
} from "./strategy-lab-store-helpers.js";

export function createStrategyLabStore(deps = {}) {
  const statePath = String(deps.statePath || "").trim();
  if (!statePath) throw new Error("statePath is required");

  let storeCache = null;

  function persistSafe(storeLike) {
    const store = storeLike && typeof storeLike === "object" ? storeLike : buildSeedStore();
    store.updatedAt = nowIso();
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(store, null, 2), "utf8");
  }

  function loadStore() {
    if (storeCache) return storeCache;
    try {
      if (!fs.existsSync(statePath)) {
        storeCache = buildSeedStore();
        persistSafe(storeCache);
        return storeCache;
      }
      const raw = fs.readFileSync(statePath, "utf8");
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") {
        storeCache = buildSeedStore();
        persistSafe(storeCache);
        return storeCache;
      }
      const seed = buildSeedStore();
      storeCache = {
        ...seed,
        ...parsed,
        seq: { ...seed.seq, ...(parsed.seq || {}) },
        features: Array.isArray(parsed.features) ? parsed.features : seed.features,
        versions: Array.isArray(parsed.versions) ? parsed.versions : seed.versions,
        artifacts: Array.isArray(parsed.artifacts) ? parsed.artifacts : [],
      };
      if (migrateStoreShape(storeCache)) {
        persistSafe(storeCache);
      }
      return storeCache;
    } catch {
      storeCache = buildSeedStore();
      persistSafe(storeCache);
      return storeCache;
    }
  }

  function saveStore() {
    const store = loadStore();
    persistSafe(store);
  }

  function nextId(prefix, seqKey) {
    const store = loadStore();
    const n = Number(store?.seq?.[seqKey] || 1);
    store.seq[seqKey] = n + 1;
    return `${prefix}_${n}`;
  }

  function listFeatures(options = {}) {
    const store = loadStore();
    const q = toText(options.q).toLowerCase();
    const group = pickEnum(options.group || "", FEATURE_GROUPS, "");
    const kind = pickEnum(options.kind || "", FEATURE_KINDS, "");
    const mainCategory = normalizeMainCategoryFilter(options.mainCategory);
    const tag = normalizeTagFilter(options.tag);
    const source = toText(options.source || "");
    const enabledFilter = normalizeEnabledFilter(options.enabled);
    const sortBy = normalizeSortField(options.sortBy);
    const sortOrder = normalizeSortOrder(options.sortOrder);
    const page = parsePositiveInt(options.page, 1, 1, 9999);
    const pageSize = parsePositiveInt(options.pageSize || options.limit, 40, 10, 120);
    let rows = Array.isArray(store.features) ? store.features.slice() : [];
    if (group) {
      rows = rows.filter((item) => String(item?.group || "") === group);
    }
    if (kind) {
      rows = rows.filter((item) => String(item?.kind || "") === kind);
    }
    if (mainCategory) {
      rows = rows.filter((item) => String(item?.mainCategory || "") === mainCategory);
    }
    if (tag) {
      rows = rows.filter((item) => Array.isArray(item?.tags) && item.tags.includes(tag));
    }
    if (source) {
      rows = rows.filter((item) => String(item?.source || "") === source);
    }
    if (enabledFilter) {
      const enabledVal = enabledFilter === "enabled";
      rows = rows.filter((item) => Boolean(item?.enabled !== false) === enabledVal);
    }
    if (q) {
      rows = rows.filter((item) => {
        const text = [
          item?.featureId,
          item?.name,
          item?.group,
          item?.kind,
          item?.mainCategory,
          item?.outputType,
          item?.description,
          item?.usageSummary,
          item?.triggerLogic,
          ...(Array.isArray(item?.tags) ? item.tags : []),
          item?.source,
          item?.originQuery,
          item?.originReply,
          item?.originConversationId,
          item?.originCardId,
        ]
          .map((v) => String(v || "").toLowerCase())
          .join(" ");
        return text.includes(q);
      });
    }
    rows.sort((a, b) => {
      let cmp = 0;
      if (
        sortBy === "name"
        || sortBy === "group"
        || sortBy === "kind"
        || sortBy === "source"
        || sortBy === "mainCategory"
        || sortBy === "outputType"
      ) {
        cmp = String(a?.[sortBy] || "").localeCompare(String(b?.[sortBy] || ""));
      } else if (sortBy === "enabled") {
        cmp = Number(Boolean(a?.enabled !== false)) - Number(Boolean(b?.enabled !== false));
      } else {
        cmp = String(a?.[sortBy] || "").localeCompare(String(b?.[sortBy] || ""));
      }
      if (cmp === 0) {
        cmp = String(b?.updatedAt || "").localeCompare(String(a?.updatedAt || ""));
      }
      return sortOrder === "asc" ? cmp : -cmp;
    });
    const total = rows.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const normalizedPage = Math.min(page, totalPages);
    const start = (normalizedPage - 1) * pageSize;
    return {
      total,
      page: normalizedPage,
      pageSize,
      totalPages,
      sortBy,
      sortOrder,
      features: rows.slice(start, start + pageSize),
    };
  }

  function getFeatureFacets() {
    const store = loadStore();
    const rows = Array.isArray(store.features) ? store.features : [];
    const groups = uniqStrings(rows.map((item) => item?.group)).sort((a, b) => a.localeCompare(b));
    const kinds = uniqStrings(rows.map((item) => item?.kind)).sort((a, b) => a.localeCompare(b));
    const sources = uniqStrings(rows.map((item) => item?.source)).sort((a, b) => a.localeCompare(b));
    const mainCategories = uniqStrings(rows.map((item) => item?.mainCategory))
      .filter((key) => Boolean(MAIN_CATEGORY_CONFIG[key]))
      .sort((a, b) => a.localeCompare(b));
    const tags = uniqStrings(
      rows.flatMap((item) => (Array.isArray(item?.tags) ? item.tags : [])),
    )
      .filter((key) => Boolean(TAG_CONFIG[key]))
      .sort((a, b) => a.localeCompare(b));
    const outputTypes = uniqStrings(rows.map((item) => item?.outputType))
      .filter((key) => Boolean(OUTPUT_TYPE_CONFIG[key]))
      .sort((a, b) => a.localeCompare(b));
    const enabledCount = rows.filter((item) => item?.enabled !== false).length;
    return {
      groups,
      kinds,
      sources,
      mainCategories,
      tags,
      outputTypes,
      taxonomy: {
        mainCategories: FEATURE_TAXONOMY.mainCategories,
        tags: FEATURE_TAXONOMY.tags,
        outputTypes: FEATURE_TAXONOMY.outputTypes,
      },
      enabledCount,
      disabledCount: Math.max(0, rows.length - enabledCount),
    };
  }

  function listVersions(options = {}) {
    const store = loadStore();
    const limit = Math.max(1, Math.min(300, Number(options.limit) || 80));
    const rows = (Array.isArray(store.versions) ? store.versions.slice() : [])
      .sort((a, b) => String(b?.updatedAt || "").localeCompare(String(a?.updatedAt || "")));
    return {
      total: rows.length,
      versions: rows.slice(0, limit),
    };
  }

  function findFeatureByName(nameLike) {
    const key = slugify(nameLike);
    if (!key) return null;
    const store = loadStore();
    return (store.features || []).find((item) => slugify(item?.name) === key) || null;
  }

  function upsertFeature(featureLike, metaLike = {}) {
    const store = loadStore();
    const normalized = normalizeFeatureCandidate(featureLike);
    if (!normalized) throw new Error("invalid feature candidate");
    const now = nowIso();
    const existing = findFeatureByName(normalized.name);
    if (existing) {
      existing.group = normalized.group;
      existing.kind = normalized.kind;
      existing.description = normalized.description;
      existing.params = normalized.params;
      existing.mainCategory = normalized.mainCategory || existing.mainCategory;
      existing.tags = normalized.tags && normalized.tags.length ? normalized.tags : existing.tags;
      existing.displayMode = normalized.displayMode || existing.displayMode;
      existing.outputType = normalized.outputType || existing.outputType;
      existing.usageSummary = normalized.usageSummary || existing.usageSummary;
      existing.triggerLogic = normalized.triggerLogic || existing.triggerLogic;
      existing.algorithmSummary = normalized.algorithmSummary || existing.algorithmSummary;
      existing.algorithmSteps = normalized.algorithmSteps && normalized.algorithmSteps.length
        ? normalized.algorithmSteps
        : existing.algorithmSteps;
      existing.pseudoCode = normalized.pseudoCode && normalized.pseudoCode.length
        ? normalized.pseudoCode
        : existing.pseudoCode;
      existing.paramSpecs = normalized.paramSpecs && normalized.paramSpecs.length
        ? normalized.paramSpecs
        : existing.paramSpecs;
      existing.sourceType = normalized.sourceType || existing.sourceType;
      existing.createdBy = normalized.createdBy || existing.createdBy;
      existing.enabled = normalized.enabled !== false;
      applyProvenanceMeta(existing, metaLike, now, toText(existing.source || "chat_intent", "chat_intent"));
      applyFeatureProductMeta(existing, {
        ...metaLike,
        source: toText(metaLike?.source || existing.source || "chat_intent"),
        sourceType: toText(metaLike?.sourceType || existing.sourceType || existing.source || "chat_intent"),
        creator: toText(metaLike?.createdBy || metaLike?.creator || existing.createdBy || "ThunderClaw"),
        bumpRevision: true,
      });
      existing.updatedAt = now;
      saveStore();
      return { created: false, feature: existing };
    }
    const item = {
      featureId: nextId("feat", "feature"),
      name: normalized.name,
      group: normalized.group,
      kind: normalized.kind,
      description: normalized.description,
      params: normalized.params,
      mainCategory: normalized.mainCategory,
      tags: normalized.tags,
      displayMode: normalized.displayMode,
      outputType: normalized.outputType,
      usageSummary: normalized.usageSummary,
      triggerLogic: normalized.triggerLogic,
      algorithmSummary: normalized.algorithmSummary,
      algorithmSteps: normalized.algorithmSteps,
      pseudoCode: normalized.pseudoCode,
      paramSpecs: normalized.paramSpecs,
      enabled: normalized.enabled !== false,
      source: "chat_intent",
      sourceType: toText(normalized.sourceType || metaLike?.sourceType || metaLike?.source || "chat_intent"),
      createdBy: toText(normalized.createdBy || metaLike?.createdBy || metaLike?.creator || "ThunderClaw"),
      originQuery: "",
      originReply: "",
      createdAt: now,
      updatedAt: now,
    };
    applyProvenanceMeta(item, metaLike, now, "chat_intent");
    applyFeatureProductMeta(item, {
      ...metaLike,
      source: toText(metaLike?.source || "chat_intent"),
      sourceType: toText(metaLike?.sourceType || metaLike?.source || "chat_intent"),
      creator: toText(metaLike?.createdBy || metaLike?.creator || "ThunderClaw"),
      bumpRevision: false,
    });
    store.features.push(item);
    saveStore();
    return { created: true, feature: item };
  }

  function upsertStrategy(strategyLike, metaLike = {}) {
    const store = loadStore();
    const normalized = normalizeStrategyCandidate(strategyLike);
    if (!normalized.title) throw new Error("invalid strategy candidate");
    const now = nowIso();
    const titleKey = normalized.title.toLowerCase();
    const existing = (store.versions || []).find((item) => String(item?.title || "").toLowerCase() === titleKey) || null;
    const featureRefs = uniqStrings([
      ...normalized.featureRefs,
      ...normalized.features.map((f) => f.name),
    ]);
    normalized.features.forEach((feature) => {
      try {
        upsertFeature(feature, metaLike);
      } catch {}
    });
    if (existing) {
      existing.strategy = {
        ...existing.strategy,
        thesis: normalized.thesis,
        horizon: normalized.horizon,
        riskLevel: normalized.riskLevel,
        entry: normalized.entry,
        riskControl: normalized.riskControl,
        exit: normalized.exit,
        featureRefs,
        dsl: normalized.dsl || existing.strategy?.dsl || null,
      };
      existing.source = toText(metaLike.source || existing.source || "chat_intent");
      existing.originQuery = toText(metaLike.query || existing.originQuery || "");
      existing.originReply = toText(metaLike.reply || existing.originReply || "");
      applyProvenanceMeta(existing, metaLike, now, toText(existing.source || "chat_intent", "chat_intent"));
      existing.updatedAt = now;
      saveStore();
      return { created: false, version: existing };
    }
    const item = {
      versionId: nextId("ver", "version"),
      title: normalized.title,
      status: "candidate",
      parentVersionId: toText(metaLike.parentVersionId || ""),
      score: null,
      evalSummary: "",
      source: toText(metaLike.source || "chat_intent"),
      originQuery: toText(metaLike.query || ""),
      originReply: toText(metaLike.reply || ""),
      strategy: {
        thesis: normalized.thesis,
        horizon: normalized.horizon,
        riskLevel: normalized.riskLevel,
        entry: normalized.entry,
        riskControl: normalized.riskControl,
        exit: normalized.exit,
        featureRefs,
        dsl: normalized.dsl || null,
      },
      createdAt: now,
      updatedAt: now,
    };
    applyProvenanceMeta(item, metaLike, now, "chat_intent");
    store.versions.push(item);
    saveStore();
    return { created: true, version: item };
  }

  function applyIntentCandidate(candidateLike, metaLike = {}) {
    const candidate = candidateLike && typeof candidateLike === "object" ? candidateLike : {};
    const kind = String(candidate.kind || "").trim().toLowerCase();
    if (kind === "feature") {
      const featureRaw = candidate.feature && typeof candidate.feature === "object"
        ? candidate.feature
        : candidate;
      const result = upsertFeature(featureRaw, metaLike);
      return {
        kind: "feature",
        created: result.created,
        feature: result.feature,
        version: null,
      };
    }
    if (kind === "strategy") {
      const strategyRaw = candidate.strategy && typeof candidate.strategy === "object"
        ? candidate.strategy
        : candidate;
      const prepared = {
        ...strategyRaw,
        title: toText(strategyRaw.title || candidate.title || "对话策略候选"),
      };
      const result = upsertStrategy(prepared, metaLike);
      return {
        kind: "strategy",
        created: result.created,
        feature: null,
        version: result.version,
      };
    }
    throw new Error("candidate.kind must be feature or strategy");
  }

  function proposeVersionsFromMessage(params = {}) {
    const message = toText(params.message);
    if (!message) throw new Error("message is required");
    const baseVersionId = toText(params.baseVersionId);
    const store = loadStore();
    const base = (store.versions || []).find((v) => String(v?.versionId || "") === baseVersionId)
      || (store.versions || [])[0]
      || null;
    const objective = message.slice(0, 160);
    const baseTitle = toText(base?.title || "策略基线");
    const parentVersionId = toText(base?.versionId || "");
    const variants = [
      {
        title: `${baseTitle} · 稳健降回撤`,
        horizon: "intraday",
        riskLevel: "conservative",
        entry: "增加确认条件后再入场",
        riskControl: "收紧单笔风险，优先控制回撤",
        exit: "目标收益达到即分批退出",
      },
      {
        title: `${baseTitle} · 平衡收益`,
        horizon: "intraday",
        riskLevel: "balanced",
        entry: "趋势同向 + 动量确认",
        riskControl: "ATR 风险控制 + notional 约束",
        exit: "趋势衰减或收益目标达成退出",
      },
      {
        title: `${baseTitle} · 进攻增强`,
        horizon: "swing",
        riskLevel: "aggressive",
        entry: "突破或再入信号触发即执行",
        riskControl: "允许更大波动，设置硬止损",
        exit: "反向信号或时间止盈退出",
      },
    ];
    const proposals = variants.map((item) => {
      const result = upsertStrategy(
        {
          title: item.title,
          thesis: `用户目标：${objective}`,
          horizon: item.horizon,
          riskLevel: item.riskLevel,
          entry: item.entry,
          riskControl: item.riskControl,
          exit: item.exit,
          featureRefs: base?.strategy?.featureRefs || [],
        },
        {
          source: "manual_propose",
          query: message,
          parentVersionId,
        },
      );
      return result.version;
    });
    return { proposals };
  }

  function evaluateVersion(params = {}) {
    const versionId = toText(params.versionId);
    if (!versionId) throw new Error("versionId is required");
    const metrics = params.metrics && typeof params.metrics === "object" ? params.metrics : {};
    const store = loadStore();
    const target = (store.versions || []).find((item) => String(item?.versionId || "") === versionId);
    if (!target) throw new Error("version not found");
    const score = computeScore(metrics);
    const report = {
      ts: nowIso(),
      score,
      metrics: {
        tradeCount: clampNumber(metrics.tradeCount, 0, 50000, 0),
        winRate: clampNumber(metrics.winRate, 0, 100, 0),
        netPnlPct: clampNumber(metrics.netPnlPct, -100, 300, 0),
        maxDrawdownPct: clampNumber(metrics.maxDrawdownPct, 0, 100, 0),
        sharpe: clampNumber(metrics.sharpe, -5, 10, 0),
        profitFactor: clampNumber(metrics.profitFactor, 0, 10, 0),
      },
    };
    target.score = Number(score.toFixed(4));
    target.status = "evaluated";
    target.evalSummary = `win=${report.metrics.winRate.toFixed(1)}% pnl=${report.metrics.netPnlPct.toFixed(2)}% dd=${report.metrics.maxDrawdownPct.toFixed(2)}%`;
    target.lastReport = report;
    target.updatedAt = nowIso();
    saveStore();
    return { report, version: target };
  }

  function reportArtifact(payloadLike = {}) {
    const store = loadStore();
    const payload = payloadLike && typeof payloadLike === "object" ? payloadLike : {};
    const reportKey = toText(payload.reportKey || "");
    const existing = reportKey
      ? (store.artifacts || []).find((item) => String(item?.reportKey || "") === reportKey) || null
      : null;
    const ts = nowIso();
    if (existing) {
      existing.ts = ts;
      existing.source = toText(payload.source || existing.source || "dashboard");
      existing.query = toText(payload.query || existing.query || "");
      existing.label = toText(payload.label || existing.label || "strategy-artifact");
      existing.config = payload.config && typeof payload.config === "object" ? payload.config : existing.config || {};
      existing.result = payload.result && typeof payload.result === "object" ? payload.result : existing.result || {};
      existing.version = Number(existing.version || 1) + 1;
      existing.updatedAt = ts;
      saveStore();
      return { artifact: existing, artifactId: existing.artifactId, version: existing.version };
    }
    const artifact = {
      artifactId: nextId("artifact", "artifact"),
      reportKey: reportKey || nextId("report", "artifact"),
      version: 1,
      ts,
      updatedAt: ts,
      source: toText(payload.source || "dashboard"),
      query: toText(payload.query || ""),
      label: toText(payload.label || "strategy-artifact"),
      config: payload.config && typeof payload.config === "object" ? payload.config : {},
      result: payload.result && typeof payload.result === "object" ? payload.result : {},
    };
    store.artifacts.push(artifact);
    if (store.artifacts.length > 2000) {
      store.artifacts = store.artifacts.slice(-1600);
    }
    saveStore();
    return { artifact, artifactId: artifact.artifactId, version: 1 };
  }

  function getStats() {
    const store = loadStore();
    return {
      featureCount: Array.isArray(store.features) ? store.features.length : 0,
      versionCount: Array.isArray(store.versions) ? store.versions.length : 0,
      artifactCount: Array.isArray(store.artifacts) ? store.artifacts.length : 0,
      updatedAt: String(store.updatedAt || ""),
    };
  }

  return {
    listFeatures,
    getFeatureFacets,
    listVersions,
    applyIntentCandidate,
    proposeVersionsFromMessage,
    evaluateVersion,
    reportArtifact,
    getStats,
  };
}
