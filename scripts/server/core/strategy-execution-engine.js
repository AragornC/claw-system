import { MAIN_CATEGORY_CONFIG } from "../domain/feature-taxonomy.js";

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

function toLower(valueLike, fallback = "") {
  return text(valueLike, fallback).toLowerCase();
}

function normKey(valueLike) {
  const raw = toLower(valueLike);
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
  return out.slice(0, 80);
}

function safeArray(rowsLike) {
  return Array.isArray(rowsLike) ? rowsLike : [];
}

function normalizeRangeDays(daysLike, fallback = 30) {
  const n = Math.floor(num(daysLike, fallback));
  if (n <= 0) return fallback;
  if (n > 365) return 365;
  return n;
}

function normalizeBars(barsLike) {
  const rows = safeArray(barsLike);
  return rows
    .map((item) => {
      const row = item && typeof item === "object" ? item : {};
      const tRaw = Math.floor(num(row.time || row.ts || row.t || 0, 0));
      const time = tRaw > 9_999_999_999 ? Math.floor(tRaw / 1000) : tRaw;
      const open = num(row.open, NaN);
      const high = num(row.high, NaN);
      const low = num(row.low, NaN);
      const close = num(row.close, NaN);
      const volume = Math.max(0, num(row.volume, 0));
      if (!Number.isFinite(time) || time <= 0) return null;
      if (!Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) return null;
      return { time, open, high, low, close, volume };
    })
    .filter(Boolean)
    .sort((a, b) => a.time - b.time);
}

function buildSeed(valueLike) {
  const raw = text(valueLike || "", "seed");
  let seed = 0;
  for (let i = 0; i < raw.length; i += 1) {
    seed = (seed * 131 + raw.charCodeAt(i)) % 1_000_003;
  }
  return seed;
}

function buildDeterministicBars(optionsLike = {}) {
  const options = optionsLike && typeof optionsLike === "object" ? optionsLike : {};
  const rangeDays = normalizeRangeDays(options.rangeDays || 30, 30);
  const points = Math.max(120, Math.min(2200, rangeDays * 24));
  const stepSec = Math.max(900, Math.floor(num(options.stepSec, 3600)));
  const nowSec = Math.floor(num(options.baseTimeSec, Date.now() / 1000));
  const startSec = nowSec - points * stepSec;
  const seed = Math.max(0, Math.floor(num(options.seed, 0)));
  const bars = [];
  let price = 50_000 + (seed % 3000) - 1500;
  for (let i = 0; i < points; i += 1) {
    const idx = i + seed;
    const drift = Math.sin(idx / 11) * 36 + Math.cos(idx / 17) * 28 + (idx % 53 === 0 ? 120 : -6);
    const open = price;
    const close = Math.max(900, open + drift);
    const high = Math.max(open, close) + Math.abs(Math.sin(idx / 8) * 22) + 6;
    const low = Math.min(open, close) - Math.abs(Math.cos(idx / 10) * 20) - 6;
    const volume = Math.max(1, 90 + Math.abs(Math.sin(idx / 13)) * 70 + (idx % 29));
    bars.push({
      time: startSec + i * stepSec,
      open,
      high,
      low,
      close,
      volume,
    });
    price = close;
  }
  return bars;
}

function emaSeries(valuesLike, periodLike) {
  const values = safeArray(valuesLike);
  const period = Math.max(2, Math.floor(num(periodLike, 14)));
  const out = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let ema = null;
  for (let i = 0; i < values.length; i += 1) {
    const v = num(values[i], NaN);
    if (!Number.isFinite(v)) continue;
    ema = ema == null ? v : (v * k + ema * (1 - k));
    out[i] = ema;
  }
  return out;
}

function smaSeries(valuesLike, periodLike) {
  const values = safeArray(valuesLike);
  const period = Math.max(2, Math.floor(num(periodLike, 14)));
  const out = new Array(values.length).fill(null);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < values.length; i += 1) {
    const v = num(values[i], NaN);
    if (Number.isFinite(v)) {
      sum += v;
      count += 1;
    }
    if (i >= period) {
      const prev = num(values[i - period], NaN);
      if (Number.isFinite(prev)) {
        sum -= prev;
        count -= 1;
      }
    }
    if (i >= period - 1 && count > 0) {
      out[i] = sum / count;
    }
  }
  return out;
}

function atrSeries(barsLike, periodLike = 14) {
  const bars = safeArray(barsLike);
  const period = Math.max(2, Math.floor(num(periodLike, 14)));
  const tr = new Array(bars.length).fill(null);
  for (let i = 0; i < bars.length; i += 1) {
    const high = num(bars[i]?.high, NaN);
    const low = num(bars[i]?.low, NaN);
    if (!Number.isFinite(high) || !Number.isFinite(low)) continue;
    if (i === 0) {
      tr[i] = high - low;
      continue;
    }
    const prevClose = num(bars[i - 1]?.close, NaN);
    tr[i] = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
  }
  const out = new Array(bars.length).fill(null);
  let atr = 0;
  for (let i = 0; i < bars.length; i += 1) {
    if (!Number.isFinite(tr[i])) continue;
    if (i < period) {
      atr += tr[i];
      if (i === period - 1) {
        atr /= period;
        out[i] = atr;
      }
    } else {
      atr = ((atr * (period - 1)) + tr[i]) / period;
      out[i] = atr;
    }
  }
  return out;
}

function rsiSeries(valuesLike, periodLike = 14) {
  const values = safeArray(valuesLike);
  const period = Math.max(2, Math.floor(num(periodLike, 14)));
  const out = new Array(values.length).fill(null);
  if (values.length < period + 1) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const diff = num(values[i], NaN) - num(values[i - 1], NaN);
    if (!Number.isFinite(diff)) continue;
    if (diff >= 0) gain += diff;
    else loss += Math.abs(diff);
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss <= 1e-12 ? 100 : (100 - (100 / (1 + avgGain / avgLoss)));
  for (let i = period + 1; i < values.length; i += 1) {
    const diff = num(values[i], NaN) - num(values[i - 1], NaN);
    const g = Number.isFinite(diff) && diff > 0 ? diff : 0;
    const l = Number.isFinite(diff) && diff < 0 ? Math.abs(diff) : 0;
    avgGain = ((avgGain * (period - 1)) + g) / period;
    avgLoss = ((avgLoss * (period - 1)) + l) / period;
    out[i] = avgLoss <= 1e-12 ? 100 : (100 - (100 / (1 + avgGain / avgLoss)));
  }
  return out;
}

function adxSeries(barsLike, periodLike = 14) {
  const bars = safeArray(barsLike);
  const period = Math.max(2, Math.floor(num(periodLike, 14)));
  const len = bars.length;
  const out = new Array(len).fill(null);
  if (len < period * 2 + 1) return out;
  const tr = new Array(len).fill(0);
  const pdm = new Array(len).fill(0);
  const mdm = new Array(len).fill(0);
  for (let i = 1; i < len; i += 1) {
    const upMove = num(bars[i]?.high, 0) - num(bars[i - 1]?.high, 0);
    const downMove = num(bars[i - 1]?.low, 0) - num(bars[i]?.low, 0);
    pdm[i] = (upMove > downMove && upMove > 0) ? upMove : 0;
    mdm[i] = (downMove > upMove && downMove > 0) ? downMove : 0;
    const high = num(bars[i]?.high, NaN);
    const low = num(bars[i]?.low, NaN);
    const prevClose = num(bars[i - 1]?.close, NaN);
    tr[i] = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
  }
  let trSm = 0;
  let pdmSm = 0;
  let mdmSm = 0;
  for (let i = 1; i <= period; i += 1) {
    trSm += tr[i];
    pdmSm += pdm[i];
    mdmSm += mdm[i];
  }
  const dx = new Array(len).fill(null);
  for (let i = period + 1; i < len; i += 1) {
    trSm = trSm - (trSm / period) + tr[i];
    pdmSm = pdmSm - (pdmSm / period) + pdm[i];
    mdmSm = mdmSm - (mdmSm / period) + mdm[i];
    if (trSm <= 0) continue;
    const pdi = 100 * (pdmSm / trSm);
    const mdi = 100 * (mdmSm / trSm);
    const den = pdi + mdi;
    if (den <= 0) continue;
    dx[i] = 100 * Math.abs(pdi - mdi) / den;
  }
  let adxSum = 0;
  let count = 0;
  const adxStart = period * 2;
  for (let i = period + 1; i <= adxStart && i < len; i += 1) {
    if (Number.isFinite(dx[i])) {
      adxSum += dx[i];
      count += 1;
    }
  }
  if (!count) return out;
  let adx = adxSum / count;
  out[adxStart] = adx;
  for (let i = adxStart + 1; i < len; i += 1) {
    if (!Number.isFinite(dx[i])) {
      out[i] = adx;
      continue;
    }
    adx = ((adx * (period - 1)) + dx[i]) / period;
    out[i] = adx;
  }
  return out;
}

function donchianPrevHigh(bars, index, lookbackLike = 20) {
  const lookback = Math.max(2, Math.floor(num(lookbackLike, 20)));
  if (index - lookback < 0) return null;
  let high = -Infinity;
  for (let i = index - lookback; i < index; i += 1) {
    const v = num(bars[i]?.high, NaN);
    if (Number.isFinite(v) && v > high) high = v;
  }
  return Number.isFinite(high) ? high : null;
}

function donchianPrevLow(bars, index, lookbackLike = 20) {
  const lookback = Math.max(2, Math.floor(num(lookbackLike, 20)));
  if (index - lookback < 0) return null;
  let low = Infinity;
  for (let i = index - lookback; i < index; i += 1) {
    const v = num(bars[i]?.low, NaN);
    if (Number.isFinite(v) && v < low) low = v;
  }
  return Number.isFinite(low) ? low : null;
}

function inferMainCategory(featureLike, refLike) {
  const feature = featureLike && typeof featureLike === "object" ? featureLike : {};
  const direct = toLower(feature.mainCategory || "");
  if (MAIN_CATEGORY_CONFIG[direct]) return direct;
  const mix = toLower(
    [
      feature.kind,
      feature.group,
      feature.name,
      feature.featureId,
      feature.displayMode,
      refLike,
    ].join(" "),
  );
  if (mix.includes("rsi") || mix.includes("adx") || mix.includes("momentum")) return "momentum";
  if (mix.includes("atr") || mix.includes("volatility")) return "volatility";
  if (mix.includes("volume")) return "volume";
  if (mix.includes("breakout") || mix.includes("donchian") || mix.includes("structure")) return "structure";
  if (mix.includes("risk")) return "risk";
  return "trend";
}

function resolveFeatureCatalog(featureRefsLike, lockedFeatureLike, featuresLike) {
  const refs = safeArray(featureRefsLike);
  const locks = safeArray(lockedFeatureLike);
  const features = safeArray(featuresLike);
  const byKey = new Map();
  features.forEach((itemLike) => {
    const item = itemLike && typeof itemLike === "object" ? itemLike : {};
    const idKey = normKey(item.featureId || "");
    const nameKey = normKey(item.name || item.featureName || "");
    if (idKey) byKey.set(idKey, item);
    if (nameKey) byKey.set(nameKey, item);
  });
  const mergedRefs = [];
  refs.forEach((refLike) => {
    const ref = text(refLike || "");
    if (ref) mergedRefs.push({ featureRef: ref, locked: null });
  });
  locks.forEach((itemLike) => {
    const item = itemLike && typeof itemLike === "object" ? itemLike : {};
    const ref = text(item.featureId || item.featureName || "");
    if (!ref) return;
    mergedRefs.push({ featureRef: ref, locked: item });
  });
  const dedup = new Map();
  mergedRefs.forEach((item) => {
    const key = normKey(item.featureRef || "");
    if (!key) return;
    if (!dedup.has(key)) dedup.set(key, item);
  });
  return Array.from(dedup.values()).map((item, index) => {
    const ref = text(item.featureRef || "");
    const key = normKey(ref);
    const feature = byKey.get(key) || {};
    const mainCategory = inferMainCategory(feature, ref);
    const categoryConfig = MAIN_CATEGORY_CONFIG[mainCategory] || null;
    return {
      index: index + 1,
      featureRef: ref,
      featureId: text(feature.featureId || item.locked?.featureId || ref),
      featureName: text(feature.name || feature.featureName || item.locked?.featureName || ref),
      featureVersion: text(item.locked?.featureVersion || feature?.versionInfo?.version || "v1.0.0"),
      mainCategory,
      mainCategoryLabel: text(categoryConfig?.label || "未分类"),
      kind: toLower(feature.kind || ""),
      params: feature.params && typeof feature.params === "object" ? feature.params : {},
      tags: safeArray(feature.tags).map((v) => text(v || "")).filter(Boolean).slice(0, 3),
    };
  });
}

function createStrategyExecutionEngine() {
  function runBacktest(paramsLike = {}) {
    const params = paramsLike && typeof paramsLike === "object" ? paramsLike : {};
    const strategy = params.strategy && typeof params.strategy === "object" ? params.strategy : {};
    const version = params.version && typeof params.version === "object" ? params.version : {};
    const signalLayer = version.signalLayer && typeof version.signalLayer === "object"
      ? version.signalLayer
      : (strategy.draftConfig?.signalLayer || {});
    const positionLayer = version.positionLayer && typeof version.positionLayer === "object"
      ? version.positionLayer
      : (strategy.draftConfig?.positionLayer || {});
    const riskLayer = version.riskLayer && typeof version.riskLayer === "object"
      ? version.riskLayer
      : (strategy.draftConfig?.riskLayer || {});
    const executionLayer = version.executionLayer && typeof version.executionLayer === "object"
      ? version.executionLayer
      : (strategy.draftConfig?.executionLayer || {});
    const rangeDays = normalizeRangeDays(params.rangeDays || 30, 30);
    const strategySeed = buildSeed([
      text(strategy.strategyId || strategy.name || ""),
      text(version.strategyVersionId || version.versionTag || ""),
      String(rangeDays),
    ].join("|"));
    const bars = normalizeBars(params.bars);
    const sourceBars = bars.length
      ? bars
      : buildDeterministicBars({
        rangeDays,
        stepSec: 3600,
        seed: strategySeed,
      });
    const closes = sourceBars.map((b) => num(b.close, 0));
    const volumes = sourceBars.map((b) => num(b.volume, 0));
    const emaCache = new Map();
    const smaCache = new Map();
    const atrCache = new Map();
    const adxCache = new Map();
    const rsiCache = new Map();
    function getEma(periodLike) {
      const period = Math.max(2, Math.floor(num(periodLike, 14)));
      const key = "ema_" + String(period);
      if (!emaCache.has(key)) emaCache.set(key, emaSeries(closes, period));
      return emaCache.get(key);
    }
    function getSmaVolume(periodLike) {
      const period = Math.max(2, Math.floor(num(periodLike, 20)));
      const key = "sma_volume_" + String(period);
      if (!smaCache.has(key)) smaCache.set(key, smaSeries(volumes, period));
      return smaCache.get(key);
    }
    function getAtr(periodLike) {
      const period = Math.max(2, Math.floor(num(periodLike, 14)));
      const key = "atr_" + String(period);
      if (!atrCache.has(key)) atrCache.set(key, atrSeries(sourceBars, period));
      return atrCache.get(key);
    }
    function getAdx(periodLike) {
      const period = Math.max(2, Math.floor(num(periodLike, 14)));
      const key = "adx_" + String(period);
      if (!adxCache.has(key)) adxCache.set(key, adxSeries(sourceBars, period));
      return adxCache.get(key);
    }
    function getRsi(periodLike) {
      const period = Math.max(2, Math.floor(num(periodLike, 14)));
      const key = "rsi_" + String(period);
      if (!rsiCache.has(key)) rsiCache.set(key, rsiSeries(closes, period));
      return rsiCache.get(key);
    }
    const emaFast = getEma(12);
    const emaSlow = getEma(26);
    const lockedRows = safeArray(version.lockedFeatureVersions);
    const featureCatalog = resolveFeatureCatalog(
      signalLayer.featureRefs || [],
      lockedRows,
      params.features || [],
    );
    const longThreshold = clamp(signalLayer?.params?.longThreshold, 0.05, 1, 0.55);
    const shortThreshold = clamp(signalLayer?.params?.shortThreshold, 0.05, 1, 0.55);
    const signalMargin = clamp(signalLayer?.params?.signalMargin, 0.01, 0.5, 0.08);
    const maxHoldBars = Math.max(4, Math.floor(num(signalLayer?.params?.maxHoldBars || 96, 96)));
    const exposurePct = clamp(positionLayer.maxExposurePct, 1, 100, 35) / 100;
    const minNotional = clamp(positionLayer.minNotional, 1, 5_000_000, 10);
    const maxNotional = clamp(positionLayer.maxNotional, minNotional, 8_000_000, 80);
    const stopLossPct = clamp(riskLayer.stopLossPct, 0.1, 95, 2.5) / 100;
    const takeProfitPct = clamp(riskLayer.takeProfitPct, 0.1, 400, 5.5) / 100;
    const maxDrawdownPct = clamp(riskLayer.maxDrawdownPct, 0.1, 95, 18);
    const freqLimitPerDay = Math.max(1, Math.floor(num(riskLayer.frequencyLimitPerDay, 12)));
    const maxConsecutiveLoss = Math.max(1, Math.floor(num(riskLayer.maxConsecutiveLoss, 3)));
    const slippageBps = clamp(executionLayer.slippageBps, 0, 300, 6);
    const slippageRate = slippageBps / 10_000;
    const feeModel = toLower(executionLayer.feeModel || "taker");
    const feeRate = feeModel === "maker" ? 0.0002 : 0.0006;
    const featureRowsByIndex = new Map();
    const closedTrades = [];
    const events = [];
    const equityCurve = [];
    const drawdownCurve = [];
    let nextTradeNo = 1;
    let equity = 1;
    let peakEquity = 1;
    let currentDrawdownPct = 0;
    let consecutiveLoss = 0;
    let riskPaused = false;
    let riskTriggerSent = false;
    let position = null;
    const tradeCounterByDay = new Map();
    function dayKeyByTime(tsSec) {
      const dt = new Date(Math.floor(tsSec) * 1000);
      const y = dt.getUTCFullYear();
      const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
      const d = String(dt.getUTCDate()).padStart(2, "0");
      return `${y}-${m}-${d}`;
    }
    function appendEvent(payloadLike = {}) {
      const payload = payloadLike && typeof payloadLike === "object" ? payloadLike : {};
      const event = {
        tradeId: text(payload.tradeId || ""),
        time: Math.max(0, Math.floor(num(payload.time, 0))),
        tradeType: toLower(payload.tradeType || ""),
        price: Number(num(payload.price, 0).toFixed(6)),
        quantity: Number(num(payload.quantity, 0).toFixed(8)),
        fee: Number(num(payload.fee, 0).toFixed(8)),
        slippageBps: Number(num(payload.slippageBps, slippageBps).toFixed(4)),
        reasonRule: text(payload.reasonRule || ""),
        pnlPct: Number(num(payload.pnlPct, 0).toFixed(6)),
      };
      events.push(event);
      return event;
    }
    function evaluateFeatureAt(featureLike, indexLike) {
      const feature = featureLike && typeof featureLike === "object" ? featureLike : {};
      const i = Math.max(0, Math.floor(num(indexLike, 0)));
      const close = num(sourceBars[i]?.close, 0);
      const prevClose = i > 0 ? num(sourceBars[i - 1]?.close, close) : close;
      const high = num(sourceBars[i]?.high, close);
      const low = num(sourceBars[i]?.low, close);
      const volume = num(sourceBars[i]?.volume, 0);
      const category = toLower(feature.mainCategory || "trend");
      let longScore = 0;
      let shortScore = 0;
      let value = 0;
      let isGate = false;
      let gatePass = true;
      if (category === "trend") {
        const period = Math.max(2, Math.floor(num(feature.params.period, 20)));
        const ema = getEma(period)[i];
        const base = Number.isFinite(ema) && Math.abs(ema) > 1e-12 ? ema : close;
        const deltaPct = base !== 0 ? ((close - base) / base) * 100 : 0;
        value = deltaPct;
        longScore = deltaPct > 0 ? clamp(deltaPct / 0.45, 0, 1, 0) : 0;
        shortScore = deltaPct < 0 ? clamp(Math.abs(deltaPct) / 0.45, 0, 1, 0) : 0;
      } else if (category === "momentum") {
        if (feature.kind === "rsi") {
          const period = Math.max(2, Math.floor(num(feature.params.period, 14)));
          const rsi = num(getRsi(period)[i], 50);
          value = rsi;
          longScore = rsi > 53 ? clamp((rsi - 53) / 18, 0, 1, 0) : 0;
          shortScore = rsi < 47 ? clamp((47 - rsi) / 18, 0, 1, 0) : 0;
        } else {
          const period = Math.max(2, Math.floor(num(feature.params.period, 14)));
          const adx = num(getAdx(period)[i], 0);
          const strength = clamp((adx - 18) / 24, 0, 1, 0);
          const biasLong = num(emaFast[i], close) >= num(emaSlow[i], close);
          value = adx;
          longScore = biasLong ? strength : 0;
          shortScore = biasLong ? 0 : strength;
        }
      } else if (category === "volatility") {
        const period = Math.max(2, Math.floor(num(feature.params.period, 14)));
        const atr = num(getAtr(period)[i], close * 0.003);
        const atrPct = close > 0 ? (atr / close) * 100 : 0;
        const maxVolPct = clamp(feature.params.maxVolPct || 4, 0.2, 40, 4);
        value = atrPct;
        isGate = true;
        gatePass = atrPct <= maxVolPct;
      } else if (category === "volume") {
        const period = Math.max(2, Math.floor(num(feature.params.period, 20)));
        const avgVol = num(getSmaVolume(period)[i], 0);
        const ratio = avgVol > 0 ? volume / avgVol : 1;
        const minRatio = clamp(feature.params.minRatio || 1.05, 0.1, 10, 1.05);
        value = ratio;
        const momentum = close - prevClose;
        const strength = ratio >= minRatio ? clamp((ratio - minRatio) / 1.5, 0, 1, 0) : 0;
        longScore = momentum >= 0 ? strength : 0;
        shortScore = momentum < 0 ? strength : 0;
      } else if (category === "structure") {
        const lookback = Math.max(5, Math.floor(num(feature.params.lookback, 20)));
        const prevHigh = donchianPrevHigh(sourceBars, i, lookback);
        const prevLow = donchianPrevLow(sourceBars, i, lookback);
        if (Number.isFinite(prevHigh) && close > prevHigh) longScore = 1;
        if (Number.isFinite(prevLow) && close < prevLow) shortScore = 1;
        value = Number.isFinite(prevHigh) && Number.isFinite(prevLow) ? ((close - prevLow) / Math.max(1e-9, prevHigh - prevLow)) : 0;
      } else if (category === "risk") {
        value = currentDrawdownPct;
        isGate = true;
        gatePass = currentDrawdownPct < maxDrawdownPct;
      } else {
        const pct = prevClose > 0 ? ((close - prevClose) / prevClose) * 100 : 0;
        value = pct;
        longScore = pct > 0 ? clamp(pct / 0.2, 0, 1, 0) : 0;
        shortScore = pct < 0 ? clamp(Math.abs(pct) / 0.2, 0, 1, 0) : 0;
      }
      return {
        featureRef: text(feature.featureRef || feature.featureId || ""),
        featureName: text(feature.featureName || feature.featureRef || ""),
        mainCategory: category,
        mainCategoryLabel: text(feature.mainCategoryLabel || MAIN_CATEGORY_CONFIG[category]?.label || "未分类"),
        featureVersion: text(feature.featureVersion || "v1.0.0"),
        longScore: Number(longScore.toFixed(6)),
        shortScore: Number(shortScore.toFixed(6)),
        value: Number(num(value, 0).toFixed(6)),
        isGate,
        gatePass,
      };
    }
    function computeSignal(indexLike) {
      const i = Math.max(0, Math.floor(num(indexLike, 0)));
      const rows = [];
      let directionalCount = 0;
      let longScore = 0;
      let shortScore = 0;
      const blockedReasons = [];
      featureCatalog.forEach((feature) => {
        const row = evaluateFeatureAt(feature, i);
        rows.push(row);
        if (row.isGate) {
          if (!row.gatePass) blockedReasons.push(row.mainCategory);
          return;
        }
        directionalCount += 1;
        longScore += row.longScore;
        shortScore += row.shortScore;
      });
      const baseCount = Math.max(1, directionalCount);
      const longNorm = longScore / baseCount;
      const shortNorm = shortScore / baseCount;
      let action = "flat";
      if (!blockedReasons.length) {
        if (longNorm >= longThreshold && longNorm > shortNorm + signalMargin) {
          action = "long";
        } else if (shortNorm >= shortThreshold && shortNorm > longNorm + signalMargin) {
          action = "short";
        }
      }
      featureRowsByIndex.set(i, rows);
      return {
        index: i,
        action,
        longNorm: Number(longNorm.toFixed(6)),
        shortNorm: Number(shortNorm.toFixed(6)),
        blockedReasons,
        rows,
      };
    }
    function closePosition(indexLike, closePriceLike, reasonLike) {
      if (!position) return;
      const i = Math.max(0, Math.floor(num(indexLike, 0)));
      const closePrice = num(closePriceLike, NaN);
      if (!Number.isFinite(closePrice) || closePrice <= 0) return;
      const exitFill = position.side === "long"
        ? closePrice * (1 - slippageRate)
        : closePrice * (1 + slippageRate);
      const gross = position.side === "long"
        ? (exitFill - position.entryPrice) * position.quantity
        : (position.entryPrice - exitFill) * position.quantity;
      const fee = (position.entryPrice + exitFill) * position.quantity * feeRate;
      const net = gross - fee;
      const pnlPct = position.notional > 0 ? (net / position.notional) * 100 : 0;
      equity = Math.max(0.0001, equity * (1 + (net / Math.max(1e-9, position.notional))));
      closedTrades.push({
        tradeId: position.tradeId,
        side: position.side,
        entryTime: position.entryTime,
        exitTime: sourceBars[i]?.time || position.entryTime,
        entryPrice: position.entryPrice,
        exitPrice: exitFill,
        quantity: position.quantity,
        pnlPct,
        reason: text(reasonLike || "close"),
        holdBars: Math.max(1, i - position.entryIndex),
      });
      appendEvent({
        tradeId: position.tradeId,
        time: sourceBars[i]?.time || position.entryTime,
        tradeType: "close",
        price: exitFill,
        quantity: position.quantity,
        fee,
        slippageBps,
        reasonRule: text(reasonLike || "close"),
        pnlPct,
      });
      if (pnlPct < 0) {
        consecutiveLoss += 1;
      } else {
        consecutiveLoss = 0;
      }
      if (!riskPaused && consecutiveLoss >= maxConsecutiveLoss) {
        riskPaused = true;
        appendEvent({
          tradeId: "",
          time: sourceBars[i]?.time || position.entryTime,
          tradeType: "risk_trigger",
          price: exitFill,
          quantity: 0,
          fee: 0,
          slippageBps: 0,
          reasonRule: "risk.max_consecutive_loss",
          pnlPct: 0,
        });
      }
      position = null;
    }
    function openPosition(indexLike, sideLike, signalLike) {
      const i = Math.max(0, Math.floor(num(indexLike, 0)));
      const side = toLower(sideLike || "");
      if (side !== "long" && side !== "short") return false;
      const bar = sourceBars[i];
      if (!bar) return false;
      const dayKey = dayKeyByTime(bar.time);
      const dayCount = Math.max(0, Math.floor(num(tradeCounterByDay.get(dayKey), 0)));
      if (dayCount >= freqLimitPerDay) {
        if (!riskTriggerSent) {
          appendEvent({
            tradeId: "",
            time: bar.time,
            tradeType: "risk_trigger",
            price: bar.close,
            quantity: 0,
            fee: 0,
            slippageBps: 0,
            reasonRule: "risk.frequency_limit",
            pnlPct: 0,
          });
          riskTriggerSent = true;
        }
        return false;
      }
      if (riskPaused) return false;
      const refPrice = num(bar.close, NaN);
      if (!Number.isFinite(refPrice) || refPrice <= 0) return false;
      const fillPrice = side === "long"
        ? refPrice * (1 + slippageRate)
        : refPrice * (1 - slippageRate);
      const targetNotional = clamp(equity * exposurePct, minNotional, maxNotional, minNotional);
      const quantity = targetNotional > 0 && fillPrice > 0 ? targetNotional / fillPrice : 0;
      if (!Number.isFinite(quantity) || quantity <= 0) return false;
      const stop = side === "long"
        ? fillPrice * (1 - stopLossPct)
        : fillPrice * (1 + stopLossPct);
      const take = side === "long"
        ? fillPrice * (1 + takeProfitPct)
        : fillPrice * (1 - takeProfitPct);
      const tradeId = "tr_" + String(nextTradeNo);
      nextTradeNo += 1;
      position = {
        tradeId,
        side,
        entryIndex: i,
        entryTime: bar.time,
        entryPrice: fillPrice,
        quantity,
        notional: quantity * fillPrice,
        stop,
        take,
        signal: signalLike && typeof signalLike === "object" ? signalLike : null,
      };
      tradeCounterByDay.set(dayKey, dayCount + 1);
      appendEvent({
        tradeId,
        time: bar.time,
        tradeType: side === "long" ? "buy" : "sell",
        price: fillPrice,
        quantity,
        fee: fillPrice * quantity * feeRate,
        slippageBps,
        reasonRule: side === "long" ? "signal.open_long" : "signal.open_short",
        pnlPct: 0,
      });
      return true;
    }
    const startIndex = Math.max(24, Math.floor(num(signalLayer?.params?.warmupBars, 48)));
    for (let i = 1; i < sourceBars.length; i += 1) {
      const bar = sourceBars[i];
      if (!bar) continue;
      const signal = computeSignal(i);
      if (position) {
        if (position.side === "long") {
          if (bar.low <= position.stop) {
            closePosition(i, position.stop, "risk.stop_loss");
          } else if (bar.high >= position.take) {
            closePosition(i, position.take, "risk.take_profit");
          }
        } else if (position.side === "short") {
          if (bar.high >= position.stop) {
            closePosition(i, position.stop, "risk.stop_loss");
          } else if (bar.low <= position.take) {
            closePosition(i, position.take, "risk.take_profit");
          }
        }
      }
      if (position && (i - position.entryIndex) >= maxHoldBars) {
        closePosition(i, bar.close, "risk.max_hold");
      }
      if (position && signal.action !== "flat") {
        const reverse = (position.side === "long" && signal.action === "short")
          || (position.side === "short" && signal.action === "long");
        if (reverse) {
          closePosition(i, bar.close, "signal.reverse");
        }
      }
      if (!position && i >= startIndex && !riskPaused && (signal.action === "long" || signal.action === "short")) {
        openPosition(i, signal.action, signal);
      }
      let markEq = equity;
      if (position) {
        const closeNow = num(bar.close, position.entryPrice);
        const unreal = position.side === "long"
          ? ((closeNow - position.entryPrice) / position.entryPrice)
          : ((position.entryPrice - closeNow) / position.entryPrice);
        markEq = Math.max(0.0001, equity * (1 + unreal));
      }
      peakEquity = Math.max(peakEquity, markEq);
      currentDrawdownPct = peakEquity > 0 ? ((peakEquity - markEq) / peakEquity) * 100 : 0;
      if (!riskPaused && currentDrawdownPct >= maxDrawdownPct) {
        riskPaused = true;
        appendEvent({
          tradeId: "",
          time: bar.time,
          tradeType: "risk_trigger",
          price: bar.close,
          quantity: 0,
          fee: 0,
          slippageBps: 0,
          reasonRule: "risk.max_drawdown",
          pnlPct: 0,
        });
        if (position) {
          closePosition(i, bar.close, "risk.pause_close");
        }
      }
      equityCurve.push({
        time: bar.time,
        equity: Number(markEq.toFixed(8)),
      });
      drawdownCurve.push({
        time: bar.time,
        drawdownPct: Number(currentDrawdownPct.toFixed(6)),
      });
    }
    if (position) {
      const lastIndex = sourceBars.length - 1;
      const lastBar = sourceBars[lastIndex];
      closePosition(lastIndex, num(lastBar?.close, position.entryPrice), "session.end");
    }
    const winCount = closedTrades.filter((item) => num(item.pnlPct, 0) > 0).length;
    const totalCount = closedTrades.length;
    const latestReturnPct = (equity - 1) * 100;
    const maxDrawdown = drawdownCurve.reduce((acc, item) => Math.max(acc, num(item.drawdownPct, 0)), 0);
    const summary = {
      tradeCount: totalCount,
      winRate: totalCount > 0 ? (winCount / totalCount) * 100 : 0,
      latestReturnPct,
      maxDrawdownPct: maxDrawdown,
    };
    return {
      executionReport: {
        generatedAt: new Date().toISOString(),
        timeframeDays: rangeDays,
        engine: {
          name: "thunderclaw_strategy_engine_v1",
          mode: "event_driven",
        },
        barsMeta: {
          count: sourceBars.length,
          stepSec: sourceBars.length > 1 ? Math.max(1, sourceBars[1].time - sourceBars[0].time) : 3600,
        },
        events,
        equityCurve,
        drawdownCurve,
        featureCatalog: featureCatalog.map((item) => ({
          featureRef: item.featureRef,
          featureName: item.featureName,
          featureId: item.featureId,
          featureVersion: item.featureVersion,
          mainCategory: item.mainCategory,
          mainCategoryLabel: item.mainCategoryLabel,
        })),
      },
      summary: {
        tradeCount: Math.max(0, Math.floor(summary.tradeCount)),
        winRate: Number(summary.winRate.toFixed(6)),
        latestReturnPct: Number(summary.latestReturnPct.toFixed(6)),
        maxDrawdownPct: Number(summary.maxDrawdownPct.toFixed(6)),
      },
      featureRowsByIndex,
      closedTrades,
    };
  }

  return {
    runBacktest,
  };
}

export {
  createStrategyExecutionEngine,
};

