function tcSafeText(valueLike, fallback) {
  const s = String(valueLike == null ? "" : valueLike).trim();
  return s || String(fallback || "");
}

function tcClamp(valueLike, min, max, fallback) {
  const n = Number(valueLike);
  if (!Number.isFinite(n)) return Number(fallback || 0);
  if (Number.isFinite(min) && n < min) return min;
  if (Number.isFinite(max) && n > max) return max;
  return n;
}

function normalizeCardStatusRuntime(statusLike) {
  const status = String(statusLike || "").trim().toLowerCase();
  if (status === "accepted" || status === "ignored" || status === "registered") return status;
  return "proposed";
}

function strategyStatusLabelRuntime(statusLike) {
  const status = String(statusLike || "").trim().toLowerCase();
  if (status === "draft") return "草稿";
  if (status === "backtested") return "已回测";
  if (status === "paper_live") return "模拟中";
  if (status === "live") return "实盘中";
  if (status === "paused") return "已暂停";
  if (status === "risk_paused") return "风控暂停";
  return "";
}

function normalizeIntentCandidateRuntime(rawLike) {
  const raw = rawLike && typeof rawLike === "object" ? rawLike : {};
  const kind = String(raw.kind || "").trim().toLowerCase();
  if (kind !== "feature" && kind !== "strategy") return null;
  const confidence = tcClamp(raw.confidence, 0, 1, 0.6);
  const id = tcSafeText(raw.id || raw.cardId || raw.candidateId || "");
  const status = normalizeCardStatusRuntime(raw.status);
  if (kind === "feature") {
    const feature = raw.feature && typeof raw.feature === "object" ? raw.feature : {};
    const name = tcSafeText(feature.name || raw.title || "");
    if (!name) return null;
    const normalizedFeature = typeof normalizeStrategyFeatureRuntime === "function"
      ? normalizeStrategyFeatureRuntime({
        ...feature,
        name: name,
        description: tcSafeText(feature.description || raw.summary || ""),
      })
      : null;
    return {
      id: id || tcSafeText(raw.candidateId || "cand_feature"),
      candidateId: tcSafeText(raw.candidateId || "cand_feature"),
      kind: "feature",
      title: tcSafeText(raw.title || name || "交易特征候选"),
      summary: tcSafeText(raw.summary || feature.description || "来自对话提案"),
      confidence: confidence,
      status: status,
      feature: {
        name: name,
        group: tcSafeText(feature.group || "custom"),
        kind: tcSafeText(feature.kind || "custom"),
        description: tcSafeText(feature.description || raw.summary || ""),
        params: feature.params && typeof feature.params === "object" ? feature.params : {},
        mainCategory: normalizedFeature ? tcSafeText(normalizedFeature.mainCategory || "") : tcSafeText(feature.mainCategory || ""),
        mainCategoryLabel: normalizedFeature ? tcSafeText(normalizedFeature.mainCategoryLabel || "") : "",
        tags: normalizedFeature && Array.isArray(normalizedFeature.tags) ? normalizedFeature.tags.slice(0, 3) : (Array.isArray(feature.tags) ? feature.tags.slice(0, 3) : []),
        tagLabels: normalizedFeature && Array.isArray(normalizedFeature.tagLabels) ? normalizedFeature.tagLabels.slice(0, 3) : [],
        outputType: normalizedFeature ? tcSafeText(normalizedFeature.outputType || "") : tcSafeText(feature.outputType || ""),
        outputTypeLabel: normalizedFeature ? tcSafeText(normalizedFeature.outputTypeLabel || "") : "",
        usageSummary: normalizedFeature ? tcSafeText(normalizedFeature.usageSummary || "") : tcSafeText(feature.usageSummary || ""),
        triggerLogic: normalizedFeature ? tcSafeText(normalizedFeature.triggerLogic || "") : tcSafeText(feature.triggerLogic || ""),
      },
    };
  }
  const strategy = raw.strategy && typeof raw.strategy === "object" ? raw.strategy : {};
  const title = tcSafeText(raw.title || strategy.title || "");
  if (!title) return null;
  return {
    id: id || tcSafeText(raw.candidateId || "cand_strategy"),
    candidateId: tcSafeText(raw.candidateId || "cand_strategy"),
    kind: "strategy",
    title: title,
    summary: tcSafeText(raw.summary || strategy.thesis || "来自对话提案"),
    confidence: confidence,
    status: status,
    syncStatus: tcSafeText(
      raw.extra && typeof raw.extra === "object"
        ? (raw.extra.strategyStatus || "")
        : (raw.strategyStatus || strategy.status || ""),
    ),
    strategy: {
      title: title,
      thesis: tcSafeText(strategy.thesis || raw.summary || ""),
      horizon: tcSafeText(strategy.horizon || "intraday"),
      riskLevel: tcSafeText(strategy.riskLevel || "balanced"),
      entry: tcSafeText(strategy.entry || ""),
      riskControl: tcSafeText(strategy.riskControl || ""),
      exit: tcSafeText(strategy.exit || ""),
      featureRefs: Array.isArray(strategy.featureRefs) ? strategy.featureRefs.map(function(x) { return tcSafeText(x); }).filter(Boolean) : [],
      features: Array.isArray(strategy.features) ? strategy.features : [],
      dsl: strategy.dsl && typeof strategy.dsl === "object" ? strategy.dsl : null,
      strategyId: tcSafeText(
        strategy.strategyId
        || (raw.extra && typeof raw.extra === "object" ? raw.extra.strategyId : "")
        || raw.strategyId
        || "",
      ),
    },
  };
}

var createStrategyIntentApiClientRuntime = function createStrategyIntentApiClientRuntime(optionsLike) {
  const options = optionsLike && typeof optionsLike === "object" ? optionsLike : {};
  const routes = options.routes && typeof options.routes === "object" ? options.routes : {};
  const detectRoute = tcSafeText(routes.detect || "/api/strategy/intent-candidates", "/api/strategy/intent-candidates");
  const applyRoute = tcSafeText(routes.apply || "/api/strategy/intent-candidates/apply", "/api/strategy/intent-candidates/apply");
  const statusRoute = tcSafeText(routes.status || "/api/chat/cards/status", "/api/chat/cards/status");

  async function postJson(url, body) {
    const resp = await fetch(url, {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    const payload = await resp.json().catch(function() { return null; });
    if (!resp.ok || !payload) {
      throw new Error(payload && payload.error ? String(payload.error) : ("HTTP " + resp.status));
    }
    return payload;
  }

  async function detect(paramsLike) {
    const params = paramsLike && typeof paramsLike === "object" ? paramsLike : {};
    const payload = await postJson(detectRoute, params);
    const candidates = (Array.isArray(payload.candidates) ? payload.candidates : [])
      .map(function(item) { return normalizeIntentCandidateRuntime(item); })
      .filter(Boolean);
    return {
      ok: Boolean(payload.ok),
      intentDetected: Boolean(payload.intentDetected) && candidates.length > 0,
      confidence: tcClamp(payload.confidence, 0, 1, candidates.length ? 0.7 : 0),
      reasoning: tcSafeText(payload.reasoning || ""),
      candidates: candidates,
      error: tcSafeText(payload.error || ""),
    };
  }

  async function apply(candidateLike, metaLike) {
    const candidate = normalizeIntentCandidateRuntime(candidateLike);
    if (!candidate) throw new Error("invalid candidate");
    const meta = metaLike && typeof metaLike === "object" ? metaLike : {};
    return await postJson(applyRoute, {
      candidate: candidate,
      source: tcSafeText(meta.source || "chat_intent"),
      query: tcSafeText(meta.query || ""),
      reply: tcSafeText(meta.reply || ""),
      parentVersionId: tcSafeText(meta.parentVersionId || ""),
      conversationId: tcSafeText(meta.conversationId || meta.sessionId || "thunderclaw-main"),
      eventId: Number(meta.eventId) || null,
      cardId: tcSafeText(meta.cardId || candidate.id || candidate.candidateId || ""),
    });
  }

  async function updateStatus(eventIdLike, cardIdLike, statusLike) {
    const eventId = Number(eventIdLike);
    const cardId = tcSafeText(cardIdLike || "");
    const status = normalizeCardStatusRuntime(statusLike);
    if (!Number.isFinite(eventId) || eventId <= 0) throw new Error("eventId is required");
    if (!cardId) throw new Error("cardId is required");
    return await postJson(statusRoute, {
      eventId: eventId,
      cardId: cardId,
      status: status,
    });
  }

  return {
    detect: detect,
    apply: apply,
    updateStatus: updateStatus,
  };
};

function renderCandidateMetaRuntime(candidateLike) {
  const candidate = candidateLike && typeof candidateLike === "object" ? candidateLike : {};
  if (candidate.kind === "feature") {
    const feature = candidate.feature && typeof candidate.feature === "object" ? candidate.feature : {};
    const cat = tcSafeText(feature.mainCategoryLabel || feature.mainCategory || "");
    const tags = Array.isArray(feature.tagLabels) && feature.tagLabels.length
      ? feature.tagLabels.slice(0, 2).join("/")
      : Array.isArray(feature.tags) && feature.tags.length
        ? feature.tags.slice(0, 2).join("/")
        : "";
    const output = tcSafeText(feature.outputTypeLabel || feature.outputType || "");
    const parts = [
      "分类: " + tcSafeText(cat || "未分类"),
      tags ? ("标签: " + tags) : "",
      output ? ("输出: " + output) : "",
    ].filter(Boolean);
    return parts.join(" · ");
  }
  const strategy = candidate.strategy && typeof candidate.strategy === "object" ? candidate.strategy : {};
  const state = tcSafeText(candidate.syncStatus || strategy.status || "");
  const stateLabel = strategyStatusLabelRuntime(state);
  const stateText = stateLabel ? (" · 状态: " + stateLabel) : "";
  const framework = strategy.frameworkSummary && typeof strategy.frameworkSummary === "object"
    ? strategy.frameworkSummary
    : {};
  const frameworkText = [
    tcSafeText(framework.signal || ""),
    tcSafeText(framework.position || ""),
    tcSafeText(framework.risk || ""),
    tcSafeText(framework.execution || ""),
  ].filter(Boolean).join(" | ");
  return "Horizon: " + tcSafeText(strategy.horizon || "intraday")
    + " · Risk: " + tcSafeText(strategy.riskLevel || "balanced")
    + stateText
    + (frameworkText ? (" · " + frameworkText) : "");
}

function renderStrategyLayersRuntime(candidateLike) {
  const candidate = candidateLike && typeof candidateLike === "object" ? candidateLike : {};
  if (candidate.kind !== "strategy") return "";
  const strategy = candidate.strategy && typeof candidate.strategy === "object" ? candidate.strategy : {};
  const layers = strategy.layers && typeof strategy.layers === "object" ? strategy.layers : {};
  const signal = layers.signalLayer && typeof layers.signalLayer === "object" ? layers.signalLayer : {};
  const position = layers.positionLayer && typeof layers.positionLayer === "object" ? layers.positionLayer : {};
  const risk = layers.riskLayer && typeof layers.riskLayer === "object" ? layers.riskLayer : {};
  const execution = layers.executionLayer && typeof layers.executionLayer === "object" ? layers.executionLayer : {};
  const signalSummary = tcSafeText(signal.signalLogic || strategy.entry || "").slice(0, 80);
  const featureCount = Array.isArray(signal.featureRefs) ? signal.featureRefs.length : 0;
  const positionSummary = "mode=" + tcSafeText(position.mode || "risk_budget") + ", exposure<= " + String(tcSafeText(position.maxExposurePct || "-")) + "%";
  const riskSummary = "SL " + String(tcSafeText(risk.stopLossPct || "-")) + "% / TP " + String(tcSafeText(risk.takeProfitPct || "-")) + "%";
  const executionSummary = tcSafeText(execution.orderMode || "market") + " · slippage " + String(tcSafeText(execution.slippageBps || "-")) + "bps";
  return ''
    + '<div class="ai-intent-layer-grid">'
    + '<div class="ai-intent-layer-item"><span>信号层</span><small>' + tcSafeText(signalSummary || "未配置") + (featureCount ? (" · refs=" + String(featureCount)) : "") + '</small></div>'
    + '<div class="ai-intent-layer-item"><span>仓位层</span><small>' + tcSafeText(positionSummary) + '</small></div>'
    + '<div class="ai-intent-layer-item"><span>风控层</span><small>' + tcSafeText(riskSummary) + '</small></div>'
    + '<div class="ai-intent-layer-item"><span>执行层</span><small>' + tcSafeText(executionSummary) + '</small></div>'
    + '</div>';
}

function renderCandidateDetailRuntime(candidateLike) {
  const candidate = candidateLike && typeof candidateLike === "object" ? candidateLike : {};
  if (candidate.kind === "feature") {
    const feature = candidate.feature && typeof candidate.feature === "object" ? candidate.feature : {};
    const desc = tcSafeText(feature.usageSummary || feature.description || candidate.summary || "");
    const params = feature.params && typeof feature.params === "object" ? feature.params : {};
    const entries = Object.entries(params).slice(0, 4).map(function(item) {
      return String(item[0]) + "=" + String(item[1]);
    });
    const trigger = tcSafeText(feature.triggerLogic || "");
    const info = trigger ? (desc + "；触发：" + trigger) : desc;
    return entries.length ? (info + " · " + entries.join(", ")) : info;
  }
  const strategy = candidate.strategy && typeof candidate.strategy === "object" ? candidate.strategy : {};
  const parts = [];
  if (strategy.entry) parts.push("入场: " + String(strategy.entry));
  if (strategy.riskControl) parts.push("风控: " + String(strategy.riskControl));
  if (strategy.exit) parts.push("退出: " + String(strategy.exit));
  if (!parts.length) return tcSafeText(candidate.summary || "");
  return parts.slice(0, 2).join("；");
}

var createStrategyIntentSuggestionRowRuntime = function createStrategyIntentSuggestionRowRuntime(optionsLike) {
  const options = optionsLike && typeof optionsLike === "object" ? optionsLike : {};
  const candidatesRaw = Array.isArray(options.candidates) ? options.candidates : [];
  const candidates = candidatesRaw
    .map(function(item) { return normalizeIntentCandidateRuntime(item); })
    .filter(Boolean)
    .slice(0, 4);
  if (!candidates.length) return null;

  const onApply = typeof options.onApply === "function" ? options.onApply : null;
  const onEdit = typeof options.onEdit === "function" ? options.onEdit : null;
  const onIgnore = typeof options.onIgnore === "function" ? options.onIgnore : null;
  const onStatusChange = typeof options.onStatusChange === "function" ? options.onStatusChange : null;
  const confidence = tcClamp(options.confidence, 0, 1, 0.7);

  const row = document.createElement("div");
  row.className = "ai-msg-row bot ai-strategy-intent-row";

  const meta = document.createElement("div");
  meta.className = "ai-msg-meta";
  meta.textContent = "策略技能建议 · 置信度 " + String((confidence * 100).toFixed(0)) + "%";
  row.appendChild(meta);

  const bubble = document.createElement("div");
  bubble.className = "ai-msg bot ai-strategy-intent-bubble";
  row.appendChild(bubble);

  const title = document.createElement("div");
  title.className = "ai-strategy-intent-title";
  title.textContent = "检测到可落地的虾策候选，确认后将写入「虾策」列表";
  bubble.appendChild(title);

  const cardWrap = document.createElement("div");
  cardWrap.className = "ai-strategy-intent-cards";
  bubble.appendChild(cardWrap);

  candidates.forEach(function(candidate) {
    const card = document.createElement("div");
    card.className = "ai-strategy-intent-card";

    const top = document.createElement("div");
    top.className = "ai-strategy-intent-card-top";

    const badge = document.createElement("span");
    badge.className = "ai-strategy-intent-badge " + (candidate.kind === "feature" ? "feature" : "strategy");
    badge.textContent = candidate.kind === "feature" ? "交易特征" : "交易策略";

    const conf = document.createElement("span");
    conf.className = "ai-strategy-intent-conf";
    conf.textContent = String((tcClamp(candidate.confidence, 0, 1, 0.6) * 100).toFixed(0)) + "%";

    top.appendChild(badge);
    top.appendChild(conf);
    card.appendChild(top);

    const h = document.createElement("div");
    h.className = "ai-strategy-intent-name";
    h.textContent = tcSafeText(candidate.title || "");
    card.appendChild(h);

    const m = document.createElement("div");
    m.className = "ai-strategy-intent-meta";
    m.textContent = renderCandidateMetaRuntime(candidate);
    card.appendChild(m);

    if (candidate.kind === "feature") {
      const feature = candidate.feature && typeof candidate.feature === "object" ? candidate.feature : {};
      const chips = [];
      const categoryLabel = tcSafeText(feature.mainCategoryLabel || feature.mainCategory || "");
      if (categoryLabel) chips.push(categoryLabel);
      const tagLabels = Array.isArray(feature.tagLabels) && feature.tagLabels.length
        ? feature.tagLabels.slice(0, 2)
        : Array.isArray(feature.tags) ? feature.tags.slice(0, 2) : [];
      tagLabels.forEach(function(tag) { if (tcSafeText(tag)) chips.push(tcSafeText(tag)); });
      if (tcSafeText(feature.outputTypeLabel || feature.outputType || "")) {
        chips.push("输出:" + tcSafeText(feature.outputTypeLabel || feature.outputType || ""));
      }
      if (chips.length) {
        const taxonomyEl = document.createElement("div");
        taxonomyEl.className = "ai-strategy-intent-taxonomy";
        chips.forEach(function(chipText) {
          const chip = document.createElement("span");
          chip.className = "chip";
          chip.textContent = tcSafeText(chipText);
          taxonomyEl.appendChild(chip);
        });
        card.appendChild(taxonomyEl);
      }
    }

    const d = document.createElement("div");
    d.className = "ai-strategy-intent-detail";
    d.textContent = renderCandidateDetailRuntime(candidate);
    card.appendChild(d);

    if (candidate.kind === "strategy") {
      const layerHtml = renderStrategyLayersRuntime(candidate);
      if (layerHtml) {
        const layerWrap = document.createElement("div");
        layerWrap.className = "ai-strategy-intent-layers";
        layerWrap.innerHTML = layerHtml;
        card.appendChild(layerWrap);
      }
    }

    const actions = document.createElement("div");
    actions.className = "ai-strategy-intent-actions";

    const applyBtn = document.createElement("button");
    applyBtn.type = "button";
    applyBtn.className = "apply";
    applyBtn.textContent = candidate.kind === "strategy" ? "保存草稿" : "加入虾策";

    let editBtn = null;
    if (candidate.kind === "strategy" && onEdit) {
      editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "ghost";
      editBtn.textContent = "保存并编辑";
      actions.appendChild(editBtn);
    }

    const ignoreBtn = document.createElement("button");
    ignoreBtn.type = "button";
    ignoreBtn.className = "ghost";
    ignoreBtn.textContent = "忽略";

    const status = document.createElement("span");
    status.className = "ai-strategy-intent-status";
    status.textContent = "";

    actions.appendChild(applyBtn);
    if (editBtn) actions.appendChild(editBtn);
    actions.appendChild(ignoreBtn);
    actions.appendChild(status);
    card.appendChild(actions);

    function setAccepted(textLike) {
      card.classList.add("accepted");
      applyBtn.textContent = "已加入";
      applyBtn.disabled = true;
      ignoreBtn.disabled = true;
      if (editBtn) editBtn.disabled = true;
      ignoreBtn.style.display = "none";
      status.textContent = tcSafeText(textLike || "已加入");
    }
    function setIgnored(textLike) {
      card.classList.add("ignored");
      applyBtn.disabled = true;
      ignoreBtn.disabled = true;
      if (editBtn) editBtn.disabled = true;
      status.textContent = tcSafeText(textLike || "已忽略");
    }

    const initialStatus = normalizeCardStatusRuntime(candidate.status);
    const strategyStateLabel = strategyStatusLabelRuntime(candidate.syncStatus || "");
    if (initialStatus === "accepted" || initialStatus === "registered") {
      if (strategyStateLabel) {
        setAccepted("已绑定 · " + strategyStateLabel);
      } else {
        setAccepted(initialStatus === "registered" ? "已注册" : "已加入");
      }
    } else if (initialStatus === "ignored") {
      setIgnored("已忽略");
    }

    applyBtn.addEventListener("click", function() {
      if (!onApply) return;
      applyBtn.disabled = true;
      ignoreBtn.disabled = true;
      if (editBtn) editBtn.disabled = true;
      status.textContent = "写入中...";
      Promise.resolve(onApply(candidate))
        .then(function(outcome) {
          const ok = Boolean(outcome && outcome.ok);
          if (ok) {
            const done = function() {
              setAccepted(outcome.message || "已加入");
            };
            if (onStatusChange) {
              Promise.resolve(onStatusChange(candidate, "accepted"))
                .then(done)
                .catch(function() { done(); });
            } else {
              done();
            }
          } else {
            status.textContent = tcSafeText(outcome && outcome.message ? outcome.message : "写入失败");
            applyBtn.disabled = false;
            ignoreBtn.disabled = false;
            if (editBtn) editBtn.disabled = false;
          }
        })
        .catch(function(err) {
          status.textContent = "写入失败: " + tcSafeText(err && err.message ? err.message : err, "未知错误");
          applyBtn.disabled = false;
          ignoreBtn.disabled = false;
          if (editBtn) editBtn.disabled = false;
        });
    });

    if (editBtn) {
      editBtn.addEventListener("click", function() {
        if (!onEdit) return;
        applyBtn.disabled = true;
        ignoreBtn.disabled = true;
        editBtn.disabled = true;
        status.textContent = "保存并打开编辑器...";
        Promise.resolve(onEdit(candidate))
          .then(function(outcome) {
            const ok = Boolean(outcome && outcome.ok);
            if (ok) {
              const done = function() {
                setAccepted(outcome.message || "已保存，已打开编辑器");
              };
              if (onStatusChange) {
                Promise.resolve(onStatusChange(candidate, "accepted"))
                  .then(done)
                  .catch(function() { done(); });
              } else {
                done();
              }
            } else {
              status.textContent = tcSafeText(outcome && outcome.message ? outcome.message : "保存失败");
              applyBtn.disabled = false;
              ignoreBtn.disabled = false;
              editBtn.disabled = false;
            }
          })
          .catch(function(err) {
            status.textContent = "保存失败: " + tcSafeText(err && err.message ? err.message : err, "未知错误");
            applyBtn.disabled = false;
            ignoreBtn.disabled = false;
            editBtn.disabled = false;
          });
      });
    }

    ignoreBtn.addEventListener("click", function() {
      const doIgnore = function() {
        if (typeof onIgnore === "function") onIgnore(candidate);
        setIgnored("已忽略");
      };
      if (onStatusChange) {
        Promise.resolve(onStatusChange(candidate, "ignored"))
          .then(doIgnore)
          .catch(function() { doIgnore(); });
      } else {
        doIgnore();
      }
    });

    cardWrap.appendChild(card);
  });

  return row;
};
