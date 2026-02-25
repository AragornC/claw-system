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
  clampNumber,
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
import {
  STRATEGY_STATUS_LABELS,
  STRATEGY_RUNTIME_ENV_BY_STATUS,
  STRATEGY_RUNTIME_ENV_LABELS,
  TRADE_TYPE_LABELS,
  normalizeStatus,
  normalizeRuntimeEnv,
  canTransitionStatus,
  normalizeSortField as normalizeStrategySortField,
  normalizeSortOrder as normalizeStrategySortOrder,
  normalizeRangeDays,
  normalizeTradeType,
  normalizeFeatureRefs,
  buildStrategyDraftPayload,
  buildFeatureLookup,
  lockFeatureVersions,
  buildSampleExecutionReport,
  filterExecutionReport,
} from "./strategy-lifecycle-helpers.js";

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
        ensureStrategyLifecycleShape(storeCache);
        persistSafe(storeCache);
        return storeCache;
      }
      const raw = fs.readFileSync(statePath, "utf8");
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") {
        storeCache = buildSeedStore();
        ensureStrategyLifecycleShape(storeCache);
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
        strategies: Array.isArray(parsed.strategies) ? parsed.strategies : seed.strategies,
        strategyVersions: Array.isArray(parsed.strategyVersions) ? parsed.strategyVersions : seed.strategyVersions,
        strategyAudits: Array.isArray(parsed.strategyAudits) ? parsed.strategyAudits : seed.strategyAudits,
      };
      if (migrateStoreShape(storeCache) || ensureStrategyLifecycleShape(storeCache)) {
        persistSafe(storeCache);
      }
      return storeCache;
    } catch {
      storeCache = buildSeedStore();
      ensureStrategyLifecycleShape(storeCache);
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

  function ensureStrategyLifecycleShape(storeLike) {
    const store = storeLike && typeof storeLike === "object" ? storeLike : buildSeedStore();
    let changed = false;
    if (!Number.isFinite(Number(store.version)) || Number(store.version) < 3) {
      store.version = 3;
      changed = true;
    }
    if (!store.seq || typeof store.seq !== "object") {
      store.seq = {};
      changed = true;
    }
    if (!Number.isFinite(Number(store.seq.strategy)) || Number(store.seq.strategy) <= 0) {
      store.seq.strategy = 1;
      changed = true;
    }
    if (!Number.isFinite(Number(store.seq.strategyVersion)) || Number(store.seq.strategyVersion) <= 0) {
      store.seq.strategyVersion = 1;
      changed = true;
    }
    if (!Number.isFinite(Number(store.seq.audit)) || Number(store.seq.audit) <= 0) {
      store.seq.audit = 1;
      changed = true;
    }
    if (!Array.isArray(store.strategies)) {
      store.strategies = [];
      changed = true;
    }
    if (!Array.isArray(store.strategyVersions)) {
      store.strategyVersions = [];
      changed = true;
    }
    if (!Array.isArray(store.strategyAudits)) {
      store.strategyAudits = [];
      changed = true;
    }
    const now = nowIso();
    if (!store.strategies.length && Array.isArray(store.versions) && store.versions.length) {
      const featureLookup = buildFeatureLookup(store.features || []);
      const seedRows = store.versions.slice(0, 3);
      seedRows.forEach((versionRow, idx) => {
        const item = versionRow && typeof versionRow === "object" ? versionRow : {};
        const strategyId = `stg_${idx + 1}`;
        const strategyVersionId = `stgver_${idx + 1}`;
        const featureRefs = normalizeFeatureRefs(item?.strategy?.featureRefs || []);
        const status = normalizeStatus(item.status === "active" ? "backtested" : "draft", "draft");
        const draftConfig = buildStrategyDraftPayload({
          signalLayer: {
            featureRefs,
            signalLogic: toText(item?.strategy?.entry || "多信号确认后触发"),
            params: {},
          },
          riskLayer: {
            riskPauseCondition: toText(item?.strategy?.riskControl || ""),
          },
          executionLayer: {},
          positionLayer: {},
        });
        const perfScore = Number(item.score);
        const latestReturnPct = Number.isFinite(perfScore) ? Number((perfScore * 65 - 8).toFixed(3)) : 0;
        const maxDrawdownPct = Number.isFinite(perfScore) ? Number((28 - perfScore * 16).toFixed(3)) : 18;
        const executionReport = buildSampleExecutionReport({ days: 30 + idx * 8, stepSec: 3600 });
        const strategyVersion = {
          strategyVersionId,
          strategyId,
          versionNo: 1,
          immutable: true,
          publishState: "published",
          versionTag: "v1.0.0",
          createdAt: toText(item.createdAt || now),
          publishedAt: toText(item.updatedAt || item.createdAt || now),
          createdBy: "ThunderClaw",
          lockedFeatureVersions: lockFeatureVersions(featureRefs, featureLookup),
          signalLayer: draftConfig.signalLayer,
          positionLayer: draftConfig.positionLayer,
          riskLayer: draftConfig.riskLayer,
          executionLayer: draftConfig.executionLayer,
          performance: {
            latestReturnPct,
            maxDrawdownPct,
            score: Number.isFinite(perfScore) ? Number(perfScore.toFixed(4)) : null,
            tradeCount: Number(item?.lastReport?.metrics?.tradeCount || 0),
            winRate: Number(item?.lastReport?.metrics?.winRate || 0),
          },
          executionReport,
        };
        const strategy = {
          strategyId,
          name: toText(item.title || `策略 ${idx + 1}`),
          description: toText(item?.strategy?.thesis || item.evalSummary || "策略草稿"),
          status,
          runtimeEnv: normalizeRuntimeEnv(status),
          currentVersionId: strategyVersionId,
          latestVersionId: strategyVersionId,
          featureCount: featureRefs.length,
          latestReturnPct,
          maxDrawdownPct,
          draftConfig,
          cardBinding: null,
          createdAt: toText(item.createdAt || now),
          updatedAt: toText(item.updatedAt || now),
        };
        store.strategies.push(strategy);
        store.strategyVersions.push(strategyVersion);
        store.strategyAudits.push({
          auditId: `audit_${idx + 1}`,
          strategyId,
          strategyVersionId,
          action: "bootstrap_migrate",
          fromStatus: "",
          toStatus: status,
          operator: "system",
          reason: "从旧策略版本迁移初始化",
          ts: now,
          detail: {
            sourceVersionId: toText(item.versionId || ""),
            sourceTitle: toText(item.title || ""),
          },
        });
      });
      store.seq.strategy = Math.max(Number(store.seq.strategy || 1), store.strategies.length + 1);
      store.seq.strategyVersion = Math.max(Number(store.seq.strategyVersion || 1), store.strategyVersions.length + 1);
      store.seq.audit = Math.max(Number(store.seq.audit || 1), store.strategyAudits.length + 1);
      changed = true;
    }
    return changed;
  }

  function appendStrategyAudit(storeLike, payloadLike = {}) {
    const store = storeLike && typeof storeLike === "object" ? storeLike : loadStore();
    const payload = payloadLike && typeof payloadLike === "object" ? payloadLike : {};
    const audit = {
      auditId: `audit_${Number(store.seq.audit || 1)}`,
      strategyId: toText(payload.strategyId || ""),
      strategyVersionId: toText(payload.strategyVersionId || ""),
      action: toText(payload.action || "unknown"),
      fromStatus: toText(payload.fromStatus || ""),
      toStatus: toText(payload.toStatus || ""),
      operator: toText(payload.operator || "ThunderClaw"),
      reason: toText(payload.reason || ""),
      ts: toText(payload.ts || nowIso(), nowIso()),
      detail: payload.detail && typeof payload.detail === "object" ? payload.detail : {},
    };
    store.seq.audit = Number(store.seq.audit || 1) + 1;
    store.strategyAudits.push(audit);
    if (store.strategyAudits.length > 5000) {
      store.strategyAudits = store.strategyAudits.slice(-4200);
    }
    return audit;
  }

  function resolveStrategyById(storeLike, strategyIdLike) {
    const store = storeLike && typeof storeLike === "object" ? storeLike : loadStore();
    const strategyId = toText(strategyIdLike || "");
    if (!strategyId) return null;
    return (store.strategies || []).find((item) => toText(item?.strategyId || "") === strategyId) || null;
  }

  function resolveStrategyByName(storeLike, nameLike) {
    const store = storeLike && typeof storeLike === "object" ? storeLike : loadStore();
    const key = slugify(nameLike);
    if (!key) return null;
    return (store.strategies || []).find((item) => slugify(item?.name || "") === key) || null;
  }

  function resolveStrategyVersionById(storeLike, strategyVersionIdLike) {
    const store = storeLike && typeof storeLike === "object" ? storeLike : loadStore();
    const strategyVersionId = toText(strategyVersionIdLike || "");
    if (!strategyVersionId) return null;
    return (store.strategyVersions || []).find((item) => toText(item?.strategyVersionId || "") === strategyVersionId) || null;
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
      const extraFeatureRefs = Array.isArray(prepared.features)
        ? prepared.features.map((item) => {
          if (typeof item === "string") return item;
          const row = item && typeof item === "object" ? item : {};
          return toText(row.featureId || row.name || "");
        }).filter(Boolean)
        : [];
      const draftFeatureRefs = uniqStrings([
        ...(Array.isArray(prepared.featureRefs) ? prepared.featureRefs : []),
        ...extraFeatureRefs,
      ]);
      const result = upsertStrategy(prepared, metaLike);
      const lifecycleResult = saveStrategyDraft({
        name: prepared.title,
        description: toText(prepared.thesis || candidate.summary || ""),
        signalLayer: {
          featureRefs: draftFeatureRefs,
          signalLogic: toText(prepared.entry || "多信号确认"),
          params: {},
        },
        riskLayer: {
          riskPauseCondition: toText(prepared.riskControl || ""),
        },
        executionLayer: {},
        positionLayer: {},
      }, {
        ...metaLike,
        source: toText(metaLike?.source || "chat_intent"),
        reason: "来自 ThunderClaw 对话候选",
      });
      return {
        kind: "strategy",
        created: result.created,
        feature: null,
        version: result.version,
        strategy: lifecycleResult?.strategy || null,
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

  function listStrategies(options = {}) {
    const store = loadStore();
    const q = toText(options.q || "").toLowerCase();
    const statusRaw = toText(options.status || "").toLowerCase();
    const status = STRATEGY_STATUS_LABELS[statusRaw] ? statusRaw : "";
    const sortBy = normalizeStrategySortField(options.sortBy);
    const sortOrder = normalizeStrategySortOrder(options.sortOrder);
    const page = parsePositiveInt(options.page, 1, 1, 9999);
    const pageSize = parsePositiveInt(options.pageSize || options.limit, 20, 5, 100);
    let rows = Array.isArray(store.strategies) ? store.strategies.slice() : [];
    if (status) {
      rows = rows.filter((item) => normalizeStatus(item?.status || "draft") === status);
    }
    if (q) {
      rows = rows.filter((item) => {
        const textPack = [
          item?.strategyId,
          item?.name,
          item?.description,
          item?.status,
          item?.runtimeEnv,
          item?.currentVersionId,
        ].map((v) => String(v || "").toLowerCase()).join(" ");
        return textPack.includes(q);
      });
    }
    rows.sort((a, b) => {
      let cmp = 0;
      if (sortBy === "latestReturnPct" || sortBy === "maxDrawdownPct") {
        cmp = Number(a?.[sortBy] || 0) - Number(b?.[sortBy] || 0);
      } else if (sortBy === "name" || sortBy === "status") {
        cmp = String(a?.[sortBy] || "").localeCompare(String(b?.[sortBy] || ""));
      } else {
        cmp = String(a?.updatedAt || "").localeCompare(String(b?.updatedAt || ""));
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
    const list = rows.slice(start, start + pageSize).map((item) => {
      const strategy = item && typeof item === "object" ? item : {};
      const statusKey = normalizeStatus(strategy.status || "draft");
      const runtimeEnv = normalizeRuntimeEnv(statusKey, strategy.runtimeEnv);
      return {
        strategyId: toText(strategy.strategyId || ""),
        name: toText(strategy.name || ""),
        description: toText(strategy.description || ""),
        status: statusKey,
        statusLabel: STRATEGY_STATUS_LABELS[statusKey] || statusKey,
        runtimeEnv: runtimeEnv,
        runtimeEnvLabel: STRATEGY_RUNTIME_ENV_LABELS[runtimeEnv] || runtimeEnv,
        latestReturnPct: Number(strategy.latestReturnPct || 0),
        maxDrawdownPct: Number(strategy.maxDrawdownPct || 0),
        featureCount: Math.max(0, Math.floor(Number(strategy.featureCount || 0))),
        currentVersionId: toText(strategy.currentVersionId || ""),
        latestVersionId: toText(strategy.latestVersionId || ""),
        createdAt: toText(strategy.createdAt || ""),
        updatedAt: toText(strategy.updatedAt || ""),
      };
    });
    return {
      total,
      page: normalizedPage,
      pageSize,
      totalPages,
      sortBy,
      sortOrder,
      strategies: list,
    };
  }

  function saveStrategyDraft(payloadLike = {}, metaLike = {}) {
    const store = loadStore();
    const payload = payloadLike && typeof payloadLike === "object" ? payloadLike : {};
    const meta = metaLike && typeof metaLike === "object" ? metaLike : {};
    const now = nowIso();
    const name = toText(payload.name || payload.title || "");
    if (!name) throw new Error("strategy name is required");
    let strategy = resolveStrategyById(store, payload.strategyId || "")
      || resolveStrategyByName(store, name)
      || null;
    const requestedStatusRaw = toText(payload.status || "");
    const requestedStatus = requestedStatusRaw
      ? normalizeStatus(requestedStatusRaw, "draft")
      : normalizeStatus(strategy?.status || "draft", "draft");
    const draftConfig = buildStrategyDraftPayload(payload);
    const featureCount = normalizeFeatureRefs(draftConfig?.signalLayer?.featureRefs || []).length;
    const operator = toText(meta.operator || meta.createdBy || "ThunderClaw");
    if (!strategy) {
      strategy = {
        strategyId: nextId("stg", "strategy"),
        name,
        description: toText(payload.description || payload.summary || "策略草稿"),
        status: requestedStatus,
        runtimeEnv: normalizeRuntimeEnv(requestedStatus, payload.runtimeEnv),
        currentVersionId: "",
        latestVersionId: "",
        featureCount,
        latestReturnPct: 0,
        maxDrawdownPct: 0,
        draftConfig,
        cardBinding: null,
        createdAt: now,
        updatedAt: now,
      };
      if (Number.isFinite(Number(meta.eventId)) && Number(meta.eventId) > 0 && toText(meta.cardId || "")) {
        strategy.cardBinding = {
          conversationId: toText(meta.conversationId || "thunderclaw-main"),
          eventId: Number(meta.eventId),
          cardId: toText(meta.cardId || ""),
          linkedAt: now,
        };
      }
      applyProvenanceMeta(strategy, meta, now, toText(meta.source || "chat_intent", "chat_intent"));
      store.strategies.push(strategy);
      appendStrategyAudit(store, {
        strategyId: strategy.strategyId,
        action: "create_draft",
        fromStatus: "",
        toStatus: strategy.status,
        operator,
        reason: toText(meta.reason || "创建策略草稿"),
        ts: now,
        detail: {
          name: strategy.name,
          featureCount,
        },
      });
      saveStore();
      return { created: true, strategy };
    }
    const fromStatus = normalizeStatus(strategy.status || "draft");
    strategy.name = name;
    strategy.description = toText(payload.description || strategy.description || "");
    strategy.status = requestedStatus || fromStatus;
    strategy.runtimeEnv = normalizeRuntimeEnv(strategy.status, payload.runtimeEnv || strategy.runtimeEnv);
    strategy.featureCount = featureCount;
    strategy.draftConfig = draftConfig;
    strategy.updatedAt = now;
    if (Number.isFinite(Number(meta.eventId)) && Number(meta.eventId) > 0 && toText(meta.cardId || "")) {
      strategy.cardBinding = {
        conversationId: toText(meta.conversationId || strategy?.cardBinding?.conversationId || "thunderclaw-main"),
        eventId: Number(meta.eventId),
        cardId: toText(meta.cardId || ""),
        linkedAt: now,
      };
    }
    applyProvenanceMeta(strategy, meta, now, toText(meta.source || "chat_intent", "chat_intent"));
    appendStrategyAudit(store, {
      strategyId: strategy.strategyId,
      action: "save_draft",
      fromStatus,
      toStatus: strategy.status,
      operator,
      reason: toText(meta.reason || "更新策略草稿"),
      ts: now,
      detail: {
        featureCount,
      },
    });
    saveStore();
    return { created: false, strategy };
  }

  function publishStrategyVersion(paramsLike = {}, metaLike = {}) {
    const store = loadStore();
    const params = paramsLike && typeof paramsLike === "object" ? paramsLike : {};
    const meta = metaLike && typeof metaLike === "object" ? metaLike : {};
    const strategy = resolveStrategyById(store, params.strategyId || "");
    if (!strategy) throw new Error("strategy not found");
    const now = nowIso();
    const statusBeforePublish = normalizeStatus(strategy.status || "draft");
    const operator = toText(meta.operator || meta.createdBy || "ThunderClaw");
    const draftConfig = strategy.draftConfig && typeof strategy.draftConfig === "object"
      ? strategy.draftConfig
      : buildStrategyDraftPayload({});
    const featureLookup = buildFeatureLookup(store.features || []);
    const lockedFeatureVersions = lockFeatureVersions(draftConfig?.signalLayer?.featureRefs || [], featureLookup);
    const versionNo = (store.strategyVersions || []).filter((item) => toText(item?.strategyId || "") === strategy.strategyId).length + 1;
    const strategyVersionId = nextId("stgver", "strategyVersion");
    const perfLike = params.performance && typeof params.performance === "object" ? params.performance : {};
    const latestReturnPct = Number(clampNumber(perfLike.latestReturnPct, -1000, 2000, strategy.latestReturnPct || 0).toFixed(4));
    const maxDrawdownPct = Number(clampNumber(perfLike.maxDrawdownPct, 0, 100, strategy.maxDrawdownPct || 0).toFixed(4));
    const executionReport = params.executionReport && typeof params.executionReport === "object"
      ? params.executionReport
      : buildSampleExecutionReport({ days: normalizeRangeDays(params.rangeDays || 30), stepSec: 3600 });
    const version = {
      strategyVersionId,
      strategyId: strategy.strategyId,
      versionNo,
      immutable: true,
      publishState: "published",
      versionTag: `v${versionNo}.0.0`,
      createdAt: now,
      publishedAt: now,
      createdBy: operator,
      publishNote: toText(params.note || meta.reason || ""),
      lockedFeatureVersions,
      signalLayer: draftConfig.signalLayer,
      positionLayer: draftConfig.positionLayer,
      riskLayer: draftConfig.riskLayer,
      executionLayer: draftConfig.executionLayer,
      performance: {
        latestReturnPct,
        maxDrawdownPct,
        winRate: Number(clampNumber(perfLike.winRate, 0, 100, 0).toFixed(4)),
        tradeCount: Math.max(0, Math.floor(Number(perfLike.tradeCount || 0))),
        score: Number.isFinite(Number(perfLike.score)) ? Number(Number(perfLike.score).toFixed(4)) : null,
      },
      executionReport,
    };
    store.strategyVersions.push(version);
    strategy.latestVersionId = strategyVersionId;
    strategy.currentVersionId = strategyVersionId;
    strategy.updatedAt = now;
    strategy.featureCount = lockedFeatureVersions.length;
    strategy.latestReturnPct = latestReturnPct;
    strategy.maxDrawdownPct = maxDrawdownPct;
    if (strategy.status === "draft" || strategy.status === "backtested") {
      strategy.status = "backtested";
      strategy.runtimeEnv = STRATEGY_RUNTIME_ENV_BY_STATUS.backtested;
    }
    appendStrategyAudit(store, {
      strategyId: strategy.strategyId,
      strategyVersionId,
      action: "publish_version",
      fromStatus: statusBeforePublish,
      toStatus: toText(strategy.status || ""),
      operator,
      reason: toText(params.note || meta.reason || "发布新版本"),
      ts: now,
      detail: {
        versionNo,
        versionTag: version.versionTag,
        featureLocks: lockedFeatureVersions,
      },
    });
    saveStore();
    return { strategy, version };
  }

  function updateStrategyStatus(paramsLike = {}, metaLike = {}) {
    const store = loadStore();
    const params = paramsLike && typeof paramsLike === "object" ? paramsLike : {};
    const meta = metaLike && typeof metaLike === "object" ? metaLike : {};
    const strategy = resolveStrategyById(store, params.strategyId || "");
    if (!strategy) throw new Error("strategy not found");
    const now = nowIso();
    const fromStatus = normalizeStatus(strategy.status || "draft");
    const toStatus = normalizeStatus(params.targetStatus || params.status || fromStatus, fromStatus);
    if (!canTransitionStatus(fromStatus, toStatus)) {
      throw new Error(`invalid status transition: ${fromStatus} -> ${toStatus}`);
    }
    strategy.status = toStatus;
    strategy.runtimeEnv = normalizeRuntimeEnv(toStatus, params.runtimeEnv || strategy.runtimeEnv);
    strategy.updatedAt = now;
    appendStrategyAudit(store, {
      strategyId: strategy.strategyId,
      strategyVersionId: toText(strategy.currentVersionId || ""),
      action: toText(params.action || "change_status"),
      fromStatus,
      toStatus,
      operator: toText(meta.operator || meta.createdBy || "ThunderClaw"),
      reason: toText(params.reason || meta.reason || ""),
      ts: now,
      detail: {
        runtimeEnv: strategy.runtimeEnv,
      },
    });
    saveStore();
    return { strategy };
  }

  function listStrategyAudits(options = {}) {
    const store = loadStore();
    const strategyId = toText(options.strategyId || "");
    if (!strategyId) return { total: 0, audits: [] };
    const limit = Math.max(1, Math.min(300, Number(options.limit) || 120));
    const rows = (store.strategyAudits || [])
      .filter((item) => toText(item?.strategyId || "") === strategyId)
      .slice()
      .sort((a, b) => String(b?.ts || "").localeCompare(String(a?.ts || "")));
    return {
      total: rows.length,
      audits: rows.slice(0, limit),
    };
  }

  function getStrategyDetail(options = {}) {
    const store = loadStore();
    const strategyId = toText(options.strategyId || "");
    if (!strategyId) throw new Error("strategyId is required");
    const strategy = resolveStrategyById(store, strategyId);
    if (!strategy) throw new Error("strategy not found");
    const rangeDays = normalizeRangeDays(options.rangeDays || 30);
    const tradeType = normalizeTradeType(options.tradeType || "all");
    const specifiedVersionId = toText(options.strategyVersionId || "");
    let version = specifiedVersionId
      ? resolveStrategyVersionById(store, specifiedVersionId)
      : null;
    if (!version || toText(version?.strategyId || "") !== strategyId) {
      const preferredVersionId = toText(strategy.currentVersionId || strategy.latestVersionId || "");
      version = preferredVersionId
        ? resolveStrategyVersionById(store, preferredVersionId)
        : null;
    }
    if (!version) {
      const candidates = (store.strategyVersions || [])
        .filter((item) => toText(item?.strategyId || "") === strategyId)
        .sort((a, b) => Number(b?.versionNo || 0) - Number(a?.versionNo || 0));
      version = candidates[0] || null;
    }
    const reportRaw = version && version.executionReport && typeof version.executionReport === "object"
      ? version.executionReport
      : buildSampleExecutionReport({ days: rangeDays, stepSec: 3600 });
    const filtered = filterExecutionReport(reportRaw, { rangeDays, tradeType });
    const report = filtered.report;
    const events = (Array.isArray(report.events) ? report.events : []).map((item) => ({
      ...item,
      tradeTypeLabel: TRADE_TYPE_LABELS[toText(item?.tradeType || "").toLowerCase()] || toText(item?.tradeType || ""),
    }));
    return {
      strategy: {
        ...strategy,
        status: normalizeStatus(strategy.status || "draft"),
        statusLabel: STRATEGY_STATUS_LABELS[normalizeStatus(strategy.status || "draft")] || normalizeStatus(strategy.status || "draft"),
        runtimeEnv: normalizeRuntimeEnv(strategy.status || "draft", strategy.runtimeEnv),
        runtimeEnvLabel: STRATEGY_RUNTIME_ENV_LABELS[normalizeRuntimeEnv(strategy.status || "draft", strategy.runtimeEnv)] || strategy.runtimeEnv,
      },
      version: version || null,
      visualization: {
        rangeDays: filtered.rangeDays,
        tradeType: filtered.tradeType,
        events,
        equityCurve: report.equityCurve || [],
        drawdownCurve: report.drawdownCurve || [],
        playback: {
          minSpeedMs: 180,
          defaultSpeedMs: 520,
        },
      },
      labels: {
        status: STRATEGY_STATUS_LABELS,
        runtimeEnv: STRATEGY_RUNTIME_ENV_LABELS,
        tradeType: TRADE_TYPE_LABELS,
      },
    };
  }

  function getStats() {
    const store = loadStore();
    return {
      featureCount: Array.isArray(store.features) ? store.features.length : 0,
      versionCount: Array.isArray(store.versions) ? store.versions.length : 0,
      artifactCount: Array.isArray(store.artifacts) ? store.artifacts.length : 0,
      strategyCount: Array.isArray(store.strategies) ? store.strategies.length : 0,
      strategyVersionCount: Array.isArray(store.strategyVersions) ? store.strategyVersions.length : 0,
      strategyAuditCount: Array.isArray(store.strategyAudits) ? store.strategyAudits.length : 0,
      updatedAt: String(store.updatedAt || ""),
    };
  }

  return {
    listFeatures,
    getFeatureFacets,
    listVersions,
    listStrategies,
    getStrategyDetail,
    listStrategyAudits,
    saveStrategyDraft,
    publishStrategyVersion,
    updateStrategyStatus,
    applyIntentCandidate,
    proposeVersionsFromMessage,
    evaluateVersion,
    reportArtifact,
    getStats,
  };
}
