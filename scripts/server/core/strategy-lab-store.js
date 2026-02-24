import fs from "node:fs";
import path from "node:path";

const FEATURE_GROUPS = new Set(["trend", "momentum", "volatility", "risk", "execution", "custom"]);
const FEATURE_KINDS = new Set([
  "ema",
  "sma",
  "rsi",
  "adx",
  "atr",
  "volume",
  "price_action",
  "risk_rule",
  "custom",
]);
const STRATEGY_HORIZONS = new Set(["scalp", "intraday", "swing", "position"]);
const STRATEGY_RISK_LEVELS = new Set(["conservative", "balanced", "aggressive"]);
const FEATURE_SORT_FIELDS = new Set(["updatedAt", "createdAt", "name", "group", "kind", "source", "enabled"]);

function clampNumber(valueLike, min, max, fallback = 0) {
  const n = Number(valueLike);
  if (!Number.isFinite(n)) return fallback;
  if (Number.isFinite(min) && n < min) return min;
  if (Number.isFinite(max) && n > max) return max;
  return n;
}

function toText(valueLike, fallback = "") {
  const s = String(valueLike ?? "").trim();
  return s || fallback;
}

function slugify(valueLike) {
  const raw = String(valueLike ?? "").trim().toLowerCase();
  const slug = raw
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "";
}

function uniqStrings(valuesLike) {
  const rows = Array.isArray(valuesLike) ? valuesLike : [];
  const set = new Set();
  rows.forEach((item) => {
    const v = String(item ?? "").trim();
    if (v) set.add(v);
  });
  return Array.from(set);
}

function pickEnum(valueLike, allowedSet, fallback) {
  const v = String(valueLike ?? "").trim().toLowerCase();
  if (allowedSet.has(v)) return v;
  return fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function parsePositiveInt(valueLike, fallback, min, max) {
  const n = Number.parseInt(String(valueLike ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  if (Number.isFinite(min) && n < min) return fallback;
  if (Number.isFinite(max) && n > max) return max;
  return n;
}

function normalizeSortField(valueLike) {
  const raw = String(valueLike ?? "").trim();
  if (FEATURE_SORT_FIELDS.has(raw)) return raw;
  return "updatedAt";
}

function normalizeSortOrder(valueLike) {
  const raw = String(valueLike ?? "").trim().toLowerCase();
  return raw === "asc" ? "asc" : "desc";
}

function normalizeEnabledFilter(valueLike) {
  const raw = String(valueLike ?? "").trim().toLowerCase();
  if (raw === "enabled" || raw === "true" || raw === "1") return "enabled";
  if (raw === "disabled" || raw === "false" || raw === "0") return "disabled";
  return "";
}

function buildSeedStore() {
  const ts = nowIso();
  return {
    version: 1,
    updatedAt: ts,
    seq: {
      feature: 4,
      version: 5,
      artifact: 1,
    },
    features: [
      {
        featureId: "feat_1",
        name: "ema_trend_gate",
        group: "trend",
        kind: "ema",
        description: "趋势过滤：仅在价格位于 EMA 上方（或下方）时开仓。",
        params: { period: 20 },
        enabled: true,
        source: "seed",
        createdAt: ts,
        updatedAt: ts,
      },
      {
        featureId: "feat_2",
        name: "adx_strength_filter",
        group: "trend",
        kind: "adx",
        description: "强度过滤：仅在 ADX 达到阈值时允许进场。",
        params: { period: 14, min: 20 },
        enabled: true,
        source: "seed",
        createdAt: ts,
        updatedAt: ts,
      },
      {
        featureId: "feat_3",
        name: "atr_risk_guard",
        group: "risk",
        kind: "atr",
        description: "风险保护：根据 ATR 动态设置止损和止盈。",
        params: { stopAtr: 1.2, tpAtr: 2.8 },
        enabled: true,
        source: "seed",
        createdAt: ts,
        updatedAt: ts,
      },
    ],
    versions: [
      {
        versionId: "ver_1",
        title: "v5 混合（回踩+再入）",
        status: "active",
        parentVersionId: null,
        score: 0.7165,
        evalSummary: "默认基线版本",
        source: "seed",
        strategy: {
          thesis: "趋势方向确认后，结合回踩与再入信号执行。",
          horizon: "intraday",
          riskLevel: "balanced",
          entry: "趋势同向 + 回踩确认或二次放量",
          riskControl: "ATR 止损 + notional 上下限",
          exit: "ATR 止盈或结构破坏",
          featureRefs: ["ema_trend_gate", "adx_strength_filter", "atr_risk_guard"],
        },
        createdAt: ts,
        updatedAt: ts,
      },
      {
        versionId: "ver_2",
        title: "v5 回踩确认",
        status: "draft",
        parentVersionId: "ver_1",
        score: 0.6842,
        evalSummary: "",
        source: "seed",
        strategy: {
          thesis: "优先控制回撤，等待回踩确认后入场。",
          horizon: "intraday",
          riskLevel: "conservative",
          entry: "EMA 同向 + 回踩反转",
          riskControl: "较紧 ATR 止损",
          exit: "固定风险收益比或趋势失效",
          featureRefs: ["ema_trend_gate", "adx_strength_filter"],
        },
        createdAt: ts,
        updatedAt: ts,
      },
      {
        versionId: "ver_3",
        title: "v5 趋势再入",
        status: "draft",
        parentVersionId: "ver_1",
        score: 0.6918,
        evalSummary: "",
        source: "seed",
        strategy: {
          thesis: "主趋势成立后等待二次发力再入场。",
          horizon: "intraday",
          riskLevel: "aggressive",
          entry: "趋势同向 + 动量再放量",
          riskControl: "分批仓位 + 时间止损",
          exit: "趋势反转或时间窗口结束",
          featureRefs: ["ema_trend_gate", "atr_risk_guard"],
        },
        createdAt: ts,
        updatedAt: ts,
      },
      {
        versionId: "ver_4",
        title: "v4 Donchian 突破",
        status: "draft",
        parentVersionId: null,
        score: 0.6584,
        evalSummary: "",
        source: "seed",
        strategy: {
          thesis: "通道突破入场，趋势衰减时退出。",
          horizon: "swing",
          riskLevel: "balanced",
          entry: "Donchian 上下轨突破",
          riskControl: "通道反向突破止损",
          exit: "回落通道中轴或触发 ATR 退出",
          featureRefs: ["atr_risk_guard"],
        },
        createdAt: ts,
        updatedAt: ts,
      },
    ],
    artifacts: [],
  };
}

function normalizeFeatureCandidate(rawLike = {}) {
  const raw = rawLike && typeof rawLike === "object" ? rawLike : {};
  const nameRaw = toText(raw.name || raw.featureId || raw.title || "");
  const name = slugify(nameRaw) || slugify(raw.description || "") || "";
  if (!name) return null;
  const group = pickEnum(raw.group, FEATURE_GROUPS, "custom");
  const kind = pickEnum(raw.kind, FEATURE_KINDS, "custom");
  const description = toText(raw.description || raw.summary || raw.note || "来自对话提案");
  const paramsRaw = raw.params && typeof raw.params === "object" ? raw.params : {};
  const params = {};
  Object.entries(paramsRaw)
    .slice(0, 16)
    .forEach(([k, v]) => {
      const key = slugify(k).replace(/-/g, "_");
      if (!key) return;
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        params[key] = v;
      }
    });
  return {
    name,
    group,
    kind,
    description,
    params,
    enabled: raw.enabled !== false,
  };
}

function normalizeStrategyCandidate(rawLike = {}) {
  const raw = rawLike && typeof rawLike === "object" ? rawLike : {};
  const title = toText(raw.title || raw.name || "对话策略候选");
  const thesis = toText(raw.thesis || raw.objective || raw.summary || "");
  const horizon = pickEnum(raw.horizon, STRATEGY_HORIZONS, "intraday");
  const riskLevel = pickEnum(raw.riskLevel || raw.risk, STRATEGY_RISK_LEVELS, "balanced");
  const entry = toText(raw.entry || raw.entryRule || "");
  const riskControl = toText(raw.riskControl || raw.riskRule || "");
  const exit = toText(raw.exit || raw.exitRule || "");
  const featureRefs = uniqStrings([
    ...(Array.isArray(raw.featureRefs) ? raw.featureRefs : []),
    ...(Array.isArray(raw.features)
      ? raw.features.map((item) => (typeof item === "string" ? item : toText(item?.name || item?.featureId || "")))
      : []),
  ]).slice(0, 12);
  const featuresRaw = Array.isArray(raw.features) ? raw.features : [];
  const features = featuresRaw
    .map((item) => normalizeFeatureCandidate(item))
    .filter(Boolean)
    .slice(0, 8);
  const dsl = raw.dsl && typeof raw.dsl === "object" ? raw.dsl : null;
  return {
    title,
    thesis,
    horizon,
    riskLevel,
    entry,
    riskControl,
    exit,
    featureRefs,
    features,
    dsl,
  };
}

function computeScore(metricsLike = {}) {
  const m = metricsLike && typeof metricsLike === "object" ? metricsLike : {};
  const winRate = clampNumber(m.winRate, 0, 100, 0);
  const netPnlPct = clampNumber(m.netPnlPct, -100, 300, 0);
  const maxDrawdownPct = clampNumber(m.maxDrawdownPct, 0, 100, 0);
  const sharpe = clampNumber(m.sharpe, -5, 10, 0);
  const profitFactor = clampNumber(m.profitFactor, 0, 10, 0);
  const tradeCount = clampNumber(m.tradeCount, 0, 50000, 0);

  const winNorm = winRate / 100;
  const pnlNorm = clampNumber((netPnlPct + 20) / 120, 0, 1, 0);
  const ddNorm = 1 - (maxDrawdownPct / 100);
  const sharpeNorm = clampNumber((sharpe + 1) / 4, 0, 1, 0);
  const pfNorm = clampNumber(profitFactor / 3, 0, 1, 0);
  const tradeNorm = clampNumber(tradeCount / 120, 0, 1, 0);

  const score = clampNumber(
    (winNorm * 0.40) +
      (pnlNorm * 0.28) +
      (ddNorm * 0.18) +
      (sharpeNorm * 0.08) +
      (pfNorm * 0.04) +
      (tradeNorm * 0.02),
    0,
    1,
    0,
  );
  return score;
}

function normalizeProvenanceMeta(metaLike = {}, fallbackSource = "chat_intent") {
  const meta = metaLike && typeof metaLike === "object" ? metaLike : {};
  const source = toText(meta.source || fallbackSource, fallbackSource);
  const conversationId = toText(meta.conversationId || meta.sessionId || "");
  const cardId = toText(meta.cardId || meta.candidateId || "");
  const eventIdNum = Number(meta.eventId);
  const eventId = Number.isFinite(eventIdNum) && eventIdNum > 0 ? Math.floor(eventIdNum) : null;
  const query = toText(meta.query || meta.userMessage || "");
  const reply = toText(meta.reply || meta.assistantReply || "");
  return {
    source,
    conversationId,
    cardId,
    eventId,
    query,
    reply,
  };
}

function applyProvenanceMeta(targetLike, metaLike, tsLike, fallbackSource = "chat_intent") {
  const target = targetLike && typeof targetLike === "object" ? targetLike : {};
  const ts = toText(tsLike || nowIso(), nowIso());
  const provenance = normalizeProvenanceMeta(metaLike, fallbackSource);
  target.source = toText(provenance.source || target.source || fallbackSource, fallbackSource);
  target.originQuery = toText(provenance.query || target.originQuery || "");
  target.originReply = toText(provenance.reply || target.originReply || "");
  if (provenance.conversationId) {
    target.originConversationId = provenance.conversationId;
  } else if (!toText(target.originConversationId)) {
    target.originConversationId = "thunderclaw-main";
  }
  if (provenance.eventId) target.originEventId = provenance.eventId;
  if (provenance.cardId) target.originCardId = provenance.cardId;

  const entry = {
    ts,
    source: target.source,
    conversationId: toText(target.originConversationId || ""),
    eventId: Number.isFinite(Number(target.originEventId)) ? Number(target.originEventId) : null,
    cardId: toText(target.originCardId || ""),
    query: toText(provenance.query || target.originQuery || "").slice(0, 260),
    reply: toText(provenance.reply || target.originReply || "").slice(0, 260),
  };
  const key = [
    entry.source,
    entry.conversationId,
    String(entry.eventId || ""),
    entry.cardId,
    entry.query,
  ].join("|");
  const trail = Array.isArray(target.originTrail) ? target.originTrail.slice(-20) : [];
  const exists = trail.some((item) => {
    const it = item && typeof item === "object" ? item : {};
    const itKey = [
      toText(it.source || ""),
      toText(it.conversationId || ""),
      String(Number.isFinite(Number(it.eventId)) ? Number(it.eventId) : ""),
      toText(it.cardId || ""),
      toText(it.query || ""),
    ].join("|");
    return itKey === key;
  });
  if (!exists) trail.push(entry);
  target.originTrail = trail.slice(-16);
  return target;
}

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
          item?.description,
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
      if (sortBy === "name" || sortBy === "group" || sortBy === "kind" || sortBy === "source") {
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
    const enabledCount = rows.filter((item) => item?.enabled !== false).length;
    return {
      groups,
      kinds,
      sources,
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
      existing.enabled = normalized.enabled !== false;
      applyProvenanceMeta(existing, metaLike, now, toText(existing.source || "chat_intent", "chat_intent"));
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
      enabled: normalized.enabled !== false,
      source: "chat_intent",
      originQuery: "",
      originReply: "",
      createdAt: now,
      updatedAt: now,
    };
    applyProvenanceMeta(item, metaLike, now, "chat_intent");
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
