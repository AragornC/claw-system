import { toText } from "../../lib/utils.js";

function sanitizeName(valueLike, fallback = "custom_feature") {
  const value = toText(valueLike, fallback).toLowerCase().replace(/[^a-z0-9_]/g, "_");
  return value || fallback;
}

function normalizeStringList(itemsLike, limit = 8) {
  return (Array.isArray(itemsLike) ? itemsLike : [])
    .map((item) => toText(item, ""))
    .filter(Boolean)
    .slice(0, limit);
}

function pickFiniteNumber(...values) {
  for (const value of values) {
    const num = Number(value);
    if (Number.isFinite(num)) return num;
  }
  return null;
}

function familyFromFeature(featureLike = {}) {
  const feature = featureLike && typeof featureLike === "object" ? featureLike : {};
  const haystack = [
    toText(feature.kind, ""),
    toText(feature.name, ""),
    toText(feature.description, ""),
    toText(feature.indicatorLogic, ""),
    toText(feature.entryCondition, ""),
    toText(feature.exitCondition, ""),
  ].join(" ").toLowerCase();
  if (/(ema|sma|trend|cross|golden|death)/.test(haystack)) return "trend";
  if (/(rsi|stoch|oscillat|mfi|willr|cci)/.test(haystack)) return "oscillator";
  if (/(atr|volatility|boll|bandwidth|variance|risk)/.test(haystack)) return "volatility";
  if (/(volume|turnover|成交量|异常量)/.test(haystack)) return "volume";
  if (/(momentum|mom|roc|return|impulse)/.test(haystack)) return "momentum";
  return "custom";
}

export function detectTemplateRoute(featureLike = {}, specArtifactLike = null) {
  const feature = featureLike && typeof featureLike === "object" ? featureLike : {};
  const specArtifact = specArtifactLike && typeof specArtifactLike === "object" ? specArtifactLike : null;
  const haystack = [
    toText(feature.kind, ""),
    toText(feature.name, ""),
    toText(feature.description, ""),
    toText(specArtifact?.summary, ""),
    toText(specArtifact?.coreSignal, ""),
  ].join(" ").toLowerCase();
  const checks = [
    { templateId: "ema_crossover", family: "trend", re: /(ema).*(cross|crossover|golden|death)|((golden|death).*(cross|ema))/ },
    { templateId: "rsi_oscillator", family: "oscillator", re: /rsi|relative strength/ },
    { templateId: "atr_filter", family: "volatility", re: /atr|volatility/ },
    { templateId: "bollinger_width", family: "volatility", re: /boll|bandwidth/ },
    { templateId: "trend_filter", family: "trend", re: /trend filter|趋势过滤|trend/ },
    { templateId: "volume_spike", family: "volume", re: /volume|成交量|spike/ },
    { templateId: "momentum_signal", family: "momentum", re: /momentum|mom|roc/ },
  ];
  for (const item of checks) {
    if (item.re.test(haystack)) {
      return { route: "template", templateId: item.templateId, family: item.family, confidence: 0.88 };
    }
  }
  return { route: "custom", templateId: "", family: familyFromFeature(feature), confidence: 0.45 };
}

function inferSpecOutput(featureLike = {}, routeLike = null) {
  const route = routeLike && typeof routeLike === "object" ? routeLike : detectTemplateRoute(featureLike);
  const params = featureLike?.params && typeof featureLike.params === "object" ? featureLike.params : {};
  if (route.templateId === "rsi_oscillator") {
    return { outputType: "bounded_oscillator", outputRange: { min: 0, max: 100 } };
  }
  if (route.templateId === "atr_filter" || route.templateId === "bollinger_width") {
    return { outputType: "continuous_non_negative", outputRange: { min: 0, max: null } };
  }
  if (route.templateId === "trend_filter") {
    return { outputType: "categorical", outputRange: { min: -1, max: 1 } };
  }
  if (route.templateId === "volume_spike") {
    return { outputType: "continuous_non_negative", outputRange: { min: 0, max: null } };
  }
  if (route.templateId === "momentum_signal") {
    return { outputType: "continuous_bounded", outputRange: { min: -1, max: 1 } };
  }
  if (route.templateId === "ema_crossover") {
    return {
      outputType: params.binaryOutput ? "categorical" : "continuous_bounded",
      outputRange: params.binaryOutput ? { min: -1, max: 1 } : { min: -1, max: 1 },
    };
  }
  return { outputType: "continuous", outputRange: { min: null, max: null } };
}

function inferInputColumns(featureLike = {}, routeLike = null) {
  const route = routeLike && typeof routeLike === "object" ? routeLike : detectTemplateRoute(featureLike);
  if (route.family === "volume") return ["date", "close", "volume"];
  if (route.family === "volatility") return ["date", "open", "high", "low", "close"];
  return ["date", "open", "high", "low", "close", "volume"];
}

function inferIndicators(featureLike = {}, routeLike = null) {
  const route = routeLike && typeof routeLike === "object" ? routeLike : detectTemplateRoute(featureLike);
  const params = featureLike?.params && typeof featureLike.params === "object" ? featureLike.params : {};
  const timeperiod = pickFiniteNumber(params.period, params.timeperiod, 14);
  if (route.templateId === "ema_crossover") {
    return [
      { name: "EMA", params: { fast_period: pickFiniteNumber(params.fast_period, 12), slow_period: pickFiniteNumber(params.slow_period, 26) } },
    ];
  }
  if (route.templateId === "rsi_oscillator") return [{ name: "RSI", params: { period: timeperiod } }];
  if (route.templateId === "atr_filter") return [{ name: "ATR", params: { period: timeperiod } }];
  if (route.templateId === "bollinger_width") return [{ name: "BBANDS", params: { period: pickFiniteNumber(params.period, 20) } }];
  if (route.templateId === "volume_spike") return [{ name: "VOLUME_SMA", params: { period: pickFiniteNumber(params.period, 20) } }];
  if (route.templateId === "momentum_signal") return [{ name: "MOM", params: { period: pickFiniteNumber(params.period, 10) } }];
  return normalizeStringList(featureLike?.indicatorLogic ? [featureLike.indicatorLogic] : [], 4).map((name) => ({ name, params: {} }));
}

export function buildFeatureSpecArtifact(params = {}) {
  const feature = params.feature && typeof params.feature === "object" ? params.feature : {};
  const featureConcept = params.featureConcept && typeof params.featureConcept === "object" ? params.featureConcept : feature;
  const planArtifact = params.planArtifact && typeof params.planArtifact === "object" ? params.planArtifact : null;
  const userChoices = params.userChoices && typeof params.userChoices === "object" ? params.userChoices : {};
  const route = detectTemplateRoute(feature, params.routeHint || params.specArtifact || null);
  const outputSpec = inferSpecOutput(feature, route);
  const inputColumns = inferInputColumns(feature, route);
  const indicators = inferIndicators(feature, route);
  const paramsLike = feature.params && typeof feature.params === "object" ? feature.params : userChoices;
  const acceptanceCriteria = [
    "必须定义 compute_feature(df, ...) 并返回与 df 等长的 pandas.Series",
    "不得修改输入 df 或向 df 写入新列",
  ];
  if (outputSpec.outputRange.min != null || outputSpec.outputRange.max != null) {
    acceptanceCriteria.push(`输出范围应尽量满足 ${String(outputSpec.outputRange.min ?? "-inf")} 到 ${String(outputSpec.outputRange.max ?? "inf")}`);
  }
  return {
    specVersion: 1,
    featureName: sanitizeName(feature.name || featureConcept.name, "custom_feature"),
    route: route.route,
    templateId: route.templateId,
    family: route.family,
    summary: toText(feature.description || featureConcept.description || planArtifact?.summary, ""),
    coreSignal: toText(
      feature.indicatorLogic
      || featureConcept.technicalApproach
      || planArtifact?.approach?.[0]
      || feature.description
      || feature.name,
      "生成一个可解释、可运行的交易特征信号",
    ),
    inputColumns,
    indicators,
    params: { ...paramsLike },
    outputType: outputSpec.outputType,
    outputRange: outputSpec.outputRange,
    constraints: normalizeStringList([
      planArtifact?.validation?.[0],
      planArtifact?.repairStrategy?.[0],
      route.route === "template" ? `优先遵循模板 ${route.templateId} 的结构与输出契约` : "允许自由实现，但不能偏离原始信号意图",
    ], 6),
    preservedConstraints: normalizeStringList([
      `特征名称保持为 ${sanitizeName(feature.name || featureConcept.name, "custom_feature")}`,
      `输入列限定为：${inputColumns.join(", ")}`,
      outputSpec.outputType ? `输出类型保持为 ${outputSpec.outputType}` : "",
      outputSpec.outputRange.min != null || outputSpec.outputRange.max != null
        ? `输出范围保持在 ${String(outputSpec.outputRange.min ?? "-inf")} 到 ${String(outputSpec.outputRange.max ?? "inf")}`
        : "",
    ], 8),
    acceptanceCriteria,
    userChoices: { ...userChoices },
  };
}

export function buildCodeDiffArtifact(previousCodeLike, nextCodeLike) {
  const previousCode = toText(previousCodeLike, "");
  const nextCode = toText(nextCodeLike, "");
  if (!previousCode && !nextCode) {
    return {
      changed: false,
      changedLineCount: 0,
      summary: "没有代码可比较",
      beforeSnippet: "",
      afterSnippet: "",
      beforeRange: null,
      afterRange: null,
    };
  }
  if (previousCode === nextCode) {
    return {
      changed: false,
      changedLineCount: 0,
      summary: "本轮代码与上一版一致",
      beforeSnippet: previousCode.split("\n").slice(0, 24).join("\n"),
      afterSnippet: nextCode.split("\n").slice(0, 24).join("\n"),
      beforeRange: { start: 1, end: Math.min(previousCode.split("\n").length, 24) },
      afterRange: { start: 1, end: Math.min(nextCode.split("\n").length, 24) },
    };
  }
  const beforeLines = previousCode.split("\n");
  const afterLines = nextCode.split("\n");
  let prefix = 0;
  while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) {
    prefix += 1;
  }
  let beforeSuffix = beforeLines.length - 1;
  let afterSuffix = afterLines.length - 1;
  while (beforeSuffix >= prefix && afterSuffix >= prefix && beforeLines[beforeSuffix] === afterLines[afterSuffix]) {
    beforeSuffix -= 1;
    afterSuffix -= 1;
  }
  const beforeStart = Math.max(0, prefix - 2);
  const afterStart = Math.max(0, prefix - 2);
  const beforeEnd = Math.min(beforeLines.length, beforeSuffix + 3);
  const afterEnd = Math.min(afterLines.length, afterSuffix + 3);
  const removedCount = Math.max(0, beforeSuffix - prefix + 1);
  const addedCount = Math.max(0, afterSuffix - prefix + 1);
  const changedLineCount = Math.max(addedCount, removedCount);
  return {
    changed: true,
    changedLineCount,
    summary: removedCount && addedCount
      ? `替换了约 ${changedLineCount} 行代码`
      : (addedCount ? `新增了约 ${addedCount} 行代码` : `删除了约 ${removedCount} 行代码`),
    beforeSnippet: beforeLines.slice(beforeStart, beforeEnd).join("\n"),
    afterSnippet: afterLines.slice(afterStart, afterEnd).join("\n"),
    beforeRange: { start: beforeStart + 1, end: beforeEnd },
    afterRange: { start: afterStart + 1, end: afterEnd },
  };
}

function boolSignalCode(signalExpr) {
  return [
    `signal = (${signalExpr}).astype(float)`,
    "signal = signal.replace([float('inf'), float('-inf')], 0.0)",
    "return signal.reindex(df.index).fillna(0.0)",
  ].join("\n    ");
}

export function generateTemplateCode(featureLike = {}, specArtifactLike = null) {
  const feature = featureLike && typeof featureLike === "object" ? featureLike : {};
  const specArtifact = specArtifactLike && typeof specArtifactLike === "object" ? specArtifactLike : buildFeatureSpecArtifact({ feature });
  const route = detectTemplateRoute(feature, specArtifact);
  if (route.route !== "template") return null;
  const params = feature.params && typeof feature.params === "object" ? feature.params : {};
  const name = sanitizeName(feature.name || specArtifact.featureName, "custom_feature");
  let featureCode = "";
  let description = "";
  if (route.templateId === "ema_crossover") {
    const fast = pickFiniteNumber(params.fast_period, 12);
    const slow = pickFiniteNumber(params.slow_period, 26);
    description = `EMA ${fast}/${slow} 趋势交叉信号`;
    featureCode = [
      "import pandas as pd",
      "import talib.abstract as ta",
      "",
      `def compute_feature(df: pd.DataFrame, fast_period: int = ${fast}, slow_period: int = ${slow}) -> pd.Series:`,
      "    fast = ta.EMA(df, timeperiod=max(2, int(fast_period)))",
      "    slow = ta.EMA(df, timeperiod=max(int(fast_period) + 1, int(slow_period)))",
      "    spread = (fast - slow) / df['close'].replace(0, 1.0)",
      "    signal = spread.clip(-1, 1)",
      "    signal = signal.replace([float('inf'), float('-inf')], 0.0)",
      "    return signal.reindex(df.index).fillna(0.0)",
    ].join("\n");
  } else if (route.templateId === "rsi_oscillator") {
    const period = pickFiniteNumber(params.period, 14);
    description = `RSI(${period}) 振荡器`;
    featureCode = [
      "import pandas as pd",
      "import talib.abstract as ta",
      "",
      `def compute_feature(df: pd.DataFrame, period: int = ${period}) -> pd.Series:`,
      "    rsi = ta.RSI(df, timeperiod=max(2, int(period)))",
      "    rsi = rsi.clip(0, 100)",
      "    return rsi.reindex(df.index).fillna(50.0)",
    ].join("\n");
  } else if (route.templateId === "atr_filter") {
    const period = pickFiniteNumber(params.period, 14);
    description = `ATR(${period}) 波动率过滤`;
    featureCode = [
      "import pandas as pd",
      "import talib.abstract as ta",
      "",
      `def compute_feature(df: pd.DataFrame, period: int = ${period}) -> pd.Series:`,
      "    atr = ta.ATR(df, timeperiod=max(2, int(period)))",
      "    scaled = (atr / df['close'].replace(0, 1.0)).clip(lower=0.0)",
      "    return scaled.reindex(df.index).fillna(0.0)",
    ].join("\n");
  } else if (route.templateId === "bollinger_width") {
    const period = pickFiniteNumber(params.period, 20);
    description = `布林带宽度（${period}）`;
    featureCode = [
      "import pandas as pd",
      "import talib.abstract as ta",
      "",
      `def compute_feature(df: pd.DataFrame, period: int = ${period}) -> pd.Series:`,
      "    bands = ta.BBANDS(df, timeperiod=max(2, int(period)), nbdevup=2, nbdevdn=2)",
      "    middle = bands['middleband'].replace(0, 1.0)",
      "    width = ((bands['upperband'] - bands['lowerband']) / middle).clip(lower=0.0)",
      "    return width.reindex(df.index).fillna(0.0)",
    ].join("\n");
  } else if (route.templateId === "trend_filter") {
    const fast = pickFiniteNumber(params.fast_period, 20);
    const slow = pickFiniteNumber(params.slow_period, 50);
    description = `趋势过滤（EMA ${fast}/${slow}）`;
    featureCode = [
      "import pandas as pd",
      "import talib.abstract as ta",
      "",
      `def compute_feature(df: pd.DataFrame, fast_period: int = ${fast}, slow_period: int = ${slow}) -> pd.Series:`,
      "    fast = ta.EMA(df, timeperiod=max(2, int(fast_period)))",
      "    slow = ta.EMA(df, timeperiod=max(int(fast_period) + 1, int(slow_period)))",
      `    ${boolSignalCode("fast > slow")}`,
    ].join("\n");
  } else if (route.templateId === "volume_spike") {
    const period = pickFiniteNumber(params.period, 20);
    description = `成交量异常（${period}）`;
    featureCode = [
      "import pandas as pd",
      "",
      `def compute_feature(df: pd.DataFrame, period: int = ${period}) -> pd.Series:`,
      "    baseline = df['volume'].rolling(max(2, int(period)), min_periods=1).mean().replace(0, 1.0)",
      "    ratio = (df['volume'] / baseline).clip(lower=0.0)",
      "    return ratio.reindex(df.index).fillna(1.0)",
    ].join("\n");
  } else if (route.templateId === "momentum_signal") {
    const period = pickFiniteNumber(params.period, 10);
    description = `动量信号（${period}）`;
    featureCode = [
      "import pandas as pd",
      "import talib.abstract as ta",
      "",
      `def compute_feature(df: pd.DataFrame, period: int = ${period}) -> pd.Series:`,
      "    mom = ta.MOM(df, timeperiod=max(2, int(period)))",
      "    scaled = (mom / df['close'].replace(0, 1.0)).clip(-1, 1)",
      "    return scaled.reindex(df.index).fillna(0.0)",
    ].join("\n");
  }
  if (!featureCode) return null;
  return {
    featureName: name,
    featureCode,
    description,
    route: route.route,
    templateId: route.templateId,
    requiredConfig: [],
  };
}
