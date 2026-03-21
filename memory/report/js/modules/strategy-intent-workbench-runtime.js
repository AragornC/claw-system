(function attachStrategyIntentWorkbenchRuntime(globalLike) {
  const globalObj = globalLike || (typeof window !== "undefined" ? window : {});

  function wbText(valueLike, fallback) {
    const text = String(valueLike == null ? "" : valueLike).trim();
    return text || String(fallback || "");
  }

  function wbNum(valueLike, fallback) {
    const num = Number(valueLike);
    return Number.isFinite(num) ? num : Number(fallback || 0);
  }

  function wbEscapeHtml(valueLike) {
    return String(valueLike == null ? "" : valueLike)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function wbList(itemsLike) {
    const items = Array.isArray(itemsLike)
      ? itemsLike.map(function mapItem(item) { return wbText(item, ""); }).filter(Boolean)
      : [];
    if (!items.length) return "";
    return '<ul class="ai-trace-list">' + items.map(function renderItem(item) {
      return "<li>" + wbEscapeHtml(item) + "</li>";
    }).join("") + "</ul>";
  }

  function wbBlock(label, html, extraClass) {
    const inner = wbText(html, "");
    if (!inner) return "";
    return '<div class="ai-trace-block' + (extraClass ? (" " + extraClass) : "") + '">'
      + '<div class="ai-trace-label">' + wbEscapeHtml(label) + "</div>"
      + inner
      + "</div>";
  }

  function wbTextBlock(label, textLike) {
    const text = wbText(textLike, "");
    if (!text) return "";
    return wbBlock(label, '<div class="ai-trace-text">' + wbEscapeHtml(text) + "</div>");
  }

  function wbCodeBlock(label, codeLike) {
    const code = wbText(codeLike, "");
    if (!code) return "";
    return wbBlock(label, '<pre class="ai-trace-code"><code>' + wbEscapeHtml(code) + "</code></pre>");
  }

  function wbInlineText(textLike) {
    const text = wbText(textLike, "");
    if (!text) return "";
    return wbEscapeHtml(text).replace(/\n/g, "<br>");
  }

  function renderPlanArtifact(planLike) {
    const plan = planLike && typeof planLike === "object" ? planLike : null;
    if (!plan) return "";
    return [
      wbTextBlock("目标", plan.goal),
      wbTextBlock("计划摘要", plan.summary),
      Array.isArray(plan.approach) && plan.approach.length ? wbBlock("技术路线", wbList(plan.approach)) : "",
      Array.isArray(plan.inputs) && plan.inputs.length ? wbBlock("输入", wbList(plan.inputs)) : "",
      Array.isArray(plan.outputs) && plan.outputs.length ? wbBlock("输出", wbList(plan.outputs)) : "",
      Array.isArray(plan.validation) && plan.validation.length ? wbBlock("验证方式", wbList(plan.validation)) : "",
      Array.isArray(plan.repairStrategy) && plan.repairStrategy.length ? wbBlock("失败时如何修复", wbList(plan.repairStrategy)) : "",
    ].join("");
  }

  function fillPlanCardFromArtifact(hostLike, planLike) {
    const host = hostLike || null;
    const plan = planLike && typeof planLike === "object" ? planLike : null;
    if (!host || !plan) return;
    const goalNode = host.querySelector("[data-plan-field='goal']");
    const approachNode = host.querySelector("[data-plan-field='approach']");
    const validationNode = host.querySelector("[data-plan-field='validation']");
    const repairNode = host.querySelector("[data-plan-field='repair']");
    if (goalNode && !wbText(goalNode.textContent, "")) {
      goalNode.innerHTML = wbInlineText(plan.goal || plan.summary || "");
    }
    if (approachNode && !wbText(approachNode.textContent, "")) {
      const approach = Array.isArray(plan.approach) ? plan.approach.filter(Boolean).join("；") : "";
      const inputs = Array.isArray(plan.inputs) ? plan.inputs.filter(Boolean).slice(0, 2).join("；") : "";
      approachNode.innerHTML = wbInlineText([approach, inputs ? ("输入：" + inputs) : ""].filter(Boolean).join("；"));
    }
    if (validationNode && !wbText(validationNode.textContent, "")) {
      validationNode.innerHTML = wbInlineText(Array.isArray(plan.validation) ? plan.validation.filter(Boolean).join("；") : "");
    }
    if (repairNode && !wbText(repairNode.textContent, "")) {
      repairNode.innerHTML = wbInlineText(Array.isArray(plan.repairStrategy) ? plan.repairStrategy.filter(Boolean).join("；") : "");
    }
  }

  function humanizeOutputType(outputType) {
    var map = {
      continuous_non_negative: "非负连续值",
      bounded_oscillator: "振荡指标",
      categorical: "分类信号",
      continuous_bounded: "有界连续值",
      continuous: "连续值",
    };
    return map[outputType] || wbText(outputType, "连续值");
  }

  function humanizeRange(rangeLike) {
    if (!rangeLike || typeof rangeLike !== "object") return "范围不限";
    var lo = rangeLike.min;
    var hi = rangeLike.max;
    if (lo == null && hi == null) return "范围不限";
    var loStr = lo == null ? "-∞" : String(lo);
    var hiStr = hi == null ? "∞" : String(hi);
    return loStr + " ~ " + hiStr;
  }

  function renderSpecArtifact(specLike) {
    var spec = specLike && typeof specLike === "object" ? specLike : null;
    if (!spec) return "";

    var featureName = wbText(spec.featureName, "custom_feature");
    var inputCols = Array.isArray(spec.inputColumns) && spec.inputColumns.length
      ? spec.inputColumns.join(" · ") : "";
    var outputLabel = humanizeOutputType(spec.outputType);
    var rangeLabel = humanizeRange(spec.outputRange);
    var coreSignal = wbText(spec.coreSignal, "");
    var summary = wbText(spec.summary, "");
    var descText = summary && coreSignal && summary !== coreSignal
      ? summary + " " + coreSignal
      : (summary || coreSignal || "");

    var header = '<div class="spec-arch-header">'
      + '<div class="spec-arch-icon">⚙</div>'
      + '<div class="spec-arch-name">' + wbEscapeHtml(featureName) + '</div>'
      + '<div class="spec-arch-tag">架构已确认</div>'
      + '</div>';

    var flowIn = '<div class="spec-arch-block spec-arch-in">'
      + '<div class="spec-arch-bhead"><span class="spec-arch-dot spec-arch-dot-in"></span>输入数据</div>'
      + '<div class="spec-arch-bval">' + wbEscapeHtml(inputCols ? "K 线 OHLCV" : "数据输入") + '</div>'
      + (inputCols ? '<div class="spec-arch-bsub">' + wbEscapeHtml(inputCols) + '</div>' : '')
      + '</div>';

    var logicVal = coreSignal || "特征计算";
    var flowMid = '<div class="spec-arch-block spec-arch-mid">'
      + '<div class="spec-arch-bhead"><span class="spec-arch-dot spec-arch-dot-mid"></span>计算逻辑</div>'
      + '<div class="spec-arch-bval">' + wbEscapeHtml(logicVal) + '</div>'
      + '</div>';

    var flowOut = '<div class="spec-arch-block spec-arch-out">'
      + '<div class="spec-arch-bhead"><span class="spec-arch-dot spec-arch-dot-out"></span>输出结果</div>'
      + '<div class="spec-arch-bval">' + wbEscapeHtml(outputLabel) + '</div>'
      + '<div class="spec-arch-bsub">' + wbEscapeHtml(rangeLabel) + '</div>'
      + '</div>';

    var flow = '<div class="spec-arch-flow">'
      + flowIn
      + '<div class="spec-arch-arrow">→</div>'
      + flowMid
      + '<div class="spec-arch-arrow">→</div>'
      + flowOut
      + '</div>';

    return '<div class="spec-arch-card">' + header + flow + '</div>';
  }

  var _pyKeywords = /\b(import|from|as|def|return|if|elif|else|for|while|in|not|and|or|is|with|try|except|finally|raise|class|pass|break|continue|yield|lambda|assert|global|nonlocal|del|True|False|None)\b/g;
  var _pyBuiltins = /\b(int|float|str|bool|list|dict|tuple|set|len|range|print|max|min|abs|round|sorted|map|filter|enumerate|zip|type|isinstance|hasattr|getattr|setattr|super|property|staticmethod|classmethod)\b/g;

  function _highlightCodeSegment(rawSeg) {
    var escaped = wbEscapeHtml(rawSeg);
    var spans = [];
    function stash(html) {
      var idx = spans.length;
      spans.push(html);
      return "\x00_" + idx + "_\x00";
    }
    escaped = escaped.replace(/\b(\d+\.?\d*)\b/g, function(_, nu) {
      return stash('<span class="py-nu">' + nu + "</span>");
    });
    escaped = escaped.replace(/\b(pd\.DataFrame|pd\.Series|np\.ndarray|pd\.Index)\b/g, function(_, tp) {
      return stash('<span class="py-tp">' + tp + "</span>");
    });
    escaped = escaped.replace(/\bdef\s+([a-zA-Z_]\w*)/g, function(_, fn) {
      return stash('<span class="py-kw">def</span> <span class="py-fn">' + fn + "</span>");
    });
    escaped = escaped.replace(_pyKeywords, function(_, kw) {
      return stash('<span class="py-kw">' + kw + "</span>");
    });
    escaped = escaped.replace(_pyBuiltins, function(_, bi) {
      return stash('<span class="py-bi">' + bi + "</span>");
    });
    return escaped.replace(/\x00_(\d+)_\x00/g, function(_, i) {
      return spans[parseInt(i, 10)];
    });
  }

  function highlightPython(rawLine) {
    var tokens = [];
    var pos = 0;
    var len = rawLine.length;
    var buf = "";
    while (pos < len) {
      var ch = rawLine[pos];
      if (ch === "#") {
        if (buf) { tokens.push({ type: "code", raw: buf }); buf = ""; }
        tokens.push({ type: "comment", raw: rawLine.slice(pos) });
        pos = len;
      } else if (ch === "'" || ch === '"') {
        if (buf) { tokens.push({ type: "code", raw: buf }); buf = ""; }
        var q = ch;
        var start = pos;
        pos++;
        while (pos < len && rawLine[pos] !== q) {
          if (rawLine[pos] === "\\") pos++;
          pos++;
        }
        pos++;
        tokens.push({ type: "string", raw: rawLine.slice(start, pos) });
      } else {
        buf += ch;
        pos++;
      }
    }
    if (buf) tokens.push({ type: "code", raw: buf });
    var result = "";
    for (var ti = 0; ti < tokens.length; ti++) {
      var tok = tokens[ti];
      if (tok.type === "comment") {
        result += '<span class="py-cm">' + wbEscapeHtml(tok.raw) + "</span>";
      } else if (tok.type === "string") {
        result += '<span class="py-st">' + wbEscapeHtml(tok.raw) + "</span>";
      } else {
        result += _highlightCodeSegment(tok.raw);
      }
    }
    return result;
  }

  var _writeCardId = 0;

  function renderCodeCard(codeLike, options) {
    var code = wbText(codeLike, "");
    if (!code) return "";
    var opts = options && typeof options === "object" ? options : {};
    var source = wbText(opts.source, "");
    var featureName = wbText(opts.featureName, "feature");
    var fileName = featureName.replace(/[^a-zA-Z0-9_]/g, "_") + ".py";
    var lines = code.split("\n");
    var lineCount = lines.length;
    var cardId = "write-card-" + (++_writeCardId);

    var isTemplate = source === "template";
    var sourceLabel = isTemplate ? "内置模板" : "AI 生成";
    var sourcePillClass = isTemplate ? "write-pill-template" : "write-pill-ai";

    var statusbar = '<div class="write-card-statusbar" onclick="(function(e){var c=document.getElementById(\'' + cardId + '\');if(c)c.classList.toggle(\'collapsed\');})()">'
      + '<div class="write-card-dot"></div>'
      + '<div class="write-card-filename">' + wbEscapeHtml(fileName) + '</div>'
      + '<div class="write-card-pills">'
      + '<span class="write-pill">Python</span>'
      + '<span class="write-pill">' + String(lineCount) + ' 行</span>'
      + '<span class="write-pill ' + sourcePillClass + '">' + wbEscapeHtml(sourceLabel) + '</span>'
      + '<span class="write-pill write-pill-green">可运行</span>'
      + '</div>'
      + '<div class="write-card-arrow">▼</div>'
      + '</div>';

    var codeLines = [];
    for (var i = 0; i < lines.length; i++) {
      codeLines.push(
        '<div class="write-code-line">'
        + '<span class="write-line-num">' + String(i + 1) + '</span>'
        + '<span class="write-line-content">' + highlightPython(lines[i]) + '</span>'
        + '</div>'
      );
    }

    var codeBody = '<div class="write-card-code-body">'
      + '<div class="write-card-code">' + codeLines.join("") + '</div>'
      + '</div>';

    var hint = '<div class="write-card-collapsed-hint">点击展开查看代码 · ' + String(lineCount) + ' 行</div>';

    return '<div class="write-card" id="' + cardId + '">'
      + statusbar + codeBody + hint
      + '</div>';
  }

  function renderUnifiedDiff(diffLike, opts) {
    var diff = diffLike && typeof diffLike === "object" ? diffLike : null;
    if (!diff) return "";
    var before = wbText(diff.beforeSnippet, "");
    var after  = wbText(diff.afterSnippet, "");
    if (!before && !after) return "";
    var fileName = (opts && opts.fileName) ? wbEscapeHtml(opts.fileName) : "feature.py";
    var id = "udiff-" + String(Math.random()).slice(2, 10);

    var bLines = before.split("\n");
    var aLines = after.split("\n");
    var addCount = 0, delCount = 0;
    var rows = [];

    var maxLen = Math.max(bLines.length, aLines.length);
    var bi = 0, ai = 0;
    var contextBefore = [];
    var changes = [];
    var contextAfter  = [];

    var bSet = {};
    var aSet = {};
    for (var xi = 0; xi < bLines.length; xi++) bSet[bLines[xi]] = (bSet[bLines[xi]] || 0) + 1;
    for (var yi = 0; yi < aLines.length; yi++) aSet[aLines[yi]] = (aSet[aLines[yi]] || 0) + 1;

    function escLine(s) { return wbEscapeHtml(s); }
    function makeCtx(bNum, aNum, text) {
      return '<div class="udiff-line udl-ctx"><div class="udiff-gutter"><div class="udiff-num">'
        + bNum + '</div><div class="udiff-num">' + aNum
        + '</div><div class="udiff-mark"> </div></div><div class="udiff-text">' + escLine(text) + '</div></div>';
    }
    function makeDel(bNum, text) {
      return '<div class="udiff-line udl-del"><div class="udiff-gutter"><div class="udiff-num">'
        + bNum + '</div><div class="udiff-num-e"></div><div class="udiff-mark">\u2212</div></div>'
        + '<div class="udiff-text">' + escLine(text) + '</div></div>';
    }
    function makeAdd(aNum, text) {
      return '<div class="udiff-line udl-add"><div class="udiff-gutter"><div class="udiff-num-e"></div><div class="udiff-num">'
        + aNum + '</div><div class="udiff-mark">+</div></div>'
        + '<div class="udiff-text">' + escLine(text) + '</div></div>';
    }

    bi = 0; ai = 0;
    while (bi < bLines.length && ai < aLines.length) {
      if (bLines[bi] === aLines[ai]) {
        rows.push(makeCtx(bi + 1, ai + 1, bLines[bi]));
        bi++; ai++;
      } else {
        var delStart = bi, addStart = ai;
        while (bi < bLines.length && (bi === delStart || bLines[bi] !== aLines[ai])) {
          if (ai < aLines.length && bLines[bi] === aLines[ai]) break;
          bi++;
        }
        while (ai < aLines.length && (ai === addStart || bLines[bi] !== aLines[ai])) {
          if (bi < bLines.length && bLines[bi] === aLines[ai]) break;
          ai++;
        }
        for (var di = delStart; di < bi; di++) { rows.push(makeDel(di + 1, bLines[di])); delCount++; }
        for (var ai2 = addStart; ai2 < ai; ai2++) { rows.push(makeAdd(ai2 + 1, aLines[ai2])); addCount++; }
      }
    }
    while (bi < bLines.length) { rows.push(makeDel(bi + 1, bLines[bi])); delCount++; bi++; }
    while (ai < aLines.length) { rows.push(makeAdd(ai + 1, aLines[ai])); addCount++; ai++; }

    var hunkLabel = '@@ -1,' + bLines.length + ' +1,' + aLines.length + ' @@';
    var hunk = '<div class="udiff-hunk"><span class="udiff-hunk-txt">' + wbEscapeHtml(hunkLabel) + '</span></div>';

    return '<div class="udiff-card" id="' + id + '">'
      + '<div class="udiff-card-head" onclick="(function(e){e.closest(\'.udiff-card\').classList.toggle(\'udiff-open\')})(this)">'
      + '<div class="udiff-filename">' + fileName + '</div>'
      + '<span class="udiff-stat-add">+' + addCount + '</span>&nbsp;'
      + '<span class="udiff-stat-del">\u2212' + delCount + '</span>'
      + '<span class="udiff-arrow">\u25B6</span>'
      + '</div>'
      + '<div class="udiff-collapse"><div class="udiff-body"><div class="udiff-inner">'
      + hunk + rows.join("")
      + '</div></div></div></div>';
  }

  /* ── 特征验证卡 ── */
  var VALIDATE_PHASES = { run: 1, detect: 1, repair: 1 };

  function buildValidateRoundHtml(roundTraces, roundNum) {
    var runTrace = null, detectTrace = null, repairTrace = null;
    for (var i = 0; i < roundTraces.length; i++) {
      var t = roundTraces[i] && typeof roundTraces[i] === "object" ? roundTraces[i] : {};
      var p = stepPhase(t);
      if (p === "run") runTrace = t;
      else if (p === "detect") detectTrace = t;
      else if (p === "repair") repairTrace = t;
    }
    var hasRepair = !!repairTrace;
    var detStatus = detectTrace ? wbText(detectTrace.status, "done").toLowerCase() : "done";
    var passed = detStatus === "done" && !hasRepair;
    var detDetails = detectTrace && detectTrace.details && typeof detectTrace.details === "object" ? detectTrace.details : {};
    var runDetails = runTrace && runTrace.details && typeof runTrace.details === "object" ? runTrace.details : {};
    var repDetails = repairTrace && repairTrace.details && typeof repairTrace.details === "object" ? repairTrace.details : {};

    var outcomeClass = passed ? "vro-pass" : "vro-fail";
    var outcomeText  = passed ? "全部检测通过" : "检测失败 · 已修复";
    var numClass     = passed ? "vrn-pass" : "vrn-fail";
    var collapsed    = passed ? " collapsed" : "";
    var cardId       = "vr-" + roundNum + "-" + String(Math.random()).slice(2, 8);

    var html = '<div class="vr-card' + collapsed + '" id="' + cardId + '">'
      + '<div class="vr-head" onclick="document.getElementById(\'' + cardId + '\').classList.toggle(\'collapsed\')">'
      + '<div class="vr-num ' + numClass + '">' + roundNum + '</div>'
      + '<div class="vr-title">第 ' + roundNum + ' 轮</div>'
      + '<div class="vr-outcome ' + outcomeClass + '">' + wbEscapeHtml(outcomeText) + '</div>'
      + '<div class="vr-arrow">▾</div>'
      + '</div><div class="vr-body"><div class="vflow">';

    /* 运行节点 */
    var runStat = '';
    var runResult = runDetails.runResult && typeof runDetails.runResult === "object" ? runDetails.runResult : null;
    var evalOut = runDetails.runArtifacts && typeof runDetails.runArtifacts === "object"
      && runDetails.runArtifacts.evaluationOutput && typeof runDetails.runArtifacts.evaluationOutput === "object"
      ? runDetails.runArtifacts.evaluationOutput : null;
    var barCount = runResult ? wbNum(runResult.barCount, 0) : (evalOut ? wbNum(evalOut.barCount, 0) : 0);
    if (barCount > 0) runStat += '<span class="vf-stat-k">数据行<span class="vf-stat-v">' + String(barCount) + '</span></span>';
    if (runResult && runResult.stats && typeof runResult.stats === "object") {
      var mean = Number.isFinite(Number(runResult.stats.mean)) ? Number(runResult.stats.mean).toFixed(4) : null;
      if (mean !== null) runStat += '<span class="vf-stat-k">均值<span class="vf-stat-v">' + mean + '</span></span>';
    }

    html += '<div class="vf-row"><div class="vf-left">'
      + '<div class="vf-dot vs-ok">▶</div>'
      + '<div class="vf-line-wrap"><div class="vf-line-track"></div><div class="vf-line-fill ' + (passed ? 'lf-green' : 'lf-blue') + '" style="height:100%"></div></div>'
      + '</div><div class="vf-right"><div class="vf-header">'
      + '<span class="vf-phase-name vfn-ok">运行</span>'
      + '<span class="vf-badge vfb-ok show">完成</span>'
      + '</div><div class="vf-content visible">'
      + (runStat ? '<div class="vf-stat-row">' + runStat + '</div>' : '')
      + '</div></div></div>';

    /* 检测节点 */
    if (passed) {
      var checkItems = [];
      if (Array.isArray(detDetails.issues) && detDetails.issues.length === 0) checkItems.push("✓ 无问题");
      if (!checkItems.length) checkItems.push("✓ 全部检测通过");
      html += '<div class="vf-row"><div class="vf-left">'
        + '<div class="vf-dot vs-ok">✓</div>'
        + '<div class="vf-line-wrap" style="min-height:0;flex:0;height:0;"></div>'
        + '</div><div class="vf-right"><div class="vf-header">'
        + '<span class="vf-phase-name vfn-ok">检测通过</span>'
        + '<span class="vf-badge vfb-ok show">通过</span>'
        + '</div><div class="vf-content visible">'
        + '<div class="vf-pass-result">' + wbEscapeHtml(checkItems.join(" · ")) + '</div>'
        + '</div></div></div>';
    } else {
      var issuesHtml = '';
      if (Array.isArray(detDetails.issues)) {
        for (var ii = 0; ii < detDetails.issues.length; ii++) {
          issuesHtml += '<span class="vf-issue-tag">⚠ ' + wbEscapeHtml(wbText(detDetails.issues[ii], "")) + '</span>';
        }
      }
      if (detDetails.failureType) {
        issuesHtml += '<div class="vf-issue-desc">' + wbEscapeHtml(detDetails.failureType) + '</div>';
      }
      html += '<div class="vf-row"><div class="vf-left">'
        + '<div class="vf-dot vs-fail">✕</div>'
        + '<div class="vf-line-wrap"><div class="vf-line-track"></div><div class="vf-line-fill lf-red" style="height:100%"></div></div>'
        + '</div><div class="vf-right"><div class="vf-header">'
        + '<span class="vf-phase-name vfn-fail">检测</span>'
        + '<span class="vf-badge vfb-fail show">检测失败</span>'
        + '</div><div class="vf-content visible">' + issuesHtml
        + '</div></div></div>';

      /* 修复节点 */
      var repairDescHtml = '';
      var repairSummary = repDetails.repairSummary && typeof repDetails.repairSummary === "object" ? repDetails.repairSummary : null;
      if (repairSummary && repairSummary.repairGoal) {
        repairDescHtml = '<div class="vf-repair-desc">' + wbEscapeHtml(repairSummary.repairGoal) + '</div>';
      } else if (repDetails.fixSummary) {
        repairDescHtml = '<div class="vf-repair-desc">' + wbEscapeHtml(repDetails.fixSummary) + '</div>';
      }
      var diffHtml = repDetails.codeDiff ? renderUnifiedDiff(repDetails.codeDiff, { fileName: "feature.py" }) : '';

      html += '<div class="vf-row"><div class="vf-left">'
        + '<div class="vf-dot vs-repair">↻</div>'
        + '<div class="vf-line-wrap" style="min-height:0;flex:0;height:0;"></div>'
        + '</div><div class="vf-right"><div class="vf-header">'
        + '<span class="vf-phase-name vfn-repair">修复</span>'
        + '<span class="vf-badge vfb-repair show">已修复</span>'
        + '</div><div class="vf-content visible">'
        + repairDescHtml + diffHtml
        + '</div></div></div>';
    }

    html += '</div></div></div>';
    return html;
  }

  function renderStaticValidateCard(validateTraces) {
    if (!validateTraces || !validateTraces.length) return "";
    var rounds = {};
    var maxAttempt = 0;
    for (var i = 0; i < validateTraces.length; i++) {
      var t = validateTraces[i] && typeof validateTraces[i] === "object" ? validateTraces[i] : {};
      var attempt = Math.max(1, Math.floor(wbNum(t.attempt, 1)));
      if (!rounds[attempt]) rounds[attempt] = [];
      rounds[attempt].push(t);
      if (attempt > maxAttempt) maxAttempt = attempt;
    }

    var lastDetect = null;
    for (var j = validateTraces.length - 1; j >= 0; j--) {
      var tt = validateTraces[j] && typeof validateTraces[j] === "object" ? validateTraces[j] : {};
      if (stepPhase(tt) === "detect") { lastDetect = tt; break; }
    }
    var allPassed = lastDetect && wbText(lastDetect.status, "done").toLowerCase() === "done";
    var hasRepairAnywhere = false;
    for (var k = 0; k < validateTraces.length; k++) {
      if (stepPhase(validateTraces[k]) === "repair") { hasRepairAnywhere = true; break; }
    }
    if (hasRepairAnywhere) allPassed = true;

    var subText = maxAttempt + " 轮验证";
    if (hasRepairAnywhere) subText += " · 含修复";
    subText += allPassed ? " · 全部通过" : " · 未通过";

    var cardId = "vc-" + String(Math.random()).slice(2, 8);
    var html = '<div class="validate-card open" id="' + cardId + '">'
      + '<div class="validate-head" onclick="document.getElementById(\'' + cardId + '\').classList.toggle(\'open\')">'
      + '<div class="vhead-icon ' + (allPassed ? 'vhi-done' : 'vhi-done') + '">' + (allPassed ? '✓' : '✗') + '</div>'
      + '<div style="flex:1"><div class="vhead-title">特征验证</div></div>'
      + '<div class="vhead-badge ' + (allPassed ? 'vhb-done' : 'vhb-running') + '">' + (allPassed ? '已完成' : '进行中') + '</div>'
      + '<div class="vhead-arrow">▾</div>'
      + '</div><div class="validate-body">'
      + '<div class="validate-summary"><div class="vs-icon">' + (allPassed ? '✓' : '⚠') + '</div>'
      + '<div class="vs-text">' + wbEscapeHtml(subText) + '</div>'
      + (allPassed ? '<div class="vs-badge">通过</div>' : '')
      + '</div><div class="validate-rounds">';

    for (var rn = 1; rn <= maxAttempt; rn++) {
      if (rounds[rn]) {
        html += buildValidateRoundHtml(rounds[rn], rn);
      }
    }

    html += '</div></div></div>';
    return html;
  }

  function renderRepairSummary(repairLike) {
    const repair = repairLike && typeof repairLike === "object" ? repairLike : null;
    if (!repair) return "";
    const summaryLines = [];
    if (repair.failureType) summaryLines.push("失败类型：" + repair.failureType);
    if (repair.repairGoal) summaryLines.push("修复目标：" + repair.repairGoal);
    if (Array.isArray(repair.changes)) {
      repair.changes.forEach(function addLine(item) {
        const text = wbText(item, "");
        if (text) summaryLines.push(text);
      });
    }
    return [
      summaryLines.length ? wbBlock("修复摘要", wbList(summaryLines)) : "",
      Array.isArray(repair.preservedConstraints) && repair.preservedConstraints.length
        ? wbBlock("保留约束", wbList(repair.preservedConstraints))
        : "",
    ].join("");
  }

  function renderRunResult(resultLike) {
    const result = resultLike && typeof resultLike === "object" ? resultLike : null;
    if (!result) return "";
    const lines = [];
    if (Number.isFinite(Number(result.barCount))) lines.push("评估 K 线数：" + String(Number(result.barCount)));
    if (result.stats && typeof result.stats === "object") {
      const mean = Number.isFinite(Number(result.stats.mean)) ? Number(result.stats.mean).toFixed(4) : "-";
      const std = Number.isFinite(Number(result.stats.std)) ? Number(result.stats.std).toFixed(4) : "-";
      const min = Number.isFinite(Number(result.stats.min)) ? Number(result.stats.min).toFixed(4) : "-";
      const max = Number.isFinite(Number(result.stats.max)) ? Number(result.stats.max).toFixed(4) : "-";
      lines.push("均值：" + mean + "，标准差：" + std + "，最小值：" + min + "，最大值：" + max);
    }
    if (Array.isArray(result.columns) && result.columns.length) {
      lines.push("产出列：" + result.columns.join(", "));
    }
    return lines.length ? wbBlock("运行结果", wbList(lines)) : "";
  }

  function renderRunArtifacts(artifactsLike) {
    const artifacts = artifactsLike && typeof artifactsLike === "object" ? artifactsLike : null;
    if (!artifacts) return "";
    const blocks = [];
    const evalInput = artifacts.evaluationInput && typeof artifacts.evaluationInput === "object"
      ? artifacts.evaluationInput
      : null;
    if (evalInput) {
      const inputLines = [];
      if (evalInput.pair) inputLines.push("交易对：" + evalInput.pair);
      if (evalInput.timeframe) inputLines.push("周期：" + evalInput.timeframe);
      if (Number.isFinite(Number(evalInput.rangeDays))) inputLines.push("范围天数：" + String(Number(evalInput.rangeDays)));
      if (Number.isFinite(Number(evalInput.barCount)) && Number(evalInput.barCount) > 0) inputLines.push("K 线数：" + String(Number(evalInput.barCount)));
      if (inputLines.length) blocks.push(wbBlock("运行输入", wbList(inputLines)));
    }
    const evalOutput = artifacts.evaluationOutput && typeof artifacts.evaluationOutput === "object"
      ? artifacts.evaluationOutput
      : null;
    if (evalOutput) {
      const firstStats = evalOutput.stats && typeof evalOutput.stats === "object"
        ? (evalOutput.stats[Object.keys(evalOutput.stats)[0]] || null)
        : null;
      blocks.push(renderRunResult({
        barCount: evalOutput.barCount,
        stats: firstStats,
        columns: Array.isArray(evalOutput.featureColumns) ? evalOutput.featureColumns : [],
      }));
    }
    const mockValidation = artifacts.mockValidation && typeof artifacts.mockValidation === "object"
      ? artifacts.mockValidation
      : null;
    if (mockValidation) {
      const lines = [];
      if (Number.isFinite(Number(mockValidation.rowCount))) lines.push("Mock 行数：" + String(Number(mockValidation.rowCount)));
      if (Number.isFinite(Number(mockValidation.nullCount))) lines.push("Mock 空值数：" + String(Number(mockValidation.nullCount)));
      if (Array.isArray(mockValidation.referencedColumns) && mockValidation.referencedColumns.length) {
        lines.push("引用列：" + mockValidation.referencedColumns.join(", "));
      }
      if (lines.length) blocks.push(wbBlock("工程验证", wbList(lines)));
    }
    const logs = artifacts.logs && typeof artifacts.logs === "object" ? artifacts.logs : null;
    if (logs && (logs.stderr || logs.stdout)) {
      blocks.push(wbCodeBlock("日志摘录", (logs.stderr || logs.stdout || "").slice(0, 1200)));
    }
    const samples = Array.isArray(artifacts.samples) ? artifacts.samples : [];
    if (samples.length) {
      const sampleLines = samples.slice(0, 6).map(function mapSample(itemLike) {
        const item = itemLike && typeof itemLike === "object" ? itemLike : {};
        const parts = [];
        if (item.ts) parts.push(String(item.ts));
        if (item.value != null) parts.push("值=" + String(item.value));
        if (item.label) parts.push(String(item.label));
        return parts.join(" · ");
      }).filter(Boolean);
      if (sampleLines.length) blocks.push(wbBlock("样本数据", wbList(sampleLines)));
    }
    return blocks.join("");
  }

  function stepPhase(traceLike) {
    const trace = traceLike && typeof traceLike === "object" ? traceLike : {};
    return wbText(trace.phase || trace.step, "step").toLowerCase();
  }

  function buildStepTitle(traceLike) {
    const trace = traceLike && typeof traceLike === "object" ? traceLike : {};
    const phase = stepPhase(trace);
    const attempt = Math.max(0, Math.floor(wbNum(trace.attempt, 0)));
    const explicitTitle = wbText(trace.title, "");
    if (explicitTitle) return explicitTitle;
    if (phase === "understand") return "理解需求";
    if (phase === "plan") return "生成计划";
    if (phase === "spec_lock") return "架构设计";
    if (phase === "write") return "生成首版代码";
    if (phase === "run" || phase === "detect" || phase === "repair") return "特征验证";
    if (phase === "summarize") return "最终结果";
    return wbText(trace.message || phase, "处理步骤");
  }

  function buildStepSummary(traceLike) {
    const trace = traceLike && typeof traceLike === "object" ? traceLike : {};
    const status = wbText(trace.status, "").toLowerCase();
    if (status === "done") return "已完成";
    if (status === "error") return "执行失败";
    if (status === "running") return "进行中";
    const summary = wbText(trace.message || trace.summary, "");
    return summary || "";
  }

  function renderTraceDetails(traceLike) {
    const trace = traceLike && typeof traceLike === "object" ? traceLike : {};
    const phase = stepPhase(trace);
    const details = trace.details && typeof trace.details === "object" ? trace.details : {};
    const blocks = [];
    if (details.actionLabel) blocks.push(wbTextBlock("执行动作", details.actionLabel));
    if (details.executionMode) blocks.push(wbTextBlock("执行环境", details.executionMode));
    if (phase === "understand") {
      return "";
    } else if (phase === "plan") {
      if (details.streamMode === "thinking_stream"
        || (details.planBuild && typeof details.planBuild === "object")
        || wbText(trace.moduleId, "") === "plan.finalize") {
        return "";
      }
      blocks.push(renderPlanArtifact(details.planArtifact));
    } else if (phase === "spec_lock") {
      return renderSpecArtifact(details.specArtifact);
    } else if (phase === "write") {
      var specForName = details.specArtifact && typeof details.specArtifact === "object" ? details.specArtifact : null;
      return renderCodeCard(details.codeSnippet, {
        source: wbText(details.codeSource, wbText(details.executionMode, "")),
        featureName: specForName ? wbText(specForName.featureName, "feature") : "feature",
      });
    } else if (phase === "summarize") {
      if (details.resultSummary) blocks.push(wbTextBlock("最终摘要", details.resultSummary));
      if (details.specArtifact) blocks.push(renderSpecArtifact(details.specArtifact));
      if (details.generatedCode && details.generatedCode.featureCode) {
        blocks.push(wbCodeBlock("最终代码", details.generatedCode.featureCode));
      }
      if (details.runArtifacts) blocks.push(renderRunArtifacts(details.runArtifacts));
    } else {
      if (details.planArtifact) blocks.push(renderPlanArtifact(details.planArtifact));
      if (details.specArtifact) blocks.push(renderSpecArtifact(details.specArtifact));
      if (details.repairSummary) blocks.push(renderRepairSummary(details.repairSummary));
      if (details.codeDiff) blocks.push(renderUnifiedDiff(details.codeDiff));
      if (details.codeSnippet) blocks.push(wbCodeBlock("代码片段", details.codeSnippet));
      if (details.runResult) blocks.push(renderRunResult(details.runResult));
      if (details.runArtifacts) blocks.push(renderRunArtifacts(details.runArtifacts));
      if (Array.isArray(details.issues) && details.issues.length) blocks.push(wbBlock("检测到的问题", wbList(details.issues)));
      if (Array.isArray(details.warnings) && details.warnings.length) blocks.push(wbBlock("提示", wbList(details.warnings)));
    }
    return blocks.filter(Boolean).join("");
  }

  function buildTraceFingerprint(traceLike) {
    const trace = traceLike && typeof traceLike === "object" ? traceLike : {};
    const details = trace.details && typeof trace.details === "object" ? trace.details : {};
    const planBuild = details.planBuild && typeof details.planBuild === "object" ? details.planBuild : {};
    return [
      wbText(trace.moduleId, ""),
      wbText(trace.seq, ""),
      wbText(trace.ts, ""),
      stepPhase(trace),
      wbText(trace.status, ""),
      wbText(trace.message, ""),
      wbText(trace.title, ""),
      wbText(trace.attempt, ""),
      wbText(details.actionLabel, ""),
      wbText(details.executionMode, ""),
      wbText(details.streamMode, ""),
      wbText(details.thinkingText, "").slice(0, 120),
      wbText(planBuild.key, ""),
      wbText(planBuild.status, ""),
      wbText(planBuild.text, "").slice(0, 120),
      wbText(details.codeSnippet, "").slice(0, 80),
      wbText(details.fixSummary, "").slice(0, 80),
    ].join("|");
  }

  function renderTraceEvent(traceLike) {
    const trace = traceLike && typeof traceLike === "object" ? traceLike : {};
    const phase = stepPhase(trace);
    var skipSummary = phase === "spec_lock" || phase === "write";
    const summary = skipSummary ? "" : wbText(trace.message || trace.summary, "");
    const detailsHtml = renderTraceDetails(trace);
    const status = wbText(trace.status, "running").toLowerCase();
    var extraClass = (phase === "spec_lock" || phase === "write") ? " spec-lock-trace" : "";
    return ''
      + '<div class="ai-workbench-trace-event ' + wbEscapeHtml(status || "running") + extraClass + '">'
      + (summary ? ('<div class="ai-workbench-trace-summary">' + wbEscapeHtml(summary) + "</div>") : "")
      + detailsHtml
      + "</div>";
  }

  function renderStaticProgressivePlanStep(tracesLike) {
    const traces = Array.isArray(tracesLike) ? tracesLike : [];
    if (!traces.length) return "";
    const lastTrace = traces[traces.length - 1] && typeof traces[traces.length - 1] === "object" ? traces[traces.length - 1] : {};
    const status = wbText(lastTrace.status, "done").toLowerCase();
    const title = buildStepTitle(lastTrace);
    const summary = buildStepSummary(lastTrace);
    let thinkingText = "";
    const planState = { goal: "", approach: "", validation: "", repair: "" };
    let planStatus = "";
    let planArtifact = null;
    traces.forEach(function(traceLike) {
      const trace = traceLike && typeof traceLike === "object" ? traceLike : {};
      const details = trace.details && typeof trace.details === "object" ? trace.details : {};
      if (details.streamMode === "thinking_stream") {
        thinkingText = wbText(details.thinkingText, thinkingText);
      }
      if (details.planBuild && typeof details.planBuild === "object") {
        const key = wbText(details.planBuild.key, "");
        if (key && Object.prototype.hasOwnProperty.call(planState, key)) {
          planState[key] = wbText(details.planBuild.text, planState[key]);
        }
      }
      if (details.planArtifact && typeof details.planArtifact === "object") {
        planArtifact = details.planArtifact;
      }
      if (details.planStatus) {
        planStatus = wbText(details.planStatus, planStatus);
      }
    });
    if (planArtifact) {
      if (!planState.goal) planState.goal = wbText(planArtifact.goal || planArtifact.summary, "");
      if (!planState.approach) {
        const approach = Array.isArray(planArtifact.approach) ? planArtifact.approach.filter(Boolean).join("；") : "";
        const inputs = Array.isArray(planArtifact.inputs) ? planArtifact.inputs.filter(Boolean).slice(0, 2).join("；") : "";
        planState.approach = [approach, inputs ? ("输入：" + inputs) : ""].filter(Boolean).join("；");
      }
      if (!planState.validation) {
        planState.validation = Array.isArray(planArtifact.validation) ? planArtifact.validation.filter(Boolean).join("；") : "";
      }
      if (!planState.repair) {
        planState.repair = Array.isArray(planArtifact.repairStrategy) ? planArtifact.repairStrategy.filter(Boolean).join("；") : "";
      }
    }
    const planStatusLabel = planStatus === "finalized" ? "已定稿"
      : planStatus === "refining" ? "细化中"
      : planStatus === "drafting" ? "草案中"
      : "进行中";
    const detailsHtml = [
      thinkingText
        ? '<div class="ai-trace-block"><div class="ai-trace-label">AI 思考过程</div><div class="ai-trace-text">' + wbInlineText(thinkingText) + "</div></div>"
        : "",
      (planState.goal || planState.approach || planState.validation || planState.repair)
        ? '<div class="ai-trace-block"><div class="ai-trace-label">本次任务计划（' + wbEscapeHtml(planStatusLabel) + '）</div>'
          + [
            planState.goal ? '<div class="ai-trace-block"><div class="ai-trace-label">我理解到的需求</div><div class="ai-trace-text">' + wbInlineText(planState.goal) + "</div></div>" : "",
            planState.approach ? '<div class="ai-trace-block"><div class="ai-trace-label">我将怎么做</div><div class="ai-trace-text">' + wbInlineText(planState.approach) + "</div></div>" : "",
            planState.validation ? '<div class="ai-trace-block"><div class="ai-trace-label">我会如何验证</div><div class="ai-trace-text">' + wbInlineText(planState.validation) + "</div></div>" : "",
            planState.repair ? '<div class="ai-trace-block"><div class="ai-trace-label">若失败怎么修复</div><div class="ai-trace-text">' + wbInlineText(planState.repair) + "</div></div>" : "",
          ].join("")
          + "</div>"
        : "",
    ].filter(Boolean).join("");
    return '<details class="ai-workbench-static-step"'
      + (status === "running" || status === "error" ? " open" : "")
      + ">"
      + '<summary><span class="status ' + wbEscapeHtml(status) + '">'
      + wbEscapeHtml(status === "done" ? "✓" : status === "error" ? "✗" : "◦")
      + '</span><span class="title">' + wbEscapeHtml(title) + '</span>'
      + (summary ? ('<span class="summary">' + wbEscapeHtml(summary) + "</span>") : "")
      + "</summary>"
      + '<div class="body">' + detailsHtml + "</div>"
      + "</details>";
  }

  function buildStepKey(traceLike) {
    const trace = traceLike && typeof traceLike === "object" ? traceLike : {};
    const phase = stepPhase(trace);
    const attempt = wbText(trace.attempt, "");
    return phase + "|" + attempt;
  }

  function buildStatusLabel(taskLike) {
    const task = taskLike && typeof taskLike === "object" ? taskLike : null;
    if (!task) return "";
    const raw = wbText(task.finalStatus || task.currentStage, "").toLowerCase();
    if (raw === "completed") return "已完成";
    if (raw === "failed") return "失败";
    if (raw) return "进行中";
    return "";
  }

  function createStrategyIntentWorkbenchRuntime(optionsLike) {
    const options = optionsLike && typeof optionsLike === "object" ? optionsLike : {};
    const onApply = typeof options.onApply === "function" ? options.onApply : null;
    const onViewportChange = typeof options.onViewportChange === "function" ? options.onViewportChange : null;
    const featureConcept = options.featureConcept && typeof options.featureConcept === "object" ? options.featureConcept : {};

    const root = document.createElement("div");
    root.className = "ai-thinking-panel ai-workbench collapsed";
    root.style.display = "none";

    const header = document.createElement("div");
    header.className = "ai-thinking-header";
    header.innerHTML = '<div class="thinking-icon"></div><span>' + wbText(options.title || "特征生成过程") + "</span>";
    root.appendChild(header);

    const body = document.createElement("div");
    body.className = "ai-thinking-body ai-workbench-body";
    root.appendChild(body);

    const processHost = document.createElement("div");
    processHost.className = "ai-workbench-process";
    body.appendChild(processHost);

    const progress = document.createElement("div");
    progress.className = "ai-clarify-progress ai-workbench-progress";
    progress.style.display = "none";
    processHost.appendChild(progress);

    const stepsHost = document.createElement("div");
    stepsHost.className = "ai-workbench-steps";
    processHost.appendChild(stepsHost);

    const resultHost = document.createElement("div");
    resultHost.className = "ai-clarify-result ai-workbench-result";
    resultHost.style.display = "none";
    body.appendChild(resultHost);

    header.addEventListener("click", function onClickHeader() {
      root.classList.toggle("collapsed");
    });

    const state = {
      task: null,
      stepKeys: [],
      stepMap: {},
      collapseTimer: 0,
      hasFinalized: false,
      autoCollapsed: false,
    };

    function notifyViewportChange(reasonLike) {
      if (!onViewportChange) return;
      try {
        onViewportChange(wbText(reasonLike, "trace"), root);
      } catch (_) {}
    }

    function clearCollapseTimer() {
      if (!state.collapseTimer) return;
      clearTimeout(state.collapseTimer);
      state.collapseTimer = 0;
    }

    function setProcessCollapsed(collapsed) {
      processHost.classList.toggle("collapsed", Boolean(collapsed));
      if (!collapsed) processHost.style.display = "";
    }

    function waitFrame() {
      return new Promise(function(resolve) {
        if (typeof requestAnimationFrame === "function") {
          requestAnimationFrame(function() { resolve(); });
          return;
        }
        setTimeout(resolve, 16);
      });
    }

    function waitMs(delayLike) {
      const delay = Math.max(0, Math.floor(wbNum(delayLike, 0)));
      return new Promise(function(resolve) { setTimeout(resolve, delay); });
    }

    async function animateTextNode(nodeLike, targetTextLike, optionsLike) {
      const node = nodeLike || null;
      if (!node) return;
      const targetText = wbText(targetTextLike, "");
      const options = optionsLike && typeof optionsLike === "object" ? optionsLike : {};
      const currentText = wbText(node.__wbAnimatedText || node.textContent, "");
      if (targetText === currentText) return;
      const appendedOnly = targetText.indexOf(currentText) === 0;
      if (!appendedOnly) {
        node.textContent = targetText;
        node.__wbAnimatedText = targetText;
        return;
      }
      const delta = targetText.slice(currentText.length);
      const minChunk = Math.max(1, Math.floor(wbNum(options.minChunk, 1)));
      const maxChunk = Math.max(minChunk, Math.floor(wbNum(options.maxChunk, 3)));
      const delayMs = Math.max(8, Math.floor(wbNum(options.delayMs, 18)));
      let cursor = 0;
      const activeClass = wbText(options.activeClass, "");
      if (activeClass) node.classList.add(activeClass);
      while (cursor < delta.length) {
        const chunkSize = Math.max(minChunk, Math.min(maxChunk, delta.length - cursor));
        const nextText = currentText + delta.slice(0, cursor + chunkSize);
        node.textContent = nextText;
        node.__wbAnimatedText = nextText;
        cursor += chunkSize;
        if (cursor < delta.length) {
          await waitMs(delayMs);
        }
      }
      if (activeClass) node.classList.remove(activeClass);
    }

    function isUnderstandPayload(payloadLike) {
      const payload = payloadLike && typeof payloadLike === "object" ? payloadLike : null;
      return Boolean(payload && wbText(payload.schema, "") === "understand_cards_v1");
    }

    function ensureUnderstandProgressiveHost(panelElLike) {
      const panelEl = panelElLike || null;
      if (!panelEl) return null;
      let host = panelEl.querySelector(".ai-workbench-understand-progressive");
      if (host) return host;
      host = document.createElement("div");
      host.className = "ai-workbench-understand-progressive";
      host.__taskRendered = false;
      host.__optionTokens = new Set();
      host.innerHTML = ""
        + '<div class="ai-workbench-understand-line" data-understand-task-line style="display:none">'
        + '  <span class="ai-workbench-understand-prefix">- 任务分配：</span>'
        + '  <span class="ai-workbench-understand-inline" data-understand-task></span>'
        + "</div>"
        + '<div class="ai-workbench-understand-line" data-understand-option-line style="display:none">'
        + '  <span class="ai-workbench-understand-prefix">- 选项加载：</span>'
        + '  <span class="ai-workbench-understand-inline ai-workbench-understand-options" data-understand-options></span>'
        + "</div>";
      panelEl.appendChild(host);
      return host;
    }

    async function applyProgressiveUnderstandTrace(panelElLike, traceLike) {
      const panelEl = panelElLike || null;
      const trace = traceLike && typeof traceLike === "object" ? traceLike : {};
      const details = trace.details && typeof trace.details === "object" ? trace.details : {};
      const payload = details.payload && typeof details.payload === "object" ? details.payload : null;
      if (!panelEl || !isUnderstandPayload(payload)) return;
      const host = ensureUnderstandProgressiveHost(panelEl);
      if (!host) return;
      if (!(host.__optionTokens instanceof Set)) host.__optionTokens = new Set();
      const taskLine = host.querySelector("[data-understand-task-line]");
      const taskInline = host.querySelector("[data-understand-task]");
      const optionLine = host.querySelector("[data-understand-option-line]");
      const optionInline = host.querySelector("[data-understand-options]");
      const taskTokenText = wbText(payload.taskToken, "");
      if (taskTokenText && taskLine && taskInline && !host.__taskRendered) {
        taskLine.style.display = "";
        const tokenEl = document.createElement("span");
        tokenEl.className = "ai-workbench-understand-token task";
        taskInline.appendChild(tokenEl);
        await animateTextNode(tokenEl, taskTokenText, {
          minChunk: 1,
          maxChunk: 3,
          delayMs: 14,
          activeClass: "is-streaming",
        });
        host.__taskRendered = true;
      }
      const optionTokens = Array.isArray(payload.optionTokens)
        ? payload.optionTokens.map(function(itemLike) { return wbText(itemLike, ""); }).filter(Boolean)
        : [];
      if (optionTokens.length && optionLine && optionInline) {
        optionLine.style.display = "";
        for (let i = 0; i < optionTokens.length; i += 1) {
          const tokenText = optionTokens[i];
          if (!tokenText || host.__optionTokens.has(tokenText)) continue;
          const optionEl = document.createElement("span");
          optionEl.className = "ai-workbench-understand-token option";
          optionInline.appendChild(optionEl);
          await animateTextNode(optionEl, tokenText, {
            minChunk: 1,
            maxChunk: 4,
            delayMs: 12,
            activeClass: "is-streaming",
          });
          host.__optionTokens.add(tokenText);
          if (i < optionTokens.length - 1) {
            await waitMs(180);
          }
        }
      }
      await waitFrame();
    }

    function ensurePlanProgressiveHost(panelElLike) {
      const panelEl = panelElLike || null;
      if (!panelEl) return null;
      let host = panelEl.querySelector(".ai-workbench-plan-progressive");
      if (host) return host;
      host = document.createElement("div");
      host.className = "ai-workbench-plan-progressive";
      host.__planThinkingDone = false;
      host.__lastThinkingIndex = 0;
      host.__pendingPlanFields = { goal: "", approach: "", validation: "", repair: "" };
      host.__renderedPlanFields = new Set();
      host.innerHTML = ""
        + '<div class="ai-workbench-plan-progress-line ai-workbench-trace-event running" data-plan-progress-line>等待生成计划清单...</div>'
        + '<div class="ai-workbench-plan-thinking" style="display:none">'
        + '  <div class="ai-workbench-phase-title">AI 思考过程</div>'
        + '  <div class="ai-workbench-phase-stream" data-thinking-stream></div>'
        + "</div>"
        + '<div class="ai-workbench-plan-card" style="display:none">'
        + '  <div class="ai-workbench-plan-card-title">本次任务计划 <span data-plan-card-status>等待中</span></div>'
        + '  <div class="ai-workbench-plan-section"><div class="ai-workbench-plan-label">我理解到的需求</div><div class="ai-workbench-plan-text" data-plan-field="goal"></div></div>'
        + '  <div class="ai-workbench-plan-section"><div class="ai-workbench-plan-label">我将怎么做</div><div class="ai-workbench-plan-text" data-plan-field="approach"></div></div>'
        + '  <div class="ai-workbench-plan-section"><div class="ai-workbench-plan-label">我会如何验证</div><div class="ai-workbench-plan-text" data-plan-field="validation"></div></div>'
        + '  <div class="ai-workbench-plan-section"><div class="ai-workbench-plan-label">若失败怎么修复</div><div class="ai-workbench-plan-text" data-plan-field="repair"></div></div>'
        + "</div>";
      panelEl.appendChild(host);
      return host;
    }

    function getPlanStatusLabel(statusLike, fallbackLike) {
      const status = wbText(statusLike, "").toLowerCase();
      if (status === "finalized") return "已定稿";
      if (status === "refining") return "细化中";
      if (status === "drafting") return "草案中";
      return wbText(fallbackLike, "等待中");
    }

    function queuePlanField(hostLike, keyLike, textLike) {
      const host = hostLike || null;
      if (!host || !host.__pendingPlanFields || typeof host.__pendingPlanFields !== "object") return;
      const key = wbText(keyLike, "");
      const text = wbText(textLike, "");
      if (!key || !Object.prototype.hasOwnProperty.call(host.__pendingPlanFields, key) || !text) return;
      host.__pendingPlanFields[key] = text;
    }

    async function flushQueuedPlanFields(hostLike) {
      const host = hostLike || null;
      if (!host) return;
      const cardWrap = host.querySelector(".ai-workbench-plan-card");
      const renderedSet = host.__renderedPlanFields instanceof Set ? host.__renderedPlanFields : new Set();
      host.__renderedPlanFields = renderedSet;
      const fieldOrder = ["goal", "approach", "validation", "repair"];
      for (let i = 0; i < fieldOrder.length; i += 1) {
        const key = fieldOrder[i];
        const text = wbText(host.__pendingPlanFields && host.__pendingPlanFields[key], "");
        if (!text) break;
        const fieldNode = host.querySelector("[data-plan-field='" + wbEscapeHtml(key) + "']");
        if (!fieldNode) continue;
        if (cardWrap) cardWrap.style.display = "";
        await animateTextNode(fieldNode, text, {
          minChunk: 1,
          maxChunk: 4,
          delayMs: 16,
          activeClass: "is-streaming",
        });
        renderedSet.add(key);
      }
    }

    async function applyProgressivePlanTrace(panelElLike, traceLike) {
      const panelEl = panelElLike || null;
      const trace = traceLike && typeof traceLike === "object" ? traceLike : {};
      const details = trace.details && typeof trace.details === "object" ? trace.details : {};
      if (!panelEl) return;
      const host = ensurePlanProgressiveHost(panelEl);
      if (!host) return;
      const progressLine = host.querySelector("[data-plan-progress-line]");
      const thinkingWrap = host.querySelector(".ai-workbench-plan-thinking");
      const thinkingNode = host.querySelector("[data-thinking-stream]");
      const cardWrap = host.querySelector(".ai-workbench-plan-card");
      const cardStatusNode = host.querySelector("[data-plan-card-status]");
      const planBuild = details.planBuild && typeof details.planBuild === "object" ? details.planBuild : null;
      const planStatus = wbText(details.planStatus || (planBuild && planBuild.status), "");
      const thinkingIndex = Math.max(0, Math.floor(wbNum(details.thinkingIndex, 0)));
      const thinkingText = wbText(details.thinkingText, "");
      const isPlanFinalize = wbText(trace.moduleId, "") === "plan.finalize";
      if (progressLine) {
        progressLine.textContent = wbText(trace.message || trace.summary, "计划生成中...");
        progressLine.className = "ai-workbench-trace-event " + wbText(trace.status, "running").toLowerCase();
      }
      if (details.streamMode === "thinking_stream" && thinkingNode) {
        if (thinkingWrap) thinkingWrap.style.display = "";
        if (thinkingIndex > 0 && host.__lastThinkingIndex > 0 && thinkingIndex < host.__lastThinkingIndex) {
          thinkingNode.textContent = thinkingText;
          thinkingNode.__wbAnimatedText = thinkingText;
        } else {
          await animateTextNode(thinkingNode, thinkingText, {
            minChunk: 1,
            maxChunk: 3,
            delayMs: 14,
            activeClass: "is-streaming",
          });
        }
        host.__lastThinkingIndex = Math.max(host.__lastThinkingIndex || 0, thinkingIndex);
        if (details.chunkDone === true) {
          host.__planThinkingDone = true;
        }
      }
      if (planBuild) {
        queuePlanField(host, wbText(planBuild.key, ""), wbText(planBuild.text, ""));
      }
      if (host.__planThinkingDone && planBuild) {
        await flushQueuedPlanFields(host);
      }
      if (details.planArtifact && (isPlanFinalize || planStatus === "finalized")) {
        if (cardWrap) cardWrap.style.display = "";
        fillPlanCardFromArtifact(host, details.planArtifact);
        if (host.__renderedPlanFields instanceof Set) {
          ["goal", "approach", "validation", "repair"].forEach(function(key) {
            host.__renderedPlanFields.add(key);
          });
        }
      }
      if (cardStatusNode) {
        cardStatusNode.textContent = getPlanStatusLabel(planStatus, host.__planThinkingDone ? "细化中" : "草案中");
      }
      await waitFrame();
    }

    function renderHeader() {
      const titleEl = header.querySelector("span");
      if (!titleEl) return;
      const label = buildStatusLabel(state.task);
      const count = state.stepKeys.length;
      titleEl.textContent = wbText(options.title || "特征生成过程")
        + (count ? (" (" + String(count) + " 步" + (label ? (", " + label) : "") + ")") : "");
    }

    function ensureVisible() {
      root.style.display = "";
    }

    function setExpanded(stepRow, expanded) {
      if (!stepRow) return;
      const toggle = stepRow.querySelector(".ai-workbench-step-toggle");
      const panel = stepRow.querySelector(".ai-workbench-step-panel");
      stepRow.classList.toggle("collapsed", !expanded);
      if (toggle) toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
      if (panel) panel.style.display = expanded ? "" : "none";
    }

    function expandAllSteps() {
      state.stepKeys.forEach(function(key) {
        const row = state.stepMap[key] || null;
        if (row) setExpanded(row, true);
      });
      root.classList.remove("collapsed");
      setProcessCollapsed(false);
    }

    function scheduleCollapseIfFinished() {
      clearCollapseTimer();
      state.autoCollapsed = false;
      setProcessCollapsed(false);
    }

    function ensureStep(traceLike) {
      const key = buildStepKey(traceLike);
      let stepRow = state.stepMap[key] || null;
      if (stepRow) return stepRow;
      stepRow = document.createElement("details");
      stepRow.className = "ai-thinking-step ai-workbench-step";
      stepRow.open = true;
      stepRow.setAttribute("data-step", key);
      stepRow.__traceFingerprints = new Set();
      stepRow.innerHTML = ""
        + '<summary class="ai-workbench-step-toggle" aria-expanded="true">'
        + '<span class="step-icon">◦</span>'
        + '<span class="step-text"></span>'
        + '<span class="ai-workbench-step-summary"></span>'
        + '<span class="ai-workbench-step-chevron">▼</span>'
        + "</summary>"
        + '<div class="ai-workbench-step-panel"></div>';
      const toggle = stepRow.querySelector(".ai-workbench-step-toggle");
      toggle.addEventListener("click", function onClickStep() {
        requestAnimationFrame(function syncToggleState() {
          setExpanded(stepRow, Boolean(stepRow.open));
        });
      });
      stepsHost.appendChild(stepRow);
      state.stepMap[key] = stepRow;
      state.stepKeys.push(key);
      return stepRow;
    }

    /* ── 特征验证 — 动态路径 ── */
    var validateState = {
      stepRow: null,
      currentAttempt: 0,
      roundCard: null,
      runDot: null, runName: null, runBadge: null, runLine: null, runContent: null,
      detDot: null, detName: null, detBadge: null, detLine: null, detContent: null,
      repDot: null, repName: null, repBadge: null, repContent: null,
    };

    function ensureValidateStep() {
      if (validateState.stepRow) return validateState.stepRow;
      var key = "validate|1";
      var stepRow = state.stepMap[key] || null;
      if (stepRow) { validateState.stepRow = stepRow; return stepRow; }
      stepRow = document.createElement("details");
      stepRow.className = "ai-thinking-step ai-workbench-step running";
      stepRow.open = true;
      stepRow.setAttribute("data-step", key);
      stepRow.__traceFingerprints = new Set();
      stepRow.innerHTML = ''
        + '<summary class="ai-workbench-step-toggle" aria-expanded="true">'
        + '<span class="step-icon">◦</span>'
        + '<span class="step-text">特征验证</span>'
        + '<span class="ai-workbench-step-summary">进行中</span>'
        + '<span class="ai-workbench-step-chevron">▼</span>'
        + '</summary>'
        + '<div class="ai-workbench-step-panel"></div>';
      var toggle = stepRow.querySelector(".ai-workbench-step-toggle");
      toggle.addEventListener("click", function() {
        requestAnimationFrame(function() { setExpanded(stepRow, Boolean(stepRow.open)); });
      });
      stepsHost.appendChild(stepRow);
      state.stepMap[key] = stepRow;
      state.stepKeys.push(key);
      validateState.stepRow = stepRow;
      return stepRow;
    }

    function ensureValidateRound(attempt) {
      if (validateState.currentAttempt === attempt && validateState.roundCard) return;
      validateState.currentAttempt = attempt;
      var stepRow = ensureValidateStep();
      var panelEl = stepRow.querySelector(".ai-workbench-step-panel");
      var roundsHost = panelEl.querySelector(".validate-rounds");
      if (!roundsHost) {
        panelEl.innerHTML = '<div class="validate-rounds"></div>';
        roundsHost = panelEl.querySelector(".validate-rounds");
      }
      var cardId = "vr-dyn-" + attempt + "-" + String(Math.random()).slice(2, 8);
      var cardHtml = '<div class="vr-card" id="' + cardId + '">'
        + '<div class="vr-head" onclick="document.getElementById(\'' + cardId + '\').classList.toggle(\'collapsed\')">'
        + '<div class="vr-num vrn-fail">' + attempt + '</div>'
        + '<div class="vr-title">第 ' + attempt + ' 轮</div>'
        + '<div class="vr-outcome vro-fail">验证中</div>'
        + '<div class="vr-arrow">▾</div>'
        + '</div><div class="vr-body"><div class="vflow">'
        + '<div class="vf-row" data-vf="run"><div class="vf-left">'
        + '<div class="vf-dot vs-idle" data-dot="run">▶</div>'
        + '<div class="vf-line-wrap"><div class="vf-line-track"></div><div class="vf-line-fill lf-blue" data-line="run"></div></div>'
        + '</div><div class="vf-right"><div class="vf-header">'
        + '<span class="vf-phase-name vfn-idle" data-name="run">运行</span>'
        + '<span class="vf-badge vfb-run" data-badge="run">执行中</span>'
        + '</div><div class="vf-content" data-cont="run">'
        + '<div class="vf-scan" data-scan>执行特征函数<span class="vf-scan-cursor"></span></div>'
        + '<div class="vf-stat-row" data-stats style="display:none"></div>'
        + '</div></div></div>'
        + '<div class="vf-row" data-vf="det"><div class="vf-left">'
        + '<div class="vf-dot vs-idle" data-dot="det">◎</div>'
        + '<div class="vf-line-wrap"><div class="vf-line-track"></div><div class="vf-line-fill lf-red" data-line="det"></div></div>'
        + '</div><div class="vf-right"><div class="vf-header">'
        + '<span class="vf-phase-name vfn-idle" data-name="det">检测</span>'
        + '<span class="vf-badge vfb-run" data-badge="det">检测中</span>'
        + '</div><div class="vf-content" data-cont="det">'
        + '<div class="vf-check" data-check><span>正在校验</span><span class="vf-dp"><span></span><span></span><span></span></span></div>'
        + '<div data-det-result style="display:none"></div>'
        + '</div></div></div>'
        + '<div class="vf-row" data-vf="rep" style="display:none"><div class="vf-left">'
        + '<div class="vf-dot vs-idle" data-dot="rep">↻</div>'
        + '<div class="vf-line-wrap" style="min-height:0;flex:0;height:0;"></div>'
        + '</div><div class="vf-right"><div class="vf-header">'
        + '<span class="vf-phase-name vfn-idle" data-name="rep">修复</span>'
        + '<span class="vf-badge vfb-repair" data-badge="rep">修复中</span>'
        + '</div><div class="vf-content" data-cont="rep"></div></div></div>'
        + '</div></div></div>';
      var wrapper = document.createElement("div");
      wrapper.innerHTML = cardHtml;
      var card = wrapper.firstChild;
      roundsHost.appendChild(card);
      validateState.roundCard = card;
      var q = function(sel) { return card.querySelector(sel); };
      validateState.runDot  = q('[data-dot="run"]'); validateState.runName  = q('[data-name="run"]');
      validateState.runBadge= q('[data-badge="run"]'); validateState.runLine = q('[data-line="run"]');
      validateState.runContent = q('[data-cont="run"]');
      validateState.detDot  = q('[data-dot="det"]'); validateState.detName  = q('[data-name="det"]');
      validateState.detBadge= q('[data-badge="det"]'); validateState.detLine = q('[data-line="det"]');
      validateState.detContent = q('[data-cont="det"]');
      validateState.repDot  = q('[data-dot="rep"]'); validateState.repName  = q('[data-name="rep"]');
      validateState.repBadge= q('[data-badge="rep"]'); validateState.repContent = q('[data-cont="rep"]');
    }

    function applyValidateTrace(trace) {
      var phase = stepPhase(trace);
      var attempt = Math.max(1, Math.floor(wbNum(trace.attempt, 1)));
      var status = wbText(trace.status, "running").toLowerCase();
      var details = trace.details && typeof trace.details === "object" ? trace.details : {};
      ensureValidateRound(attempt);
      var vs = validateState;
      var card = vs.roundCard;

      if (phase === "run") {
        vs.runDot.className  = "vf-dot " + (status === "done" ? "vs-ok" : "vs-run");
        vs.runName.className = "vf-phase-name " + (status === "done" ? "vfn-ok" : "vfn-run");
        vs.runBadge.textContent = status === "done" ? "完成" : "执行中";
        vs.runBadge.className = "vf-badge " + (status === "done" ? "vfb-ok" : "vfb-run") + " show";
        vs.runContent.classList.add("visible");
        var scanEl = card.querySelector("[data-scan]");
        var statsEl = card.querySelector("[data-stats]");
        if (status === "done") {
          if (scanEl) scanEl.classList.remove("active");
          if (statsEl) {
            var statParts = [];
            var rr = details.runResult && typeof details.runResult === "object" ? details.runResult : null;
            if (rr && Number.isFinite(Number(rr.barCount))) statParts.push('<span class="vf-stat-k">数据行<span class="vf-stat-v">' + Number(rr.barCount) + '</span></span>');
            if (rr && rr.stats && typeof rr.stats === "object" && Number.isFinite(Number(rr.stats.mean))) {
              statParts.push('<span class="vf-stat-k">均值<span class="vf-stat-v">' + Number(rr.stats.mean).toFixed(4) + '</span></span>');
            }
            statsEl.innerHTML = statParts.join("");
            statsEl.style.display = statParts.length ? "flex" : "none";
          }
          vs.runLine.style.transition = "height .55s ease";
          vs.runLine.style.height = "100%";
        } else {
          if (scanEl) scanEl.classList.add("active");
        }
      } else if (phase === "detect") {
        vs.detDot.className  = "vf-dot " + (status === "done" ? "vs-fail" : "vs-run");
        vs.detName.className = "vf-phase-name " + (status === "done" ? "vfn-fail" : "vfn-run");
        vs.detContent.classList.add("visible");
        var checkEl = card.querySelector("[data-check]");
        var detResultEl = card.querySelector("[data-det-result]");
        if (status === "done") {
          var hasIssues = Array.isArray(details.issues) && details.issues.length > 0;
          if (hasIssues) {
            vs.detDot.className = "vf-dot vs-fail";
            vs.detName.className = "vf-phase-name vfn-fail";
            vs.detBadge.textContent = "检测失败";
            vs.detBadge.className = "vf-badge vfb-fail show";
            var issHtml = "";
            for (var ii = 0; ii < details.issues.length; ii++) {
              issHtml += '<span class="vf-issue-tag">⚠ ' + wbEscapeHtml(wbText(details.issues[ii], "")) + '</span>';
            }
            if (details.failureType) issHtml += '<div class="vf-issue-desc">' + wbEscapeHtml(details.failureType) + '</div>';
            if (detResultEl) { detResultEl.innerHTML = issHtml; detResultEl.style.display = "block"; }
            vs.detLine.style.transition = "height .5s ease";
            vs.detLine.style.height = "100%";
          } else {
            vs.detDot.className = "vf-dot vs-ok";
            vs.detName.className = "vf-phase-name vfn-ok";
            vs.detBadge.textContent = "通过";
            vs.detBadge.className = "vf-badge vfb-ok show";
            if (detResultEl) { detResultEl.innerHTML = '<div class="vf-pass-result">✓ 全部检测通过</div>'; detResultEl.style.display = "block"; }
            var headOutcome = card.querySelector(".vr-outcome");
            if (headOutcome) { headOutcome.textContent = "全部检测通过"; headOutcome.className = "vr-outcome vro-pass"; }
            var headNum = card.querySelector(".vr-num");
            if (headNum) headNum.className = "vr-num vrn-pass";
          }
          if (checkEl) checkEl.classList.remove("active");
        } else {
          vs.detBadge.textContent = "检测中"; vs.detBadge.className = "vf-badge vfb-run show";
          if (checkEl) checkEl.classList.add("active");
        }
      } else if (phase === "repair") {
        var repRow = card.querySelector('[data-vf="rep"]');
        if (repRow) repRow.style.display = "";
        vs.repDot.className  = "vf-dot " + (status === "done" ? "vs-repair" : "vs-run");
        vs.repName.className = "vf-phase-name " + (status === "done" ? "vfn-repair" : "vfn-run");
        vs.repBadge.textContent = status === "done" ? "已修复" : "修复中";
        vs.repBadge.className = "vf-badge " + (status === "done" ? "vfb-repair" : "vfb-run") + " show";
        vs.repContent.classList.add("visible");
        if (status === "done") {
          var repSummary = details.repairSummary && typeof details.repairSummary === "object" ? details.repairSummary : null;
          var descHtml = "";
          if (repSummary && repSummary.repairGoal) descHtml = '<div class="vf-repair-desc">' + wbEscapeHtml(repSummary.repairGoal) + '</div>';
          else if (details.fixSummary) descHtml = '<div class="vf-repair-desc">' + wbEscapeHtml(details.fixSummary) + '</div>';
          var diffHtml = details.codeDiff ? renderUnifiedDiff(details.codeDiff, { fileName: "feature.py" }) : "";
          vs.repContent.innerHTML = descHtml + diffHtml;
          var headOutcome2 = card.querySelector(".vr-outcome");
          if (headOutcome2) { headOutcome2.textContent = "检测失败 · 已修复"; headOutcome2.className = "vr-outcome vro-fail"; }
        }
      }

      /* 更新验证步骤行状态 */
      var vstep = validateState.stepRow;
      if (vstep) {
        var isDone = status === "done" && (phase === "detect" || phase === "repair");
        var icon = vstep.querySelector(".step-icon");
        var sum  = vstep.querySelector(".ai-workbench-step-summary");
        if (icon && isDone && phase === "detect" && !(Array.isArray(details.issues) && details.issues.length)) {
          icon.textContent = "✓";
          if (sum) sum.textContent = "已完成";
          vstep.className = "ai-thinking-step ai-workbench-step done";
        }
      }
    }

    async function applyTrace(traceLike) {
      const trace = traceLike && typeof traceLike === "object" ? traceLike : {};
      const phase = stepPhase(trace);
      if (!phase) return;
      ensureVisible();

      /* run/detect/repair → 特征验证卡 */
      if (VALIDATE_PHASES[phase]) {
        applyValidateTrace(trace);
        root.classList.remove("collapsed");
        setProcessCollapsed(false);
        if (!state.hasFinalized) { clearCollapseTimer(); state.autoCollapsed = false; }
        renderHeader();
        notifyViewportChange("trace");
        await waitFrame();
        return;
      }

      const stepRow = ensureStep(trace);
      const status = wbText(trace.status, "running").toLowerCase();
      const iconEl = stepRow.querySelector(".step-icon");
      const titleEl = stepRow.querySelector(".step-text");
      const summaryEl = stepRow.querySelector(".ai-workbench-step-summary");
      const panelEl = stepRow.querySelector(".ai-workbench-step-panel");
      const details = trace.details && typeof trace.details === "object" ? trace.details : {};
      stepRow.className = "ai-thinking-step ai-workbench-step " + status;
      stepRow.classList.toggle("collapsed", !stepRow.open);
      if (iconEl) iconEl.textContent = status === "done" ? "✓" : status === "error" ? "✗" : "◦";
      if (titleEl) titleEl.textContent = buildStepTitle(trace);
      if (summaryEl) summaryEl.textContent = buildStepSummary(trace);
      if (panelEl) {
        if (phase === "understand" && isUnderstandPayload(details.payload)) {
          await applyProgressiveUnderstandTrace(panelEl, trace);
        } else if (phase === "plan" && (
          details.streamMode === "thinking_stream"
          || (details.planBuild && typeof details.planBuild === "object")
          || wbText(trace.moduleId, "") === "plan.finalize"
        )) {
          await applyProgressivePlanTrace(panelEl, trace);
        } else if (phase === "write" && details.streamMode === "code_accumulate") {
          let streamHost = panelEl.querySelector(".ai-workbench-stream-host");
          if (!streamHost) {
            const specForCard = details.specArtifact && typeof details.specArtifact === "object" ? details.specArtifact : null;
            const cardFeatureName = specForCard ? wbText(specForCard.featureName, "feature") : "feature";
            const cardFileName = cardFeatureName.replace(/[^a-zA-Z0-9_]/g, "_") + ".py";
            const cardSource = wbText(details.codeSource, wbText(details.executionMode, ""));
            const isTemplate = cardSource === "template";
            const sourceLabel = isTemplate ? "内置模板" : "AI 生成";
            const sourcePillClass = isTemplate ? "write-pill-template" : "write-pill-ai";
            streamHost = document.createElement("div");
            streamHost.className = "ai-workbench-stream-host write-card";
            streamHost.innerHTML = ""
              + '<div class="write-card-statusbar">'
              + '<div class="write-card-dot"></div>'
              + '<div class="write-card-filename">' + wbEscapeHtml(cardFileName) + '</div>'
              + '<div class="write-card-pills">'
              + '<span class="write-pill">Python</span>'
              + '<span class="write-pill write-stream-linecount">...</span>'
              + '<span class="write-pill ' + wbEscapeHtml(sourcePillClass) + '">' + wbEscapeHtml(sourceLabel) + '</span>'
              + '</div>'
              + '<div class="write-card-arrow">▼</div>'
              + '</div>'
              + '<div class="write-card-code-body">'
              + '<div class="write-card-code write-card-streaming-code"><code></code></div>'
              + '</div>'
              + '<div class="write-card-collapsed-hint"></div>';
            streamHost.querySelector(".write-card-statusbar").addEventListener("click", function() {
              streamHost.classList.toggle("collapsed");
            });
            panelEl.appendChild(streamHost);
          }
          var codeNode = streamHost.querySelector("code");
          var lineCountNode = streamHost.querySelector(".write-stream-linecount");
          if (codeNode) {
            await animateTextNode(codeNode, wbText(details.codeSnippet, ""), {
              minChunk: 2,
              maxChunk: 8,
              delayMs: 6,
              activeClass: "is-streaming",
            });
            if (lineCountNode) {
              var linesNow = wbText(details.codeSnippet, "").split("\n").length;
              lineCountNode.textContent = String(linesNow) + " 行";
            }
          }
          if (status === "done") {
            var fullCode = wbText(details.codeSnippet, "");
            var codeLines = fullCode.split("\n");
            var lineCountFinal = codeLines.length;
            var linesHtml = [];
            for (var li = 0; li < codeLines.length; li++) {
              linesHtml.push(
                '<div class="write-code-line">'
                + '<span class="write-line-num">' + String(li + 1) + '</span>'
                + '<span class="write-line-content">' + highlightPython(codeLines[li]) + '</span>'
                + '</div>'
              );
            }
            var codeBodyEl = streamHost.querySelector(".write-card-code-body");
            if (codeBodyEl) {
              codeBodyEl.innerHTML = '<div class="write-card-code">' + linesHtml.join("") + '</div>';
            }
            if (lineCountNode) {
              lineCountNode.textContent = String(lineCountFinal) + " 行";
            }
            var pillsEl = streamHost.querySelector(".write-card-pills");
            if (pillsEl && !pillsEl.querySelector(".write-pill-green")) {
              var runPill = document.createElement("span");
              runPill.className = "write-pill write-pill-green";
              runPill.textContent = "可运行";
              pillsEl.appendChild(runPill);
            }
            var hintEl = streamHost.querySelector(".write-card-collapsed-hint");
            if (hintEl) {
              hintEl.textContent = "点击展开查看代码 · " + String(lineCountFinal) + " 行";
            }
          }
        } else {
          const fingerprint = buildTraceFingerprint(trace);
          if (!(stepRow.__traceFingerprints instanceof Set)) stepRow.__traceFingerprints = new Set();
          if (!stepRow.__traceFingerprints.has(fingerprint)) {
            const eventEl = document.createElement("div");
            eventEl.className = "ai-workbench-trace-event-wrap";
            eventEl.innerHTML = renderTraceEvent(trace);
            panelEl.appendChild(eventEl);
            stepRow.__traceFingerprints.add(fingerprint);
          }
        }
      }
      setExpanded(stepRow, true);
      root.classList.remove("collapsed");
      setProcessCollapsed(false);
      if (!state.hasFinalized) {
        clearCollapseTimer();
        state.autoCollapsed = false;
      }
      renderHeader();
      notifyViewportChange("trace");
      await waitFrame();
    }

    function setTask(taskLike) {
      state.task = taskLike && typeof taskLike === "object" ? taskLike : null;
      if (state.task) {
        ensureVisible();
        root.classList.toggle("done", wbText(state.task.finalStatus, "").toLowerCase() === "completed");
      }
      const finalStatus = wbText(state.task && state.task.finalStatus, "").toLowerCase();
      state.hasFinalized = finalStatus === "completed" || finalStatus === "failed";
      if (!state.hasFinalized) state.autoCollapsed = false;
      expandAllSteps();
      renderHeader();
      scheduleCollapseIfFinished();
    }

    function renderResult(resultLike) {
      const result = resultLike && typeof resultLike === "object" ? resultLike : {};
      state.hasFinalized = true;
      progress.style.display = "none";
      resultHost.style.display = "block";
      resultHost.innerHTML = "";
      if (!result.ok) {
        const errorDiv = document.createElement("div");
        errorDiv.className = "ai-clarify-result-error";
        errorDiv.textContent = "⚠️ " + wbText(result.error || "特征生成失败，请重试或调整描述", "特征生成失败，请重试或调整描述");
        resultHost.appendChild(errorDiv);
        applyTrace({
          phase: "summarize",
          status: "error",
          message: wbText(result.error || "特征生成失败", "特征生成失败"),
          details: { resultSummary: wbText(result.error || "特征生成失败", "特征生成失败") },
        });
        scheduleCollapseIfFinished();
        notifyViewportChange("result");
        return;
      }

      const feature = result.feature && typeof result.feature === "object" ? result.feature : {};
      const featureName = wbText(feature.name || featureConcept.name || "", "特征");
      const successDiv = document.createElement("div");
      successDiv.className = "ai-clarify-result-success";

      const titleDiv = document.createElement("div");
      titleDiv.className = "ai-clarify-result-title";
      titleDiv.textContent = "✅ 特征已生成";
      successDiv.appendChild(titleDiv);

      const summary = wbText(result.resultSummary, "");
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

      const resultBlocks = document.createElement("div");
      resultBlocks.className = "ai-workbench-result-blocks";
      const hasPlanStep = state.stepKeys.some(function(key) {
        return String(key || "").indexOf("plan|") === 0;
      });
      const resultHtml = [
        !hasPlanStep && result.planArtifact ? renderPlanArtifact(result.planArtifact) : "",
        result.specArtifact ? renderSpecArtifact(result.specArtifact) : "",
        result.generatedCode && result.generatedCode.featureCode ? wbCodeBlock("最终代码", result.generatedCode.featureCode) : "",
        result.generatedCode && result.generatedCode.codeDiff ? renderUnifiedDiff(result.generatedCode.codeDiff) : "",
        result.repairSummary ? renderRepairSummary(result.repairSummary) : "",
        result.runArtifacts ? renderRunArtifacts(result.runArtifacts) : "",
      ].filter(Boolean).join("");
      resultBlocks.innerHTML = resultHtml;
      if (resultHtml) successDiv.appendChild(resultBlocks);

      if (onApply) {
        const applyBtn = document.createElement("button");
        applyBtn.type = "button";
        applyBtn.className = "ai-clarify-apply";
        applyBtn.textContent = "加入特征库";
        applyBtn.addEventListener("click", function onClickApply() {
          applyBtn.disabled = true;
          applyBtn.textContent = "正在加入...";
          Promise.resolve(onApply(result))
            .then(function onOutcome(outcome) {
              if (outcome && outcome.ok) {
                applyBtn.textContent = "✅ 已加入特征库";
                applyBtn.classList.add("done");
                return;
              }
              applyBtn.textContent = "加入失败：" + wbText(outcome && outcome.error, "");
              applyBtn.disabled = false;
            })
            .catch(function onError() {
              applyBtn.textContent = "加入失败";
              applyBtn.disabled = false;
            });
        });
        successDiv.appendChild(applyBtn);
      }

      resultHost.appendChild(successDiv);
      root.classList.remove("collapsed");
      expandAllSteps();
      setProcessCollapsed(false);
      scheduleCollapseIfFinished();
      notifyViewportChange("result");
    }

    function setProgress(textLike) {
      const text = wbText(textLike, "");
      if (!text) {
        progress.style.display = "none";
        progress.textContent = "";
        return;
      }
      ensureVisible();
      progress.style.display = "block";
      progress.textContent = text;
    }

    async function load(tracesLike, taskLike, resultLike) {
      const traces = Array.isArray(tracesLike) ? tracesLike : [];
      const finalStatus = wbText(taskLike && taskLike.finalStatus, "").toLowerCase();
      state.hasFinalized = finalStatus === "completed" || finalStatus === "failed" || Boolean(resultLike);
      for (let i = 0; i < traces.length; i += 1) {
        await applyTrace(traces[i]);
      }
      setTask(taskLike);
      if (resultLike && typeof resultLike === "object") {
        renderResult(resultLike);
      }
      const task = taskLike && typeof taskLike === "object" ? taskLike : null;
      root.classList.toggle("done", wbText(task && task.finalStatus, "").toLowerCase() === "completed" || Boolean(resultLike && resultLike.ok));
      expandAllSteps();
      scheduleCollapseIfFinished();
    }

    return {
      root: root,
      applyTrace: applyTrace,
      setTask: setTask,
      setProgress: setProgress,
      showResult: renderResult,
      load: load,
      collapseProcessArea: function() {
        clearCollapseTimer();
        state.autoCollapsed = false;
        setProcessCollapsed(false);
      },
      expandProcessArea: function() {
        clearCollapseTimer();
        setProcessCollapsed(false);
      },
      _renderers: {
        renderPlanArtifact: renderPlanArtifact,
        renderSpecArtifact: renderSpecArtifact,
        renderUnifiedDiff: renderUnifiedDiff,
        renderRepairSummary: renderRepairSummary,
        renderRunArtifacts: renderRunArtifacts,
      },
    };
  }

  async function runStrategyIntentConfirmStreamRuntime(optionsLike) {
    const options = optionsLike && typeof optionsLike === "object" ? optionsLike : {};
    const route = wbText(options.route || "/api/strategy/intent-confirm/stream", "/api/strategy/intent-confirm/stream");
    const payload = options.payload && typeof options.payload === "object" ? options.payload : {};
    const onTrace = typeof options.onTrace === "function" ? options.onTrace : null;
    const onResult = typeof options.onResult === "function" ? options.onResult : null;
    const resp = await fetch(route, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    if (!resp.body || typeof resp.body.getReader !== "function") {
      throw new Error("response stream is not readable");
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finalResult = null;
    let currentEvent = "";
    async function acknowledgeTrace(dataLike) {
      const data = dataLike && typeof dataLike === "object" ? dataLike : {};
      const task = data.task && typeof data.task === "object" ? data.task : null;
      const traces = task && Array.isArray(task.traces) ? task.traces : [];
      const latestTrace = traces.length ? (traces[traces.length - 1] || {}) : {};
      const taskId = wbText(data.taskId || (task && task.taskId), "");
      const moduleId = wbText(data.moduleId || latestTrace.moduleId, "");
      const seq = Math.max(0, Math.floor(wbNum(data.seq || latestTrace.seq, 0)));
      if (!taskId || !moduleId || seq <= 0) return;
      if (typeof requestAnimationFrame === "function") {
        await new Promise(function(resolve) {
          requestAnimationFrame(function() {
            requestAnimationFrame(resolve);
          });
        });
      }
      try {
        await fetch("/api/strategy/task-ack", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            taskId: taskId,
            moduleId: moduleId,
            seq: seq,
          }),
        });
      } catch (_) {}
    }
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (let i = 0; i < lines.length; i += 1) {
        const trimmed = wbText(lines[i], "");
        if (!trimmed) continue;
        if (trimmed.indexOf("event: ") === 0) {
          currentEvent = trimmed.slice(7);
          continue;
        }
        if (trimmed.indexOf("data: ") !== 0) continue;
        let data = null;
        try {
          data = JSON.parse(trimmed.slice(6) || "{}");
        } catch (_) {
          data = null;
        }
        if (!data || typeof data !== "object") {
          currentEvent = "";
          continue;
        }
        if (currentEvent === "thinking") {
          if (onTrace) await Promise.resolve(onTrace(data, data.task || null));
          await acknowledgeTrace(data);
        } else if (currentEvent === "result" || currentEvent === "done") {
          finalResult = data;
        }
        currentEvent = "";
      }
    }
    const result = finalResult && typeof finalResult === "object"
      ? finalResult
      : { ok: false, error: "生成失败" };
    if (onResult) onResult(result);
    return result;
  }

  function renderStaticStrategyIntentWorkbenchRuntime(payloadLike) {
    const payload = payloadLike && typeof payloadLike === "object" ? payloadLike : {};
    const traces = Array.isArray(payload.traces) ? payload.traces : [];
    const steps = [];
    for (let i = 0; i < traces.length; i += 1) {
      const trace = traces[i] && typeof traces[i] === "object" ? traces[i] : {};
      const details = trace.details && typeof trace.details === "object" ? trace.details : {};
      const isProgressivePlan = stepPhase(trace) === "plan"
        && (details.streamMode === "thinking_stream" || (details.planBuild && typeof details.planBuild === "object"));
      if (isProgressivePlan) {
        const chunk = [trace];
        while (i + 1 < traces.length) {
          const nextTrace = traces[i + 1] && typeof traces[i + 1] === "object" ? traces[i + 1] : {};
          const nextDetails = nextTrace.details && typeof nextTrace.details === "object" ? nextTrace.details : {};
          const sameStep = buildStepKey(nextTrace) === buildStepKey(trace);
          const nextIsProgressivePlan = stepPhase(nextTrace) === "plan"
            && (nextDetails.streamMode === "thinking_stream" || (nextDetails.planBuild && typeof nextDetails.planBuild === "object"));
          if (!sameStep || !nextIsProgressivePlan) break;
          chunk.push(nextTrace);
          i += 1;
        }
        steps.push(renderStaticProgressivePlanStep(chunk));
        continue;
      }
      const tracePhase = stepPhase(trace);

      /* run/detect/repair → 收组，合并为「特征验证」卡 */
      if (VALIDATE_PHASES[tracePhase]) {
        const vChunk = [trace];
        while (i + 1 < traces.length) {
          const nextT = traces[i + 1] && typeof traces[i + 1] === "object" ? traces[i + 1] : {};
          if (!VALIDATE_PHASES[stepPhase(nextT)]) break;
          vChunk.push(nextT);
          i += 1;
        }
        steps.push(renderStaticValidateCard(vChunk));
        continue;
      }

      const status = wbText(trace.status, "done").toLowerCase();
      const title = buildStepTitle(trace);
      var skipStepSummary = tracePhase === "spec_lock" || tracePhase === "write";
      const summary = skipStepSummary ? "" : buildStepSummary(trace);
      const detailsHtml = renderTraceDetails(trace);
      const stepExtraClass = (tracePhase === "spec_lock" || tracePhase === "write") ? " spec-lock-step" : "";
      steps.push('<details class="ai-workbench-static-step' + stepExtraClass + '"'
        + (status === "running" || status === "error" ? " open" : "")
        + ">"
        + '<summary><span class="status ' + wbEscapeHtml(status) + '">'
        + wbEscapeHtml(status === "done" ? "✓" : status === "error" ? "✗" : "◦")
        + '</span><span class="title">' + wbEscapeHtml(title) + '</span>'
        + (summary ? ('<span class="summary">' + wbEscapeHtml(summary) + "</span>") : "")
        + "</summary>"
        + '<div class="body">' + detailsHtml + "</div>"
        + "</details>");
    }
    const stepsHtml = steps.join("");
    return '<div class="ai-workbench-static">' + stepsHtml + "</div>";
  }

  globalObj.createStrategyIntentWorkbenchRuntime = createStrategyIntentWorkbenchRuntime;
  globalObj.runStrategyIntentConfirmStreamRuntime = runStrategyIntentConfirmStreamRuntime;
  globalObj.renderStaticStrategyIntentWorkbenchRuntime = renderStaticStrategyIntentWorkbenchRuntime;
})(typeof window !== "undefined" ? window : globalThis);
