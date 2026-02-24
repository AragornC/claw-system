(function attachStrategyFeatureRuntime(globalLike) {
  const globalObj = globalLike || (typeof window !== "undefined" ? window : {});

  const FEATURE_MAIN_CATEGORY_CONFIG = {
    trend: { key: "trend", label: "趋势类", displayMode: "trend_overlay" },
    momentum: { key: "momentum", label: "动量类", displayMode: "momentum_oscillator" },
    volatility: { key: "volatility", label: "波动类", displayMode: "volatility_risk" },
    volume: { key: "volume", label: "成交量类", displayMode: "volume_highlight" },
    structure: { key: "structure", label: "结构类", displayMode: "structure_levels" },
    risk: { key: "risk", label: "风控类", displayMode: "risk_panel" },
  };

  const FEATURE_TAG_CONFIG = {
    entry: { key: "entry", label: "入场" },
    exit: { key: "exit", label: "出场" },
    filter: { key: "filter", label: "过滤" },
    breakout: { key: "breakout", label: "突破" },
    reversal: { key: "reversal", label: "反转" },
    position: { key: "position", label: "仓位" },
    range: { key: "range", label: "震荡" },
    trend_continuation: { key: "trend_continuation", label: "趋势延续" },
  };

  const FEATURE_OUTPUT_TYPE_CONFIG = {
    boolean: { key: "boolean", label: "布尔" },
    continuous: { key: "continuous", label: "连续" },
    score: { key: "score", label: "评分" },
  };

  const FEATURE_KIND_PROFILE = {
    ema: {
      mainCategory: "trend",
      tags: ["filter", "trend_continuation"],
      outputType: "continuous",
      usageSummary: "用于识别价格是否处于顺势区间。",
      triggerLogic: "收盘价与 EMA 相对位置触发通过/过滤。",
      algorithmSummary: "EMA 对收盘价做指数平滑，近期价格权重更高。",
      algorithmSteps: ["读取最近 N 根收盘价。", "计算 alpha=2/(N+1)。", "逐根递推 EMA。", "输出最新 EMA 作为趋势门控。"],
      pseudoCode: ["ema = close[0]", "alpha = 2 / (period + 1)", "for close_t in closes[1:]: ema = ema + alpha * (close_t - ema)", "return ema"],
    },
    sma: {
      mainCategory: "trend",
      tags: ["filter", "trend_continuation"],
      outputType: "continuous",
      usageSummary: "用于平滑价格并判断中短期方向。",
      triggerLogic: "收盘价高于/低于 SMA 时给出顺势倾向。",
      algorithmSummary: "SMA 对窗口内收盘价做等权平均。",
      algorithmSteps: ["读取最近 N 根收盘价。", "窗口求和后除以 N。", "滚动窗口重复计算。", "输出最新 SMA 值。"],
      pseudoCode: ["window = closes[-period:]", "sma = sum(window) / period", "return sma"],
    },
    rsi: {
      mainCategory: "momentum",
      tags: ["entry", "reversal", "range"],
      outputType: "score",
      usageSummary: "用于判断动量强弱与超买超卖状态。",
      triggerLogic: "RSI 低于阈值偏多，高于阈值偏空。",
      algorithmSummary: "RSI 通过上涨/下跌平均幅度比值衡量动量。",
      algorithmSteps: ["计算每根收盘变化值。", "拆分上涨与下跌幅度。", "平滑平均涨跌幅。", "计算 RSI=100-100/(1+RS)。"],
      pseudoCode: ["delta = close_t - close_{t-1}", "gain = max(delta,0), loss=max(-delta,0)", "rs = avgGain / max(avgLoss,eps)", "rsi = 100 - 100 / (1 + rs)"],
    },
    adx: {
      mainCategory: "momentum",
      tags: ["filter", "trend_continuation"],
      outputType: "score",
      usageSummary: "用于衡量趋势强弱，过滤震荡区间噪音。",
      triggerLogic: "ADX 高于阈值视为趋势有效。",
      algorithmSummary: "ADX 平滑方向性差值，输出趋势强度评分。",
      algorithmSteps: ["计算 +DM/-DM 与 TR。", "平滑得到 +DI/-DI。", "计算 DX。", "对 DX 再平滑得到 ADX。"],
      pseudoCode: ["plusDM, minusDM, tr = buildDMTR()", "plusDI, minusDI = smoothDI()", "dx = abs(plusDI-minusDI)/(plusDI+minusDI)*100", "adx = wilderSmooth(dx, period)"],
    },
    atr: {
      mainCategory: "volatility",
      tags: ["filter", "position", "exit"],
      outputType: "continuous",
      usageSummary: "用于波动率度量并驱动止损止盈尺度。",
      triggerLogic: "ATR 越高，风险半径和止损距离越大。",
      algorithmSummary: "ATR 对真实波幅 TR 进行 Wilder 平滑。",
      algorithmSteps: ["计算 TR=max(H-L,|H-Cprev|,|L-Cprev|)。", "对 TR 做 Wilder 平滑。", "输出 ATR 波动尺度。", "结合倍数参数生成风控距离。"],
      pseudoCode: ["tr = max(high-low, abs(high-prevClose), abs(low-prevClose))", "atr = wilderSmooth(tr, period)", "stopDistance = atr * stopAtr"],
    },
    volume: {
      mainCategory: "volume",
      tags: ["breakout", "filter"],
      outputType: "continuous",
      usageSummary: "用于识别放量突破与缩量衰竭。",
      triggerLogic: "当前量/均量比值超过阈值触发确认。",
      algorithmSummary: "成交量均线与当前成交量比值用于判定量能状态。",
      algorithmSteps: ["读取成交量序列。", "计算 N 周期均量。", "计算当前量/均量比。", "输出量能强弱标签。"],
      pseudoCode: ["volMA = sma(volume, period)", "ratio = volume_t / max(volMA_t, eps)", "signal = ratio >= threshold"],
    },
    price_action: {
      mainCategory: "structure",
      tags: ["breakout", "reversal", "entry"],
      outputType: "boolean",
      usageSummary: "用于识别关键位突破/回踩等结构行为。",
      triggerLogic: "价格突破关键位并收盘确认时触发。",
      algorithmSummary: "基于关键价位与收盘确认规则识别结构形态。",
      algorithmSteps: ["提取最近窗口高低点。", "比较当前收盘与关键位关系。", "判断突破/回踩确认。", "输出结构触发布尔值。"],
      pseudoCode: ["level = max(high[-lookback:])", "isBreakout = close_t > level", "isRetest = low_t <= level and close_t > level", "signal = isBreakout or isRetest"],
    },
    risk_rule: {
      mainCategory: "risk",
      tags: ["position", "exit", "filter"],
      outputType: "boolean",
      usageSummary: "用于统一风控状态和下单许可控制。",
      triggerLogic: "任一风控规则触发时限制开仓或要求减仓。",
      algorithmSummary: "将风险阈值映射为状态机并输出许可状态。",
      algorithmSteps: ["读取仓位、回撤、波动输入。", "计算风险等级。", "判定开仓许可/减仓动作。", "输出风险状态。"],
      pseudoCode: ["if drawdown > maxDD: allowOpen = false", "if exposure > maxExposure: reducePosition = true", "riskState = buildRiskState(allowOpen, reducePosition)"],
    },
    custom: {
      mainCategory: "structure",
      tags: ["filter"],
      outputType: "score",
      usageSummary: "用于承载对话生成的自定义特征逻辑。",
      triggerLogic: "按结构化参数动态计算并输出结果。",
      algorithmSummary: "自定义特征由结构化参数驱动执行。",
      algorithmSteps: ["加载特征配置。", "读取市场状态。", "按规则组合计算。", "输出可用于策略决策的结果。"],
      pseudoCode: ["state = readMarketState()", "value = computeCustomFeature(state, params)", "return value"],
    },
  };

  function sfText(valueLike, fallback) {
    const s = String(valueLike == null ? "" : valueLike).trim();
    return s || String(fallback || "");
  }

  function sfNum(valueLike, fallback) {
    const n = Number(valueLike);
    return Number.isFinite(n) ? n : Number(fallback || 0);
  }

  function sfClamp(valueLike, min, max, fallback) {
    const n = sfNum(valueLike, fallback);
    if (Number.isFinite(min) && n < min) return min;
    if (Number.isFinite(max) && n > max) return max;
    return n;
  }

  function sfEscapeHtml(valueLike) {
    return String(valueLike == null ? "" : valueLike)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function sfTrimText(valueLike, maxLenLike) {
    const raw = sfText(valueLike, "");
    const maxLen = Math.max(0, Math.floor(sfNum(maxLenLike, 0)));
    if (!maxLen || raw.length <= maxLen) return raw;
    return raw.slice(0, maxLen) + "...";
  }

  function sfFormatTs(isoLike) {
    const text = sfText(isoLike, "");
    if (!text) return "-";
    const ms = Date.parse(text);
    if (!Number.isFinite(ms)) return text;
    const d = new Date(ms);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return y + "-" + m + "-" + day + " " + hh + ":" + mm;
  }

  function sfFormatBarTs(secLike) {
    const sec = sfNum(secLike, 0);
    if (!Number.isFinite(sec) || sec <= 0) return "-";
    const d = new Date(sec * 1000);
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return m + "-" + day + " " + hh + ":" + mm;
  }

  function sfUniq(valuesLike) {
    const rows = Array.isArray(valuesLike) ? valuesLike : [];
    const seen = new Set();
    const out = [];
    rows.forEach(function each(item) {
      const key = sfText(item, "").toLowerCase();
      if (!key || seen.has(key)) return;
      seen.add(key);
      out.push(key);
    });
    return out;
  }

  function inferCategoryFromGroup(groupLike) {
    const group = sfText(groupLike, "").toLowerCase();
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
    return mapping[group] || "structure";
  }

  function normalizeMainCategoryRuntime(categoryLike, fallbackLike) {
    const fallback = sfText(fallbackLike || "trend", "trend").toLowerCase();
    const key = sfText(categoryLike, "").toLowerCase();
    if (FEATURE_MAIN_CATEGORY_CONFIG[key]) return key;
    return FEATURE_MAIN_CATEGORY_CONFIG[fallback] ? fallback : "trend";
  }

  function normalizeOutputTypeRuntime(outputLike, fallbackLike) {
    const fallback = sfText(fallbackLike || "continuous", "continuous").toLowerCase();
    const key = sfText(outputLike, "").toLowerCase();
    if (FEATURE_OUTPUT_TYPE_CONFIG[key]) return key;
    return FEATURE_OUTPUT_TYPE_CONFIG[fallback] ? fallback : "continuous";
  }

  function normalizeFeatureTagsRuntime(tagsLike, fallbackLike) {
    const direct = sfUniq(tagsLike).filter(function onlyKnown(key) {
      return Boolean(FEATURE_TAG_CONFIG[key]);
    }).slice(0, 3);
    if (direct.length) return direct;
    const fallback = sfUniq(fallbackLike).filter(function onlyKnown(key) {
      return Boolean(FEATURE_TAG_CONFIG[key]);
    }).slice(0, 3);
    return fallback.length ? fallback : ["filter"];
  }

  function resolveKindProfileRuntime(kindLike, groupLike) {
    const kind = sfText(kindLike, "").toLowerCase();
    if (FEATURE_KIND_PROFILE[kind]) return FEATURE_KIND_PROFILE[kind];
    const inferred = inferCategoryFromGroup(groupLike);
    return {
      ...FEATURE_KIND_PROFILE.custom,
      mainCategory: inferred,
    };
  }

  function normalizeParamSpecsRuntime(featureLike) {
    const feature = featureLike && typeof featureLike === "object" ? featureLike : {};
    if (Array.isArray(feature.paramSpecs) && feature.paramSpecs.length) {
      return feature.paramSpecs.slice(0, 16).map(function mapSpec(item) {
        const row = item && typeof item === "object" ? item : {};
        return {
          name: sfText(row.name || ""),
          defaultValue: row.defaultValue,
          type: sfText(row.type || typeof row.defaultValue || "string"),
          note: sfText(row.note || ""),
        };
      }).filter(function hasName(item) { return Boolean(item.name); });
    }
    const params = feature.params && typeof feature.params === "object" ? feature.params : {};
    return Object.entries(params).slice(0, 16).map(function mapPair(pair) {
      return {
        name: sfText(pair[0], ""),
        defaultValue: pair[1],
        type: typeof pair[1],
        note: "",
      };
    }).filter(function hasName(item) { return Boolean(item.name); });
  }

  function normalizeFeatureVersionRuntime(featureLike) {
    const feature = featureLike && typeof featureLike === "object" ? featureLike : {};
    const raw = feature.versionInfo && typeof feature.versionInfo === "object" ? feature.versionInfo : {};
    const major = Math.max(1, Math.floor(sfNum(raw.major, 1)));
    const minor = Math.max(0, Math.floor(sfNum(raw.minor, 0)));
    const patch = Math.max(0, Math.floor(sfNum(raw.patch, 0)));
    const revision = Math.max(1, Math.floor(sfNum(raw.revision, patch + 1)));
    const version = sfText(raw.version || ("v" + major + "." + minor + "." + patch));
    return {
      major: major,
      minor: minor,
      patch: patch,
      revision: revision,
      version: version,
      notes: sfText(raw.notes || ""),
    };
  }

  function normalizeStrategyFeatureRuntime(rawLike) {
    const raw = rawLike && typeof rawLike === "object" ? rawLike : {};
    const profile = resolveKindProfileRuntime(raw.kind, raw.group);
    const mainCategory = normalizeMainCategoryRuntime(raw.mainCategory || profile.mainCategory || inferCategoryFromGroup(raw.group), profile.mainCategory || "trend");
    const tags = normalizeFeatureTagsRuntime(raw.tags, profile.tags || []);
    const outputType = normalizeOutputTypeRuntime(raw.outputType, profile.outputType || "continuous");
    const categoryConfig = FEATURE_MAIN_CATEGORY_CONFIG[mainCategory] || FEATURE_MAIN_CATEGORY_CONFIG.trend;
    const outputConfig = FEATURE_OUTPUT_TYPE_CONFIG[outputType] || FEATURE_OUTPUT_TYPE_CONFIG.continuous;
    const tagLabels = tags.map(function mapTag(key) {
      return FEATURE_TAG_CONFIG[key] ? FEATURE_TAG_CONFIG[key].label : key;
    });
    const params = raw.params && typeof raw.params === "object" ? raw.params : {};
    const algorithmSteps = Array.isArray(raw.algorithmSteps)
      ? raw.algorithmSteps.map(function mapStep(item) { return sfText(item, ""); }).filter(Boolean).slice(0, 5)
      : [];
    const pseudoCodeLines = Array.isArray(raw.pseudoCode)
      ? raw.pseudoCode.map(function mapLine(item) { return sfText(item, ""); }).filter(Boolean)
      : sfText(raw.pseudoCode, "") ? [sfText(raw.pseudoCode, "")] : [];
    const versionInfo = normalizeFeatureVersionRuntime(raw);
    const normalized = {
      featureId: sfText(raw.featureId || ""),
      name: sfText(raw.name || raw.featureId || "unnamed_feature"),
      title: sfText(raw.title || raw.name || raw.featureId || "未命名特征"),
      group: sfText(raw.group || "custom"),
      kind: sfText(raw.kind || "custom"),
      description: sfText(raw.description || raw.summary || "来自对话特征候选。"),
      params: params,
      enabled: raw.enabled !== false,
      source: sfText(raw.source || "chat_intent"),
      sourceType: sfText(raw.sourceType || raw.source || "chat_intent"),
      createdBy: sfText(raw.createdBy || "ThunderClaw"),
      createdAt: sfText(raw.createdAt || ""),
      updatedAt: sfText(raw.updatedAt || ""),
      mainCategory: mainCategory,
      mainCategoryLabel: categoryConfig.label,
      tags: tags,
      tagLabels: tagLabels,
      outputType: outputType,
      outputTypeLabel: outputConfig.label,
      displayMode: sfText(raw.displayMode || categoryConfig.displayMode || "trend_overlay"),
      usageSummary: sfText(raw.usageSummary || profile.usageSummary || "用于策略决策。"),
      triggerLogic: sfText(raw.triggerLogic || profile.triggerLogic || "满足条件时触发。"),
      algorithmSummary: sfText(raw.algorithmSummary || profile.algorithmSummary || "按结构化规则计算。"),
      algorithmSteps: algorithmSteps.length ? algorithmSteps : (profile.algorithmSteps || []).slice(0, 5),
      pseudoCode: pseudoCodeLines.length ? pseudoCodeLines : (profile.pseudoCode || []).slice(0, 10),
      paramSpecs: normalizeParamSpecsRuntime(raw),
      versionInfo: versionInfo,
      originConversationId: sfText(raw.originConversationId || ""),
      originEventId: sfNum(raw.originEventId, 0),
      originCardId: sfText(raw.originCardId || ""),
      originQuery: sfText(raw.originQuery || ""),
      originReply: sfText(raw.originReply || ""),
      originTrail: Array.isArray(raw.originTrail) ? raw.originTrail.slice(-16) : [],
    };
    return normalized;
  }

  function calcSmaSeries(values, periodLike) {
    const period = Math.max(2, Math.floor(sfNum(periodLike, 14)));
    const out = Array(values.length).fill(null);
    let sum = 0;
    for (let i = 0; i < values.length; i += 1) {
      const val = sfNum(values[i], Number.NaN);
      if (!Number.isFinite(val)) continue;
      sum += val;
      if (i >= period) {
        const prev = sfNum(values[i - period], Number.NaN);
        if (Number.isFinite(prev)) sum -= prev;
      }
      if (i >= period - 1) out[i] = sum / period;
    }
    return out;
  }

  function calcEmaSeries(values, periodLike) {
    const period = Math.max(2, Math.floor(sfNum(periodLike, 14)));
    const alpha = 2 / (period + 1);
    const out = Array(values.length).fill(null);
    let ema = null;
    for (let i = 0; i < values.length; i += 1) {
      const v = sfNum(values[i], Number.NaN);
      if (!Number.isFinite(v)) continue;
      if (ema == null) ema = v;
      else ema = (v - ema) * alpha + ema;
      out[i] = ema;
    }
    return out;
  }

  function calcRsiSeries(values, periodLike) {
    const period = Math.max(2, Math.floor(sfNum(periodLike, 14)));
    const out = Array(values.length).fill(null);
    let gain = 0;
    let loss = 0;
    for (let i = 1; i < values.length; i += 1) {
      const prev = sfNum(values[i - 1], Number.NaN);
      const curr = sfNum(values[i], Number.NaN);
      if (!Number.isFinite(prev) || !Number.isFinite(curr)) continue;
      const diff = curr - prev;
      if (i <= period) {
        gain += Math.max(diff, 0);
        loss += Math.max(-diff, 0);
        if (i === period) {
          const avgGain = gain / period;
          const avgLoss = loss / period;
          const rs = avgLoss <= 0 ? 100 : (avgGain / avgLoss);
          out[i] = 100 - (100 / (1 + rs));
        }
        continue;
      }
      gain = ((gain * (period - 1)) + Math.max(diff, 0)) / period;
      loss = ((loss * (period - 1)) + Math.max(-diff, 0)) / period;
      const rs = loss <= 0 ? 100 : (gain / loss);
      out[i] = 100 - (100 / (1 + rs));
    }
    return out;
  }

  function calcAtrSeries(highs, lows, closes, periodLike) {
    const period = Math.max(2, Math.floor(sfNum(periodLike, 14)));
    const tr = Array(highs.length).fill(null);
    for (let i = 0; i < highs.length; i += 1) {
      const h = sfNum(highs[i], Number.NaN);
      const l = sfNum(lows[i], Number.NaN);
      const cPrev = i > 0 ? sfNum(closes[i - 1], Number.NaN) : sfNum(closes[i], Number.NaN);
      if (!Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(cPrev)) continue;
      tr[i] = Math.max(h - l, Math.abs(h - cPrev), Math.abs(l - cPrev));
    }
    const out = Array(highs.length).fill(null);
    let atr = null;
    for (let i = 0; i < tr.length; i += 1) {
      const v = sfNum(tr[i], Number.NaN);
      if (!Number.isFinite(v)) continue;
      if (atr == null) atr = v;
      else atr = ((atr * (period - 1)) + v) / period;
      out[i] = atr;
    }
    return out;
  }

  function calcAdxSeries(highs, lows, closes, periodLike) {
    const period = Math.max(2, Math.floor(sfNum(periodLike, 14)));
    const len = highs.length;
    const plusDm = Array(len).fill(0);
    const minusDm = Array(len).fill(0);
    const tr = Array(len).fill(0);
    for (let i = 1; i < len; i += 1) {
      const up = sfNum(highs[i], 0) - sfNum(highs[i - 1], 0);
      const down = sfNum(lows[i - 1], 0) - sfNum(lows[i], 0);
      plusDm[i] = up > down && up > 0 ? up : 0;
      minusDm[i] = down > up && down > 0 ? down : 0;
      const h = sfNum(highs[i], 0);
      const l = sfNum(lows[i], 0);
      const cPrev = sfNum(closes[i - 1], 0);
      tr[i] = Math.max(h - l, Math.abs(h - cPrev), Math.abs(l - cPrev));
    }
    const adx = Array(len).fill(null);
    let trSm = 0;
    let plusSm = 0;
    let minusSm = 0;
    for (let i = 1; i < len; i += 1) {
      trSm = trSm - (trSm / period) + tr[i];
      plusSm = plusSm - (plusSm / period) + plusDm[i];
      minusSm = minusSm - (minusSm / period) + minusDm[i];
      if (i < period) continue;
      const pdi = trSm <= 0 ? 0 : (100 * plusSm / trSm);
      const mdi = trSm <= 0 ? 0 : (100 * minusSm / trSm);
      const dx = (pdi + mdi) <= 0 ? 0 : (100 * Math.abs(pdi - mdi) / (pdi + mdi));
      if (adx[i - 1] == null) adx[i] = dx;
      else adx[i] = ((adx[i - 1] * (period - 1)) + dx) / period;
    }
    return adx;
  }

  function resolvePreviewBarsRuntime(contextLike) {
    const context = contextLike && typeof contextLike === "object" ? contextLike : {};
    const ohlcvByTf = context.ohlcvByTf && typeof context.ohlcvByTf === "object" ? context.ohlcvByTf : {};
    const tfPrefer = sfText(context.previewTf || "auto", "auto");
    const windowSize = Math.max(60, Math.min(360, Math.floor(sfNum(context.previewWindow, 120))));
    if (tfPrefer !== "auto") {
      const rows = Array.isArray(ohlcvByTf[tfPrefer]) ? ohlcvByTf[tfPrefer] : [];
      if (rows.length >= 16) return { bars: rows.slice(-windowSize), tf: tfPrefer, windowSize: windowSize };
    }
    const priority = ["1h", "15m", "5m", "1m", "4h", "1d"];
    for (let i = 0; i < priority.length; i += 1) {
      const tf = priority[i];
      const rows = Array.isArray(ohlcvByTf[tf]) ? ohlcvByTf[tf] : [];
      if (rows.length >= 24) return { bars: rows.slice(-windowSize), tf: tf, windowSize: windowSize };
    }
    const keys = Object.keys(ohlcvByTf || {});
    for (let i = 0; i < keys.length; i += 1) {
      const rows = Array.isArray(ohlcvByTf[keys[i]]) ? ohlcvByTf[keys[i]] : [];
      if (rows.length >= 16) return { bars: rows.slice(-windowSize), tf: keys[i], windowSize: windowSize };
    }
    return { bars: [], tf: tfPrefer === "auto" ? "-" : tfPrefer, windowSize: windowSize };
  }

  function downsampleRowsRuntime(rowsLike, maxPointsLike) {
    const rows = Array.isArray(rowsLike) ? rowsLike : [];
    const maxPoints = Math.max(12, Math.min(72, Math.floor(sfNum(maxPointsLike, 36))));
    if (rows.length <= maxPoints) return rows.slice();
    const step = Math.max(1, Math.floor(rows.length / maxPoints));
    const out = [];
    for (let i = Math.max(0, rows.length - maxPoints * step); i < rows.length; i += step) {
      out.push(rows[i]);
    }
    if (out.length && out[out.length - 1] !== rows[rows.length - 1]) out.push(rows[rows.length - 1]);
    return out.slice(-maxPoints);
  }

  function seriesPathRuntime(valuesLike, minValLike, maxValLike, left, right, top, bottom) {
    const values = Array.isArray(valuesLike) ? valuesLike : [];
    const minVal = sfNum(minValLike, 0);
    const maxVal = sfNum(maxValLike, 1);
    const span = Math.max(1e-9, maxVal - minVal);
    const innerW = Math.max(1, right - left);
    const innerH = Math.max(1, bottom - top);
    const pts = [];
    for (let i = 0; i < values.length; i += 1) {
      const v = sfNum(values[i], Number.NaN);
      if (!Number.isFinite(v)) continue;
      const x = left + (i / Math.max(1, values.length - 1)) * innerW;
      const y = top + (1 - ((v - minVal) / span)) * innerH;
      pts.push([x, y]);
    }
    if (pts.length < 2) return "";
    return pts.map(function build(item, idx) {
      return (idx ? "L" : "M") + item[0].toFixed(2) + " " + item[1].toFixed(2);
    }).join(" ");
  }

  function buildCandleLayerRuntime(barsLike, left, right, top, bottom) {
    const bars = Array.isArray(barsLike) ? barsLike : [];
    const highs = bars.map(function mapHigh(item) { return sfNum(item && item.high, Number.NaN); }).filter(Number.isFinite);
    const lows = bars.map(function mapLow(item) { return sfNum(item && item.low, Number.NaN); }).filter(Number.isFinite);
    if (!highs.length || !lows.length) return { wickPath: "", bodyHtml: "", min: 0, max: 1 };
    const maxPrice = Math.max.apply(null, highs);
    const minPrice = Math.min.apply(null, lows);
    const span = Math.max(1e-9, maxPrice - minPrice);
    const innerW = Math.max(1, right - left);
    const innerH = Math.max(1, bottom - top);
    const slot = bars.length > 1 ? innerW / (bars.length - 1) : innerW;
    const wick = [];
    const bodies = [];
    function scalePrice(vLike) {
      const v = sfNum(vLike, minPrice);
      return top + (1 - ((v - minPrice) / span)) * innerH;
    }
    bars.forEach(function eachBar(barLike, idx) {
      const bar = barLike && typeof barLike === "object" ? barLike : {};
      const x = left + idx * slot;
      const yH = scalePrice(bar.high);
      const yL = scalePrice(bar.low);
      wick.push("M" + x.toFixed(2) + " " + yH.toFixed(2) + "L" + x.toFixed(2) + " " + yL.toFixed(2));
      const yO = scalePrice(bar.open);
      const yC = scalePrice(bar.close);
      const bodyTop = Math.min(yO, yC);
      const bodyH = Math.max(1, Math.abs(yO - yC));
      const bodyW = Math.max(1.6, Math.min(6, slot * 0.42));
      const color = sfNum(bar.close, 0) >= sfNum(bar.open, 0)
        ? "rgba(63,185,80,0.78)"
        : "rgba(248,81,73,0.78)";
      bodies.push(
        '<rect x="' + (x - bodyW / 2).toFixed(2) + '" y="' + bodyTop.toFixed(2)
        + '" width="' + bodyW.toFixed(2) + '" height="' + bodyH.toFixed(2)
        + '" fill="' + color + '"></rect>',
      );
    });
    return { wickPath: wick.join(""), bodyHtml: bodies.join(""), min: minPrice, max: maxPrice };
  }

  function getIndicatorSeriesRuntime(feature, barsLike) {
    const bars = Array.isArray(barsLike) ? barsLike : [];
    const period = Math.max(2, Math.floor(sfNum(feature.params && feature.params.period, 14)));
    const closes = bars.map(function mapClose(item) { return sfNum(item && item.close, Number.NaN); });
    const highs = bars.map(function mapHigh(item) { return sfNum(item && item.high, Number.NaN); });
    const lows = bars.map(function mapLow(item) { return sfNum(item && item.low, Number.NaN); });
    const volumes = bars.map(function mapVolume(item) { return sfNum(item && item.volume, Number.NaN); });
    const kind = sfText(feature.kind, "custom").toLowerCase();
    const builders = {
      ema: function buildEma() { return calcEmaSeries(closes, period); },
      sma: function buildSma() { return calcSmaSeries(closes, period); },
      rsi: function buildRsi() { return calcRsiSeries(closes, period); },
      adx: function buildAdx() { return calcAdxSeries(highs, lows, closes, period); },
      atr: function buildAtr() { return calcAtrSeries(highs, lows, closes, period); },
      volume: function buildVolume() { return calcSmaSeries(volumes, period); },
      price_action: function buildPa() { return calcSmaSeries(closes, Math.max(3, Math.floor(period / 2))); },
      risk_rule: function buildRisk() { return calcAtrSeries(highs, lows, closes, Math.max(4, period)); },
      custom: function buildCustom() { return calcSmaSeries(closes, period); },
    };
    const fn = builders[kind] || builders.custom;
    return fn();
  }

  function describeValueRuntime(feature, barLike, valueLike) {
    const featureKind = sfText(feature.kind, "custom").toLowerCase();
    const bar = barLike && typeof barLike === "object" ? barLike : {};
    const value = sfNum(valueLike, Number.NaN);
    if (!Number.isFinite(value)) return "-";
    const explainers = {
      ema: function emaExp() {
        const close = sfNum(bar.close, Number.NaN);
        if (!Number.isFinite(close)) return "-";
        return close >= value ? "Close>=EMA（趋势通过）" : "Close<EMA（趋势过滤）";
      },
      sma: function smaExp() {
        const close = sfNum(bar.close, Number.NaN);
        if (!Number.isFinite(close)) return "-";
        return close >= value ? "Close>=SMA（顺势）" : "Close<SMA（偏弱）";
      },
      rsi: function rsiExp() {
        if (value <= 30) return "RSI<=30（超卖）";
        if (value >= 70) return "RSI>=70（超买）";
        return "30<RSI<70（中性）";
      },
      adx: function adxExp() {
        const min = sfNum(feature.params && feature.params.min, 20);
        return value >= min ? ("ADX>=" + min + "（趋势有效）") : ("ADX<" + min + "（趋势偏弱）");
      },
      atr: function atrExp() {
        const stopAtr = sfNum(feature.params && feature.params.stopAtr, 1.2);
        return "ATR=" + value.toFixed(2) + "，止损距离≈" + (value * stopAtr).toFixed(2);
      },
      volume: function volExp() {
        const vol = sfNum(bar.volume, Number.NaN);
        if (!Number.isFinite(vol) || value <= 0) return "-";
        const ratio = vol / value;
        if (ratio >= 1.3) return "放量确认（ratio=" + ratio.toFixed(2) + "）";
        if (ratio <= 0.8) return "缩量状态（ratio=" + ratio.toFixed(2) + "）";
        return "量能中性（ratio=" + ratio.toFixed(2) + "）";
      },
      price_action: function paExp() {
        const close = sfNum(bar.close, Number.NaN);
        const high = sfNum(bar.high, Number.NaN);
        const low = sfNum(bar.low, Number.NaN);
        if (!Number.isFinite(close) || !Number.isFinite(high) || !Number.isFinite(low)) return "-";
        if (close >= high * 0.998) return "接近上沿（潜在突破）";
        if (close <= low * 1.002) return "接近下沿（潜在反转）";
        return "结构中性";
      },
      risk_rule: function riskExp() {
        return value >= 1 ? "风险偏高（限制开仓）" : "风险可控（允许执行）";
      },
      custom: function defaultExp() {
        return "特征值=" + value.toFixed(4);
      },
    };
    const fn = explainers[featureKind] || explainers.custom;
    return fn();
  }

  function buildSampleRowsRuntime(feature, barsLike, valuesLike, maxRowsLike) {
    const bars = Array.isArray(barsLike) ? barsLike : [];
    const values = Array.isArray(valuesLike) ? valuesLike : [];
    const maxRows = Math.max(3, Math.min(10, Math.floor(sfNum(maxRowsLike, 6))));
    const out = [];
    for (let i = bars.length - 1; i >= 0 && out.length < maxRows; i -= 1) {
      const bar = bars[i] && typeof bars[i] === "object" ? bars[i] : null;
      if (!bar) continue;
      const val = sfNum(values[i], Number.NaN);
      if (!Number.isFinite(val)) continue;
      out.push({
        idx: i,
        timeSec: Math.floor(sfNum(bar.time, 0)),
        ts: sfFormatBarTs(bar.time),
        close: Number.isFinite(sfNum(bar.close, Number.NaN)) ? sfNum(bar.close, Number.NaN) : null,
        value: val,
        explain: describeValueRuntime(feature, bar, val),
      });
    }
    return out;
  }

  function buildSampleTableRuntime(rowsLike, tfLike, optionsLike) {
    const options = optionsLike && typeof optionsLike === "object" ? optionsLike : {};
    const detailMode = Boolean(options.detailMode);
    const rows = Array.isArray(rowsLike) ? rowsLike : [];
    const tf = sfText(tfLike, "1h");
    if (!rows.length) return "";
    const body = rows.map(function mapRow(rowLike) {
      const row = rowLike && typeof rowLike === "object" ? rowLike : {};
      const timeSec = Math.floor(sfNum(row.timeSec, 0));
      const hasTime = Number.isFinite(timeSec) && timeSec > 0;
      const rowAttrs = hasTime
        ? (' data-feature-bar-time="' + sfEscapeHtml(String(timeSec)) + '"'
          + ' data-feature-tf="' + sfEscapeHtml(tf) + '"'
          + ' data-feature-value="' + sfEscapeHtml(sfNum(row.value, 0).toFixed(6)) + '"'
          + ' data-feature-label="' + sfEscapeHtml(sfText(row.explain, "")) + '"'
          + ' title="点击定位主K线"')
        : "";
      const jumpBtn = hasTime
        ? ('<button class="feature-jump-btn" type="button"'
          + ' data-feature-bar-time="' + sfEscapeHtml(String(timeSec)) + '"'
          + ' data-feature-tf="' + sfEscapeHtml(tf) + '"'
          + ' data-feature-value="' + sfEscapeHtml(sfNum(row.value, 0).toFixed(6)) + '"'
          + ' data-feature-label="' + sfEscapeHtml(sfText(row.explain, "")) + '">定位K线</button>')
        : "-";
      return "<tr" + rowAttrs + ">"
        + "<td>" + sfEscapeHtml(sfText(row.ts, "-")) + "</td>"
        + "<td>" + sfEscapeHtml("#" + String(Math.floor(sfNum(row.idx, 0)) + 1)) + "</td>"
        + "<td>" + sfEscapeHtml(row.close == null ? "-" : sfNum(row.close, 0).toFixed(2)) + "</td>"
        + "<td>" + sfEscapeHtml(sfNum(row.value, 0).toFixed(4)) + "</td>"
        + "<td>" + sfEscapeHtml(sfText(row.explain, "-")) + "</td>"
        + "<td>" + jumpBtn + "</td>"
        + "</tr>";
    }).join("");
    const tableClassName = detailMode ? "feature-sample-table detail" : "feature-sample-table";
    return '<table class="' + tableClassName + '"><thead><tr>'
      + "<th>时间</th><th>位置</th><th>Close</th><th>特征值</th><th>解释</th><th>联动</th>"
      + "</tr></thead><tbody>" + body + "</tbody></table>";
  }

  function renderTrendOverlayComponent(paramsLike) {
    const params = paramsLike && typeof paramsLike === "object" ? paramsLike : {};
    const detailMode = Boolean(params.context && params.context.detailMode);
    const feature = params.feature;
    const bars = downsampleRowsRuntime(params.bars || [], detailMode ? 76 : 38);
    if (!bars.length) return { visualHtml: "", sampleRows: [], tf: params.tf || "-", windowSize: params.windowSize || 0 };
    const indicator = downsampleRowsRuntime(getIndicatorSeriesRuntime(feature, params.bars || []).map(function mapSeries(v, idx) {
      return { idx: idx, v: v };
    }), detailMode ? 76 : 38).map(function pick(item) { return item.v; });
    const width = detailMode ? 980 : 460;
    const height = detailMode ? 280 : 96;
    const left = detailMode ? 16 : 8;
    const right = width - (detailMode ? 16 : 8);
    const top = detailMode ? 16 : 8;
    const bottom = detailMode ? 218 : 70;
    const candleLayer = buildCandleLayerRuntime(bars, left, right, top, bottom);
    const validIndicator = indicator.filter(function onlyFinite(v) { return Number.isFinite(sfNum(v, Number.NaN)); });
    const minVal = validIndicator.length ? Math.min.apply(null, validIndicator.concat([candleLayer.min])) : candleLayer.min;
    const maxVal = validIndicator.length ? Math.max.apply(null, validIndicator.concat([candleLayer.max])) : candleLayer.max;
    const linePath = seriesPathRuntime(indicator, minVal, maxVal, left, right, top, bottom);
    const firstLabel = bars.length ? sfFormatBarTs(bars[0].time) : "-";
    const lastLabel = bars.length ? sfFormatBarTs(bars[bars.length - 1].time) : "-";
    const svg = '<svg class="feature-preview-svg' + (detailMode ? " large" : "") + '" viewBox="0 0 ' + width + " " + height + '" preserveAspectRatio="none">'
      + '<path d="' + candleLayer.wickPath + '" fill="none" stroke="rgba(139,148,158,0.55)" stroke-width="1"></path>'
      + candleLayer.bodyHtml
      + '<path d="' + linePath + '" fill="none" stroke="rgba(88,166,255,0.95)" stroke-width="1.6"></path>'
      + '<text x="' + left + '" y="' + (height - (detailMode ? 10 : 2)) + '" fill="rgba(139,148,158,0.86)" font-size="' + (detailMode ? "12" : "8") + '">' + sfEscapeHtml(firstLabel) + "</text>"
      + '<text x="' + right + '" y="' + (height - (detailMode ? 10 : 2)) + '" text-anchor="end" fill="rgba(139,148,158,0.86)" font-size="' + (detailMode ? "12" : "8") + '">' + sfEscapeHtml(lastLabel) + "</text>"
      + "</svg>";
    const fullSeries = getIndicatorSeriesRuntime(feature, params.bars || []);
    return {
      visualHtml: '<div class="meta">模板：K线 + 指标线叠加（趋势） · TF=' + sfEscapeHtml(sfText(params.tf, "-")) + "</div>" + svg,
      sampleRows: buildSampleRowsRuntime(feature, params.bars || [], fullSeries, detailMode ? 10 : 6),
      tf: params.tf || "-",
      windowSize: params.windowSize || 0,
    };
  }

  function renderMomentumOscillatorComponent(paramsLike) {
    const params = paramsLike && typeof paramsLike === "object" ? paramsLike : {};
    const detailMode = Boolean(params.context && params.context.detailMode);
    const feature = params.feature;
    const bars = downsampleRowsRuntime(params.bars || [], detailMode ? 72 : 36);
    if (!bars.length) return { visualHtml: "", sampleRows: [], tf: params.tf || "-", windowSize: params.windowSize || 0 };
    const width = detailMode ? 980 : 460;
    const height = detailMode ? 320 : 108;
    const left = detailMode ? 16 : 8;
    const right = width - (detailMode ? 16 : 8);
    const topA = detailMode ? 16 : 8;
    const bottomA = detailMode ? 150 : 52;
    const topB = detailMode ? 180 : 64;
    const bottomB = detailMode ? 292 : 98;
    const candleLayer = buildCandleLayerRuntime(bars, left, right, topA, bottomA);
    const fullSeries = getIndicatorSeriesRuntime(feature, params.bars || []);
    const sampledSeries = downsampleRowsRuntime(fullSeries, detailMode ? 72 : 36);
    const valid = sampledSeries.filter(function finite(v) { return Number.isFinite(sfNum(v, Number.NaN)); });
    const minVal = valid.length ? Math.min.apply(null, valid.concat([0])) : 0;
    const maxVal = valid.length ? Math.max.apply(null, valid.concat([100])) : 100;
    const linePath = seriesPathRuntime(sampledSeries, minVal, maxVal, left, right, topB, bottomB);
    const lowLine = seriesPathRuntime([30, 30], 0, 100, left, right, topB, bottomB);
    const highLine = seriesPathRuntime([70, 70], 0, 100, left, right, topB, bottomB);
    const svg = '<svg class="feature-preview-svg' + (detailMode ? " large" : "") + '" viewBox="0 0 ' + width + " " + height + '" preserveAspectRatio="none">'
      + '<path d="' + candleLayer.wickPath + '" fill="none" stroke="rgba(139,148,158,0.55)" stroke-width="1"></path>'
      + candleLayer.bodyHtml
      + '<line x1="' + left + '" y1="' + topB + '" x2="' + right + '" y2="' + topB + '" stroke="rgba(139,148,158,0.20)" stroke-width="1"></line>'
      + '<line x1="' + left + '" y1="' + bottomB + '" x2="' + right + '" y2="' + bottomB + '" stroke="rgba(139,148,158,0.20)" stroke-width="1"></line>'
      + '<path d="' + lowLine + '" fill="none" stroke="rgba(210,153,34,0.45)" stroke-width="1" stroke-dasharray="3 3"></path>'
      + '<path d="' + highLine + '" fill="none" stroke="rgba(248,81,73,0.45)" stroke-width="1" stroke-dasharray="3 3"></path>'
      + '<path d="' + linePath + '" fill="none" stroke="rgba(121,192,255,0.95)" stroke-width="1.5"></path>'
      + "</svg>";
    return {
      visualHtml: '<div class="meta">模板：K线 + 副图震荡指标（动量） · TF=' + sfEscapeHtml(sfText(params.tf, "-")) + "</div>" + svg,
      sampleRows: buildSampleRowsRuntime(feature, params.bars || [], fullSeries, detailMode ? 10 : 6),
      tf: params.tf || "-",
      windowSize: params.windowSize || 0,
    };
  }

  function renderVolatilityRiskComponent(paramsLike) {
    const params = paramsLike && typeof paramsLike === "object" ? paramsLike : {};
    const detailMode = Boolean(params.context && params.context.detailMode);
    const feature = params.feature;
    const bars = Array.isArray(params.bars) ? params.bars : [];
    if (!bars.length) return { visualHtml: "", sampleRows: [], tf: params.tf || "-", windowSize: params.windowSize || 0 };
    const highs = bars.map(function h(item) { return sfNum(item && item.high, Number.NaN); });
    const lows = bars.map(function l(item) { return sfNum(item && item.low, Number.NaN); });
    const closes = bars.map(function c(item) { return sfNum(item && item.close, Number.NaN); });
    const period = Math.max(2, Math.floor(sfNum(feature.params && feature.params.period, 14)));
    const series = calcAtrSeries(highs, lows, closes, period);
    const sampledSeries = downsampleRowsRuntime(series, detailMode ? 88 : 42);
    const valid = sampledSeries.filter(function finite(v) { return Number.isFinite(sfNum(v, Number.NaN)); });
    const latest = valid.length ? valid[valid.length - 1] : 0;
    const max = valid.length ? Math.max.apply(null, valid) : 1;
    const level = latest >= max * 0.72 ? "高风险" : (latest >= max * 0.42 ? "中风险" : "低风险");
    const levelClass = level === "高风险" ? "warn" : (level === "中风险" ? "ok" : "");
    const width = detailMode ? 980 : 460;
    const height = detailMode ? 240 : 86;
    const left = detailMode ? 16 : 8;
    const right = width - (detailMode ? 16 : 8);
    const top = detailMode ? 30 : 10;
    const bottom = detailMode ? 170 : 62;
    const path = seriesPathRuntime(sampledSeries, Math.min.apply(null, valid.concat([0])), Math.max.apply(null, valid.concat([1])), left, right, top, bottom);
    const svg = '<svg class="feature-preview-svg' + (detailMode ? " large" : "") + '" viewBox="0 0 ' + width + " " + height + '" preserveAspectRatio="none">'
      + '<path d="' + path + '" fill="none" stroke="rgba(210,153,34,0.92)" stroke-width="1.8"></path>'
      + "</svg>";
    const panel = '<div class="meta" style="display:flex;gap:6px;flex-wrap:wrap;">'
      + '<span class="tag ' + levelClass + '">风险等级：' + sfEscapeHtml(level) + "</span>"
      + '<span class="tag">ATR=' + sfEscapeHtml(sfNum(latest, 0).toFixed(4)) + "</span>"
      + '<span class="tag">period=' + sfEscapeHtml(String(period)) + "</span>"
      + "</div>";
    return {
      visualHtml: '<div class="meta">模板：风险等级卡片 + 波动趋势图（波动） · TF=' + sfEscapeHtml(sfText(params.tf, "-")) + "</div>" + panel + svg,
      sampleRows: buildSampleRowsRuntime(feature, bars, series, detailMode ? 10 : 6),
      tf: params.tf || "-",
      windowSize: params.windowSize || 0,
    };
  }

  function renderVolumeHighlightComponent(paramsLike) {
    const params = paramsLike && typeof paramsLike === "object" ? paramsLike : {};
    const detailMode = Boolean(params.context && params.context.detailMode);
    const feature = params.feature;
    const bars = downsampleRowsRuntime(params.bars || [], detailMode ? 68 : 34);
    if (!bars.length) return { visualHtml: "", sampleRows: [], tf: params.tf || "-", windowSize: params.windowSize || 0 };
    const width = detailMode ? 980 : 460;
    const height = detailMode ? 300 : 106;
    const left = detailMode ? 16 : 8;
    const right = width - (detailMode ? 16 : 8);
    const topA = detailMode ? 18 : 8;
    const bottomA = detailMode ? 152 : 56;
    const topB = detailMode ? 182 : 66;
    const bottomB = detailMode ? 288 : 98;
    const candleLayer = buildCandleLayerRuntime(bars, left, right, topA, bottomA);
    const vols = bars.map(function v(item) { return sfNum(item && item.volume, Number.NaN); });
    const volMa = calcSmaSeries(vols, Math.max(2, Math.floor(sfNum(feature.params && feature.params.period, 14))));
    const vMax = Math.max.apply(null, vols.filter(Number.isFinite).concat([1]));
    const innerW = Math.max(1, right - left);
    const slot = bars.length > 1 ? innerW / (bars.length - 1) : innerW;
    const volRects = [];
    bars.forEach(function eachBar(barLike, idx) {
      const bar = barLike && typeof barLike === "object" ? barLike : {};
      const x = left + idx * slot;
      const volume = sfNum(bar.volume, 0);
      const ratio = volume / Math.max(1e-9, sfNum(volMa[idx], volume || 1));
      const h = ((volume / Math.max(1e-9, vMax)) * (bottomB - topB));
      const y = bottomB - h;
      const color = ratio >= 1.3 ? "rgba(210,153,34,0.85)" : "rgba(88,166,255,0.52)";
      const w = Math.max(1.4, Math.min(6.6, slot * 0.52));
      volRects.push('<rect x="' + (x - w / 2).toFixed(2) + '" y="' + y.toFixed(2) + '" width="' + w.toFixed(2) + '" height="' + h.toFixed(2) + '" fill="' + color + '"></rect>');
    });
    const svg = '<svg class="feature-preview-svg' + (detailMode ? " large" : "") + '" viewBox="0 0 ' + width + " " + height + '" preserveAspectRatio="none">'
      + '<path d="' + candleLayer.wickPath + '" fill="none" stroke="rgba(139,148,158,0.55)" stroke-width="1"></path>'
      + candleLayer.bodyHtml
      + volRects.join("")
      + "</svg>";
    const fullSeries = calcSmaSeries((params.bars || []).map(function m(item) { return sfNum(item && item.volume, Number.NaN); }), Math.max(2, Math.floor(sfNum(feature.params && feature.params.period, 14))));
    return {
      visualHtml: '<div class="meta">模板：K线 + 成交量高亮（成交量） · TF=' + sfEscapeHtml(sfText(params.tf, "-")) + "</div>" + svg,
      sampleRows: buildSampleRowsRuntime(feature, params.bars || [], fullSeries, detailMode ? 10 : 6),
      tf: params.tf || "-",
      windowSize: params.windowSize || 0,
    };
  }

  function renderStructureLevelsComponent(paramsLike) {
    const params = paramsLike && typeof paramsLike === "object" ? paramsLike : {};
    const detailMode = Boolean(params.context && params.context.detailMode);
    const feature = params.feature;
    const bars = downsampleRowsRuntime(params.bars || [], detailMode ? 80 : 40);
    if (!bars.length) return { visualHtml: "", sampleRows: [], tf: params.tf || "-", windowSize: params.windowSize || 0 };
    const width = detailMode ? 980 : 460;
    const height = detailMode ? 270 : 92;
    const left = detailMode ? 16 : 8;
    const right = width - (detailMode ? 16 : 8);
    const top = detailMode ? 16 : 8;
    const bottom = detailMode ? 226 : 72;
    const candleLayer = buildCandleLayerRuntime(bars, left, right, top, bottom);
    const lookback = Math.max(8, Math.min(48, Math.floor(sfNum(feature.params && feature.params.lookback, 20))));
    const focus = bars.slice(-lookback);
    const high = Math.max.apply(null, focus.map(function m(item) { return sfNum(item && item.high, Number.NaN); }).filter(Number.isFinite).concat([candleLayer.max]));
    const low = Math.min.apply(null, focus.map(function m(item) { return sfNum(item && item.low, Number.NaN); }).filter(Number.isFinite).concat([candleLayer.min]));
    const levelTopY = top + (1 - ((high - candleLayer.min) / Math.max(1e-9, candleLayer.max - candleLayer.min))) * (bottom - top);
    const levelBottomY = top + (1 - ((low - candleLayer.min) / Math.max(1e-9, candleLayer.max - candleLayer.min))) * (bottom - top);
    const lastClose = sfNum(bars[bars.length - 1] && bars[bars.length - 1].close, 0);
    const trigger = lastClose >= high ? "突破上沿" : (lastClose <= low ? "跌破下沿" : "区间内");
    const triggerColor = trigger === "区间内" ? "rgba(139,148,158,0.86)" : "rgba(210,153,34,0.9)";
    const svg = '<svg class="feature-preview-svg' + (detailMode ? " large" : "") + '" viewBox="0 0 ' + width + " " + height + '" preserveAspectRatio="none">'
      + '<path d="' + candleLayer.wickPath + '" fill="none" stroke="rgba(139,148,158,0.55)" stroke-width="1"></path>'
      + candleLayer.bodyHtml
      + '<line x1="' + left + '" y1="' + levelTopY.toFixed(2) + '" x2="' + right + '" y2="' + levelTopY.toFixed(2) + '" stroke="rgba(210,153,34,0.75)" stroke-width="1.2" stroke-dasharray="4 3"></line>'
      + '<line x1="' + left + '" y1="' + levelBottomY.toFixed(2) + '" x2="' + right + '" y2="' + levelBottomY.toFixed(2) + '" stroke="rgba(88,166,255,0.75)" stroke-width="1.2" stroke-dasharray="4 3"></line>'
      + '<text x="' + right + '" y="' + (top + 10) + '" text-anchor="end" fill="' + triggerColor + '" font-size="9">' + sfEscapeHtml(trigger) + "</text>"
      + "</svg>";
    const fullSeries = getIndicatorSeriesRuntime(feature, params.bars || []);
    return {
      visualHtml: '<div class="meta">模板：K线 + 关键位/箱体/触发标记（结构） · TF=' + sfEscapeHtml(sfText(params.tf, "-")) + "</div>" + svg,
      sampleRows: buildSampleRowsRuntime(feature, params.bars || [], fullSeries, detailMode ? 10 : 6),
      tf: params.tf || "-",
      windowSize: params.windowSize || 0,
    };
  }

  function renderRiskPanelComponent(paramsLike) {
    const params = paramsLike && typeof paramsLike === "object" ? paramsLike : {};
    const detailMode = Boolean(params.context && params.context.detailMode);
    const feature = params.feature;
    const bars = Array.isArray(params.bars) ? params.bars : [];
    const rows = bars.slice(-8);
    const riskScores = rows.map(function each(item) {
      const high = sfNum(item && item.high, 0);
      const low = sfNum(item && item.low, 0);
      const close = Math.max(1e-9, sfNum(item && item.close, 0));
      return ((high - low) / close) * 100;
    });
    const last = riskScores.length ? riskScores[riskScores.length - 1] : 0;
    const max = riskScores.length ? Math.max.apply(null, riskScores) : 0;
    const riskState = last >= max * 0.75 ? "限制开仓" : (last >= max * 0.45 ? "谨慎执行" : "正常执行");
    const panel = '<div class="detail-block">'
      + '<div class="detail-title">风控状态面板</div>'
      + '<div class="meta">当前状态：<span class="tag ' + (riskState === "限制开仓" ? "warn" : "ok") + '">' + sfEscapeHtml(riskState) + "</span></div>"
      + '<div class="meta">输出类型：' + sfEscapeHtml(feature.outputTypeLabel) + "</div>"
      + '<div class="meta">波动代理值：' + sfEscapeHtml(last.toFixed(3)) + "%</div>"
      + "</div>";
    const derivedRows = rows.map(function mapRow(item, idx) {
      return {
        idx: idx,
        timeSec: Math.floor(sfNum(item && item.time, 0)),
        ts: sfFormatBarTs(item && item.time),
        close: sfNum(item && item.close, Number.NaN),
        value: sfNum(riskScores[idx], 0),
        explain: sfNum(riskScores[idx], 0) >= max * 0.75 ? "触发风险约束" : "风险可控",
      };
    }).reverse().slice(0, detailMode ? 10 : 6);
    return {
      visualHtml: '<div class="meta">模板：状态面板展示（风控，无需K线）</div>' + panel,
      sampleRows: derivedRows,
      tf: params.tf || "-",
      windowSize: params.windowSize || 0,
    };
  }

  const FEATURE_DISPLAY_COMPONENTS = {
    trend_overlay: renderTrendOverlayComponent,
    momentum_oscillator: renderMomentumOscillatorComponent,
    volatility_risk: renderVolatilityRiskComponent,
    volume_highlight: renderVolumeHighlightComponent,
    structure_levels: renderStructureLevelsComponent,
    risk_panel: renderRiskPanelComponent,
  };

  function renderFeatureVisualizationRuntime(featureLike, contextLike) {
    const feature = normalizeStrategyFeatureRuntime(featureLike);
    const context = contextLike && typeof contextLike === "object" ? contextLike : {};
    const detailMode = Boolean(context.detailMode);
    const barsPayload = resolvePreviewBarsRuntime(context);
    const component = FEATURE_DISPLAY_COMPONENTS[feature.displayMode]
      || FEATURE_DISPLAY_COMPONENTS[(FEATURE_MAIN_CATEGORY_CONFIG[feature.mainCategory] || {}).displayMode]
      || FEATURE_DISPLAY_COMPONENTS.trend_overlay;
    const result = component({
      feature: feature,
      bars: barsPayload.bars,
      tf: barsPayload.tf,
      windowSize: barsPayload.windowSize,
      context: context,
    }) || { visualHtml: "", sampleRows: [], tf: barsPayload.tf, windowSize: barsPayload.windowSize };
    const sampleTable = buildSampleTableRuntime(result.sampleRows, result.tf || barsPayload.tf, { detailMode: detailMode });
    return {
      html: result.visualHtml + (sampleTable || ""),
      tf: sfText(result.tf || barsPayload.tf || "-"),
      windowSize: Math.floor(sfNum(result.windowSize || barsPayload.windowSize || 0)),
    };
  }

  function renderParamTableRuntime(paramSpecsLike) {
    const specs = Array.isArray(paramSpecsLike) ? paramSpecsLike : [];
    if (!specs.length) return '<div class="meta">暂无参数。</div>';
    const rows = specs.slice(0, 20).map(function mapRow(item) {
      const row = item && typeof item === "object" ? item : {};
      const valueRaw = row.defaultValue;
      const valueText = typeof valueRaw === "number"
        ? Number(valueRaw).toString()
        : typeof valueRaw === "boolean"
          ? String(Boolean(valueRaw))
          : sfText(valueRaw, "");
      return "<tr>"
        + "<td>" + sfEscapeHtml(sfText(row.name, "-")) + "</td>"
        + "<td>" + sfEscapeHtml(sfText(valueText, "-")) + "</td>"
        + "<td>" + sfEscapeHtml(sfText(row.type || typeof valueRaw || "-", "-")) + "</td>"
        + "<td>" + sfEscapeHtml(sfText(row.note || "-", "-")) + "</td>"
        + "</tr>";
    }).join("");
    return '<table class="feature-sample-table"><thead><tr>'
      + "<th>参数</th><th>默认值</th><th>类型</th><th>说明</th>"
      + "</tr></thead><tbody>" + rows + "</tbody></table>";
  }

  function renderOriginTrailRuntime(featureLike, maxLike) {
    const feature = featureLike && typeof featureLike === "object" ? featureLike : {};
    const trail = Array.isArray(feature.originTrail) ? feature.originTrail.slice() : [];
    const limit = Math.max(1, Math.min(8, Math.floor(sfNum(maxLike, 4))));
    if (!trail.length) return "";
    return trail.slice(-limit).reverse().map(function mapTrail(itemLike) {
      const row = itemLike && typeof itemLike === "object" ? itemLike : {};
      const eventId = Math.floor(sfNum(row.eventId, 0));
      const line = [
        sfFormatTs(row.ts),
        sfText(row.source, ""),
        row.conversationId ? ("会话=" + sfText(row.conversationId, "")) : "",
        eventId > 0 ? ("消息#" + String(eventId)) : "",
        row.cardId ? ("卡片=" + sfText(row.cardId, "")) : "",
      ].filter(Boolean).join(" · ");
      const jumpBtn = eventId > 0
        ? ('<button class="feature-jump-btn" type="button" data-feature-jump-event="' + sfEscapeHtml(String(eventId)) + '">跳转对话</button>')
        : "";
      const q = sfTrimText(row.query, 120);
      return '<div class="meta mini-mono">' + sfEscapeHtml(line) + jumpBtn + (q ? ("<br/>Q: " + sfEscapeHtml(q)) : "") + "</div>";
    }).join("");
  }

  function renderStrategyFeatureCardRuntime(featureLike, contextLike) {
    const feature = normalizeStrategyFeatureRuntime(featureLike);
    const context = contextLike && typeof contextLike === "object" ? contextLike : {};
    const itemKey = sfText(context.itemKey || feature.featureId || feature.name || "");
    const listTags = feature.tags.slice(0, 2).map(function mapTag(key) {
      const label = FEATURE_TAG_CONFIG[key] ? FEATURE_TAG_CONFIG[key].label : key;
      return '<span class="tag">' + sfEscapeHtml(label) + "</span>";
    }).join("");
    const createdAt = sfFormatTs(feature.createdAt);
    const updatedAt = sfFormatTs(feature.updatedAt);
    const headerTags = '<span class="tag">' + sfEscapeHtml(feature.mainCategoryLabel) + "</span>"
      + listTags
      + '<span class="tag">' + sfEscapeHtml(feature.outputTypeLabel) + "</span>"
      + '<span class="tag ' + (feature.enabled ? "ok" : "warn") + '">' + (feature.enabled ? "启用" : "关闭") + "</span>";
    return '<div class="strategy-feature-item">'
      + '<div class="head"><div class="name">' + sfEscapeHtml(feature.title) + '</div><div class="tags">' + headerTags + "</div></div>"
      + '<div class="meta">id=' + sfEscapeHtml(feature.featureId || "-") + " · 创建=" + sfEscapeHtml(createdAt) + " · 更新=" + sfEscapeHtml(updatedAt) + "</div>"
      + '<div class="meta">用途：' + sfEscapeHtml(feature.usageSummary) + "</div>"
      + '<div class="meta">触发逻辑：' + sfEscapeHtml(feature.triggerLogic) + "</div>"
      + '<div class="strategy-feature-item-actions">'
      + '<button class="feature-open-detail-btn" type="button" data-feature-detail-key="' + sfEscapeHtml(itemKey) + '">查看详情</button>'
      + "</div>"
      + "</div>";
  }

  function renderStrategyFeatureDetailModalRuntime(featureLike, contextLike) {
    const feature = normalizeStrategyFeatureRuntime(featureLike);
    const context = contextLike && typeof contextLike === "object" ? contextLike : {};
    const detailContext = {
      ...context,
      detailMode: true,
      previewWindow: Math.max(180, Math.floor(sfNum(context.previewWindow, 220))),
      originTrailLimit: Math.max(6, Math.floor(sfNum(context.originTrailLimit, 8))),
    };
    const preview = renderFeatureVisualizationRuntime(feature, detailContext);
    const createdAt = sfFormatTs(feature.createdAt);
    const updatedAt = sfFormatTs(feature.updatedAt);
    const trailHtml = renderOriginTrailRuntime(feature, detailContext.originTrailLimit);
    const stepsHtml = feature.algorithmSteps.slice(0, 5).map(function mapStep(step, idx) {
      return "<li>" + sfEscapeHtml(String(idx + 1) + ". " + sfText(step, "")) + "</li>";
    }).join("");
    const pseudoCodeText = feature.pseudoCode.join("\n");
    const version = feature.versionInfo || {};
    const allTags = feature.tags.slice(0, 3).map(function mapTag(key) {
      const label = FEATURE_TAG_CONFIG[key] ? FEATURE_TAG_CONFIG[key].label : key;
      return '<span class="tag">' + sfEscapeHtml(label) + "</span>";
    }).join("");
    return '<div class="feature-detail-view">'
      + '<div class="feature-detail-hero">'
      + '<div class="feature-detail-title-wrap">'
      + '<div class="feature-detail-title">' + sfEscapeHtml(feature.title) + "</div>"
      + '<div class="feature-detail-sub">主分类：<span class="tag">' + sfEscapeHtml(feature.mainCategoryLabel) + '</span> 功能标签：' + (allTags || '<span class="tag">过滤</span>') + ' 输出：<span class="tag">' + sfEscapeHtml(feature.outputTypeLabel) + "</span></div>"
      + "</div>"
      + '<div class="feature-detail-summary">'
      + '<div class="meta">用途：' + sfEscapeHtml(feature.usageSummary) + "</div>"
      + '<div class="meta">触发逻辑：' + sfEscapeHtml(feature.triggerLogic) + "</div>"
      + "</div>"
      + "</div>"
      + '<div class="feature-detail-grid">'
      + '<div class="feature-detail-card feature-detail-card-wide"><div class="feature-detail-card-title">分类可视化（' + sfEscapeHtml(feature.mainCategoryLabel) + ' · display_mode=' + sfEscapeHtml(feature.displayMode) + "）</div>" + preview.html + "</div>"
      + '<div class="feature-detail-card"><div class="feature-detail-card-title">来源模块</div>'
      + '<div class="meta">来源类型：' + sfEscapeHtml(feature.sourceType || feature.source || "-") + "</div>"
      + '<div class="meta">创建人：' + sfEscapeHtml(feature.createdBy || "ThunderClaw") + "</div>"
      + '<div class="meta">创建时间：' + sfEscapeHtml(createdAt) + "</div>"
      + '<div class="meta">最近更新：' + sfEscapeHtml(updatedAt) + "</div>"
      + (feature.originQuery ? ('<div class="meta">触发问题：' + sfEscapeHtml(sfTrimText(feature.originQuery, 220)) + "</div>") : "")
      + (feature.originReply ? ('<div class="meta">触发回复：' + sfEscapeHtml(sfTrimText(feature.originReply, 220)) + "</div>") : "")
      + (trailHtml ? ('<div class="meta" style="margin-top:6px;">最近链路：</div>' + trailHtml) : "")
      + "</div>"
      + '<div class="feature-detail-card"><div class="feature-detail-card-title">算法摘要与计算步骤</div>'
      + '<div class="meta">' + sfEscapeHtml(feature.algorithmSummary) + "</div>"
      + (stepsHtml ? ('<ol class="meta feature-step-list">' + stepsHtml + "</ol>") : '<div class="meta">暂无步骤。</div>')
      + "</div>"
      + '<div class="feature-detail-card"><div class="feature-detail-card-title">参数表（默认值）</div>'
      + renderParamTableRuntime(feature.paramSpecs)
      + "</div>"
      + '<div class="feature-detail-card"><details class="feature-detail-fold" open><summary>伪代码（折叠）</summary><pre class="mini-mono">' + sfEscapeHtml(pseudoCodeText || "// 暂无伪代码") + "</pre></details></div>"
      + '<div class="feature-detail-card"><details class="feature-detail-fold"><summary>版本信息（折叠）</summary>'
      + '<div class="meta">版本：' + sfEscapeHtml(sfText(version.version, "v1.0.0")) + "</div>"
      + '<div class="meta">修订：' + sfEscapeHtml(String(Math.floor(sfNum(version.revision, 1)))) + "</div>"
      + (sfText(version.notes, "") ? ('<div class="meta">备注：' + sfEscapeHtml(sfText(version.notes, "")) + "</div>") : "")
      + "</details></div>"
      + "</div>"
      + "</div>";
  }

  function getStrategyFeatureConfigRuntime() {
    return {
      mainCategories: FEATURE_MAIN_CATEGORY_CONFIG,
      tags: FEATURE_TAG_CONFIG,
      outputTypes: FEATURE_OUTPUT_TYPE_CONFIG,
      kindProfiles: FEATURE_KIND_PROFILE,
    };
  }

  function getStrategyFeatureLabelRuntime(typeLike, keyLike) {
    const type = sfText(typeLike, "").toLowerCase();
    const key = sfText(keyLike, "").toLowerCase();
    const maps = {
      category: FEATURE_MAIN_CATEGORY_CONFIG,
      maincategory: FEATURE_MAIN_CATEGORY_CONFIG,
      tag: FEATURE_TAG_CONFIG,
      output: FEATURE_OUTPUT_TYPE_CONFIG,
      outputtype: FEATURE_OUTPUT_TYPE_CONFIG,
    };
    const mapping = maps[type] || {};
    const row = mapping[key];
    return row ? sfText(row.label || row.key || key) : key;
  }

  globalObj.getStrategyFeatureConfigRuntime = getStrategyFeatureConfigRuntime;
  globalObj.getStrategyFeatureLabelRuntime = getStrategyFeatureLabelRuntime;
  globalObj.normalizeStrategyFeatureRuntime = normalizeStrategyFeatureRuntime;
  globalObj.renderStrategyFeatureCardRuntime = renderStrategyFeatureCardRuntime;
  globalObj.renderStrategyFeatureDetailModalRuntime = renderStrategyFeatureDetailModalRuntime;
})(typeof window !== "undefined" ? window : this);
