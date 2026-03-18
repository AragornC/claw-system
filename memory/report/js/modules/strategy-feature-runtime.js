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
      // Preserve pipeline-generated code
      generatedCode: raw.generatedCode && typeof raw.generatedCode === "object" ? raw.generatedCode : null,
      planArtifact: raw.planArtifact && typeof raw.planArtifact === "object" ? raw.planArtifact : null,
      specArtifact: raw.specArtifact && typeof raw.specArtifact === "object" ? raw.specArtifact : null,
      generationTask: raw.generationTask && typeof raw.generationTask === "object" ? raw.generationTask : null,
      generationTraces: Array.isArray(raw.generationTraces) ? raw.generationTraces.slice(-40) : [],
    };
    return normalized;
  }

  const strategyFeatureVisualRuntime = typeof createStrategyFeatureVisualRuntime === "function"
    ? createStrategyFeatureVisualRuntime({
      sfText: sfText,
      sfNum: sfNum,
      sfEscapeHtml: sfEscapeHtml,
      sfFormatBarTs: sfFormatBarTs,
      normalizeStrategyFeatureRuntime: normalizeStrategyFeatureRuntime,
      mainCategoryConfig: FEATURE_MAIN_CATEGORY_CONFIG,
    })
    : null;

  function renderFeatureVisualizationRuntime(featureLike, contextLike) {
    if (strategyFeatureVisualRuntime && typeof strategyFeatureVisualRuntime.renderFeatureVisualizationRuntime === "function") {
      return strategyFeatureVisualRuntime.renderFeatureVisualizationRuntime(featureLike, contextLike);
    }
    return {
      html: "",
      tf: sfText("-", "-"),
      windowSize: 0,
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

  function sanitizeAnchorPartRuntime(valueLike) {
    const raw = sfText(valueLike, "feature").toLowerCase();
    let out = "";
    let prevDash = false;
    for (let i = 0; i < raw.length; i += 1) {
      const ch = raw[i];
      const code = ch.charCodeAt(0);
      const isLower = code >= 97 && code <= 122;
      const isDigit = code >= 48 && code <= 57;
      if (isLower || isDigit) {
        out += ch;
        prevDash = false;
      } else if (!prevDash) {
        out += "-";
        prevDash = true;
      }
      if (out.length >= 44) break;
    }
    while (out.startsWith("-")) out = out.slice(1);
    while (out.endsWith("-")) out = out.slice(0, -1);
    const cleaned = out.slice(0, 40);
    return cleaned || "feature";
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

  function buildFeatureProcessTracesRuntime(featureLike) {
    const feature = normalizeStrategyFeatureRuntime(featureLike);
    const generatedCode = feature.generatedCode && typeof feature.generatedCode === "object" ? feature.generatedCode : {};
    const traces = Array.isArray(feature.generationTraces) ? feature.generationTraces.slice() : [];
    if (traces.length) return traces;
    const built = [];
    const planArtifact = feature.planArtifact && typeof feature.planArtifact === "object" ? feature.planArtifact : null;
    const specArtifact = feature.specArtifact && typeof feature.specArtifact === "object"
      ? feature.specArtifact
      : (generatedCode.specArtifact && typeof generatedCode.specArtifact === "object" ? generatedCode.specArtifact : null);
    if (planArtifact) {
      built.push({
        phase: "plan",
        status: "done",
        message: "已产出特征加工计划。",
        details: { planArtifact: planArtifact },
      });
    }
    if (specArtifact) {
      built.push({
        phase: "spec_lock",
        status: "done",
        message: "已锁定结构化 Spec。",
        details: { specArtifact: specArtifact },
      });
    }
    if (sfText(generatedCode.featureCode, "")) {
      built.push({
        phase: "write",
        status: "done",
        message: "已生成最终代码。",
        details: {
          codeSnippet: sfText(generatedCode.featureCode, ""),
          codeSource: sfText(generatedCode.codeSource || "", ""),
        },
      });
    }
    if (generatedCode.runArtifacts && typeof generatedCode.runArtifacts === "object") {
      built.push({
        phase: "run",
        status: "done",
        message: "已记录运行结果。",
        details: {
          runArtifacts: generatedCode.runArtifacts,
        },
      });
    }
    if ((generatedCode.repairSummary && typeof generatedCode.repairSummary === "object")
      || (generatedCode.codeDiff && typeof generatedCode.codeDiff === "object")) {
      built.push({
        phase: "repair",
        status: "done",
        message: "已记录最后一轮修复。",
        details: {
          repairSummary: generatedCode.repairSummary || null,
          codeDiff: generatedCode.codeDiff || null,
          codeSnippet: sfText(generatedCode.featureCode, ""),
        },
      });
    }
    if (feature.description || specArtifact || generatedCode.runArtifacts) {
      built.push({
        phase: "summarize",
        status: "done",
        message: "最终结果已保存。",
        details: {
          resultSummary: sfText(feature.description || feature.usageSummary || "", ""),
          specArtifact: specArtifact,
          generatedCode: generatedCode,
          runArtifacts: generatedCode.runArtifacts || null,
        },
      });
    }
    return built;
  }

  function renderFeatureProcessModuleRuntime(featureLike) {
    const traces = buildFeatureProcessTracesRuntime(featureLike);
    if (!traces.length || typeof renderStaticStrategyIntentWorkbenchRuntime !== "function") return "";
    const markup = renderStaticStrategyIntentWorkbenchRuntime({ traces: traces });
    if (!markup) return "";
    return '<details class="fd-module">'
      + '<summary class="fd-module-header">🧠 生成过程</summary>'
      + '<div class="fd-module-body">' + markup + "</div></details>";
  }

  function renderStrategyFeatureDetailModalRuntime(featureLike, contextLike) {
    const feature = normalizeStrategyFeatureRuntime(featureLike);
    const context = contextLike && typeof contextLike === "object" ? contextLike : {};
    const executionCode = resolveExecutionCodeRuntime(feature);
    const createdAt = sfFormatTs(feature.createdAt);
    const updatedAt = sfFormatTs(feature.updatedAt);
    const featureId = sfText(feature.featureId || feature.name || "", "");
    const generatedCode = feature.generatedCode && typeof feature.generatedCode === "object" ? feature.generatedCode : {};
    const codeSource = sfText(generatedCode.codeSource || "", "");
    const allTags = feature.tags.slice(0, 3).map(function(key) {
      return '<span class="tag">' + sfEscapeHtml(FEATURE_TAG_CONFIG[key] ? FEATURE_TAG_CONFIG[key].label : key) + "</span>";
    }).join(" ");

    // Module 1: 特征详情 (基础信息 + 执行代码)
    var module1 = '<details class="fd-module">'
      + '<summary class="fd-module-header">📋 特征详情</summary>'
      + '<div class="fd-module-body">'
      + '<div class="fd-info-grid">'
      + '<div class="fd-info-item"><span class="fd-info-label">名称</span><span class="fd-info-value">' + sfEscapeHtml(feature.title) + '</span></div>'
      + '<div class="fd-info-item"><span class="fd-info-label">分类</span><span class="fd-info-value"><span class="tag">' + sfEscapeHtml(feature.mainCategoryLabel) + '</span> ' + allTags + '</span></div>'
      + '<div class="fd-info-item"><span class="fd-info-label">描述</span><span class="fd-info-value">' + sfEscapeHtml(feature.description) + '</span></div>'
      + '<div class="fd-info-item"><span class="fd-info-label">用途</span><span class="fd-info-value">' + sfEscapeHtml(feature.usageSummary) + '</span></div>'
      + '<div class="fd-info-item"><span class="fd-info-label">创建时间</span><span class="fd-info-value">' + sfEscapeHtml(createdAt) + '</span></div>'
      + '<div class="fd-info-item"><span class="fd-info-label">最近更新</span><span class="fd-info-value">' + sfEscapeHtml(updatedAt) + '</span></div>'
      + (codeSource ? '<div class="fd-info-item"><span class="fd-info-label">代码来源</span><span class="fd-info-value">' + sfEscapeHtml(codeSource) + '</span></div>' : '')
      + '</div>'
      + '<div class="fd-code-section">'
      + '<div class="fd-code-title">执行代码（compute_feature）</div>'
      + '<pre class="fd-code-block">' + sfEscapeHtml(executionCode || "# 暂无执行代码") + '</pre>'
      + '</div>'
      + '</div></details>';

    // Module 1.5: 配置参数 (requiredConfig — API keys, URLs, etc.)
    var reqConfig = Array.isArray(generatedCode.requiredConfig) ? generatedCode.requiredConfig : [];
    var userConfig = feature.params && feature.params.userConfig && typeof feature.params.userConfig === "object"
      ? feature.params.userConfig : {};
    var moduleConfig = "";
    if (reqConfig.length > 0) {
      var configItems = reqConfig.map(function(c) {
        var key = sfText(c.key || "", "");
        var label = sfText(c.label || key, "");
        var desc = sfText(c.description || "", "");
        var currentValue = sfText(userConfig[key] || "", "");
        var maskedValue = currentValue ? (currentValue.slice(0, 4) + "****" + currentValue.slice(-4)) : "";
        return '<div class="fd-config-item">'
          + '<div class="fd-config-label">' + sfEscapeHtml(label) + '</div>'
          + (desc ? '<div class="fd-config-desc">' + sfEscapeHtml(desc) + '</div>' : '')
          + '<div class="fd-config-input-row">'
          + '<input type="password" class="fd-config-input" data-config-key="' + sfEscapeHtml(key) + '" '
          + 'placeholder="' + sfEscapeHtml(currentValue ? "已配置" : "请输入") + '" '
          + 'value="" />'
          + (currentValue ? '<span class="fd-config-status ok">✓ ' + sfEscapeHtml(maskedValue) + '</span>' : '<span class="fd-config-status warn">未配置</span>')
          + '</div></div>';
      }).join("");
      moduleConfig = '<details class="fd-module" open>'
        + '<summary class="fd-module-header">⚙️ 配置参数</summary>'
        + '<div class="fd-module-body">'
        + '<div class="fd-config-grid">' + configItems + '</div>'
        + '<button type="button" class="fd-config-save" data-feature-name="' + sfEscapeHtml(sfText(feature.name || feature.featureId || "", "")) + '">保存配置</button>'
        + '<div class="fd-config-hint">填写后点击保存，特征运行时将自动使用这些配置。</div>'
        + '</div></details>';
    }
    var moduleProcess = renderFeatureProcessModuleRuntime(feature);

    // Module 2: 特征说明 (K线可视化解释)
    var detailContext = { ...context, detailMode: true, previewWindow: 220 };
    var preview = renderFeatureVisualizationRuntime(feature, detailContext);
    var module2 = '<details class="fd-module">'
      + '<summary class="fd-module-header">📊 特征说明</summary>'
      + '<div class="fd-module-body">'
      + '<div class="fd-explain">'
      + '<div class="meta">触发逻辑：' + sfEscapeHtml(feature.triggerLogic) + '</div>'
      + '<div class="meta">算法：' + sfEscapeHtml(feature.algorithmSummary) + '</div>'
      + '</div>'
      + '<div class="fd-kline-preview">' + preview.html + '</div>'
      + '</div></details>';

    if (featureId) rememberFeatureEvalContextRuntime(featureId, context, feature);

    // Module 3: 特征回测 (K线 + 周期选择 + 运行评估)
    var module3 = '<details class="fd-module">'
      + '<summary class="fd-module-header">🔬 特征回测</summary>'
      + '<div class="fd-module-body">'
      + renderFeatureEvalButtonRuntime(feature)
      + '</div></details>';

    // Module 4: 计算历史
    var module4 = '<details class="fd-module">'
      + '<summary class="fd-module-header">📜 计算历史</summary>'
      + '<div class="fd-module-body">'
      + '<div class="feature-eval-history" data-feature-eval-history="' + sfEscapeHtml(featureId) + '">' + renderEvalHistoryMarkupRuntime(featureId) + '</div>'
      + '<div class="meta" style="color:#8b949e;font-size:0.72rem;">运行计算后，结果将保存在此列表中。</div>'
      + '</div></details>';

    return '<div class="feature-detail-view fd-new-layout">'
      + '<div class="fd-header">'
      + '<div class="fd-header-title">' + sfEscapeHtml(feature.title) + '</div>'
      + '<div class="fd-header-meta"><span class="tag">' + sfEscapeHtml(feature.mainCategoryLabel) + '</span> ' + allTags + ' <span class="tag">' + sfEscapeHtml(feature.outputTypeLabel) + '</span></div>'
      + '</div>'
      + '<div class="fd-modules">'
      + module1 + moduleConfig + moduleProcess + module2 + module3 + module4
      + '</div>'
      + '</div>';
  }



  function resolveExternalPipelineCodeRuntime(featureLike) {
    const feature = featureLike && typeof featureLike === "object" ? featureLike : {};
    const params = feature.params && typeof feature.params === "object" ? feature.params : {};
    const runtime = params.runtime && typeof params.runtime === "object" ? params.runtime : {};
    const fromCandidate = sfText(runtime.pipelineCode || params.pipelineCode || params.pipeline_code || feature.pipelineCode || "", "");
    if (!fromCandidate) {
      return {
        code: "",
        source: "",
      };
    }
    return {
      code: fromCandidate,
      source: sfText((params.codegen && params.codegen.codeSource) || params.codeSource || "", "model_generated"),
    };
  }

  function resolveExecutionCodeRuntime(featureLike) {
    const feature = featureLike && typeof featureLike === "object" ? featureLike : {};
    const params = feature.params && typeof feature.params === "object" ? feature.params : {};
    const runtime = params.runtime && typeof params.runtime === "object" ? params.runtime : {};
    // Priority: generatedCode (pipeline) → runtime → params → feature
    const generatedCode = feature.generatedCode && typeof feature.generatedCode === "object" ? feature.generatedCode : {};
    if (sfText(generatedCode.featureCode, "")) return sfText(generatedCode.featureCode, "");
    const candidates = [
      runtime.featureCode, runtime.pipelineCode, runtime.pythonCode, runtime.code, runtime.expression,
      params.featureCode, params.pipelineCode, params.pythonCode, params.code, params.expression,
      feature.featureCode, feature.pipelineCode, feature.pythonCode, feature.code, feature.expression,
    ];
    for (var i = 0; i < candidates.length; i += 1) {
      const text = sfText(candidates[i], "");
      if (text) return text;
    }
    return "";
  }

  var featureEvalRuntimeContext = {};
  var featureEvalChartRuntime = {};

  function normalizeFeatureEvalBarsRuntime(barsLike) {
    var rows = Array.isArray(barsLike) ? barsLike : [];
    return rows.map(function(itemLike) {
      var row = itemLike && typeof itemLike === "object" ? itemLike : {};
      var rawTime = Math.floor(sfNum(row.time || row.ts || row.t, 0));
      var time = rawTime > 9999999999 ? Math.floor(rawTime / 1000) : rawTime;
      var open = sfNum(row.open, Number.NaN);
      var high = sfNum(row.high, Number.NaN);
      var low = sfNum(row.low, Number.NaN);
      var close = sfNum(row.close, Number.NaN);
      var volume = sfNum(row.volume, Number.NaN);
      if (!Number.isFinite(time) || time <= 0) return null;
      if (![open, high, low, close].every(Number.isFinite)) return null;
      return {
        time: time,
        open: open,
        high: high,
        low: low,
        close: close,
        volume: Number.isFinite(volume) ? Math.max(0, volume) : null,
      };
    }).filter(Boolean).sort(function(a, b) { return sfNum(a.time, 0) - sfNum(b.time, 0); });
  }

  function chooseFeatureEvalBarsRuntime(contextLike) {
    var context = contextLike && typeof contextLike === "object" ? contextLike : {};
    var ohlcvByTf = context.ohlcvByTf && typeof context.ohlcvByTf === "object" ? context.ohlcvByTf : {};
    var tfPrefer = sfText(context.previewTf || "auto", "auto");
    if (tfPrefer !== "auto") {
      var directBars = normalizeFeatureEvalBarsRuntime(ohlcvByTf[tfPrefer]);
      if (directBars.length >= 16) return { bars: directBars, timeframe: tfPrefer };
    }
    var priority = ["1h", "15m", "5m", "1m", "4h", "1d"];
    for (var i = 0; i < priority.length; i += 1) {
      var tf = priority[i];
      var rows = normalizeFeatureEvalBarsRuntime(ohlcvByTf[tf]);
      if (rows.length >= 24) return { bars: rows, timeframe: tf };
    }
    var keys = Object.keys(ohlcvByTf || {});
    for (var j = 0; j < keys.length; j += 1) {
      var key = keys[j];
      var fallbackBars = normalizeFeatureEvalBarsRuntime(ohlcvByTf[key]);
      if (fallbackBars.length >= 16) return { bars: fallbackBars, timeframe: key };
    }
    return { bars: [], timeframe: tfPrefer === "auto" ? "-" : tfPrefer };
  }

  function sliceFeatureEvalBarsByRangeRuntime(barsLike, rangeDaysLike) {
    var bars = Array.isArray(barsLike) ? barsLike : [];
    var rangeDays = Math.max(1, Math.min(365, Math.floor(sfNum(rangeDaysLike, 30))));
    if (!bars.length) return [];
    var latestTime = sfNum(bars[bars.length - 1] && bars[bars.length - 1].time, 0);
    if (!Number.isFinite(latestTime) || latestTime <= 0) return [];
    var threshold = latestTime - (rangeDays * 86400);
    var filtered = bars.filter(function(rowLike) {
      return sfNum(rowLike && rowLike.time, 0) >= threshold;
    });
    return filtered.length ? filtered : bars.slice(-Math.max(24, Math.min(400, rangeDays * 24)));
  }

  function rememberFeatureEvalContextRuntime(featureIdLike, contextLike, featureLike) {
    var featureId = sfText(featureIdLike, "");
    if (!featureId) return;
    var context = contextLike && typeof contextLike === "object" ? contextLike : {};
    var feature = featureLike && typeof featureLike === "object" ? featureLike : {};
    featureEvalRuntimeContext[featureId] = {
      previewTf: sfText(context.previewTf || "auto", "auto"),
      ohlcvByTf: context.ohlcvByTf && typeof context.ohlcvByTf === "object" ? context.ohlcvByTf : {},
      pair: sfText(context.pair || context.symbol || "BTC/USDT", "BTC/USDT"),
      feature: feature,
    };
  }

  function resolveFeatureEvalRequestRuntime(featureIdLike, rangeDaysLike) {
    var featureId = sfText(featureIdLike, "");
    var cached = featureEvalRuntimeContext[featureId] && typeof featureEvalRuntimeContext[featureId] === "object"
      ? featureEvalRuntimeContext[featureId]
      : null;
    if (!cached) {
      return { ok: false, error: "缺少特征详情上下文，请关闭详情后重试。" };
    }
    var selected = chooseFeatureEvalBarsRuntime(cached);
    var timeframe = sfText(selected.timeframe || cached.previewTf || "1h", "1h");
    if (!timeframe || timeframe === "-") timeframe = "1h";
    return {
      ok: true,
      timeframe: timeframe,
      pair: sfText(cached.pair || "BTC/USDT", "BTC/USDT"),
    };
  }

  function renderFeatureEvalErrorRuntime(messageLike) {
    var message = sfText(messageLike, "未知错误");
    return '<div class="feature-eval-error-card">'
      + '<div class="feature-eval-error-title">特征图渲染失败</div>'
      + '<div class="feature-eval-error-text">' + sfEscapeHtml(message) + '</div>'
      + '</div>';
  }

  function formatFeatureEvalValueRuntime(valueLike, digitsLike) {
    var digits = Math.max(0, Math.min(8, Math.floor(sfNum(digitsLike, 4))));
    var parsed = parseFeatureEvalMaybeNumberRuntime(valueLike);
    if (parsed == null) return "-";
    return Number(parsed).toFixed(digits);
  }

  function parseFeatureEvalMaybeNumberRuntime(valueLike) {
    if (valueLike == null || valueLike === "") return null;
    var value = Number(valueLike);
    return Number.isFinite(value) ? value : null;
  }

  function normalizeFeatureEvalPointRuntime(rowLike, featureColLike) {
    var row = rowLike && typeof rowLike === "object" ? rowLike : {};
    var featureCol = sfText(featureColLike, "");
    var timeSec = Math.floor(sfNum(row.time, 0));
    if (!Number.isFinite(timeSec) || timeSec <= 0) return null;
    var open = parseFeatureEvalMaybeNumberRuntime(row.open);
    var high = parseFeatureEvalMaybeNumberRuntime(row.high);
    var low = parseFeatureEvalMaybeNumberRuntime(row.low);
    var close = parseFeatureEvalMaybeNumberRuntime(row.close);
    var volume = parseFeatureEvalMaybeNumberRuntime(row.volume);
    var featureValue = parseFeatureEvalMaybeNumberRuntime(row[featureCol]);
    return {
      time: timeSec,
      open: open,
      high: high,
      low: low,
      close: close,
      volume: volume,
      featureValue: featureValue,
    };
  }

  function buildFeatureEvalChartModelRuntime(featureIdLike, timeSeriesLike, columnsLike, optionsLike) {
    var featureId = sfText(featureIdLike, "");
    var options = optionsLike && typeof optionsLike === "object" ? optionsLike : {};
    var columns = Array.isArray(columnsLike) ? columnsLike.filter(function(colLike) {
      return sfText(colLike, "").indexOf("tc_feat_") === 0;
    }) : [];
    var featureCol = columns[0] || "";
    if (!featureCol) {
      return { ok: false, error: "未找到可展示的特征列。" };
    }
    var points = (Array.isArray(timeSeriesLike) ? timeSeriesLike : []).map(function mapPoint(itemLike) {
      return normalizeFeatureEvalPointRuntime(itemLike, featureCol);
    }).filter(Boolean).sort(function(a, b) {
      return sfNum(a.time, 0) - sfNum(b.time, 0);
    });
    if (!points.length) {
      return { ok: false, error: "缺少可展示的时序数据。" };
    }
    var requestedWindow = Math.floor(sfNum(options.chartWindow, points.length));
    if (!Number.isFinite(requestedWindow) || requestedWindow <= 0) requestedWindow = points.length;
    var minWindow = Math.min(24, points.length);
    var chartWindow = Math.max(minWindow, Math.min(points.length, requestedWindow));
    var recent = points.slice(-chartWindow);
    var candleData = [];
    var lineData = [];
    var pointMap = {};
    var skippedBars = 0;
    var skippedFeaturePoints = 0;
    recent.forEach(function eachPoint(pointLike) {
      var point = pointLike && typeof pointLike === "object" ? pointLike : {};
      var time = Math.floor(sfNum(point.time, 0));
      if (!Number.isFinite(time) || time <= 0) return;
      pointMap[time] = point;
      var hasBar = [point.open, point.high, point.low, point.close].every(function(vLike) {
        return Number.isFinite(vLike);
      });
      if (hasBar) {
        candleData.push({
          time: time,
          open: Number(point.open),
          high: Number(point.high),
          low: Number(point.low),
          close: Number(point.close),
        });
      } else {
        skippedBars += 1;
      }
      if (Number.isFinite(point.featureValue)) {
        lineData.push({ time: time, value: point.featureValue });
      } else {
        lineData.push({ time: time });
        skippedFeaturePoints += 1;
      }
    });
    var validFeatureValues = lineData.map(function(itemLike) {
      return itemLike && Number.isFinite(itemLike.value) ? itemLike.value : Number.NaN;
    }).filter(Number.isFinite);
    if (candleData.length < 8) {
      return { ok: false, error: "有效 K 线数量不足，无法绘制特征图。" };
    }
    if (validFeatureValues.length < 3) {
      return { ok: false, error: "有效特征点数量不足，无法绘制特征图。" };
    }
    return {
      ok: true,
      featureId: featureId,
      featureCol: featureCol,
      featureLabel: featureCol.replace(/^tc_feat_/, ""),
      timeframe: sfText(options.timeframe || "-", "-"),
      candleData: candleData,
      lineData: lineData,
      pointMap: pointMap,
      skippedBars: skippedBars,
      skippedFeaturePoints: skippedFeaturePoints,
      windowSize: recent.length,
    };
  }

  function renderFeatureEvalChartShellRuntime(featureIdLike, modelLike) {
    var featureId = sfText(featureIdLike, "");
    var model = modelLike && typeof modelLike === "object" ? modelLike : {};
    var metaParts = [
      "TF=" + sfEscapeHtml(sfText(model.timeframe, "-")),
      "窗口=" + sfEscapeHtml(String(Math.max(0, Math.floor(sfNum(model.windowSize, 0))))) + "根",
    ];
    if (sfNum(model.skippedBars, 0) > 0) metaParts.push("跳过坏K线 " + sfEscapeHtml(String(Math.floor(sfNum(model.skippedBars, 0)))));
    if (sfNum(model.skippedFeaturePoints, 0) > 0) metaParts.push("忽略坏点 " + sfEscapeHtml(String(Math.floor(sfNum(model.skippedFeaturePoints, 0)))));
    return '<div class="feature-eval-chart-card" data-feature-chart-host="' + sfEscapeHtml(featureId) + '">'
      + '<div class="feature-eval-chart-head">'
      + '<div class="feature-eval-chart-head-top">'
      + '<div class="feature-eval-chart-title">特征曲线 + K线辅助</div>'
      + '<button type="button" class="feature-eval-reset-btn" data-action="reset-feature-chart" data-feature-id="' + sfEscapeHtml(featureId) + '" disabled>重置视图</button>'
      + '</div>'
      + '<div class="feature-eval-chart-meta">' + metaParts.join(' · ') + '</div>'
      + '</div>'
      + '<div class="feature-eval-interactive-wrap">'
      + '<div class="feature-eval-chart-canvas" data-feature-chart-canvas="' + sfEscapeHtml(featureId) + '"></div>'
      + '<div class="feature-eval-selection-box" data-feature-chart-selection="' + sfEscapeHtml(featureId) + '" style="display:none;"></div>'
      + '<div class="feature-eval-hover-card" data-feature-chart-hover="' + sfEscapeHtml(featureId) + '" style="display:none;"></div>'
      + '<div class="feature-eval-point-card" data-feature-chart-point="' + sfEscapeHtml(featureId) + '" style="display:none;"></div>'
      + '</div>'
      + '</div>';
  }

  function isStandardFeatureKindRuntime(kindLike) {
    var kind = sfText(kindLike, "").toLowerCase();
    return kind === "ema" || kind === "sma" || kind === "rsi" || kind === "adx" || kind === "atr";
  }

  function buildFeaturePointExplainRuntime(featureLike, pointLike) {
    var feature = featureLike && typeof featureLike === "object" ? featureLike : {};
    var point = pointLike && typeof pointLike === "object" ? pointLike : {};
    var kind = sfText(feature.kind, "custom").toLowerCase();
    var period = Math.max(2, Math.floor(sfNum(feature.params && feature.params.period, 14)));
    var valueText = formatFeatureEvalValueRuntime(point.featureValue, 4);
    if (kind === "ema") return "EMA(" + period + ") 平滑 close 序列，当前值 " + valueText + "。";
    if (kind === "sma") return "SMA(" + period + ") 取最近 " + period + " 根 close 均值，当前值 " + valueText + "。";
    if (kind === "rsi") return "RSI(" + period + ") 基于涨跌强弱，当前值 " + valueText + "。";
    if (kind === "adx") return "ADX(" + period + ") 衡量趋势强度，当前值 " + valueText + "。";
    if (kind === "atr") return "ATR(" + period + ") 衡量波动强度，当前值 " + valueText + "。";
    return "该值来自 compute_feature 的真实输出。";
  }

  function renderFeatureHoverRuntime(featureLike, pointLike, featureLabelLike) {
    var feature = featureLike && typeof featureLike === "object" ? featureLike : {};
    var point = pointLike && typeof pointLike === "object" ? pointLike : {};
    var featureLabel = sfText(featureLabelLike || feature.title || feature.name || "feature", "feature");
    return '<div class="feature-eval-hover-title">' + sfEscapeHtml(featureLabel) + '</div>'
      + '<div class="feature-eval-hover-row"><span>时间</span><strong>' + sfEscapeHtml(sfFormatBarTs(point.time)) + '</strong></div>'
      + '<div class="feature-eval-hover-row"><span>特征值</span><strong>' + sfEscapeHtml(formatFeatureEvalValueRuntime(point.featureValue, 4)) + '</strong></div>'
      + '<div class="feature-eval-hover-row"><span>收盘价</span><strong>' + sfEscapeHtml(formatFeatureEvalValueRuntime(point.close, 2)) + '</strong></div>';
  }

  function renderFeaturePointCardRuntime(featureIdLike, featureLike, pointLike, featureLabelLike, timeframeLike) {
    var featureId = sfText(featureIdLike, "");
    var feature = featureLike && typeof featureLike === "object" ? featureLike : {};
    var point = pointLike && typeof pointLike === "object" ? pointLike : {};
    var featureLabel = sfText(featureLabelLike || feature.title || feature.name || "feature", "feature");
    var explain = buildFeaturePointExplainRuntime(feature, point);
    var pointValue = formatFeatureEvalValueRuntime(point.featureValue, 4);
    return '<button type="button" class="feature-eval-point-close" data-action="close-feature-point" data-feature-id="' + sfEscapeHtml(featureId) + '">关闭</button>'
      + '<div class="feature-eval-point-title">' + sfEscapeHtml(featureLabel) + '</div>'
      + '<div class="feature-eval-point-time">' + sfEscapeHtml(sfFormatBarTs(point.time)) + ' · TF=' + sfEscapeHtml(sfText(timeframeLike, "-")) + '</div>'
      + '<div class="feature-eval-point-grid">'
      + '<div><span>Open</span><strong>' + sfEscapeHtml(formatFeatureEvalValueRuntime(point.open, 2)) + '</strong></div>'
      + '<div><span>High</span><strong>' + sfEscapeHtml(formatFeatureEvalValueRuntime(point.high, 2)) + '</strong></div>'
      + '<div><span>Low</span><strong>' + sfEscapeHtml(formatFeatureEvalValueRuntime(point.low, 2)) + '</strong></div>'
      + '<div><span>Close</span><strong>' + sfEscapeHtml(formatFeatureEvalValueRuntime(point.close, 2)) + '</strong></div>'
      + '<div><span>特征值</span><strong>' + sfEscapeHtml(pointValue) + '</strong></div>'
      + '<div><span>Volume</span><strong>' + sfEscapeHtml(formatFeatureEvalValueRuntime(point.volume, 2)) + '</strong></div>'
      + '</div>'
      + '<div class="feature-eval-point-explain">' + sfEscapeHtml(explain) + '</div>';
  }

  function positionFeatureEvalFloatingCardRuntime(cardLike, wrapLike, pointLike) {
    var card = cardLike;
    var wrap = wrapLike;
    var point = pointLike && typeof pointLike === "object" ? pointLike : null;
    if (!card || !wrap || !point) return;
    var wrapRect = wrap.getBoundingClientRect();
    var cardWidth = card.offsetWidth || 260;
    var cardHeight = card.offsetHeight || 170;
    var left = Math.max(8, Math.min((wrap.clientWidth || wrapRect.width) - cardWidth - 8, point.x + 12));
    var top = Math.max(8, Math.min((wrap.clientHeight || wrapRect.height) - cardHeight - 8, point.y + 12));
    card.style.left = String(left) + "px";
    card.style.top = String(top) + "px";
  }

  function normalizeFeatureEvalSelectionRuntime(startXLike, endXLike, maxWidthLike, minWidthLike) {
    var maxWidth = Math.max(0, Math.floor(sfNum(maxWidthLike, 0)));
    if (maxWidth <= 0) return null;
    var minWidth = Math.max(8, Math.floor(sfNum(minWidthLike, 12)));
    var startX = Math.max(0, Math.min(maxWidth, sfNum(startXLike, 0)));
    var endX = Math.max(0, Math.min(maxWidth, sfNum(endXLike, 0)));
    var left = Math.min(startX, endX);
    var right = Math.max(startX, endX);
    var width = right - left;
    if (!Number.isFinite(width) || width < minWidth) return null;
    return {
      left: left,
      right: right,
      width: width,
    };
  }

  function shouldActivateFeatureEvalSelectionRuntime(startXLike, currentXLike, thresholdLike) {
    var threshold = Math.max(4, Math.floor(sfNum(thresholdLike, 12)));
    var startX = sfNum(startXLike, 0);
    var currentX = sfNum(currentXLike, 0);
    return Math.abs(currentX - startX) >= threshold;
  }

  function shouldOpenFeatureEvalPointCardRuntime(selectionStateLike) {
    var selectionState = selectionStateLike && typeof selectionStateLike === "object" ? selectionStateLike : {};
    if (selectionState.active) return false;
    if (selectionState.suppressNextClick) {
      selectionState.suppressNextClick = false;
      return false;
    }
    return true;
  }

  function parseFeatureEvalChartTimeRuntime(timeLike) {
    if (Number.isFinite(timeLike)) return Math.floor(timeLike);
    if (!timeLike || typeof timeLike !== "object") return 0;
    if (Number.isFinite(timeLike.timestamp)) return Math.floor(timeLike.timestamp);
    if (Number.isFinite(timeLike.year) && Number.isFinite(timeLike.month) && Number.isFinite(timeLike.day)) {
      var utcMs = Date.UTC(
        Math.floor(timeLike.year),
        Math.max(0, Math.floor(timeLike.month) - 1),
        Math.max(1, Math.floor(timeLike.day)),
      );
      return Math.floor(utcMs / 1000);
    }
    return 0;
  }

  function resolveFeatureEvalSelectionIndexRuntime(candleDataLike, xLike, wrapWidthLike, coordinateToTimeLike) {
    var candleData = Array.isArray(candleDataLike) ? candleDataLike : [];
    if (!candleData.length) return -1;
    var wrapWidth = Math.max(1, Math.floor(sfNum(wrapWidthLike, 1)));
    var x = Math.max(0, Math.min(wrapWidth, sfNum(xLike, 0)));
    var time = 0;
    try {
      time = parseFeatureEvalChartTimeRuntime(typeof coordinateToTimeLike === "function" ? coordinateToTimeLike(x) : null);
    } catch (_) {
      time = 0;
    }
    if (Number.isFinite(time) && time > 0) {
      var bestIndex = 0;
      var bestDiff = Number.POSITIVE_INFINITY;
      candleData.forEach(function eachBar(barLike, idx) {
        var barTime = Math.floor(sfNum(barLike && barLike.time, 0));
        var diff = Math.abs(barTime - time);
        if (diff < bestDiff) {
          bestDiff = diff;
          bestIndex = idx;
        }
      });
      return bestIndex;
    }
    var ratio = wrapWidth > 0 ? (x / wrapWidth) : 0;
    return Math.max(0, Math.min(candleData.length - 1, Math.round(ratio * Math.max(0, candleData.length - 1))));
  }

  function buildFeatureEvalLogicalRangeRuntime(candleDataLike, startXLike, endXLike, wrapWidthLike, coordinateToTimeLike) {
    var candleData = Array.isArray(candleDataLike) ? candleDataLike : [];
    if (candleData.length < 2) return null;
    var normalized = normalizeFeatureEvalSelectionRuntime(startXLike, endXLike, wrapWidthLike, 12);
    if (!normalized) return null;
    var startIndex = resolveFeatureEvalSelectionIndexRuntime(candleData, normalized.left, wrapWidthLike, coordinateToTimeLike);
    var endIndex = resolveFeatureEvalSelectionIndexRuntime(candleData, normalized.right, wrapWidthLike, coordinateToTimeLike);
    if (startIndex < 0 || endIndex < 0) return null;
    var from = Math.max(0, Math.min(startIndex, endIndex));
    var to = Math.min(candleData.length - 1, Math.max(startIndex, endIndex));
    if (to <= from) {
      if (to < candleData.length - 1) to += 1;
      else from = Math.max(0, from - 1);
    }
    return { from: from, to: to };
  }

  function setFeatureEvalSelectionBoxRuntime(selectionBoxLike, rangeLike) {
    var selectionBox = selectionBoxLike;
    var range = rangeLike && typeof rangeLike === "object" ? rangeLike : null;
    if (!selectionBox) return;
    if (!range) {
      selectionBox.style.display = "none";
      selectionBox.style.left = "";
      selectionBox.style.width = "";
      return;
    }
    selectionBox.style.display = "block";
    selectionBox.style.left = String(Math.max(0, Math.floor(sfNum(range.left, 0)))) + "px";
    selectionBox.style.width = String(Math.max(0, Math.floor(sfNum(range.width, 0)))) + "px";
  }

  function syncFeatureEvalResetButtonRuntime(resetBtnLike, isZoomedLike) {
    var resetBtn = resetBtnLike;
    var isZoomed = Boolean(isZoomedLike);
    if (!resetBtn) return;
    resetBtn.disabled = !isZoomed;
    if (isZoomed) resetBtn.classList.add("active");
    else resetBtn.classList.remove("active");
  }

  function resetFeatureEvalChartViewRuntime(featureIdLike) {
    var featureId = sfText(featureIdLike, "");
    var runtime = featureEvalChartRuntime[featureId] && typeof featureEvalChartRuntime[featureId] === "object"
      ? featureEvalChartRuntime[featureId]
      : null;
    if (!runtime || !runtime.chart || !runtime.chart.timeScale) return;
    try {
      runtime.chart.timeScale().fitContent();
    } catch (_) {}
    runtime.isZoomed = false;
    runtime.suppressNextClick = false;
    if (runtime.selectionState) {
      runtime.selectionState.pointerDown = false;
      runtime.selectionState.active = false;
      runtime.selectionState.startX = 0;
      runtime.selectionState.currentX = 0;
      runtime.selectionState.didDrag = false;
      runtime.selectionState.suppressNextClick = false;
    }
    if (runtime.wrap) runtime.wrap.classList.remove("is-selecting");
    setFeatureEvalSelectionBoxRuntime(runtime.selectionBox, null);
    syncFeatureEvalResetButtonRuntime(runtime.resetBtn, false);
  }

  function destroyFeatureEvalChartRuntime(featureIdLike) {
    var featureId = sfText(featureIdLike, "");
    var runtime = featureEvalChartRuntime[featureId] && typeof featureEvalChartRuntime[featureId] === "object"
      ? featureEvalChartRuntime[featureId]
      : null;
    if (!runtime) return;
    try {
      if (typeof runtime.cleanupSelection === "function") runtime.cleanupSelection();
    } catch (_) {}
    try {
      if (runtime.resizeObserver && typeof runtime.resizeObserver.disconnect === "function") runtime.resizeObserver.disconnect();
    } catch (_) {}
    try {
      if (runtime.chart && typeof runtime.chart.remove === "function") runtime.chart.remove();
    } catch (_) {}
    delete featureEvalChartRuntime[featureId];
  }

  function mountFeatureEvalChartRuntime(featureIdLike, hostLike, modelLike) {
    var featureId = sfText(featureIdLike, "");
    var host = hostLike;
    var model = modelLike && typeof modelLike === "object" ? modelLike : {};
    if (!featureId || !host || model.ok !== true) return;
    var canvas = host.querySelector('[data-feature-chart-canvas="' + featureId + '"]');
    var hoverCard = host.querySelector('[data-feature-chart-hover="' + featureId + '"]');
    var pointCard = host.querySelector('[data-feature-chart-point="' + featureId + '"]');
    var selectionBox = host.querySelector('[data-feature-chart-selection="' + featureId + '"]');
    var resetBtn = host.querySelector('[data-action="reset-feature-chart"][data-feature-id="' + featureId + '"]');
    var wrap = host.querySelector('.feature-eval-interactive-wrap');
    if (!canvas || !wrap) return;
    var chartLib = typeof LightweightCharts !== "undefined" && LightweightCharts && typeof LightweightCharts.createChart === "function"
      ? LightweightCharts
      : null;
    if (!chartLib) {
      host.innerHTML = renderFeatureEvalErrorRuntime("图表库 lightweight-charts 未加载。");
      return;
    }
    destroyFeatureEvalChartRuntime(featureId);
    var width = Math.max(280, Math.floor(canvas.clientWidth || wrap.clientWidth || 760));
    var height = Math.max(360, Math.floor(sfNum(wrap.getAttribute('data-height'), 420)));
    var chart = chartLib.createChart(canvas, {
      width: width,
      height: height,
      layout: {
        background: { type: 'solid', color: '#0f1419' },
        textColor: '#8b949e',
      },
      grid: {
        vertLines: { color: '#1a2332' },
        horzLines: { color: '#1a2332' },
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: false,
        horzTouchDrag: true,
        vertTouchDrag: false,
      },
      handleScale: {
        axisPressedMouseMove: false,
        mouseWheel: true,
        pinch: true,
      },
      crosshair: {
        mode: 0,
      },
      rightPriceScale: {
        borderColor: '#2d3a4f',
        scaleMargins: { top: 0.1, bottom: 0.14 },
      },
      leftPriceScale: {
        visible: true,
        borderColor: '#2d3a4f',
        scaleMargins: { top: 0.08, bottom: 0.14 },
      },
      timeScale: {
        borderColor: '#2d3a4f',
        timeVisible: true,
        secondsVisible: false,
        barSpacing: 8,
        rightOffset: 8,
      },
    });
    var candleSeries = chart.addCandlestickSeries({
      priceScaleId: 'right',
      upColor: 'rgba(63,185,80,0.45)',
      downColor: 'rgba(248,81,73,0.45)',
      wickUpColor: 'rgba(63,185,80,0.55)',
      wickDownColor: 'rgba(248,81,73,0.55)',
      borderUpColor: 'rgba(63,185,80,0.35)',
      borderDownColor: 'rgba(248,81,73,0.35)',
      borderVisible: true,
      lastValueVisible: false,
      priceLineVisible: false,
    });
    var featureSeries = chart.addLineSeries({
      priceScaleId: 'left',
      color: '#79c0ff',
      lineWidth: 3,
      priceLineVisible: true,
      lastValueVisible: true,
      crosshairMarkerVisible: true,
      crosshairMarkerRadius: 4,
      crosshairMarkerBorderColor: '#79c0ff',
      crosshairMarkerBackgroundColor: '#0f1419',
    });
    candleSeries.setData(model.candleData || []);
    featureSeries.setData(model.lineData || []);
    try {
      chart.timeScale().fitContent();
    } catch (_) {}
    syncFeatureEvalResetButtonRuntime(resetBtn, false);
    var featureContext = featureEvalRuntimeContext[featureId] && typeof featureEvalRuntimeContext[featureId] === "object"
      ? featureEvalRuntimeContext[featureId]
      : {};
    var feature = featureContext.feature && typeof featureContext.feature === "object" ? featureContext.feature : {};
    var selectionState = {
      pointerDown: false,
      active: false,
      startX: 0,
      currentX: 0,
      didDrag: false,
      suppressNextClick: false,
    };
    function resolvePointDetail(timeLike) {
      var time = Math.floor(sfNum(timeLike, 0));
      if (!Number.isFinite(time) || time <= 0) return null;
      return model.pointMap && typeof model.pointMap === "object" ? model.pointMap[time] || null : null;
    }
    function hideFloatingCards() {
      if (hoverCard) hoverCard.style.display = 'none';
      if (pointCard) {
        pointCard.style.display = 'none';
        pointCard.innerHTML = '';
      }
    }
    function updateSelectionPreview() {
      if (!selectionState.active) {
        wrap.classList.remove("is-selecting");
        setFeatureEvalSelectionBoxRuntime(selectionBox, null);
        return;
      }
      wrap.classList.add("is-selecting");
      setFeatureEvalSelectionBoxRuntime(
        selectionBox,
        normalizeFeatureEvalSelectionRuntime(selectionState.startX, selectionState.currentX, wrap.clientWidth || wrap.getBoundingClientRect().width || width, 12),
      );
    }
    function cleanupSelectionListeners() {
      if (typeof window === "undefined") return;
      window.removeEventListener("mousemove", handleSelectionMove);
      window.removeEventListener("mouseup", handleSelectionEnd);
    }
    function handleSelectionMove(evt) {
      if (!selectionState.pointerDown) return;
      var rect = wrap.getBoundingClientRect();
      selectionState.currentX = sfNum(evt && evt.clientX, rect.left) - rect.left;
      if (!selectionState.active && !shouldActivateFeatureEvalSelectionRuntime(selectionState.startX, selectionState.currentX, 12)) {
        return;
      }
      if (!selectionState.active) {
        selectionState.active = true;
        hideFloatingCards();
      }
      selectionState.didDrag = true;
      updateSelectionPreview();
    }
    function handleSelectionEnd(evt) {
      if (!selectionState.pointerDown) return;
      cleanupSelectionListeners();
      var rect = wrap.getBoundingClientRect();
      selectionState.currentX = sfNum(evt && evt.clientX, rect.left) - rect.left;
      var wasActive = selectionState.active;
      var logicalRange = buildFeatureEvalLogicalRangeRuntime(
        model.candleData || [],
        selectionState.startX,
        selectionState.currentX,
        wrap.clientWidth || rect.width || width,
        function coordinateToTimeSafe(xLike) {
          try {
            return chart.timeScale().coordinateToTime(xLike);
          } catch (_) {
            return null;
          }
        },
      );
      var shouldZoom = Boolean(wasActive && logicalRange && selectionState.didDrag);
      selectionState.pointerDown = false;
      selectionState.active = false;
      selectionState.didDrag = false;
      updateSelectionPreview();
      if (!shouldZoom) return;
      selectionState.suppressNextClick = true;
      try {
        chart.timeScale().setVisibleLogicalRange(logicalRange);
      } catch (_) {}
      syncFeatureEvalResetButtonRuntime(resetBtn, true);
      if (featureEvalChartRuntime[featureId]) featureEvalChartRuntime[featureId].isZoomed = true;
    }
    function handleSelectionStart(evt) {
      if (!evt || evt.button !== 0) return;
      if (evt.target && typeof evt.target.closest === "function" && evt.target.closest('.feature-eval-point-card')) return;
      var rect = wrap.getBoundingClientRect();
      selectionState.pointerDown = true;
      selectionState.active = false;
      selectionState.didDrag = false;
      selectionState.startX = sfNum(evt.clientX, rect.left) - rect.left;
      selectionState.currentX = selectionState.startX;
      updateSelectionPreview();
      if (typeof window !== "undefined") {
        window.addEventListener("mousemove", handleSelectionMove);
        window.addEventListener("mouseup", handleSelectionEnd);
      }
    }
    wrap.addEventListener("mousedown", handleSelectionStart);
    chart.subscribeCrosshairMove(function(param) {
      if (!hoverCard) return;
      if (selectionState.active) {
        hoverCard.style.display = 'none';
        return;
      }
      var point = param && param.point && typeof param.point === "object" ? param.point : null;
      var time = param && param.time != null ? Math.floor(sfNum(param.time, 0)) : 0;
      var detail = resolvePointDetail(time);
      if (!point || !detail || point.x < 0 || point.y < 0) {
        hoverCard.style.display = 'none';
        return;
      }
      hoverCard.innerHTML = renderFeatureHoverRuntime(feature, detail, feature.title || feature.name || model.featureLabel);
      hoverCard.style.display = 'block';
      positionFeatureEvalFloatingCardRuntime(hoverCard, wrap, point);
    });
    chart.subscribeClick(function(param) {
      if (!pointCard) return;
      if (!shouldOpenFeatureEvalPointCardRuntime(selectionState)) return;
      var point = param && param.point && typeof param.point === "object" ? param.point : null;
      var time = param && param.time != null ? Math.floor(sfNum(param.time, 0)) : 0;
      var detail = resolvePointDetail(time);
      if (!point || !detail || point.x < 0 || point.y < 0) {
        pointCard.style.display = 'none';
        pointCard.innerHTML = '';
        return;
      }
      pointCard.innerHTML = renderFeaturePointCardRuntime(featureId, feature, detail, feature.title || feature.name || model.featureLabel, model.timeframe);
      pointCard.style.display = 'block';
      positionFeatureEvalFloatingCardRuntime(pointCard, wrap, point);
    });
    var resizeObserver = null;
    if (typeof ResizeObserver === "function") {
      resizeObserver = new ResizeObserver(function() {
        try {
          chart.applyOptions({ width: Math.max(280, Math.floor(canvas.clientWidth || wrap.clientWidth || width)) });
        } catch (_) {}
      });
      try { resizeObserver.observe(wrap); } catch (_) {}
    }
    featureEvalChartRuntime[featureId] = {
      chart: chart,
      resizeObserver: resizeObserver,
      wrap: wrap,
      selectionBox: selectionBox,
      resetBtn: resetBtn,
      isZoomed: false,
      suppressNextClick: false,
      selectionState: selectionState,
      cleanupSelection: function cleanupSelectionRuntime() {
        cleanupSelectionListeners();
        try { wrap.removeEventListener("mousedown", handleSelectionStart); } catch (_) {}
      },
    };
  }

  /**
   * Render integrated feature evaluation section with time range selector.
   */
  function renderFeatureEvalButtonRuntime(featureLike) {
    const feature = featureLike && typeof featureLike === "object" ? featureLike : {};
    const featureId = sfText(feature.featureId || feature.name || "", "");
    if (!featureId) return "";
    return '<div class="feature-eval-section" data-feature-eval-id="' + sfEscapeHtml(featureId) + '">'
      + '<div class="feature-eval-header">'
      + '<span class="feature-eval-title">📊 特征值计算</span>'
      + '<div class="feature-eval-controls">'
      + '<select class="feature-eval-range" data-feature-eval-range="' + sfEscapeHtml(featureId) + '">'
      + '<option value="7">近7天</option>'
      + '<option value="14">近14天</option>'
      + '<option value="30" selected>近30天</option>'
      + '<option value="90">近90天</option>'
      + '</select>'
      + '<button class="feature-eval-run-btn" type="button" data-action="evaluate-feature" data-feature-id="' + sfEscapeHtml(featureId) + '">运行计算</button>'
      + '</div>'
      + '</div>'
      + '<div class="feature-eval-result" style="display:none;">'
      + '<div class="feature-eval-loading" style="display:none;">⏳ 正在计算特征值...</div>'
      + '<div class="feature-eval-stats"></div>'
      + '<div class="feature-eval-chart"></div>'
      + '</div>'
      + '</div>';
  }

  /**
   * Render feature evaluation statistics.
   */
  function renderFeatureEvalStatsRuntime(statsLike, columnsLike) {
    const stats = statsLike && typeof statsLike === "object" ? statsLike : {};
    const columns = Array.isArray(columnsLike) ? columnsLike : Object.keys(stats);
    if (!columns.length) return '<div class="meta">暂无特征统计数据。</div>';
    var html = '<table class="feature-eval-stats-table"><thead><tr>'
      + '<th>特征列</th><th>均值</th><th>标准差</th><th>最小值</th><th>最大值</th><th>有效数</th>'
      + '</tr></thead><tbody>';
    columns.forEach(function(col) {
      var s = stats[col] || {};
      html += '<tr>'
        + '<td><code>' + sfEscapeHtml(col) + '</code></td>'
        + '<td>' + sfEscapeHtml(String(sfNum(s.mean, 0).toFixed(4))) + '</td>'
        + '<td>' + sfEscapeHtml(String(sfNum(s.std, 0).toFixed(4))) + '</td>'
        + '<td>' + sfEscapeHtml(String(sfNum(s.min, 0).toFixed(4))) + '</td>'
        + '<td>' + sfEscapeHtml(String(sfNum(s.max, 0).toFixed(4))) + '</td>'
        + '<td>' + sfEscapeHtml(String(Math.floor(sfNum(s.nonNull, 0)))) + '</td>'
        + '</tr>';
    });
    html += '</tbody></table>';
    return html;
  }

  /**
   * Render real feature evaluation output from backend time series.
   */
  function renderFeatureEvalTimeSeriesRuntime(featureIdLike, timeSeriesLike, columnsLike, optionsLike) {
    var featureId = sfText(featureIdLike, "");
    var options = optionsLike && typeof optionsLike === "object" ? optionsLike : {};
    var defaultWindow = Array.isArray(timeSeriesLike) ? timeSeriesLike.length : 0;
    var chartWindow = Math.max(0, Math.floor(sfNum(options.chartWindow, sfNum(options.barCount, defaultWindow))));
    var model = buildFeatureEvalChartModelRuntime(featureId, timeSeriesLike, columnsLike, {
      timeframe: sfText(options.timeframe || "-", "-"),
      chartWindow: chartWindow,
    });
    if (!model.ok) return { html: renderFeatureEvalErrorRuntime(model.error || "无法绘制特征图。"), model: null };
    return { html: renderFeatureEvalChartShellRuntime(featureId, model), model: model };
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

  // In-memory evaluation history per feature
  var featureEvalHistory = {};

  /**
   * Handle feature evaluation button click.
   * Reads time range, calls API, renders results, saves to history.
   */
  async function handleFeatureEvalClickRuntime(featureId) {
    var section = document.querySelector('[data-feature-eval-id="' + featureId + '"]');
    if (!section) return;
    var rangeSelect = section.querySelector('.feature-eval-range');
    var rangeDays = rangeSelect ? parseInt(rangeSelect.value, 10) : 30;
    if (!Number.isFinite(rangeDays) || rangeDays < 1) rangeDays = 30;
    var resultDiv = section.querySelector('.feature-eval-result');
    var loadingDiv = section.querySelector('.feature-eval-loading');
    var statsDiv = section.querySelector('.feature-eval-stats');
    var chartDiv = section.querySelector('.feature-eval-chart');
    var historyDiv = document.querySelector('[data-feature-eval-history="' + featureId + '"]');
    destroyFeatureEvalChartRuntime(featureId);
    if (resultDiv) resultDiv.style.display = 'block';
    if (loadingDiv) loadingDiv.style.display = 'block';
    if (statsDiv) statsDiv.innerHTML = '';
    if (chartDiv) chartDiv.innerHTML = '';
    try {
      var evalRequest = resolveFeatureEvalRequestRuntime(featureId, rangeDays);
      if (!evalRequest.ok) {
        if (loadingDiv) loadingDiv.style.display = 'none';
        if (chartDiv) chartDiv.innerHTML = renderFeatureEvalErrorRuntime(evalRequest.error || '缺少评估上下文。');
        return;
      }
      var resp = await fetch('/api/strategy/features/evaluate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          featureIds: [featureId],
          rangeDays: rangeDays,
          pair: evalRequest.pair,
          timeframe: evalRequest.timeframe,
        }),
      });
      var body = await resp.json();
      if (loadingDiv) loadingDiv.style.display = 'none';
      if (!body.ok) {
        if (chartDiv) chartDiv.innerHTML = renderFeatureEvalErrorRuntime(body.error || '未知错误');
        return;
      }
      if (statsDiv) statsDiv.innerHTML = '<div class="feature-eval-stats-title">📊 特征统计摘要（' + (body.barCount || 0) + ' 根K线 · 近' + rangeDays + '天）</div>' + renderFeatureEvalStatsRuntime(body.featureStats, body.featureColumns);
      var chartRender = renderFeatureEvalTimeSeriesRuntime(featureId, body.featureTimeSeries, body.featureColumns, {
        timeframe: body.timeframe || evalRequest.timeframe || '-',
        barCount: body.barCount || 0,
      });
      if (chartDiv) {
        chartDiv.innerHTML = chartRender && chartRender.html ? chartRender.html : renderFeatureEvalErrorRuntime("无法绘制特征图。");
        if (chartRender && chartRender.model) {
          mountFeatureEvalChartRuntime(featureId, chartDiv, chartRender.model);
        }
      }
      // Save to evaluation history
      if (!featureEvalHistory[featureId]) featureEvalHistory[featureId] = [];
      featureEvalHistory[featureId].unshift({
        rangeDays: rangeDays,
        barCount: body.barCount || 0,
        columns: body.featureColumns || [],
        stats: body.featureStats || {},
        timeframe: body.timeframe || evalRequest.timeframe || '-',
        timestamp: new Date().toISOString(),
      });
      if (featureEvalHistory[featureId].length > 10) featureEvalHistory[featureId] = featureEvalHistory[featureId].slice(0, 10);
      // Render history
      if (historyDiv) renderEvalHistory(historyDiv, featureId);
    } catch (err) {
      if (loadingDiv) loadingDiv.style.display = 'none';
      if (chartDiv) chartDiv.innerHTML = renderFeatureEvalErrorRuntime(String(err.message || err));
    }
  }

  function renderEvalHistoryMarkupRuntime(featureId) {
    var history = featureEvalHistory[featureId] || [];
    if (!history.length) return '';
    var html = '<div class="feature-eval-history-title">计算历史（最近' + history.length + '次）</div>';
    html += '<div class="feature-eval-history-list">';
    history.forEach(function(item, idx) {
      var timeStr = item.timestamp ? new Date(item.timestamp).toLocaleString('zh-CN') : '-';
      var cols = (item.columns || []).filter(function(c) { return c.indexOf('tc_feat_') === 0; });
      var statsSummary = cols.map(function(col) {
        var s = item.stats[col] || {};
        return col.replace('tc_feat_', '') + '=' + (sfNum(s.mean, 0).toFixed(3));
      }).join(' ');
      html += '<div class="feature-eval-history-item' + (idx === 0 ? ' latest' : '') + '">'
        + '<span class="time">' + sfEscapeHtml(timeStr) + '</span>'
        + '<span class="tf">' + sfEscapeHtml(sfText(item.timeframe, '-')) + '</span>'
        + '<span class="range">近' + item.rangeDays + '天</span>'
        + '<span class="bars">' + item.barCount + '根K线</span>'
        + '<span class="summary">' + sfEscapeHtml(statsSummary || '-') + '</span>'
        + '</div>';
    });
    html += '</div>';
    return html;
  }

  function renderEvalHistory(container, featureId) {
    if (!container) return;
    container.innerHTML = renderEvalHistoryMarkupRuntime(featureId);
  }

  // Global click handler for evaluate buttons
  if (typeof document !== "undefined") {
    document.addEventListener('click', function(e) {
      var closeBtn = e.target.closest('[data-action="close-feature-point"]');
      if (closeBtn) {
        var closeFeatureId = closeBtn.getAttribute('data-feature-id');
        if (closeFeatureId) {
          var section = document.querySelector('[data-feature-eval-id="' + closeFeatureId + '"]');
          var pointCard = section ? section.querySelector('[data-feature-chart-point="' + closeFeatureId + '"]') : document.querySelector('[data-feature-chart-point="' + closeFeatureId + '"]');
          if (pointCard) {
            pointCard.style.display = 'none';
            pointCard.innerHTML = '';
          }
        }
        return;
      }
      var resetBtn = e.target.closest('[data-action="reset-feature-chart"]');
      if (resetBtn) {
        var resetFeatureId = resetBtn.getAttribute('data-feature-id');
        if (resetFeatureId) resetFeatureEvalChartViewRuntime(resetFeatureId);
        return;
      }
      var btn = e.target.closest('[data-action="evaluate-feature"]');
      if (!btn) return;
      var featureId = btn.getAttribute('data-feature-id');
      if (featureId) handleFeatureEvalClickRuntime(featureId);
    });
  }

  globalObj.getStrategyFeatureConfigRuntime = getStrategyFeatureConfigRuntime;
  globalObj.getStrategyFeatureLabelRuntime = getStrategyFeatureLabelRuntime;
  globalObj.normalizeStrategyFeatureRuntime = normalizeStrategyFeatureRuntime;
  globalObj.renderStrategyFeatureCardRuntime = renderStrategyFeatureCardRuntime;
  globalObj.renderStrategyFeatureDetailModalRuntime = renderStrategyFeatureDetailModalRuntime;
  globalObj.renderFeatureEvalStatsRuntime = renderFeatureEvalStatsRuntime;
  globalObj.renderFeatureEvalTimeSeriesRuntime = renderFeatureEvalTimeSeriesRuntime;
  globalObj.handleFeatureEvalClickRuntime = handleFeatureEvalClickRuntime;
  globalObj.__featureEvalTest__ = {
    buildFeatureEvalChartModelRuntime: buildFeatureEvalChartModelRuntime,
    buildFeaturePointExplainRuntime: buildFeaturePointExplainRuntime,
    buildFeatureEvalLogicalRangeRuntime: buildFeatureEvalLogicalRangeRuntime,
    isStandardFeatureKindRuntime: isStandardFeatureKindRuntime,
    normalizeFeatureEvalSelectionRuntime: normalizeFeatureEvalSelectionRuntime,
    shouldOpenFeatureEvalPointCardRuntime: shouldOpenFeatureEvalPointCardRuntime,
    shouldActivateFeatureEvalSelectionRuntime: shouldActivateFeatureEvalSelectionRuntime,
    renderFeaturePointCardRuntime: renderFeaturePointCardRuntime,
    resolveFeatureEvalSelectionIndexRuntime: resolveFeatureEvalSelectionIndexRuntime,
    formatFeatureEvalValueRuntime: formatFeatureEvalValueRuntime,
  };
})(typeof window !== "undefined" ? window : this);
