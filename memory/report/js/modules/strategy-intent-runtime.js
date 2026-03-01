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
  const generateRoute = tcSafeText(routes.generate || "/api/strategy/intent-candidates/generate-code", "/api/strategy/intent-candidates/generate-code");
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


  async function generate(candidateLike, metaLike) {
    const candidate = normalizeIntentCandidateRuntime(candidateLike);
    if (!candidate) throw new Error("invalid candidate");
    const meta = metaLike && typeof metaLike === "object" ? metaLike : {};
    return await postJson(generateRoute, {
      candidate: candidate,
      userMessage: tcSafeText(meta.userMessage || meta.query || ""),
      assistantReply: tcSafeText(meta.assistantReply || meta.reply || ""),
      query: tcSafeText(meta.query || ""),
      reply: tcSafeText(meta.reply || ""),
      sessionId: tcSafeText(meta.sessionId || meta.conversationId || "thunderclaw-main", "thunderclaw-main"),
      runtimeModelRef: tcSafeText(meta.runtimeModelRef || ""),
      refineInstruction: tcSafeText(meta.refineInstruction || ""),
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
    generate: generate,
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
    const codegenStatus = tcSafeText(params.codegenStatus || "", "").toLowerCase();
    const codeError = tcSafeText(params.codeValidationError || "", "");
    const needed = Array.isArray(params.requiredInputs)
      ? params.requiredInputs.map(function(row) {
        const item = row && typeof row === "object" ? row : {};
        return tcSafeText(item.label || item.key || "", "");
      }).filter(Boolean)
      : [];
    if (codegenStatus === "needs_user_input") {
      return [
        desc,
        codeError ? ("需补充：" + codeError) : "需补充模型代码后才能加入",
        needed.length ? ("待补充项：" + needed.join("、")) : "",
      ].filter(Boolean).join(" · ");
    }
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
  const onGenerate = typeof options.onGenerate === "function" ? options.onGenerate : null;
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
    applyBtn.textContent = candidate.kind === "strategy" ? "保存草稿" : "确认并加入特征库";
    const featureParams = candidate.kind === "feature" && candidate.feature && typeof candidate.feature === "object"
      ? (candidate.feature.params && typeof candidate.feature.params === "object" ? candidate.feature.params : {})
      : {};
    const featureNeedsInput = candidate.kind === "feature" && tcSafeText(featureParams.codegenStatus || "", "").toLowerCase() === "needs_user_input";
    const featureNeedHints = featureNeedsInput && Array.isArray(featureParams.requiredInputs)
      ? featureParams.requiredInputs.map(function(row) {
        const item = row && typeof row === "object" ? row : {};
        return tcSafeText(item.label || item.key || "", "");
      }).filter(Boolean)
      : [];
    if (featureNeedsInput) {
      applyBtn.textContent = onGenerate ? "补充并重新生成" : "需补充后再确认";
      applyBtn.disabled = !onGenerate;
      applyBtn.title = featureNeedHints.length
        ? ("缺少：" + featureNeedHints.join("、"))
        : tcSafeText(featureParams.codeValidationError || "请先补充模型代码", "请先补充模型代码");
    }

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
    status.textContent = featureNeedsInput
      ? tcSafeText(featureParams.codeValidationError || "请先补充模型代码后再确认", "")
      : "";

    let refineInput = null;
    if (candidate.kind === "feature" && onGenerate) {
      refineInput = document.createElement("textarea");
      refineInput.className = "ai-strategy-intent-refine";
      refineInput.rows = 2;
      const hintText = featureNeedHints.length
        ? ("请补充：" + featureNeedHints.join("、"))
        : "可补充你的改造要求（例如：改成抓取某数据源并说明阈值）";
      refineInput.placeholder = hintText;
      refineInput.value = tcSafeText(featureParams.codeRefineInstruction || "", "");
      if (featureNeedsInput) {
        card.appendChild(refineInput);
      }
    }

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
      if (refineInput) refineInput.disabled = true;
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

    function setProgress(phase, detailLike) {
      const detail = tcSafeText(detailLike || "", "");
      const phaseText = tcSafeText(phase || "处理中", "处理中");
      status.textContent = detail ? ("[" + phaseText + "] " + detail) : phaseText;
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
      if (refineInput) refineInput.disabled = true;

      var runApply = function(candidateToApply) {
        setProgress("写入", "正在保存到特征库...");
        return Promise.resolve(onApply(candidateToApply))
          .then(function(outcome) {
            const ok = Boolean(outcome && outcome.ok);
            if (ok) {
              const done = function() {
                setAccepted(outcome.message || "已确认并加入");
              };
              if (onStatusChange) {
                Promise.resolve(onStatusChange(candidateToApply, "accepted"))
                  .then(done)
                  .catch(function() { done(); });
              } else {
                done();
              }
            } else {
              setProgress("写入失败", tcSafeText(outcome && outcome.message ? outcome.message : "写入失败"));
              applyBtn.disabled = false;
              ignoreBtn.disabled = false;
              if (editBtn) editBtn.disabled = false;
              if (refineInput) refineInput.disabled = false;
            }
          })
          .catch(function(err) {
            setProgress("写入失败", tcSafeText(err && err.message ? err.message : err, "未知错误"));
            applyBtn.disabled = false;
            ignoreBtn.disabled = false;
            if (editBtn) editBtn.disabled = false;
            if (refineInput) refineInput.disabled = false;
          });
      };

      if (candidate.kind === "feature" && onGenerate) {
        var refineInstruction = refineInput ? tcSafeText(refineInput.value || "", "") : "";
        if (featureNeedsInput && !refineInstruction) {
          setProgress("等待补充", "请先补充改造要求，再重新生成");
          applyBtn.disabled = false;
          ignoreBtn.disabled = false;
          if (editBtn) editBtn.disabled = false;
          if (refineInput) refineInput.focus();
          return;
        }
        setProgress("代码生成", "正在请求模型生成执行代码...");
        Promise.resolve(onGenerate(candidate, { refineInstruction: refineInstruction }))
          .then(function(genOutcome) {
            setProgress("代码校验", "正在校验生成结果...");
            var generated = genOutcome && genOutcome.candidate && typeof genOutcome.candidate === "object" ? genOutcome.candidate : candidate;
            var params = generated.feature && typeof generated.feature === "object" && generated.feature.params && typeof generated.feature.params === "object"
              ? generated.feature.params
              : {};
            if (tcSafeText(params.codegenStatus || "", "").toLowerCase() === "needs_user_input") {
              var requiredList = Array.isArray(params.requiredInputs) ? params.requiredInputs : [];
              var requiredText = requiredList.map(function(row) {
                const item = row && typeof row === "object" ? row : {};
                return tcSafeText(item.label || item.key || "", "");
              }).filter(Boolean).join("、");
              var baseText = tcSafeText(params.codeValidationError || "代码生成未完成，请补充需求后重试", "代码生成未完成，请补充需求后重试");
              setProgress("等待补充", requiredText ? (baseText + "（待补充：" + requiredText + "）") : baseText);
              applyBtn.textContent = "补充并重新生成";
              applyBtn.disabled = false;
              ignoreBtn.disabled = false;
              if (editBtn) editBtn.disabled = false;
              if (refineInput) refineInput.disabled = false;
              return;
            }
            setProgress("写入", "代码可用，开始加入特征库...");
            runApply(generated);
          })
          .catch(function(err) {
            setProgress("生成失败", tcSafeText(err && err.message ? err.message : err, "未知错误"));
            applyBtn.disabled = false;
            ignoreBtn.disabled = false;
            if (editBtn) editBtn.disabled = false;
            if (refineInput) refineInput.disabled = false;
          });
        return;
      }

      runApply(candidate);
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

/**
 * Create an interactive clarification card (点点AI style).
 * Shows a headline, AI-generated questions with choice chips, and a submit button.
 * After submission, shows progress → result description → "加入特征库" button.
 */
var createClarificationCardRuntime = function createClarificationCardRuntime(optionsLike) {
  const options = optionsLike && typeof optionsLike === "object" ? optionsLike : {};
  const headline = tcSafeText(options.headline || "想帮你规划一条更合适的特征，先明确一下你的想法：");
  const featureConcept = options.featureConcept && typeof options.featureConcept === "object" ? options.featureConcept : {};
  const questions = Array.isArray(options.clarifyingQuestions) ? options.clarifyingQuestions : [];
  const onSubmit = typeof options.onSubmit === "function" ? options.onSubmit : null;
  const onApply = typeof options.onApply === "function" ? options.onApply : null;

  if (!questions.length) return null;

  // Track user selections
  const selections = {};

  const row = document.createElement("div");
  row.className = "ai-msg-row bot ai-clarify-row";

  const bubble = document.createElement("div");
  bubble.className = "ai-msg bot ai-clarify-bubble";
  row.appendChild(bubble);

  // Headline
  const headlineEl = document.createElement("div");
  headlineEl.className = "ai-clarify-headline";
  headlineEl.textContent = headline;
  bubble.appendChild(headlineEl);

  // Questions container
  const questionsEl = document.createElement("div");
  questionsEl.className = "ai-clarify-questions";
  bubble.appendChild(questionsEl);

  questions.forEach(function(q) {
    const qObj = q && typeof q === "object" ? q : {};
    const qId = tcSafeText(qObj.id, "q");
    const qText = tcSafeText(qObj.question, "");
    const qOptions = Array.isArray(qObj.options) ? qObj.options : [];
    if (!qText || qOptions.length < 2) return;

    const section = document.createElement("div");
    section.className = "ai-clarify-question";

    const label = document.createElement("div");
    label.className = "ai-clarify-question-label";
    label.textContent = qText;
    section.appendChild(label);

    const chipsWrap = document.createElement("div");
    chipsWrap.className = "ai-clarify-chips";

    qOptions.forEach(function(opt) {
      const optObj = opt && typeof opt === "object" ? opt : {};
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "ai-clarify-chip";
      chip.textContent = tcSafeText(optObj.label, "");
      chip.dataset.qid = qId;
      chip.dataset.value = tcSafeText(optObj.value, "");
      chip.addEventListener("click", function() {
        // Deselect siblings
        chipsWrap.querySelectorAll(".ai-clarify-chip").forEach(function(c) { c.classList.remove("selected"); });
        chip.classList.add("selected");
        selections[qId] = tcSafeText(optObj.value, "");
      });
      chipsWrap.appendChild(chip);
    });
    section.appendChild(chipsWrap);
    questionsEl.appendChild(section);
  });

  // Submit button
  const submitWrap = document.createElement("div");
  submitWrap.className = "ai-clarify-submit-wrap";
  const submitBtn = document.createElement("button");
  submitBtn.type = "button";
  submitBtn.className = "ai-clarify-submit";
  submitBtn.textContent = "开始生成特征";
  submitWrap.appendChild(submitBtn);
  bubble.appendChild(submitWrap);

  // Progress area (hidden initially)
  const progressEl = document.createElement("div");
  progressEl.className = "ai-clarify-progress";
  progressEl.style.display = "none";
  bubble.appendChild(progressEl);

  // Result area (hidden initially)
  const resultEl = document.createElement("div");
  resultEl.className = "ai-clarify-result";
  resultEl.style.display = "none";
  bubble.appendChild(resultEl);

  function setProgress(text) {
    progressEl.style.display = "block";
    progressEl.textContent = text;
  }

  function showResult(result) {
    progressEl.style.display = "none";
    resultEl.style.display = "block";
    resultEl.innerHTML = "";

    const ok = Boolean(result && result.ok);
    const summary = tcSafeText(result?.resultSummary || "", "");
    const feature = result?.feature || {};
    const featureName = tcSafeText(feature.name || featureConcept.name || "", "特征");

    if (!ok) {
      const errDiv = document.createElement("div");
      errDiv.className = "ai-clarify-result-error";
      errDiv.textContent = "⚠️ " + tcSafeText(result?.error || "特征生成失败，请重试或调整描述");
      resultEl.appendChild(errDiv);
      // Re-enable submit
      submitBtn.disabled = false;
      submitBtn.textContent = "重新生成";
      return;
    }

    // Success: show result summary
    const successDiv = document.createElement("div");
    successDiv.className = "ai-clarify-result-success";

    const titleDiv = document.createElement("div");
    titleDiv.className = "ai-clarify-result-title";
    titleDiv.textContent = "✅ 特征已生成";
    successDiv.appendChild(titleDiv);

    if (summary) {
      const summaryDiv = document.createElement("div");
      summaryDiv.className = "ai-clarify-result-summary";
      summaryDiv.textContent = summary;
      successDiv.appendChild(summaryDiv);
    }

    const nameDiv = document.createElement("div");
    nameDiv.className = "ai-clarify-result-name";
    nameDiv.textContent = "特征名称：" + featureName;
    successDiv.appendChild(nameDiv);

    // "加入特征库" button
    if (onApply) {
      const applyBtn = document.createElement("button");
      applyBtn.type = "button";
      applyBtn.className = "ai-clarify-apply";
      applyBtn.textContent = "加入特征库";
      applyBtn.addEventListener("click", function() {
        applyBtn.disabled = true;
        applyBtn.textContent = "正在加入...";
        Promise.resolve(onApply(result))
          .then(function(outcome) {
            if (outcome && outcome.ok) {
              applyBtn.textContent = "✅ 已加入特征库";
              applyBtn.classList.add("done");
            } else {
              applyBtn.textContent = "加入失败：" + tcSafeText(outcome?.error || "");
              applyBtn.disabled = false;
            }
          })
          .catch(function(err) {
            applyBtn.textContent = "加入失败";
            applyBtn.disabled = false;
          });
      });
      successDiv.appendChild(applyBtn);
    }

    resultEl.appendChild(successDiv);
  }

  submitBtn.addEventListener("click", function() {
    if (!onSubmit) return;
    // Check at least one selection
    const hasSelections = Object.keys(selections).length > 0;
    if (!hasSelections) {
      // Auto-select first option for each question
      questionsEl.querySelectorAll(".ai-clarify-chips").forEach(function(chipsWrap) {
        const firstChip = chipsWrap.querySelector(".ai-clarify-chip");
        if (firstChip && !chipsWrap.querySelector(".ai-clarify-chip.selected")) {
          firstChip.classList.add("selected");
          selections[firstChip.dataset.qid] = firstChip.dataset.value;
        }
      });
    }

    // Disable UI
    submitBtn.disabled = true;
    submitBtn.textContent = "生成中...";
    questionsEl.querySelectorAll(".ai-clarify-chip").forEach(function(c) { c.disabled = true; });

    // Progress phases
    setProgress("⏳ 正在分析你的偏好...");
    var progressTimer = setTimeout(function() { setProgress("🔄 正在生成特征代码..."); }, 3000);
    var progressTimer2 = setTimeout(function() { setProgress("🔍 正在验证代码可执行性..."); }, 8000);

    Promise.resolve(onSubmit({ featureConcept: featureConcept, userChoices: selections }))
      .then(function(result) {
        clearTimeout(progressTimer);
        clearTimeout(progressTimer2);
        showResult(result);
      })
      .catch(function(err) {
        clearTimeout(progressTimer);
        clearTimeout(progressTimer2);
        showResult({ ok: false, error: tcSafeText(err?.message || err, "生成失败") });
      });
  });

  return row;
};
