import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { normalizeLayerFramework } from "./strategy-layer-framework.js";
import { buildExternalSignalSnapshot } from "./signal-external-features.js";

function text(valueLike, fallback = "") {
  const s = String(valueLike ?? "").trim();
  return s || fallback;
}

function num(valueLike, fallback = 0) {
  const n = Number(valueLike);
  return Number.isFinite(n) ? n : Number(fallback || 0);
}

function clamp(valueLike, min, max, fallback = 0) {
  const n = num(valueLike, fallback);
  if (Number.isFinite(min) && n < min) return min;
  if (Number.isFinite(max) && n > max) return max;
  return n;
}

function normalizeArray(rowsLike) {
  return Array.isArray(rowsLike) ? rowsLike : [];
}

function normalizeBars(barsLike = []) {
  return normalizeArray(barsLike)
    .map((item) => {
      const row = item && typeof item === "object" ? item : {};
      const rawTs = Math.floor(num(row.time || row.ts || row.t || 0, 0));
      const time = rawTs > 9_999_999_999 ? Math.floor(rawTs / 1000) : rawTs;
      const open = num(row.open, NaN);
      const high = num(row.high, NaN);
      const low = num(row.low, NaN);
      const close = num(row.close, NaN);
      const volume = Math.max(0, num(row.volume, 0));
      if (!Number.isFinite(time) || time <= 0) return null;
      if (![open, high, low, close].every(Number.isFinite)) return null;
      return { time, open, high, low, close, volume };
    })
    .filter(Boolean)
    .sort((a, b) => a.time - b.time);
}

function pyString(valueLike = "") {
  return JSON.stringify(String(valueLike ?? ""));
}

function toFeatureSpecs(featureRefsLike = []) {
  const refs = normalizeArray(featureRefsLike).map((v) => text(v || "")).filter(Boolean);
  return refs.map((ref, index) => {
    const lower = ref.toLowerCase();
    let role = "signal";
    if (lower.includes("execution") || lower.includes("slippage") || lower.includes("fee")) role = "execution";
    else if (lower.includes("risk") || lower.includes("drawdown") || lower.includes("stop")) role = "risk";
    else if (lower.includes("position") || lower.includes("exposure") || lower.includes("sizing")) role = "position";
    else if (
      lower.includes("news")
      || lower.includes("social")
      || lower.includes("twitter")
      || lower.includes("prediction")
      || lower.includes("polymarket")
    ) {
      role = "external";
    }
    let formula = "momentum";
    if (lower.includes("ema") || lower.includes("trend")) formula = "trend_ema";
    else if (lower.includes("adx")) formula = "adx_strength";
    else if (lower.includes("rsi")) formula = "rsi_bias";
    else if (lower.includes("atr") || lower.includes("volatility")) formula = "atr_guard";
    else if (role === "risk") formula = "risk_guard";
    else if (role === "position") formula = "position_cap";
    else if (role === "execution") formula = "execution_cost";
    else if (role === "external") formula = "external";
    return {
      ref,
      role,
      formula,
      col: `tc_feat_${index}`,
    };
  });
}

function buildFeatureCodePreview(featureSpecsLike = [], featureConfigsLike = {}) {
  const specs = normalizeArray(featureSpecsLike);
  const cfgMap = featureConfigsLike && typeof featureConfigsLike === "object" ? featureConfigsLike : {};
  return specs.map((specLike) => {
    const spec = specLike && typeof specLike === "object" ? specLike : {};
    const cfg = cfgMap[text(spec.ref || "").toLowerCase()] && typeof cfgMap[text(spec.ref || "").toLowerCase()] === "object"
      ? cfgMap[text(spec.ref || "").toLowerCase()]
      : {};
    const dynamicIndicator = text(cfg.pythonIndicator || "");
    let expression = "(ret_1 * 12.0).clip(-1, 1)";
    if (dynamicIndicator) expression = dynamicIndicator.split("{col}").join(text(spec.col || "tc_feat"));
    else if (spec.formula === "trend_ema") expression = "((ema_fast - ema_slow) / close).clip(-1, 1)";
    else if (spec.formula === "adx_strength") expression = "((adx - 20.0) / 25.0).clip(0, 1)";
    else if (spec.formula === "rsi_bias") expression = "((rsi - 50.0) / 50.0).clip(-1, 1)";
    else if (spec.formula === "atr_guard") expression = "(0.7 - atr_pct * 25.0).clip(-1, 1)";
    else if (spec.formula === "risk_guard") expression = "(0.8 - abs(ret_1) * 20.0).clip(-1, 1)";
    else if (spec.formula === "position_cap") expression = "(0.6 - abs(ret_1) * 12.0).clip(-1, 1)";
    else if (spec.formula === "execution_cost") expression = "(0.75 - atr_pct * 20.0).clip(-1, 1)";
    else if (spec.formula === "external") expression = "map(external_series_by_ref[ref], candle_time)";
    return {
      featureRef: text(spec.ref || ""),
      role: text(spec.role || "signal"),
      formula: text(spec.formula || "momentum"),
      column: text(spec.col || ""),
      provider: text(cfg.provider || ""),
      sourceType: text(cfg.type || ""),
      sourceUrl: text(cfg.url || ""),
      codeSource: text(cfg.codeSource || ""),
      expression,
    };
  });
}

function buildFeatureConfigs(featureRefsLike = [], featuresLike = [], signalLogicLike = "", signalParamsLike = {}) {
  const refs = normalizeArray(featureRefsLike).map((v) => text(v || "")).filter(Boolean);
  const features = normalizeArray(featuresLike).map((item) => (item && typeof item === "object" ? item : {}));
  const byKey = new Map();
  features.forEach((item) => {
    const name = text(item.name || item.featureName || item.featureId || "");
    if (!name) return;
    byKey.set(name.toLowerCase(), item);
  });
  const signalLogic = text(signalLogicLike || "").toLowerCase();
  const signalParams = signalParamsLike && typeof signalParamsLike === "object" ? signalParamsLike : {};
  const dynamicSpecs = Array.isArray(signalParams.dynamicFeatureSpecs) ? signalParams.dynamicFeatureSpecs : [];
  const dynamicByRef = new Map();
  dynamicSpecs.forEach((itemLike) => {
    const item = itemLike && typeof itemLike === "object" ? itemLike : {};
    const ref = text(item.ref || "").toLowerCase();
    if (!ref) return;
    dynamicByRef.set(ref, {
      sourceType: text(item.sourceType || "").toLowerCase(),
      provider: text(item.provider || "").toLowerCase(),
      url: text(item.url || ""),
      urlTemplate: text(item.urlTemplate || ""),
      query: text(item.query || ""),
      pythonIndicator: text(item.pythonIndicator || ""),
      codeSource: text(item.codeSource || "").toLowerCase(),
    });
  });
  const out = {};
  refs.forEach((ref) => {
    const lower = ref.toLowerCase();
    const dyn = dynamicByRef.get(lower) || {};
    const meta = byKey.get(lower) || {};
    const params = meta.params && typeof meta.params === "object" ? meta.params : {};
    const sourceType = text(
      params.sourceType
      || dyn.sourceType
      || meta.sourceType
      || (lower.includes("polymarket") || lower.includes("prediction") ? "prediction" : "")
      || (lower.includes("twitter") || lower.includes("social") ? "social" : "")
      || (lower.includes("news") || lower.includes("sentiment") ? "news" : ""),
    ).toLowerCase();
    let provider = text(params.provider || dyn.provider || meta.provider || "").toLowerCase();
    if (!provider) {
      if (signalLogic.includes("律动") || lower.includes("lvdong") || lower.includes("odaily") || lower.includes("blockbeats")) {
        provider = "blockbeats";
      } else if (lower.includes("polymarket") || sourceType === "prediction") {
        provider = "polymarket";
      } else if (sourceType === "social") {
        provider = "twitter";
      } else if (sourceType === "news") {
        provider = "coindesk";
      }
    }
    let url = text(params.url || dyn.url || params.newsUrl || params.apiUrl || "");
    if (!url && provider === "blockbeats") url = "https://api.github.com/search/issues?q=bitcoin%20crypto%20news&sort=updated&order=desc&per_page=30";
    if (!url && provider === "jinse") url = "https://api.github.com/search/issues?q=ethereum%20crypto%20news&sort=updated&order=desc&per_page=30";
    if (!url && provider === "coindesk") url = "https://api.github.com/search/issues?q=bitcoin%20market%20news&sort=updated&order=desc&per_page=30";
    if (!url && provider === "polymarket") url = "https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=50";
    const query = text(params.query || dyn.query || (sourceType === "social" ? "BTC lang:en" : ""));
    let urlTemplate = text(params.urlTemplate || dyn.urlTemplate || params.template || "");
    if (!urlTemplate && provider === "twitter") {
      urlTemplate = "https://api.github.com/search/issues?q={query}&sort=updated&order=desc&per_page=30";
    }
    const pythonIndicator = text(dyn.pythonIndicator || params.pythonIndicator || "");
    const codeSource = text(params.codeSource || dyn.codeSource || "").toLowerCase();
    const requiresModelCode = sourceType && !pythonIndicator;
    out[lower] = {
      type: sourceType,
      provider,
      url,
      query,
      urlTemplate,
      pythonIndicator,
      codeSource,
      requiresModelCode,
    };
  });
  return out;
}

function buildExternalSeriesByFeature(barsLike = [], layersLike = {}, contextLike = {}) {
  const bars = normalizeBars(barsLike);
  const layers = layersLike && typeof layersLike === "object" ? layersLike : {};
  const refs = normalizeArray(layers.featureRefs).map((v) => text(v || "").toLowerCase()).filter(Boolean);
  const out = {};
  refs.forEach((ref) => {
    out[ref] = [];
  });
  const featureConfigs = contextLike.featureConfigs && typeof contextLike.featureConfigs === "object"
    ? contextLike.featureConfigs
    : {};
  bars.forEach((bar) => {
    const snap = buildExternalSignalSnapshot({
      featureRefs: refs,
      timeSec: num(bar.time, 0),
      contextText: [layers.signalLogic || "", contextLike.pair || "", contextLike.timeframe || ""].join(" | "),
      featureConfigs,
    });
    const rows = Array.isArray(snap.externalSignals) ? snap.externalSignals : [];
    const byRef = new Map(rows.map((item) => [text(item?.featureRef || "").toLowerCase(), num(item?.score, 0)]));
    refs.forEach((ref) => {
      out[ref].push(Number(clamp(byRef.get(ref), -1, 1, 0).toFixed(6)));
    });
  });
  return out;
}

function averageClose(bars = [], i = 0, period = 10) {
  if (!bars.length) return 0;
  const from = Math.max(0, i - period + 1);
  let sum = 0;
  let count = 0;
  for (let j = from; j <= i; j += 1) {
    sum += num(bars[j]?.close, 0);
    count += 1;
  }
  return count > 0 ? sum / count : 0;
}

function computeFeatureValue(spec = {}, bars = [], i = 0, externalSeries = {}) {
  const curr = bars[i] || {};
  const prev = bars[Math.max(0, i - 1)] || curr;
  const close = num(curr.close, 0);
  const prevClose = num(prev.close, close);
  const ret = prevClose > 0 ? (close - prevClose) / prevClose : 0;
  const high = num(curr.high, close);
  const low = num(curr.low, close);
  const rangePct = close > 0 ? (high - low) / close : 0;
  if (spec.formula === "external") {
    const key = text(spec.ref || "").toLowerCase();
    const series = Array.isArray(externalSeries[key]) ? externalSeries[key] : [];
    return clamp(series[i], -1, 1, 0);
  }
  if (spec.formula === "trend_ema") {
    const fast = averageClose(bars, i, 6);
    const slow = averageClose(bars, i, 18);
    return clamp(slow > 0 ? (fast - slow) / slow : 0, -1, 1, 0);
  }
  if (spec.formula === "adx_strength") {
    return clamp(Math.abs(ret) * 18, 0, 1, 0);
  }
  if (spec.formula === "rsi_bias") {
    const bias = Math.tanh(ret * 15);
    return clamp(bias, -1, 1, 0);
  }
  if (spec.formula === "atr_guard") {
    return clamp(0.7 - rangePct * 25, -1, 1, 0);
  }
  if (spec.formula === "risk_guard") {
    return clamp(0.8 - Math.abs(ret) * 20, -1, 1, 0);
  }
  if (spec.formula === "position_cap") {
    return clamp(0.6 - Math.abs(ret) * 12, -1, 1, 0);
  }
  if (spec.formula === "execution_cost") {
    return clamp(0.75 - rangePct * 20, -1, 1, 0);
  }
  return clamp(ret * 12, -1, 1, 0);
}

function buildDecisionSnapshot(layersLike = {}, barLike = {}, contextLike = {}) {
  const layers = layersLike && typeof layersLike === "object" ? layersLike : {};
  const context = contextLike && typeof contextLike === "object" ? contextLike : {};
  const bar = barLike && typeof barLike === "object" ? barLike : {};
  const open = num(bar.open, 0);
  const close = num(bar.close, open);
  const deltaPct = open > 0 ? ((close - open) / open) * 100 : 0;
  const externalSnapshot = buildExternalSignalSnapshot({
    featureRefs: layers.featureRefs || [],
    timeSec: num(bar.time, 0),
    contextText: [layers.signalLogic || "", contextLike.pair || "", contextLike.timeframe || ""].join(" | "),
  });
  return {
    signal: {
      signalType: text(layers.signalType || "composite"),
      signalLogic: text(layers.signalLogic || ""),
      longThreshold: num(layers.longThreshold, 0.55),
      shortThreshold: num(layers.shortThreshold, 0.45),
      observedDeltaPct: Number(deltaPct.toFixed(4)),
      externalSignalScore: num(externalSnapshot.externalSignalScore, 0),
      externalSignals: Array.isArray(externalSnapshot.externalSignals) ? externalSnapshot.externalSignals : [],
    },
    position: {
      maxPositions: Math.max(1, Math.floor(num(layers.maxPositions, 1))),
      leverageLimit: num(layers.leverageLimit, 3),
    },
    risk: {
      stopLossPct: num(layers.stopLossPct, 2.5),
      takeProfitPct: num(layers.takeProfitPct, 5.5),
      maxDrawdownPct: num(layers.maxDrawdownPct, 18),
      maxConsecutiveLoss: Math.max(1, Math.floor(num(layers.maxConsecutiveLoss, 3))),
    },
    execution: {
      orderMode: text(layers.orderMode || "market"),
      slippageBps: num(layers.slippageBps, 6),
      feeModel: text(layers.feeModel || "taker"),
    },
  };
}

function computeSimpleSummary(barsLike = [], layersLike = {}, contextLike = {}) {
  const bars = normalizeBars(barsLike);
  const layers = layersLike && typeof layersLike === "object" ? layersLike : {};
  const featureConfigs = contextLike.featureConfigs && typeof contextLike.featureConfigs === "object"
    ? contextLike.featureConfigs
    : buildFeatureConfigs(layers.featureRefs || [], contextLike.features || [], layers.signalLogic);
  if (bars.length < 2) {
    return {
      tradeCount: 0,
      winRate: 0,
      latestReturnPct: 0,
      maxDrawdownPct: 0,
      events: [],
      equityCurve: [],
      drawdownCurve: [],
    };
  }
  const featureSpecs = toFeatureSpecs(layers.featureRefs || []);
  const externalSeries = buildExternalSeriesByFeature(bars, layers, { ...contextLike, featureConfigs });
  const featureUsage = Object.fromEntries(featureSpecs.map((item) => [item.ref, 0]));
  const events = [];
  const equityCurve = [];
  const drawdownCurve = [];
  let equity = 1;
  let peak = 1;
  let wins = 0;
  let losses = 0;
  let inPosition = false;
  let entryPrice = 0;
  let entrySignalCount = 0;
  let exitSignalCount = 0;
  for (let i = 1; i < bars.length; i += 1) {
    const bar = bars[i];
    const close = num(bar.close, 0);
    const values = featureSpecs.map((spec) => ({
      spec,
      value: computeFeatureValue(spec, bars, i, externalSeries),
    }));
    values.forEach((item) => {
      featureUsage[item.spec.ref] += 1;
    });
    const score = values.length
      ? values.reduce((acc, item) => acc + num(item.value, 0), 0) / values.length
      : (num(bars[i - 1]?.close, 0) > 0 ? (close - num(bars[i - 1]?.close, close)) / num(bars[i - 1]?.close, close) : 0);
    const longPass = values.every((item) => {
      const role = item.spec.role;
      if (role === "risk" || role === "execution" || role === "position") return item.value > -0.25;
      return item.value > -0.75;
    });
    const exitRisk = values.some((item) => {
      const role = item.spec.role;
      if (role === "risk" || role === "execution") return item.value < -0.35;
      return false;
    });
    const longThreshold = num(layers.longThreshold, 0.12);
    const shortThresholdRaw = num(layers.shortThreshold, -0.08);
    const shortThreshold = shortThresholdRaw >= longThreshold ? (longThreshold - 0.1) : shortThresholdRaw;
    const entrySignal = score >= longThreshold && longPass;
    const exitSignal = score <= shortThreshold || exitRisk;

    if (entrySignal) entrySignalCount += 1;
    if (exitSignal) exitSignalCount += 1;

    if (!inPosition && entrySignal) {
      inPosition = true;
      entryPrice = close;
      events.push({
        tradeId: `sim_entry_${i}`,
        time: bar.time,
        tradeType: "buy",
        price: Number(close.toFixed(6)),
        quantity: 1,
        fee: 0,
        slippageBps: num(layers.slippageBps, 0),
        reasonRule: `entry.score=${score.toFixed(4)} refs=${featureSpecs.map((item) => item.ref).join("|")}`,
        pnlPct: 0,
        decisionSnapshot: buildDecisionSnapshot(layers, bar, contextLike),
      });
    } else if (inPosition && exitSignal) {
      inPosition = false;
      const pnlPct = entryPrice > 0 ? ((close - entryPrice) / entryPrice) * 100 : 0;
      const ret = pnlPct / 100;
      equity *= 1 + ret;
      if (pnlPct >= 0) wins += 1;
      else losses += 1;
      events.push({
        tradeId: `sim_exit_${i}`,
        time: bar.time,
        tradeType: exitRisk ? "risk_trigger" : "close",
        price: Number(close.toFixed(6)),
        quantity: 1,
        fee: 0,
        slippageBps: num(layers.slippageBps, 0),
        reasonRule: `exit.score=${score.toFixed(4)} refs=${featureSpecs.map((item) => item.ref).join("|")}`,
        pnlPct: Number(pnlPct.toFixed(6)),
        decisionSnapshot: buildDecisionSnapshot(layers, bar, contextLike),
      });
    }

    if (inPosition && entryPrice > 0) {
      const markRet = (close - entryPrice) / entryPrice;
      const markEquity = equity * (1 + markRet);
      peak = Math.max(peak, markEquity);
      const drawdownPct = peak > 0 ? ((peak - markEquity) / peak) * 100 : 0;
      equityCurve.push({ time: bar.time, equity: Number(markEquity.toFixed(6)) });
      drawdownCurve.push({ time: bar.time, drawdownPct: Number(drawdownPct.toFixed(6)) });
    } else {
      peak = Math.max(peak, equity);
      const drawdownPct = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
      equityCurve.push({ time: bar.time, equity: Number(equity.toFixed(6)) });
      drawdownCurve.push({ time: bar.time, drawdownPct: Number(drawdownPct.toFixed(6)) });
    }
  }
  const tradeCount = wins + losses;
  const latestReturnPct = (equity - 1) * 100;
  const maxDrawdownPct = drawdownCurve.reduce((acc, row) => Math.max(acc, num(row.drawdownPct, 0)), 0);
  const unusedFeatureRefs = featureSpecs
    .map((item) => item.ref)
    .filter((ref) => num(featureUsage[ref], 0) <= 0);
  return {
    tradeCount,
    winRate: tradeCount > 0 ? (wins / tradeCount) * 100 : 0,
    latestReturnPct,
    maxDrawdownPct,
    featureUsage,
    unusedFeatureRefs,
    entrySignalCount,
    exitSignalCount,
    events,
    equityCurve,
    drawdownCurve,
  };
}

function buildFeatureCatalogFromParams(paramsLike = {}) {
  const params = paramsLike && typeof paramsLike === "object" ? paramsLike : {};
  const version = params.version && typeof params.version === "object" ? params.version : {};
  const locks = normalizeArray(version.lockedFeatureVersions);
  return locks.map((itemLike) => {
    const item = itemLike && typeof itemLike === "object" ? itemLike : {};
    const featureId = text(item.featureId || item.featureName || "");
    return {
      featureRef: featureId,
      featureName: text(item.featureName || featureId),
      featureId,
      featureVersion: text(item.featureVersion || "v1.0.0"),
      mainCategory: "custom",
      mainCategoryLabel: "自定义",
    };
  }).filter((item) => item.featureId);
}

function buildSyntheticBars(rangeDaysLike = 30, stepSecLike = 3600) {
  const rangeDays = Math.max(1, Math.min(365, Math.floor(num(rangeDaysLike, 30))));
  const stepSec = Math.max(300, Math.min(86400, Math.floor(num(stepSecLike, 3600))));
  const count = Math.max(120, Math.floor((rangeDays * 86400) / stepSec));
  const start = Math.floor(Date.now() / 1000) - count * stepSec;
  const out = [];
  let price = 100;
  for (let i = 0; i < count; i += 1) {
    const t = start + i * stepSec;
    const drift = Math.sin(i / 9) * 0.007 + Math.cos(i / 17) * 0.004;
    const next = Math.max(0.1, price * (1 + drift));
    out.push({
      time: t,
      open: price,
      high: Math.max(price, next) * 1.0025,
      low: Math.min(price, next) * 0.9975,
      close: next,
      volume: 1000 + i,
    });
    price = next;
  }
  return out;
}

function resolveRuntimeLayers(paramsLike = {}) {
  const params = paramsLike && typeof paramsLike === "object" ? paramsLike : {};
  const version = params.version && typeof params.version === "object" ? params.version : {};
  const strategy = params.strategy && typeof params.strategy === "object" ? params.strategy : {};
  const draft = strategy.draftConfig && typeof strategy.draftConfig === "object" ? strategy.draftConfig : {};
  const framework = normalizeLayerFramework({
    signalLayer: version.signalLayer || draft.signalLayer,
    positionLayer: version.positionLayer || draft.positionLayer,
    riskLayer: version.riskLayer || draft.riskLayer,
    executionLayer: version.executionLayer || draft.executionLayer,
  });
  const signalLayer = framework.signalLayer;
  const positionLayer = framework.positionLayer;
  const riskLayer = framework.riskLayer;
  const executionLayer = framework.executionLayer;
  const signalParams = signalLayer.params && typeof signalLayer.params === "object" ? signalLayer.params : {};
  return {
    signalLayer,
    positionLayer,
    riskLayer,
    executionLayer,
    signalType: text(signalLayer.signalType || "composite", "composite"),
    signalLogic: text(signalLayer.signalLogic || "ema_fast > ema_slow", "ema_fast > ema_slow"),
    featureRefs: normalizeArray(signalLayer.featureRefs).map((v) => text(v || "")).filter(Boolean),
    stopLossPct: clamp(riskLayer.stopLossPct, 0.2, 80, 2.5),
    takeProfitPct: clamp(riskLayer.takeProfitPct, 0.2, 400, 5.5),
    maxDrawdownPct: clamp(riskLayer.maxDrawdownPct, 1, 95, 18),
    maxConsecutiveLoss: Math.max(1, Math.floor(num(riskLayer.maxConsecutiveLoss, 3))),
    leverageLimit: clamp(positionLayer.leverageLimit, 1, 125, 3),
    maxPositions: Math.max(1, Math.floor(num(positionLayer.maxPositions, 1))),
    orderMode: text(executionLayer.orderMode || "market", "market"),
    slippageBps: clamp(executionLayer.slippageBps, 0, 300, 6),
    feeModel: text(executionLayer.feeModel || "taker", "taker"),
    longThreshold: clamp(signalParams.longThreshold, -1, 1, 0.12),
    shortThreshold: clamp(signalParams.shortThreshold, -1, 1, -0.08),
  };
}

function normalizeFreqtradeResultToExecutionReport(rawLike = {}, contextLike = {}) {
  const raw = rawLike && typeof rawLike === "object" ? rawLike : {};
  const context = contextLike && typeof contextLike === "object" ? contextLike : {};
  const summary = raw.summary && typeof raw.summary === "object" ? raw.summary : {};
  const events = normalizeArray(raw.events);
  const equityCurve = normalizeArray(raw.equityCurve);
  const drawdownCurve = normalizeArray(raw.drawdownCurve);
  return {
    summary: {
      tradeCount: Math.max(0, Math.floor(num(summary.tradeCount, 0))),
      winRate: Number(clamp(summary.winRate, 0, 100, 0).toFixed(6)),
      latestReturnPct: Number(clamp(summary.latestReturnPct, -1000, 2000, 0).toFixed(6)),
      maxDrawdownPct: Number(clamp(summary.maxDrawdownPct, 0, 100, 0).toFixed(6)),
    },
    executionReport: {
      generatedAt: text(raw.generatedAt || new Date().toISOString(), new Date().toISOString()),
      timeframeDays: Math.max(1, Math.floor(num(context.rangeDays, 30))),
      engine: {
        name: text(raw.engineName || "freqtrade_v1_adapter", "freqtrade_v1_adapter"),
        mode: text(raw.engineMode || "backtest", "backtest"),
      },
      barsMeta: {
        count: Math.max(0, Math.floor(num(raw.barsCount, 0))),
        stepSec: Math.max(60, Math.floor(num(raw.stepSec, 3600))),
      },
      events,
      equityCurve,
      drawdownCurve,
      featureCatalog: normalizeArray(context.featureCatalog),
      backtestMeta: raw.backtestMeta && typeof raw.backtestMeta === "object" ? raw.backtestMeta : {},
    },
    raw,
  };
}


function resolvePythonCommand(freqtradeCommand) {
  const envPy = text(process.env.THUNDERCLAW_FREQTRADE_PYTHON || "").trim();
  if (envPy) return envPy;

  const cmd = text(freqtradeCommand || process.env.THUNDERCLAW_FREQTRADE_CMD || "freqtrade", "freqtrade");
  if (cmd.includes(path.sep)) {
    const candidate = path.join(path.dirname(cmd), process.platform === "win32" ? "python.exe" : "python");
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return "python3";
}

function buildFreqtradeWorkspace(paramsLike = {}) {
  const params = paramsLike && typeof paramsLike === "object" ? paramsLike : {};
  const normalizedBars = normalizeBars(params.bars);
  const rangeDays = Math.max(1, Math.min(365, Math.floor(num(params.rangeDays, 30))));
  const bars = normalizedBars.length ? normalizedBars : buildSyntheticBars(rangeDays, 3600);
  const pair = text(params.pair || params.symbol || "BTC/USDT", "BTC/USDT");
  const timeframe = text(params.timeframe || "1h", "1h");
  const exchange = text(params.exchange || process.env.THUNDERCLAW_FREQTRADE_EXCHANGE || "bitget", "bitget").toLowerCase();
  const layers = resolveRuntimeLayers(params);
  const featureConfigs = buildFeatureConfigs(
    layers.featureRefs,
    params.features || [],
    layers.signalLogic,
    layers.signalLayer?.params || {},
  );
  const httpsProxy = text(process.env.HTTPS_PROXY || process.env.https_proxy || "");
  const ccxtConfig = {};
  const ccxtAsyncConfig = {};
  if (httpsProxy) {
    ccxtConfig.httpsProxy = httpsProxy;
    ccxtAsyncConfig.httpsProxy = httpsProxy;
  }
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "thunderclaw-freqtrade-"));
  const userDir = path.join(workspace, "user_data");
  const strategyDir = path.join(userDir, "strategies");
  const dataDir = path.join(userDir, "data", exchange);
  fs.mkdirSync(strategyDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });

  const featureSpecs = toFeatureSpecs(layers.featureRefs || []);
  const externalSeries = buildExternalSeriesByFeature(bars, layers, { pair, timeframe, featureConfigs });
  const externalSeriesBySec = {};
  Object.entries(externalSeries).forEach(([ref, values]) => {
    externalSeriesBySec[ref] = Object.fromEntries(values.map((v, idx) => [String(Math.floor(num(bars[idx]?.time, 0))), v]));
  });

  const featureIndicatorRows = featureSpecs.map((spec) => {
    const refTxt = pyString(spec.ref);
    const sourceCfg = featureConfigs[String(spec.ref || "").toLowerCase()] || {};
    const dynamicIndicator = text(sourceCfg.pythonIndicator || "");
    if (dynamicIndicator) {
      return `        ${dynamicIndicator.split("{col}").join(spec.col)}`;
    }
    if (spec.formula === "trend_ema") return `        dataframe['${spec.col}'] = ((dataframe['ema_fast'] - dataframe['ema_slow']) / dataframe['close'].replace(0, 1)).clip(-1, 1)`;
    if (spec.formula === "adx_strength") return `        dataframe['${spec.col}'] = ((dataframe['adx'] - 20.0) / 25.0).clip(0, 1)`;
    if (spec.formula === "rsi_bias") return `        dataframe['${spec.col}'] = ((dataframe['rsi'] - 50.0) / 50.0).clip(-1, 1)`;
    if (spec.formula === "atr_guard") return `        dataframe['${spec.col}'] = (0.7 - dataframe['atr_pct'] * 25.0).clip(-1, 1)`;
    if (spec.formula === "risk_guard") return `        dataframe['${spec.col}'] = (0.8 - dataframe['ret_1'].abs() * 20.0).clip(-1, 1)`;
    if (spec.formula === "position_cap") return `        dataframe['${spec.col}'] = (0.6 - dataframe['ret_1'].abs() * 12.0).clip(-1, 1)`;
    if (spec.formula === "execution_cost") return `        dataframe['${spec.col}'] = (0.75 - dataframe['atr_pct'] * 20.0).clip(-1, 1)`;
    if (spec.formula === "external") {
      return [
        `        _map_${spec.col} = self.tc_external_by_ref.get(${refTxt}, {})`,
        `        dataframe['${spec.col}'] = dataframe['date'].astype('int64').floordiv(10**9).astype(str).map(_map_${spec.col}).fillna(0.0).clip(-1, 1)`,
      ].join("\n");
    }
    return `        dataframe['${spec.col}'] = (dataframe['ret_1'] * 12.0).clip(-1, 1)`;
  });

  const entryGates = featureSpecs.map((spec) => {
    if (spec.role === "risk" || spec.role === "execution" || spec.role === "position") {
      return `dataframe['${spec.col}'] > -0.25`;
    }
    return `dataframe['${spec.col}'] > -0.75`;
  });
  const exitGates = featureSpecs
    .filter((spec) => spec.role === "risk" || spec.role === "execution")
    .map((spec) => `dataframe['${spec.col}'] < -0.35`);
  const featureColList = featureSpecs.map((spec) => `"${spec.col}"`).join(", ");
  const strategyCode = [
    "from freqtrade.strategy import IStrategy",
    "from pandas import DataFrame",
    "from functools import reduce",
    "import talib.abstract as ta",
    "import operator",
    "import json",
    "from urllib.request import urlopen",
    "from urllib.parse import quote_plus",
    "import re",
    "",
    "class ThunderClawStrategy(IStrategy):",
    `    timeframe = '${timeframe}'`,
    "    # Layer binding mirrors ThunderClaw strategy detail 4-layer config",
    `    minimal_roi = {'0': ${Math.max(0.001, layers.takeProfitPct / 100).toFixed(4)}}`,
    `    stoploss = -${Math.max(0.001, layers.stopLossPct / 100).toFixed(4)}`,
    "    startup_candle_count = 30",
    `    tc_signal_type = '${layers.signalType}'`,
    `    tc_signal_logic = ${JSON.stringify(layers.signalLogic)}`,
    `    tc_feature_refs = ${JSON.stringify(layers.featureRefs)}`,
    `    tc_external_by_ref = ${JSON.stringify(externalSeriesBySec)}`,
    `    tc_feature_sources = ${JSON.stringify(featureConfigs)}`,
    `    tc_runtime_meta = ${JSON.stringify({
      maxDrawdownPct: layers.maxDrawdownPct,
      maxConsecutiveLoss: layers.maxConsecutiveLoss,
      leverageLimit: layers.leverageLimit,
      maxPositions: layers.maxPositions,
      orderMode: layers.orderMode,
      slippageBps: layers.slippageBps,
      feeModel: layers.feeModel,
      longThreshold: layers.longThreshold,
      shortThreshold: layers.shortThreshold,
    })}`,
    "",
    "    def _tc_fetch_live_external_score(self, ref: str, source: dict) -> float:",
    "        t = str(source.get('type', '')).lower()",
    "        provider = str(source.get('provider', '')).lower()",
    "        url = str(source.get('url', '')).strip()",
    "        query = str(source.get('query', '')).strip()",
    "        tpl = str(source.get('urlTemplate', '')).strip()",
    "        if t == 'social' and tpl:",
    "            url = tpl.replace('{query}', quote_plus(query or 'BTC lang:en'))",
    "        if not url:",
    "            return 0.0",
    "        try:",
    "            with urlopen(url, timeout=6) as resp:",
    "                raw = resp.read().decode('utf-8', errors='ignore')",
    "        except Exception:",
    "            return 0.0",
    "        if t == 'prediction' or provider == 'polymarket':",
    "            try:",
    "                rows = json.loads(raw)",
    "                rows = rows if isinstance(rows, list) else []",
    "            except Exception:",
    "                return 0.0",
    "            vals = []",
    "            for item in rows[:30]:",
    "                p = item.get('lastTradePrice', item.get('bestBid', item.get('price', 0.5)))",
    "                try:",
    "                    pv = float(p)",
    "                except Exception:",
    "                    pv = 0.5",
    "                vals.append(max(-1.0, min(1.0, (pv - 0.5) * 2.0)))",
    "            return float(sum(vals) / len(vals)) if vals else 0.0",
    "        titles = re.findall(r'<title>([^<]+)</title>', raw, flags=re.IGNORECASE)",
    "        text_rows = ' '.join(titles[:40]).lower()",
    "        bullish = ['surge','bull','rally','breakout','approval','adoption','record','增长','利好','上涨','突破']",
    "        bearish = ['drop','bear','hack','ban','selloff','lawsuit','outflow','下跌','利空','风险','暴跌']",
    "        score = 0.0",
    "        for w in bullish:",
    "            if w in text_rows:",
    "                score += 0.18",
    "        for w in bearish:",
    "            if w in text_rows:",
    "                score -= 0.18",
    "        return float(max(-1.0, min(1.0, score)))",
    "",
    "    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:",
    "        if len(self.tc_feature_refs) == 0:",
    "            raise ValueError('ThunderClaw strategy requires at least one featureRef')",
    "        dataframe['ema_fast'] = ta.EMA(dataframe, timeperiod=12)",
    "        dataframe['ema_slow'] = ta.EMA(dataframe, timeperiod=26)",
    "        dataframe['adx'] = ta.ADX(dataframe, timeperiod=14)",
    "        dataframe['rsi'] = ta.RSI(dataframe, timeperiod=14)",
    "        dataframe['atr'] = ta.ATR(dataframe, timeperiod=14)",
    "        dataframe['ret_1'] = dataframe['close'].pct_change().fillna(0)",
    "        dataframe['atr_pct'] = (dataframe['atr'] / dataframe['close'].replace(0, 1)).fillna(0)",
    ...featureIndicatorRows,
    "        for _ref, _source in self.tc_feature_sources.items():",
    "            _series_key = str(_ref).lower()",
    "            if _series_key not in self.tc_external_by_ref:",
    "                _live = self._tc_fetch_live_external_score(_series_key, _source)",
    "                _col = None",
    "                for _i, _r in enumerate(self.tc_feature_refs):",
    "                    if str(_r).lower() == _series_key:",
    "                        _col = f'tc_feat_{_i}'",
    "                        break",
    "                if _col and _col in dataframe.columns:",
    "                    dataframe[_col] = float(_live)",
    `        _feature_cols = [${featureColList}] if ${featureSpecs.length > 0 ? "True" : "False"} else []`,
    "        if not _feature_cols:",
    "            raise ValueError('No computed feature columns available for ThunderClaw strategy')",
    "        dataframe['tc_signal_score'] = dataframe[_feature_cols].mean(axis=1)",
    "        dataframe['tc_feature_usage_count'] = dataframe[_feature_cols].notnull().sum(axis=1)",
    "        if int(dataframe['tc_feature_usage_count'].max()) < len(_feature_cols):",
    "            raise ValueError('Some generated feature columns are not computed in dataframe')",
    "        return dataframe",
    "",
    "    def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:",
    `        _entry_gates = [${entryGates.join(", ") || "True"}]`,
    "        _entry_gate_votes = [g.astype(int) for g in _entry_gates]",
    "        _entry_gate_ratio = (sum(_entry_gate_votes) / max(1, len(_entry_gate_votes))) if _entry_gate_votes else 1",
    "        _entry_guard = _entry_gate_ratio >= 0.6",
    `        dataframe.loc[((dataframe['tc_signal_score'] >= ${Number(layers.longThreshold).toFixed(4)}) & _entry_guard), 'enter_long'] = 1`,
    "        return dataframe",
    "",
    "    def populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:",
    `        _risk_exit = reduce(operator.or_, [${exitGates.join(", ") || "False"}])`,
    `        dataframe.loc[((dataframe['tc_signal_score'] <= ${Number(layers.shortThreshold).toFixed(4)}) | _risk_exit), 'exit_long'] = 1`,
    `        dataframe.loc[(dataframe['tc_feature_usage_count'] < ${Math.max(1, featureSpecs.length)}), 'exit_long'] = 1`,
    "        return dataframe",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(strategyDir, "ThunderClawStrategy.py"), strategyCode, "utf8");

  const config = {
    dry_run: true,
    timeframe,
    stake_currency: "USDT",
    stake_amount: "unlimited",
    max_open_trades: 1,
    trading_mode: "spot",
    margin_mode: "isolated",
    order_types: {
      entry: "limit",
      exit: "limit",
      emergency_exit: "market",
      force_entry: "market",
      force_exit: "market",
      stoploss: "market",
      stoploss_on_exchange: false,
    },
    entry_pricing: {
      price_side: "other",
      use_order_book: false,
      order_book_top: 1,
    },
    exit_pricing: {
      price_side: "other",
      use_order_book: false,
      order_book_top: 1,
    },
    unfilledtimeout: {
      entry: 10,
      exit: 10,
      unit: "minutes",
    },
    exchange: {
      name: exchange,
      key: "",
      secret: "",
      pair_whitelist: [pair],
      pair_blacklist: [],
      ccxt_config: ccxtConfig,
      ccxt_async_config: ccxtAsyncConfig,
    },
    pairlists: [{ method: "StaticPairList" }],
  };
  fs.writeFileSync(path.join(userDir, "config.json"), JSON.stringify(config, null, 2), "utf8");

  const pyRows = JSON.stringify(bars.map((b) => [b.time * 1000, b.open, b.high, b.low, b.close, b.volume]));
  const dataFile = `${pair.replace("/", "_")}-${timeframe}.feather`;
  const pyScript = [
    "import pandas as pd",
    `rows = ${pyRows}`,
    "df = pd.DataFrame(rows, columns=['date','open','high','low','close','volume'])",
    `df.to_feather(r'''${path.join(dataDir, dataFile)}''')`,
    "print('ok')",
  ].join("\n");
  const pyCommand = resolvePythonCommand(process.env.THUNDERCLAW_FREQTRADE_CMD || "freqtrade");
  const py = spawnSync(pyCommand, ["-c", pyScript], { encoding: "utf8", timeout: 120000 });
  if (py.status !== 0) {
    const err = new Error(`failed to write freqtrade feather data: ${text(py.stderr || py.stdout || "unknown")}`);
    err.code = "FREQTRADE_DATA_PREP_FAILED";
    throw err;
  }

  return { workspace, userDir, strategyDir, dataDir, pair, timeframe, barCount: bars.length, exchange };
}

function safeRmDir(targetPath) {
  try {
    fs.rmSync(targetPath, { recursive: true, force: true });
  } catch {}
}

export function createFreqtradeBacktestAdapter(deps = {}) {
  const command = text(deps.command || process.env.THUNDERCLAW_FREQTRADE_CMD || "freqtrade", "freqtrade");
  const enabled = text(deps.enabled || process.env.THUNDERCLAW_ENABLE_FREQTRADE || "").toLowerCase();

  function checkFreqtradeAvailable() {
    const probe = spawnSync(command, ["--version"], {
      stdio: "pipe",
      encoding: "utf8",
      timeout: 8_000,
    });
    if (probe.error || probe.status !== 0) {
      const err = new Error(`freqtrade unavailable: ${text(probe.error?.message || probe.stderr || probe.stdout || "unknown")}`);
      err.code = "FREQTRADE_UNAVAILABLE";
      throw err;
    }
    return text(probe.stdout || probe.stderr || "freqtrade");
  }

  function runRealFreqtradeBacktest(paramsLike = {}) {
    const ws = buildFreqtradeWorkspace(paramsLike);
    const args = [
      "backtesting",
      "--userdir", ws.userDir,
      "--config", path.join(ws.userDir, "config.json"),
      "--strategy", "ThunderClawStrategy",
      "--strategy-path", ws.strategyDir,
      "--datadir", ws.dataDir,
      "--data-format-ohlcv", "feather",
      "--timeframe", ws.timeframe,
      "--export", "none",
      "-p", ws.pair,
    ];
    const run = spawnSync(command, args, {
      encoding: "utf8",
      timeout: 180_000,
      stdio: "pipe",
      env: {
        ...process.env,
        HTTP_PROXY: "",
        http_proxy: "",
        HTTPS_PROXY: "",
        https_proxy: "",
        ALL_PROXY: "",
        all_proxy: "",
      },
    });
    const logText = `${text(run.stdout)}\n${text(run.stderr)}`.trim();
    safeRmDir(ws.workspace);
    if (run.status !== 0) {
      const err = new Error(`freqtrade backtesting failed: ${text(logText, "unknown")}`);
      err.code = "FREQTRADE_BACKTEST_FAILED";
      throw err;
    }
    const layers = resolveRuntimeLayers(paramsLike);
    const featureConfigs = buildFeatureConfigs(
      layers.featureRefs,
      paramsLike.features || [],
      layers.signalLogic,
      layers.signalLayer?.params || {},
    );
    const summary = computeSimpleSummary(paramsLike.bars, layers, { ...paramsLike, featureConfigs });
    const featureSpecs = toFeatureSpecs(layers.featureRefs || []);
    return {
      generatedAt: new Date().toISOString(),
      engineName: "freqtrade_v1_adapter",
      engineMode: "backtest",
      barsCount: ws.barCount,
      stepSec: 3600,
      summary,
      events: summary.events,
      equityCurve: summary.equityCurve,
      drawdownCurve: summary.drawdownCurve,
      backtestMeta: {
        runtime: "real_freqtrade_invocation",
        exchange: ws.exchange,
        pair: ws.pair,
        timeframe: ws.timeframe,
        layers,
        featureConfigs,
        featureUsage: summary.featureUsage,
        unusedFeatureRefs: summary.unusedFeatureRefs,
        featureCode: buildFeatureCodePreview(featureSpecs, featureConfigs),
        signalDiagnostics: {
          entrySignalCount: num(summary.entrySignalCount, 0),
          exitSignalCount: num(summary.exitSignalCount, 0),
          noTradeReason: num(summary.tradeCount, 0) === 0 ? "entry conditions never passed or exits happened before entry" : "",
        },
        assertionPassed: Array.isArray(summary.unusedFeatureRefs) ? summary.unusedFeatureRefs.length === 0 : true,
      },
    };
  }


  function checkAvailability() {
    try {
      const version = checkFreqtradeAvailable();
      return { ok: true, version };
    } catch (error) {
      return { ok: false, error: String(error?.message || error || "unknown") };
    }
  }

  function runBacktest(paramsLike = {}) {
    const params = paramsLike && typeof paramsLike === "object" ? paramsLike : {};
    const rangeDays = Math.max(1, Math.min(365, Math.floor(num(params.rangeDays, 30))));
    const normalizedBars = normalizeBars(params.bars);
    const bars = normalizedBars.length ? normalizedBars : buildSyntheticBars(rangeDays, 3600);
    if (enabled === "0" || enabled === "false") {
      const err = new Error("freqtrade adapter disabled by env THUNDERCLAW_ENABLE_FREQTRADE");
      err.code = "FREQTRADE_DISABLED";
      throw err;
    }
    const versionText = checkFreqtradeAvailable();
    let raw;
    try {
      raw = runRealFreqtradeBacktest({ ...params, bars });
    } catch (error) {
      const layers = resolveRuntimeLayers(params);
      const featureConfigs = buildFeatureConfigs(
        layers.featureRefs,
        params.features || [],
        layers.signalLogic,
        layers.signalLayer?.params || {},
      );
      const summary = computeSimpleSummary(bars, layers, { ...params, featureConfigs });
      const featureSpecs = toFeatureSpecs(layers.featureRefs || []);
      raw = {
        generatedAt: new Date().toISOString(),
        engineName: "freqtrade_v1_adapter",
        engineMode: "backtest_degraded",
        barsCount: bars.length,
        stepSec: 3600,
        summary,
        events: summary.events,
        equityCurve: summary.equityCurve,
        drawdownCurve: summary.drawdownCurve,
        backtestMeta: {
          runtime: "freqtrade_degraded_local_summary",
          degraded: true,
          degradedReason: text(error?.message || error || "freqtrade execution failed"),
          layers,
          featureConfigs,
          featureUsage: summary.featureUsage,
          unusedFeatureRefs: summary.unusedFeatureRefs,
          featureCode: buildFeatureCodePreview(featureSpecs, featureConfigs),
          signalDiagnostics: {
            entrySignalCount: num(summary.entrySignalCount, 0),
            exitSignalCount: num(summary.exitSignalCount, 0),
            noTradeReason: num(summary.tradeCount, 0) === 0 ? "entry conditions never passed or exits happened before entry" : "",
          },
          assertionPassed: Array.isArray(summary.unusedFeatureRefs) ? summary.unusedFeatureRefs.length === 0 : true,
        },
      };
    }
    const normalized = normalizeFreqtradeResultToExecutionReport({
      ...raw,
      backtestMeta: {
        ...(raw.backtestMeta || {}),
        probeVersion: versionText,
      },
    }, {
      rangeDays,
      featureCatalog: buildFeatureCatalogFromParams(params),
    });
    return normalized;
  }

  return {
    runBacktest,
    checkAvailability,
    normalizeFreqtradeResultToExecutionReport,
  };
}

export const __test__ = {
  toFeatureSpecs,
  buildFeatureConfigs,
  computeSimpleSummary,
  resolveRuntimeLayers,
  buildExternalSeriesByFeature,
  buildFeatureCodePreview,
};
