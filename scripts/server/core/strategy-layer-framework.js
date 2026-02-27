function toText(valueLike, fallback = "") {
  const s = String(valueLike ?? "").trim();
  return s || fallback;
}

function toNum(valueLike, fallback = 0) {
  const n = Number(valueLike);
  return Number.isFinite(n) ? n : Number(fallback || 0);
}

function clamp(valueLike, min, max, fallback = 0) {
  const n = toNum(valueLike, fallback);
  if (Number.isFinite(min) && n < min) return min;
  if (Number.isFinite(max) && n > max) return max;
  return n;
}

function uniqStrings(valuesLike = []) {
  const rows = Array.isArray(valuesLike) ? valuesLike : [];
  const set = new Set();
  rows.forEach((item) => {
    const v = toText(item || "");
    if (v) set.add(v);
  });
  return Array.from(set);
}

export function normalizeLayerFramework(rawLike = {}) {
  const raw = rawLike && typeof rawLike === "object" ? rawLike : {};
  const signalRaw = raw.signalLayer && typeof raw.signalLayer === "object" ? raw.signalLayer : {};
  const positionRaw = raw.positionLayer && typeof raw.positionLayer === "object" ? raw.positionLayer : {};
  const riskRaw = raw.riskLayer && typeof raw.riskLayer === "object" ? raw.riskLayer : {};
  const executionRaw = raw.executionLayer && typeof raw.executionLayer === "object" ? raw.executionLayer : {};
  const signalParams = signalRaw.params && typeof signalRaw.params === "object" ? signalRaw.params : {};

  return {
    signalLayer: {
      signalType: toText(signalRaw.signalType || "composite", "composite"),
      signalLogic: toText(signalRaw.signalLogic || "ema_fast > ema_slow", "ema_fast > ema_slow"),
      featureRefs: uniqStrings(signalRaw.featureRefs || []),
      params: {
        longThreshold: clamp(signalParams.longThreshold, 0.05, 1, 0.55),
        shortThreshold: clamp(signalParams.shortThreshold, 0.05, 1, 0.45),
        signalMargin: clamp(signalParams.signalMargin, 0.01, 0.5, 0.08),
        maxHoldBars: Math.max(4, Math.floor(toNum(signalParams.maxHoldBars, 96))),
      },
    },
    positionLayer: {
      mode: toText(positionRaw.mode || "risk_budget", "risk_budget"),
      maxPositions: Math.max(1, Math.floor(toNum(positionRaw.maxPositions, 1))),
      maxExposurePct: clamp(positionRaw.maxExposurePct, 1, 100, 35),
      minNotional: clamp(positionRaw.minNotional, 1, 5_000_000, 10),
      maxNotional: clamp(positionRaw.maxNotional, 1, 8_000_000, 80),
      leverageLimit: clamp(positionRaw.leverageLimit, 1, 125, 10),
    },
    riskLayer: {
      stopLossPct: clamp(riskRaw.stopLossPct, 0.1, 95, 2.5),
      takeProfitPct: clamp(riskRaw.takeProfitPct, 0.1, 400, 5.5),
      maxDrawdownPct: clamp(riskRaw.maxDrawdownPct, 0.1, 95, 18),
      frequencyLimitPerDay: Math.max(1, Math.floor(toNum(riskRaw.frequencyLimitPerDay, 12))),
      maxConsecutiveLoss: Math.max(1, Math.floor(toNum(riskRaw.maxConsecutiveLoss, 3))),
      riskPauseCondition: toText(riskRaw.riskPauseCondition || "", ""),
    },
    executionLayer: {
      orderMode: toText(executionRaw.orderMode || "market", "market"),
      slippageBps: clamp(executionRaw.slippageBps, 0, 300, 6),
      feeModel: toText(executionRaw.feeModel || "taker", "taker"),
      retryCount: Math.max(0, Math.floor(toNum(executionRaw.retryCount, 2))),
      retryBackoffMs: Math.max(0, Math.floor(toNum(executionRaw.retryBackoffMs, 400))),
    },
  };
}

export function buildLayerCapabilityMatrix(frameworkLike = {}) {
  const framework = normalizeLayerFramework(frameworkLike);
  return {
    signal: {
      status: "supported",
      note: "映射到 Freqtrade indicators + entry/exit 规则",
      fields: framework.signalLayer,
    },
    position: {
      status: "partial",
      note: "映射为仓位约束与执行元数据，后续补齐 custom_stake_amount",
      fields: framework.positionLayer,
    },
    risk: {
      status: "supported",
      note: "stoploss/roi 已映射，回撤与频率用于运行时保护",
      fields: framework.riskLayer,
    },
    execution: {
      status: "partial",
      note: "order/slippage/fee 已映射，重试策略用于执行层元数据",
      fields: framework.executionLayer,
    },
  };
}

export function summarizeLayerFramework(frameworkLike = {}) {
  const framework = normalizeLayerFramework(frameworkLike);
  return {
    signal: `逻辑:${framework.signalLayer.signalLogic.slice(0, 80)}`,
    position: `模式:${framework.positionLayer.mode} 暴露:${framework.positionLayer.maxExposurePct}%`,
    risk: `SL:${framework.riskLayer.stopLossPct}% TP:${framework.riskLayer.takeProfitPct}% DD:${framework.riskLayer.maxDrawdownPct}%`,
    execution: `${framework.executionLayer.orderMode}/${framework.executionLayer.feeModel} 滑点${framework.executionLayer.slippageBps}bps`,
  };
}
