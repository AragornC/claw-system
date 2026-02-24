const MAIN_CATEGORY_CONFIG = {
  trend: { key: "trend", label: "趋势类", displayMode: "trend_overlay" },
  momentum: { key: "momentum", label: "动量类", displayMode: "momentum_oscillator" },
  volatility: { key: "volatility", label: "波动类", displayMode: "volatility_risk" },
  volume: { key: "volume", label: "成交量类", displayMode: "volume_highlight" },
  structure: { key: "structure", label: "结构类", displayMode: "structure_levels" },
  risk: { key: "risk", label: "风控类", displayMode: "risk_panel" },
};

const TAG_CONFIG = {
  entry: { key: "entry", label: "入场" },
  exit: { key: "exit", label: "出场" },
  filter: { key: "filter", label: "过滤" },
  breakout: { key: "breakout", label: "突破" },
  reversal: { key: "reversal", label: "反转" },
  position: { key: "position", label: "仓位" },
  range: { key: "range", label: "震荡" },
  trend_continuation: { key: "trend_continuation", label: "趋势延续" },
};

const OUTPUT_TYPE_CONFIG = {
  boolean: { key: "boolean", label: "布尔" },
  continuous: { key: "continuous", label: "连续" },
  score: { key: "score", label: "评分" },
};

const KIND_PROFILE = {
  ema: {
    mainCategory: "trend",
    tags: ["filter", "trend_continuation"],
    outputType: "continuous",
    usageSummary: "用于识别价格是否处于顺势区间。",
    triggerLogic: "收盘价与EMA相对位置触发通过/过滤。",
    algorithmSummary: "EMA 对收盘价做指数加权平滑，近期价格权重更高。",
    algorithmSteps: [
      "读取最新 N 根 K 线收盘价序列。",
      "初始化首个 EMA 值为首根收盘价。",
      "按 alpha=2/(N+1) 逐根递推 EMA。",
      "输出当前 EMA 值用于趋势门控。",
    ],
    pseudoCode: [
      "ema = close[0]",
      "alpha = 2 / (period + 1)",
      "for each close_t in closes[1:]:",
      "  ema = ema + alpha * (close_t - ema)",
      "return ema",
    ],
  },
  sma: {
    mainCategory: "trend",
    tags: ["filter", "trend_continuation"],
    outputType: "continuous",
    usageSummary: "用于平滑价格并判断中短期方向。",
    triggerLogic: "收盘价高于/低于 SMA 时给出顺势倾向。",
    algorithmSummary: "SMA 对窗口内收盘价做等权平均。",
    algorithmSteps: [
      "读取最近 N 根收盘价。",
      "窗口内求和并除以 N。",
      "滚动更新窗口并重复计算。",
      "输出最新 SMA 值用于判断方向。",
    ],
    pseudoCode: [
      "window = closes[-period:]",
      "sma = sum(window) / period",
      "return sma",
    ],
  },
  rsi: {
    mainCategory: "momentum",
    tags: ["entry", "reversal", "range"],
    outputType: "score",
    usageSummary: "用于判断动量强弱与超买超卖状态。",
    triggerLogic: "RSI 低于阈值偏多，高于阈值偏空，中间区间观望。",
    algorithmSummary: "RSI 通过上涨/下跌平均幅度比值衡量动量。",
    algorithmSteps: [
      "计算每根收盘价变化值。",
      "拆分为上涨幅度与下跌幅度序列。",
      "计算平均涨跌幅并求 RS。",
      "按 RSI=100-100/(1+RS) 输出评分。",
    ],
    pseudoCode: [
      "delta = close_t - close_{t-1}",
      "gain = max(delta, 0), loss = max(-delta, 0)",
      "avgGain, avgLoss = wilderSmooth(gain/loss, period)",
      "rs = avgGain / max(avgLoss, eps)",
      "rsi = 100 - 100 / (1 + rs)",
    ],
  },
  adx: {
    mainCategory: "momentum",
    tags: ["filter", "trend_continuation"],
    outputType: "score",
    usageSummary: "用于判断趋势强度，过滤震荡区间信号。",
    triggerLogic: "ADX 高于阈值视为趋势有效，低于阈值偏震荡。",
    algorithmSummary: "ADX 对方向性指标差值做平滑，输出趋势强度评分。",
    algorithmSteps: [
      "由高低价计算 +DM 与 -DM。",
      "计算 TR 并平滑得到 ATR 基础。",
      "计算 +DI、-DI 与 DX。",
      "对 DX 再平滑得到 ADX。",
    ],
    pseudoCode: [
      "plusDM, minusDM, tr = buildDMTR(high, low, close)",
      "plusDI, minusDI = smoothDI(plusDM, minusDM, tr, period)",
      "dx = abs(plusDI - minusDI) / max(plusDI + minusDI, eps) * 100",
      "adx = wilderSmooth(dx, period)",
    ],
  },
  atr: {
    mainCategory: "volatility",
    tags: ["filter", "position", "exit"],
    outputType: "continuous",
    usageSummary: "用于衡量波动并驱动止损止盈/仓位尺度。",
    triggerLogic: "ATR 越高，风险半径与止损距离越大。",
    algorithmSummary: "ATR 通过真实波幅 TR 的平滑得到波动率。",
    algorithmSteps: [
      "逐根计算 TR=max(高低差,高-前收,低-前收)。",
      "对 TR 做 Wilder 平滑。",
      "输出 ATR 作为风险尺度。",
      "结合倍数系数生成风控距离。",
    ],
    pseudoCode: [
      "tr = max(high-low, abs(high-prevClose), abs(low-prevClose))",
      "atr = wilderSmooth(tr, period)",
      "stopDistance = atr * stopAtr",
    ],
  },
  volume: {
    mainCategory: "volume",
    tags: ["breakout", "filter"],
    outputType: "continuous",
    usageSummary: "用于识别放量突破或缩量衰竭。",
    triggerLogic: "当前成交量与均量比值超过阈值触发信号确认。",
    algorithmSummary: "成交量均线与当前成交量比值用于判定量能状态。",
    algorithmSteps: [
      "读取成交量序列。",
      "计算 N 周期均量。",
      "计算当前量/均量比值。",
      "根据比值区间输出量能标签。",
    ],
    pseudoCode: [
      "volMA = sma(volume, period)",
      "ratio = volume_t / max(volMA_t, eps)",
      "signal = ratio >= threshold",
    ],
  },
  price_action: {
    mainCategory: "structure",
    tags: ["breakout", "reversal", "entry"],
    outputType: "boolean",
    usageSummary: "用于识别关键位突破/回踩等结构行为。",
    triggerLogic: "价格在关键位上方确认突破或下方失效触发。",
    algorithmSummary: "基于关键价位与收盘确认规则识别结构形态。",
    algorithmSteps: [
      "提取最近窗口高低点作为关键位。",
      "比较当前收盘与关键位关系。",
      "判断是否满足突破/回踩确认。",
      "输出结构触发布尔结果。",
    ],
    pseudoCode: [
      "level = max(high[-lookback:])",
      "isBreakout = close_t > level",
      "isRetest = low_t <= level and close_t > level",
      "signal = isBreakout or isRetest",
    ],
  },
  risk_rule: {
    mainCategory: "risk",
    tags: ["position", "exit", "filter"],
    outputType: "boolean",
    usageSummary: "用于统一风控状态和下单许可控制。",
    triggerLogic: "风控规则任一触发时禁止开仓或强制减仓。",
    algorithmSummary: "将风控阈值映射为状态机，输出开仓许可。",
    algorithmSteps: [
      "读取当前仓位、回撤、波动等风险输入。",
      "按规则阈值计算风险等级。",
      "判定是否允许开仓与是否需要减仓。",
      "输出风控状态布尔/等级值。",
    ],
    pseudoCode: [
      "if drawdown > maxDD: allowOpen = false",
      "if exposure > maxExposure: reducePosition = true",
      "riskState = buildRiskState(allowOpen, reducePosition)",
    ],
  },
  custom: {
    mainCategory: "structure",
    tags: ["filter"],
    outputType: "score",
    usageSummary: "用于承载对话生成的自定义特征逻辑。",
    triggerLogic: "按特征参数动态计算并输出评分或布尔状态。",
    algorithmSummary: "自定义特征由结构化参数驱动执行。",
    algorithmSteps: [
      "加载特征配置参数。",
      "读取当前市场状态输入。",
      "按规则组合计算特征值。",
      "输出可用于策略决策的结果。",
    ],
    pseudoCode: [
      "state = readMarketState()",
      "value = computeCustomFeature(state, params)",
      "return value",
    ],
  },
};

function toText(valueLike, fallback = "") {
  const s = String(valueLike ?? "").trim();
  return s || fallback;
}

function normalizeKey(valueLike) {
  return toText(valueLike).toLowerCase();
}

function uniqStrings(valuesLike) {
  const rows = Array.isArray(valuesLike) ? valuesLike : [];
  const set = new Set();
  rows.forEach((item) => {
    const v = toText(item);
    if (v) set.add(v);
  });
  return Array.from(set);
}

function normalizeMainCategory(valueLike, fallback = "trend") {
  const key = normalizeKey(valueLike);
  if (MAIN_CATEGORY_CONFIG[key]) return key;
  return fallback;
}

function normalizeFeatureTags(valuesLike, fallbackLike = []) {
  const normalized = uniqStrings(valuesLike)
    .map((v) => normalizeKey(v))
    .filter((v) => TAG_CONFIG[v])
    .slice(0, 3);
  if (normalized.length) return normalized;
  const fallback = uniqStrings(fallbackLike)
    .map((v) => normalizeKey(v))
    .filter((v) => TAG_CONFIG[v])
    .slice(0, 3);
  return fallback.length ? fallback : ["filter"];
}

function normalizeOutputType(valueLike, fallback = "continuous") {
  const key = normalizeKey(valueLike);
  if (OUTPUT_TYPE_CONFIG[key]) return key;
  return fallback;
}

function inferMainCategoryFromGroup(groupLike, fallback = "structure") {
  const group = normalizeKey(groupLike);
  const mapping = {
    trend: "trend",
    momentum: "momentum",
    volatility: "volatility",
    volume: "volume",
    structure: "structure",
    risk: "risk",
    execution: "risk",
    custom: "structure",
  };
  return mapping[group] || fallback;
}

function resolveKindProfile(kindLike, groupLike) {
  const kind = normalizeKey(kindLike);
  const profile = KIND_PROFILE[kind];
  if (profile) return { ...profile, kind: kind };
  const inferredCategory = inferMainCategoryFromGroup(groupLike, "structure");
  return {
    ...KIND_PROFILE.custom,
    mainCategory: inferredCategory,
    kind: kind || "custom",
  };
}

function normalizeParamSpecs(paramsLike) {
  const params = paramsLike && typeof paramsLike === "object" ? paramsLike : {};
  const specs = [];
  Object.entries(params)
    .slice(0, 16)
    .forEach(([key, value]) => {
      const name = toText(key);
      if (!name) return;
      specs.push({
        name,
        defaultValue: typeof value === "number"
          ? Number(value)
          : typeof value === "boolean"
            ? Boolean(value)
            : toText(value),
        type: typeof value,
        note: "",
      });
    });
  return specs;
}

function buildFeatureProductProfile(featureLike = {}, metaLike = {}) {
  const feature = featureLike && typeof featureLike === "object" ? featureLike : {};
  const meta = metaLike && typeof metaLike === "object" ? metaLike : {};
  const profile = resolveKindProfile(feature.kind, feature.group);
  const mainCategory = normalizeMainCategory(
    feature.mainCategory || profile.mainCategory || inferMainCategoryFromGroup(feature.group),
    profile.mainCategory || "trend",
  );
  const tags = normalizeFeatureTags(feature.tags, profile.tags || []);
  const categoryConfig = MAIN_CATEGORY_CONFIG[mainCategory] || MAIN_CATEGORY_CONFIG.trend;
  const outputType = normalizeOutputType(feature.outputType, profile.outputType || "continuous");
  const usageSummary = toText(feature.usageSummary || profile.usageSummary || "用于策略决策。");
  const triggerLogic = toText(feature.triggerLogic || profile.triggerLogic || "满足条件时触发。");
  const algorithmSummary = toText(feature.algorithmSummary || profile.algorithmSummary || "按结构化规则计算。");
  const algorithmSteps = Array.isArray(feature.algorithmSteps)
    ? feature.algorithmSteps.map((v) => toText(v)).filter(Boolean).slice(0, 5)
    : [];
  const stepsFinal = algorithmSteps.length
    ? algorithmSteps
    : (Array.isArray(profile.algorithmSteps) ? profile.algorithmSteps.slice(0, 5) : []);
  const pseudoCodeLines = Array.isArray(feature.pseudoCode)
    ? feature.pseudoCode.map((v) => toText(v)).filter(Boolean)
    : toText(feature.pseudoCode)
      ? [toText(feature.pseudoCode)]
      : [];
  const pseudoCode = pseudoCodeLines.length
    ? pseudoCodeLines
    : (Array.isArray(profile.pseudoCode) ? profile.pseudoCode.slice() : []);
  const displayMode = toText(feature.displayMode || categoryConfig.displayMode || "trend_overlay");
  const paramSpecs = Array.isArray(feature.paramSpecs) && feature.paramSpecs.length
    ? feature.paramSpecs.slice(0, 20)
    : normalizeParamSpecs(feature.params);
  const sourceType = toText(feature.sourceType || meta.sourceType || meta.source || "chat_intent");
  const createdBy = toText(feature.createdBy || meta.creator || meta.createdBy || "ThunderClaw");
  return {
    mainCategory,
    tags,
    displayMode,
    outputType,
    usageSummary,
    triggerLogic,
    algorithmSummary,
    algorithmSteps: stepsFinal,
    pseudoCode,
    paramSpecs,
    sourceType,
    createdBy,
  };
}

function buildFeatureVersionInfo(featureLike = {}, metaLike = {}) {
  const feature = featureLike && typeof featureLike === "object" ? featureLike : {};
  const meta = metaLike && typeof metaLike === "object" ? metaLike : {};
  const prev = feature.versionInfo && typeof feature.versionInfo === "object" ? feature.versionInfo : {};
  const revision = Number.isFinite(Number(prev.revision))
    ? Math.max(1, Number(prev.revision))
    : 1;
  const nextRevision = meta.bumpRevision ? revision + 1 : revision;
  const major = Number.isFinite(Number(prev.major)) ? Math.max(1, Number(prev.major)) : 1;
  const minor = Number.isFinite(Number(prev.minor)) ? Math.max(0, Number(prev.minor)) : 0;
  const patch = Math.max(0, nextRevision - 1);
  return {
    major,
    minor,
    patch,
    revision: nextRevision,
    version: `v${major}.${minor}.${patch}`,
    notes: toText(meta.versionNote || prev.notes || ""),
  };
}

export const FEATURE_TAXONOMY = {
  mainCategories: MAIN_CATEGORY_CONFIG,
  tags: TAG_CONFIG,
  outputTypes: OUTPUT_TYPE_CONFIG,
  kindProfiles: KIND_PROFILE,
};

export {
  MAIN_CATEGORY_CONFIG,
  TAG_CONFIG,
  OUTPUT_TYPE_CONFIG,
  KIND_PROFILE,
  normalizeMainCategory,
  normalizeFeatureTags,
  normalizeOutputType,
  buildFeatureProductProfile,
  buildFeatureVersionInfo,
};
