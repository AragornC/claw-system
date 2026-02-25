import {
  FEATURE_TAXONOMY,
  MAIN_CATEGORY_CONFIG,
  TAG_CONFIG,
  OUTPUT_TYPE_CONFIG,
  buildFeatureProductProfile,
  buildFeatureVersionInfo,
} from "../domain/feature-taxonomy.js";

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
const FEATURE_SORT_FIELDS = new Set([
  "updatedAt",
  "createdAt",
  "name",
  "group",
  "kind",
  "source",
  "enabled",
  "mainCategory",
  "outputType",
]);

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
  let slug = "";
  let prevDash = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    const code = ch.charCodeAt(0);
    const isLower = code >= 97 && code <= 122;
    const isDigit = code >= 48 && code <= 57;
    if (isLower || isDigit) {
      slug += ch;
      prevDash = false;
    } else if (!prevDash) {
      slug += "-";
      prevDash = true;
    }
    if (slug.length >= 56) break;
  }
  while (slug.startsWith("-")) slug = slug.slice(1);
  while (slug.endsWith("-")) slug = slug.slice(0, -1);
  slug = slug.slice(0, 48);
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

function normalizeMainCategoryFilter(valueLike) {
  const raw = String(valueLike ?? "").trim().toLowerCase();
  if (!raw) return "";
  return MAIN_CATEGORY_CONFIG[raw] ? raw : "";
}

function normalizeTagFilter(valueLike) {
  const raw = String(valueLike ?? "").trim().toLowerCase();
  if (!raw) return "";
  return TAG_CONFIG[raw] ? raw : "";
}

function buildSeedStore() {
  const ts = nowIso();
  return {
    version: 3,
    updatedAt: ts,
    seq: {
      feature: 4,
      version: 5,
      artifact: 1,
      strategy: 1,
      strategyVersion: 1,
      audit: 1,
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
    strategies: [],
    strategyVersions: [],
    strategyAudits: [],
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
      const key = slugify(k).split("-").join("_");
      if (!key) return;
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        params[key] = v;
      }
    });
  const tags = uniqStrings(Array.isArray(raw.tags) ? raw.tags : []).slice(0, 3);
  const algorithmSteps = Array.isArray(raw.algorithmSteps)
    ? raw.algorithmSteps.map((v) => toText(v)).filter(Boolean).slice(0, 5)
    : [];
  const pseudoCode = Array.isArray(raw.pseudoCode)
    ? raw.pseudoCode.map((v) => toText(v)).filter(Boolean).slice(0, 16)
    : toText(raw.pseudoCode)
      ? [toText(raw.pseudoCode)]
      : [];
  const paramSpecs = Array.isArray(raw.paramSpecs)
    ? raw.paramSpecs
      .map((item) => {
        const row = item && typeof item === "object" ? item : {};
        return {
          name: toText(row.name || ""),
          defaultValue: row.defaultValue,
          type: toText(row.type || typeof row.defaultValue || "string"),
          note: toText(row.note || ""),
        };
      })
      .filter((item) => item.name)
      .slice(0, 20)
    : [];
  return {
    name,
    group,
    kind,
    description,
    params,
    mainCategory: toText(raw.mainCategory || ""),
    tags,
    displayMode: toText(raw.displayMode || ""),
    outputType: toText(raw.outputType || ""),
    usageSummary: toText(raw.usageSummary || ""),
    triggerLogic: toText(raw.triggerLogic || ""),
    algorithmSummary: toText(raw.algorithmSummary || ""),
    algorithmSteps,
    pseudoCode,
    paramSpecs,
    sourceType: toText(raw.sourceType || ""),
    createdBy: toText(raw.createdBy || raw.creator || ""),
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

function applyFeatureProductMeta(targetLike, metaLike = {}) {
  const target = targetLike && typeof targetLike === "object" ? targetLike : {};
  const meta = metaLike && typeof metaLike === "object" ? metaLike : {};
  const profile = buildFeatureProductProfile(target, {
    source: toText(meta.source || target.source || "chat_intent"),
    sourceType: toText(meta.sourceType || target.sourceType || meta.source || target.source || "chat_intent"),
    creator: toText(meta.creator || meta.createdBy || target.createdBy || "ThunderClaw"),
  });
  Object.assign(target, profile);
  target.versionInfo = buildFeatureVersionInfo(target, {
    bumpRevision: Boolean(meta.bumpRevision),
    versionNote: toText(meta.versionNote || ""),
  });
  return target;
}

function migrateStoreShape(storeLike) {
  const store = storeLike && typeof storeLike === "object" ? storeLike : buildSeedStore();
  let changed = false;
  if (!Number.isFinite(Number(store.version)) || Number(store.version) < 3) {
    store.version = 3;
    changed = true;
  }
  if (!Array.isArray(store.features)) {
    store.features = [];
    changed = true;
  }
  store.features.forEach((item) => {
    if (!item || typeof item !== "object") return;
    const mainCategoryBefore = toText(item.mainCategory || "");
    const displayModeBefore = toText(item.displayMode || "");
    const outputTypeBefore = toText(item.outputType || "");
    const tagsBefore = JSON.stringify(Array.isArray(item.tags) ? item.tags : []);
    const versionBefore = JSON.stringify(item.versionInfo && typeof item.versionInfo === "object" ? item.versionInfo : {});
    applyFeatureProductMeta(item, {
      source: toText(item.source || "chat_intent"),
      sourceType: toText(item.sourceType || item.source || "chat_intent"),
      creator: toText(item.createdBy || "ThunderClaw"),
      bumpRevision: false,
    });
    if (!Array.isArray(item.originTrail)) {
      item.originTrail = [];
      changed = true;
    }
    if (
      mainCategoryBefore !== toText(item.mainCategory || "")
      || displayModeBefore !== toText(item.displayMode || "")
      || outputTypeBefore !== toText(item.outputType || "")
      || tagsBefore !== JSON.stringify(Array.isArray(item.tags) ? item.tags : [])
      || versionBefore !== JSON.stringify(item.versionInfo && typeof item.versionInfo === "object" ? item.versionInfo : {})
    ) {
      changed = true;
    }
  });
  return changed;
}

export {
  FEATURE_GROUPS,
  FEATURE_KINDS,
  STRATEGY_HORIZONS,
  STRATEGY_RISK_LEVELS,
  clampNumber,
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
  normalizeProvenanceMeta,
  applyProvenanceMeta,
  applyFeatureProductMeta,
  migrateStoreShape,
};
