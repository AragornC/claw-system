const STRATEGY_STATUS_LABELS = {
  draft: "草稿",
  backtested: "已回测",
  paper_live: "模拟中",
  live: "实盘中",
  paused: "已暂停",
  risk_paused: "风控暂停",
};

const STRATEGY_RUNTIME_ENV_BY_STATUS = {
  draft: "backtest",
  backtested: "backtest",
  paper_live: "paper",
  live: "live",
  paused: "paper",
  risk_paused: "live",
};

const STRATEGY_RUNTIME_ENV_LABELS = {
  backtest: "回测",
  paper: "模拟",
  live: "实盘",
};

const STRATEGY_STATUS_TRANSITIONS = {
  draft: new Set(["draft", "backtested", "paused"]),
  backtested: new Set(["draft", "backtested", "paper_live", "live", "paused"]),
  paper_live: new Set(["paper_live", "paused", "risk_paused", "live"]),
  live: new Set(["live", "paused", "risk_paused"]),
  paused: new Set(["paused", "paper_live", "live", "backtested"]),
  risk_paused: new Set(["risk_paused", "paused", "paper_live", "live"]),
};

const STRATEGY_SORT_FIELDS = new Set(["updatedAt", "latestReturnPct", "maxDrawdownPct", "name", "status"]);
const STRATEGY_TRADE_TYPES = new Set(["all", "buy_sell", "position_change", "risk_trigger"]);

const TRADE_TYPE_LABELS = {
  buy: "买入",
  sell: "卖出",
  add: "加仓",
  reduce: "减仓",
  close: "平仓",
  risk_trigger: "风控触发",
};

function text(valueLike, fallback = "") {
  const s = String(valueLike ?? "").trim();
  return s || fallback;
}

function number(valueLike, fallback = 0) {
  const n = Number(valueLike);
  return Number.isFinite(n) ? n : Number(fallback || 0);
}

function clamp(valueLike, min, max, fallback = 0) {
  const n = number(valueLike, fallback);
  if (Number.isFinite(min) && n < min) return min;
  if (Number.isFinite(max) && n > max) return max;
  return n;
}

function toLowerText(valueLike, fallback = "") {
  return text(valueLike, fallback).toLowerCase();
}

function normalizeStatus(statusLike, fallback = "draft") {
  const raw = toLowerText(statusLike);
  if (STRATEGY_STATUS_LABELS[raw]) return raw;
  return STRATEGY_STATUS_LABELS[fallback] ? fallback : "draft";
}

function normalizeRuntimeEnv(statusLike, runtimeEnvLike) {
  const status = normalizeStatus(statusLike);
  const envRaw = toLowerText(runtimeEnvLike);
  if (envRaw === "backtest" || envRaw === "paper" || envRaw === "live") return envRaw;
  return STRATEGY_RUNTIME_ENV_BY_STATUS[status] || "backtest";
}

function canTransitionStatus(fromLike, toLike) {
  const from = normalizeStatus(fromLike);
  const to = normalizeStatus(toLike);
  const allowed = STRATEGY_STATUS_TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.has(to);
}

function normalizeSortField(fieldLike) {
  const raw = text(fieldLike, "updatedAt");
  return STRATEGY_SORT_FIELDS.has(raw) ? raw : "updatedAt";
}

function normalizeSortOrder(orderLike) {
  const raw = toLowerText(orderLike, "desc");
  return raw === "asc" ? "asc" : "desc";
}

function normalizeRangeDays(daysLike) {
  const n = Math.floor(number(daysLike, 30));
  if (n <= 0) return 30;
  if (n > 365) return 365;
  return n;
}

function normalizeTradeType(typeLike) {
  const raw = toLowerText(typeLike, "all");
  return STRATEGY_TRADE_TYPES.has(raw) ? raw : "all";
}

function toFeatureRefKey(valueLike) {
  const raw = toLowerText(valueLike);
  if (!raw) return "";
  let out = "";
  let prevSep = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    const code = ch.charCodeAt(0);
    const isAlpha = code >= 97 && code <= 122;
    const isDigit = code >= 48 && code <= 57;
    if (isAlpha || isDigit) {
      out += ch;
      prevSep = false;
    } else if (!prevSep) {
      out += "_";
      prevSep = true;
    }
  }
  while (out.startsWith("_")) out = out.slice(1);
  while (out.endsWith("_")) out = out.slice(0, -1);
  return out.slice(0, 64);
}

function normalizeFeatureRefs(featureRefsLike) {
  const rows = Array.isArray(featureRefsLike) ? featureRefsLike : [];
  const seen = new Set();
  const out = [];
  rows.forEach((item) => {
    const raw = typeof item === "string"
      ? item
      : (item && typeof item === "object"
        ? (item.featureId || item.featureName || item.name || item.ref || "")
        : "");
    const key = toFeatureRefKey(raw);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(key);
  });
  return out.slice(0, 32);
}

function normalizeSignalLayer(rawLike = {}) {
  const raw = rawLike && typeof rawLike === "object" ? rawLike : {};
  const params = raw.params && typeof raw.params === "object" ? raw.params : {};
  const safeParams = {};
  Object.entries(params).slice(0, 32).forEach(([k, v]) => {
    const key = text(k);
    if (!key) return;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      safeParams[key] = v;
    }
  });
  return {
    featureRefs: normalizeFeatureRefs(raw.featureRefs || raw.features || []),
    signalLogic: text(raw.signalLogic || raw.logic || "多信号加权 + 过滤门控"),
    params: safeParams,
  };
}

function normalizePositionLayer(rawLike = {}) {
  const raw = rawLike && typeof rawLike === "object" ? rawLike : {};
  return {
    mode: text(raw.mode || "risk_cap", "risk_cap"),
    maxPositions: Math.max(1, Math.floor(number(raw.maxPositions, 1))),
    maxExposurePct: clamp(raw.maxExposurePct, 1, 100, 35),
    minNotional: clamp(raw.minNotional, 1, 1_000_000, 10),
    maxNotional: clamp(raw.maxNotional, 1, 2_000_000, 80),
    leverageLimit: clamp(raw.leverageLimit, 1, 125, 10),
  };
}

function normalizeRiskLayer(rawLike = {}) {
  const raw = rawLike && typeof rawLike === "object" ? rawLike : {};
  return {
    stopLossPct: clamp(raw.stopLossPct, 0.1, 80, 2.5),
    takeProfitPct: clamp(raw.takeProfitPct, 0.1, 400, 5.5),
    maxDrawdownPct: clamp(raw.maxDrawdownPct, 0.1, 95, 18),
    frequencyLimitPerDay: Math.max(1, Math.floor(number(raw.frequencyLimitPerDay, 12))),
    maxConsecutiveLoss: Math.max(1, Math.floor(number(raw.maxConsecutiveLoss, 3))),
    riskPauseCondition: text(raw.riskPauseCondition || "连续亏损达到上限自动暂停"),
  };
}

function normalizeExecutionLayer(rawLike = {}) {
  const raw = rawLike && typeof rawLike === "object" ? rawLike : {};
  return {
    orderMode: text(raw.orderMode || "market", "market"),
    slippageBps: clamp(raw.slippageBps, 0, 300, 6),
    feeModel: text(raw.feeModel || "taker", "taker"),
    retryCount: Math.max(0, Math.floor(number(raw.retryCount, 2))),
    retryBackoffMs: Math.max(0, Math.floor(number(raw.retryBackoffMs, 400))),
  };
}

function buildStrategyDraftPayload(rawLike = {}) {
  const raw = rawLike && typeof rawLike === "object" ? rawLike : {};
  return {
    signalLayer: normalizeSignalLayer(raw.signalLayer || {
      featureRefs: raw.featureRefs || [],
      signalLogic: raw.entry || raw.signalLogic || "",
      params: raw.params || {},
    }),
    positionLayer: normalizePositionLayer(raw.positionLayer || raw.position || {}),
    riskLayer: normalizeRiskLayer(raw.riskLayer || {
      riskPauseCondition: raw.riskControl || "",
    }),
    executionLayer: normalizeExecutionLayer(raw.executionLayer || raw.execution || {}),
    notes: text(raw.notes || raw.description || ""),
  };
}

function buildFeatureLookup(featuresLike = []) {
  const rows = Array.isArray(featuresLike) ? featuresLike : [];
  const byKey = new Map();
  rows.forEach((item) => {
    if (!item || typeof item !== "object") return;
    const idKey = toFeatureRefKey(item.featureId || item.id || "");
    const nameKey = toFeatureRefKey(item.name || item.featureName || "");
    if (idKey) byKey.set(idKey, item);
    if (nameKey) byKey.set(nameKey, item);
  });
  return byKey;
}

function lockFeatureVersions(featureRefsLike, featureLookupLike) {
  const refs = normalizeFeatureRefs(featureRefsLike);
  const lookup = featureLookupLike instanceof Map ? featureLookupLike : new Map();
  const out = [];
  refs.forEach((ref) => {
    const item = lookup.get(toFeatureRefKey(ref));
    if (item && typeof item === "object") {
      const versionInfo = item.versionInfo && typeof item.versionInfo === "object" ? item.versionInfo : {};
      out.push({
        featureId: text(item.featureId || item.id || ref),
        featureName: text(item.name || item.featureName || ref),
        featureVersion: text(versionInfo.version || "v1.0.0"),
        featureRevision: Math.max(1, Math.floor(number(versionInfo.revision, 1))),
      });
      return;
    }
    out.push({
      featureId: ref,
      featureName: ref,
      featureVersion: "v1.0.0",
      featureRevision: 1,
    });
  });
  return out;
}

function buildSampleExecutionReport(optionsLike = {}) {
  const options = optionsLike && typeof optionsLike === "object" ? optionsLike : {};
  const nowSec = Math.floor(Date.now() / 1000);
  const days = normalizeRangeDays(options.days || 30);
  const points = Math.max(60, Math.min(1800, days * 24));
  const stepSec = Math.max(900, Math.floor(number(options.stepSec, 3600)));
  const startSec = nowSec - points * stepSec;
  const equityCurve = [];
  const drawdownCurve = [];
  const events = [];
  let equity = 1;
  let peak = 1;
  const eventStep = Math.max(12, Math.floor(points / 22));
  const typeOrder = ["buy", "add", "sell", "reduce", "close", "risk_trigger"];
  for (let i = 0; i < points; i += 1) {
    const t = startSec + i * stepSec;
    const drift = Math.sin(i / 11) * 0.0023 + Math.cos(i / 17) * 0.0014 + (i % 43 === 0 ? 0.006 : -0.0002);
    equity = Math.max(0.3, equity * (1 + drift));
    peak = Math.max(peak, equity);
    const dd = peak <= 0 ? 0 : Math.max(0, (peak - equity) / peak);
    equityCurve.push({ time: t, equity: Number(equity.toFixed(6)) });
    drawdownCurve.push({ time: t, drawdownPct: Number((dd * 100).toFixed(4)) });
    if (i > 0 && i % eventStep === 0) {
      const eventType = typeOrder[Math.floor(i / eventStep) % typeOrder.length];
      const price = 52000 + Math.sin(i / 7) * 1200 + Math.cos(i / 16) * 700;
      const qty = 0.01 + (Math.abs(Math.sin(i / 9)) * 0.04);
      const fee = Number((price * qty * 0.0006).toFixed(4));
      events.push({
        tradeId: "tr_" + String(i),
        time: t,
        tradeType: eventType,
        price: Number(price.toFixed(2)),
        quantity: Number(qty.toFixed(5)),
        fee: fee,
        slippageBps: Number((3 + Math.abs(Math.cos(i / 13)) * 6).toFixed(2)),
        reasonRule: eventType === "risk_trigger"
          ? "risk.max_drawdown"
          : (eventType === "buy" || eventType === "add" ? "signal.trend_gate" : "signal.exit_rule"),
        pnlPct: Number((Math.sin(i / 10) * 1.8).toFixed(3)),
      });
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    timeframeDays: days,
    events,
    equityCurve,
    drawdownCurve,
  };
}

function filterExecutionReport(reportLike, optionsLike = {}) {
  const report = reportLike && typeof reportLike === "object" ? reportLike : {};
  const options = optionsLike && typeof optionsLike === "object" ? optionsLike : {};
  const rangeDays = normalizeRangeDays(options.rangeDays || 30);
  const tradeType = normalizeTradeType(options.tradeType || "all");
  const nowSec = Math.floor(Date.now() / 1000);
  const fromSec = nowSec - rangeDays * 86400;
  const rows = Array.isArray(report.events) ? report.events : [];
  const include = function includeTradeType(eventTypeLike) {
    const eventType = toLowerText(eventTypeLike);
    if (tradeType === "all") return true;
    if (tradeType === "buy_sell") return eventType === "buy" || eventType === "sell" || eventType === "close";
    if (tradeType === "position_change") return eventType === "add" || eventType === "reduce";
    if (tradeType === "risk_trigger") return eventType === "risk_trigger";
    return true;
  };
  const events = rows
    .filter((item) => number(item?.time, 0) >= fromSec)
    .filter((item) => include(item?.tradeType))
    .slice(-600);
  const equityCurve = (Array.isArray(report.equityCurve) ? report.equityCurve : [])
    .filter((item) => number(item?.time, 0) >= fromSec)
    .slice(-2400);
  const drawdownCurve = (Array.isArray(report.drawdownCurve) ? report.drawdownCurve : [])
    .filter((item) => number(item?.time, 0) >= fromSec)
    .slice(-2400);
  return {
    report: {
      generatedAt: text(report.generatedAt || ""),
      timeframeDays: rangeDays,
      events,
      equityCurve,
      drawdownCurve,
    },
    rangeDays,
    tradeType,
  };
}

export {
  STRATEGY_STATUS_LABELS,
  STRATEGY_RUNTIME_ENV_BY_STATUS,
  STRATEGY_RUNTIME_ENV_LABELS,
  STRATEGY_STATUS_TRANSITIONS,
  STRATEGY_SORT_FIELDS,
  STRATEGY_TRADE_TYPES,
  TRADE_TYPE_LABELS,
  normalizeStatus,
  normalizeRuntimeEnv,
  canTransitionStatus,
  normalizeSortField,
  normalizeSortOrder,
  normalizeRangeDays,
  normalizeTradeType,
  normalizeFeatureRefs,
  normalizeSignalLayer,
  normalizePositionLayer,
  normalizeRiskLayer,
  normalizeExecutionLayer,
  buildStrategyDraftPayload,
  buildFeatureLookup,
  lockFeatureVersions,
  buildSampleExecutionReport,
  filterExecutionReport,
};
