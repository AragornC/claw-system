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

  function renderSpecArtifact(specLike) {
    const spec = specLike && typeof specLike === "object" ? specLike : null;
    if (!spec) return "";
    const structLines = [];
    if (spec.featureName) structLines.push("特征名：" + spec.featureName);
    if (spec.route) structLines.push("生成路由：" + spec.route + (spec.templateId ? (" / " + spec.templateId) : ""));
    if (spec.outputType) structLines.push("输出类型：" + spec.outputType);
    if (spec.outputRange && (spec.outputRange.min != null || spec.outputRange.max != null)) {
      structLines.push(
        "输出范围：" + String(spec.outputRange.min == null ? "-inf" : spec.outputRange.min)
        + " ~ "
        + String(spec.outputRange.max == null ? "inf" : spec.outputRange.max),
      );
    }
    if (Array.isArray(spec.inputColumns) && spec.inputColumns.length) {
      structLines.push("输入列：" + spec.inputColumns.join(", "));
    }
    return [
      wbTextBlock("规格摘要", spec.summary),
      wbTextBlock("核心信号", spec.coreSignal),
      structLines.length ? wbBlock("结构化 Spec", wbList(structLines)) : "",
      Array.isArray(spec.preservedConstraints) && spec.preservedConstraints.length
        ? wbBlock("必须保持不变", wbList(spec.preservedConstraints))
        : "",
    ].join("");
  }

  function renderCodeDiff(diffLike) {
    const diff = diffLike && typeof diffLike === "object" ? diffLike : null;
    if (!diff) return "";
    return [
      wbTextBlock("变更摘要", diff.summary),
      wbCodeBlock("修改前", diff.beforeSnippet),
      wbCodeBlock("修改后", diff.afterSnippet),
    ].join("");
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
    if (phase === "spec_lock") return "锁定 Spec";
    if (phase === "write") return "生成首版代码";
    if (phase === "run") return "第 " + String(Math.max(1, attempt || 1)) + " 轮运行";
    if (phase === "detect") return "第 " + String(Math.max(1, attempt || 1)) + " 轮检测";
    if (phase === "repair") return "第 " + String(Math.max(1, attempt || 1)) + " 轮修复";
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
      blocks.push(renderSpecArtifact(details.specArtifact));
    } else if (phase === "write") {
      if (details.codeSource) {
        blocks.push(wbTextBlock("代码来源", details.codeSource));
      }
      blocks.push(wbCodeBlock("首版代码", details.codeSnippet));
      if (details.specArtifact) blocks.push(renderSpecArtifact(details.specArtifact));
      if (Array.isArray(details.warnings) && details.warnings.length) {
        blocks.push(wbBlock("提示", wbList(details.warnings)));
      }
    } else if (phase === "repair") {
      if (details.codeSource) {
        blocks.push(wbTextBlock("代码来源", details.codeSource));
      }
      blocks.push(renderRepairSummary(details.repairSummary));
      blocks.push(renderCodeDiff(details.codeDiff));
      blocks.push(wbCodeBlock("修复后代码", details.codeSnippet));
      if (details.fixSummary) blocks.push(wbTextBlock("修复动作", details.fixSummary));
    } else if (phase === "run") {
      blocks.push(renderRunResult(details.runResult));
      blocks.push(renderRunArtifacts(details.runArtifacts));
      if (Array.isArray(details.warnings) && details.warnings.length) {
        blocks.push(wbBlock("提示", wbList(details.warnings)));
      }
      if (!blocks.join("") && details.codeSnippet) {
        blocks.push(wbCodeBlock("本轮执行代码", details.codeSnippet));
      }
    } else if (phase === "detect") {
      if (details.failureType) blocks.push(wbTextBlock("失败分类", details.failureType));
      if (Array.isArray(details.issues) && details.issues.length) blocks.push(wbBlock("检测到的问题", wbList(details.issues)));
      if (Array.isArray(details.warnings) && details.warnings.length) blocks.push(wbBlock("提示", wbList(details.warnings)));
      blocks.push(renderRunArtifacts(details.runArtifacts));
      if (details.fixSummary) blocks.push(wbTextBlock("下一步处理", details.fixSummary));
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
      if (details.codeDiff) blocks.push(renderCodeDiff(details.codeDiff));
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
    const summary = wbText(trace.message || trace.summary, "");
    const detailsHtml = renderTraceDetails(trace);
    const status = wbText(trace.status, "running").toLowerCase();
    return ''
      + '<div class="ai-workbench-trace-event ' + wbEscapeHtml(status || "running") + '">'
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
      if (progressLine) {
        progressLine.textContent = wbText(trace.message || trace.summary, "计划生成中...");
        progressLine.className = "ai-workbench-trace-event " + wbText(trace.status, "running").toLowerCase();
      }
      if (details.streamMode === "thinking_stream" && thinkingNode) {
        if (thinkingWrap) thinkingWrap.style.display = "";
        await animateTextNode(thinkingNode, wbText(details.thinkingText, ""), {
          minChunk: 1,
          maxChunk: 3,
          delayMs: 14,
          activeClass: "is-streaming",
        });
      }
      if (planBuild) {
        if (cardWrap) cardWrap.style.display = "";
        const fieldNode = host.querySelector("[data-plan-field='" + wbEscapeHtml(planBuild.key) + "']");
        if (fieldNode) {
          await animateTextNode(fieldNode, wbText(planBuild.text, ""), {
            minChunk: 1,
            maxChunk: 4,
            delayMs: 16,
            activeClass: "is-streaming",
          });
        }
      }
      if (details.planArtifact) {
        if (cardWrap) cardWrap.style.display = "";
        fillPlanCardFromArtifact(host, details.planArtifact);
      }
      if (cardStatusNode) {
        const label = planStatus === "finalized" ? "已定稿"
          : planStatus === "refining" ? "细化中"
          : planStatus === "drafting" ? "草案中"
          : "等待中";
        cardStatusNode.textContent = label;
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

    async function applyTrace(traceLike) {
      const trace = traceLike && typeof traceLike === "object" ? traceLike : {};
      const phase = stepPhase(trace);
      if (!phase) return;
      ensureVisible();
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
            streamHost = document.createElement("div");
            streamHost.className = "ai-workbench-stream-host ai-workbench-trace-event running";
            streamHost.innerHTML = ""
              + '<div class="ai-workbench-phase-title">代码生成过程</div>'
              + '<div class="ai-workbench-trace-summary"></div>'
              + '<div class="ai-workbench-stream-meta"></div>'
              + '<pre class="ai-trace-code"><code></code></pre>';
            panelEl.appendChild(streamHost);
          }
          const summaryNode = streamHost.querySelector(".ai-workbench-trace-summary");
          const metaNode = streamHost.querySelector(".ai-workbench-stream-meta");
          const codeNode = streamHost.querySelector("code");
          streamHost.className = "ai-workbench-stream-host ai-workbench-trace-event " + status;
          if (summaryNode) summaryNode.textContent = wbText(trace.message || trace.summary, "");
          if (metaNode) {
            metaNode.innerHTML = [
              details.codeSource ? wbTextBlock("代码来源", details.codeSource) : "",
              details.executionMode ? wbTextBlock("执行环境", details.executionMode) : "",
            ].filter(Boolean).join("");
          }
          if (codeNode) {
            await animateTextNode(codeNode, wbText(details.codeSnippet, ""), {
              minChunk: 2,
              maxChunk: 8,
              delayMs: 6,
              activeClass: "is-streaming",
            });
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
        result.generatedCode && result.generatedCode.codeDiff ? renderCodeDiff(result.generatedCode.codeDiff) : "",
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
        renderCodeDiff: renderCodeDiff,
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
      const status = wbText(trace.status, "done").toLowerCase();
      const title = buildStepTitle(trace);
      const summary = buildStepSummary(trace);
      const detailsHtml = renderTraceDetails(trace);
      steps.push('<details class="ai-workbench-static-step"'
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
