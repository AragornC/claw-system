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
    const anchorBase = sanitizeAnchorPartRuntime(feature.featureId || feature.name || feature.title || "feature");
    const sectionIds = {
      visual: "fd-" + anchorBase + "-visual",
      source: "fd-" + anchorBase + "-source",
      algorithm: "fd-" + anchorBase + "-algorithm",
      params: "fd-" + anchorBase + "-params",
      pseudo: "fd-" + anchorBase + "-pseudo",
      version: "fd-" + anchorBase + "-version",
    };
    const tocHtml = '<aside class="feature-detail-toc">'
      + '<div class="feature-detail-toc-title">目录导航</div>'
      + '<button class="feature-detail-toc-btn active" type="button" data-feature-toc-target="' + sfEscapeHtml(sectionIds.visual) + '">分类可视化</button>'
      + '<button class="feature-detail-toc-btn" type="button" data-feature-toc-target="' + sfEscapeHtml(sectionIds.source) + '">来源模块</button>'
      + '<button class="feature-detail-toc-btn" type="button" data-feature-toc-target="' + sfEscapeHtml(sectionIds.algorithm) + '">算法摘要</button>'
      + '<button class="feature-detail-toc-btn" type="button" data-feature-toc-target="' + sfEscapeHtml(sectionIds.params) + '">参数表</button>'
      + '<button class="feature-detail-toc-btn" type="button" data-feature-toc-target="' + sfEscapeHtml(sectionIds.pseudo) + '">伪代码</button>'
      + '<button class="feature-detail-toc-btn" type="button" data-feature-toc-target="' + sfEscapeHtml(sectionIds.version) + '">版本信息</button>'
      + "</aside>";
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
      + '<div class="feature-detail-layout">'
      + tocHtml
      + '<div class="feature-detail-body">'
      + '<section id="' + sfEscapeHtml(sectionIds.visual) + '" class="feature-detail-section feature-detail-card feature-detail-card-wide"><div class="feature-detail-card-title">分类可视化（' + sfEscapeHtml(feature.mainCategoryLabel) + ' · display_mode=' + sfEscapeHtml(feature.displayMode) + "）</div>" + preview.html + "</section>"
      + '<div class="feature-detail-grid">'
      + '<section id="' + sfEscapeHtml(sectionIds.source) + '" class="feature-detail-section feature-detail-card"><div class="feature-detail-card-title">来源模块</div>'
      + '<div class="meta">来源类型：' + sfEscapeHtml(feature.sourceType || feature.source || "-") + "</div>"
      + '<div class="meta">创建人：' + sfEscapeHtml(feature.createdBy || "ThunderClaw") + "</div>"
      + '<div class="meta">创建时间：' + sfEscapeHtml(createdAt) + "</div>"
      + '<div class="meta">最近更新：' + sfEscapeHtml(updatedAt) + "</div>"
      + (feature.originQuery ? ('<div class="meta">触发问题：' + sfEscapeHtml(sfTrimText(feature.originQuery, 220)) + "</div>") : "")
      + (feature.originReply ? ('<div class="meta">触发回复：' + sfEscapeHtml(sfTrimText(feature.originReply, 220)) + "</div>") : "")
      + (trailHtml ? ('<div class="meta" style="margin-top:6px;">最近链路：</div>' + trailHtml) : "")
      + "</section>"
      + '<section id="' + sfEscapeHtml(sectionIds.algorithm) + '" class="feature-detail-section feature-detail-card"><div class="feature-detail-card-title">算法摘要与计算步骤</div>'
      + '<div class="meta">' + sfEscapeHtml(feature.algorithmSummary) + "</div>"
      + (stepsHtml ? ('<ol class="meta feature-step-list">' + stepsHtml + "</ol>") : '<div class="meta">暂无步骤。</div>')
      + "</section>"
      + "</div>"
      + '<section id="' + sfEscapeHtml(sectionIds.params) + '" class="feature-detail-section feature-detail-card"><div class="feature-detail-card-title">参数表（默认值）</div>'
      + renderParamTableRuntime(feature.paramSpecs)
      + "</section>"
      + '<section id="' + sfEscapeHtml(sectionIds.pseudo) + '" class="feature-detail-section feature-detail-card"><details class="feature-detail-fold" open><summary>伪代码（折叠）</summary><pre class="mini-mono">' + sfEscapeHtml(pseudoCodeText || "// 暂无伪代码") + "</pre></details></section>"
      + '<section id="' + sfEscapeHtml(sectionIds.version) + '" class="feature-detail-section feature-detail-card"><details class="feature-detail-fold"><summary>版本信息（折叠）</summary>'
      + '<div class="meta">版本：' + sfEscapeHtml(sfText(version.version, "v1.0.0")) + "</div>"
      + '<div class="meta">修订：' + sfEscapeHtml(String(Math.floor(sfNum(version.revision, 1)))) + "</div>"
      + (sfText(version.notes, "") ? ('<div class="meta">备注：' + sfEscapeHtml(sfText(version.notes, "")) + "</div>") : "")
      + "</details></section>"
      + "</div>"
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
