/**
 * Chat Handler — /api/ai/chat, /api/chat/history, /api/chat/cards/status
 *
 * Handles ThunderClaw conversational AI:
 * 1. Intent Gating (rule-based, <1ms) → decides if LLM clarification needed
 * 2. Clarification Fast Path → returns feature card
 * 3. Chat Path → LLM direct with architecture context
 */

import { runIntentGating, shouldCallLlmForIntent } from "../core/intent-gating.js";
import { createLlmClient } from "../core/llm-client.js";

const SYSTEM_PROMPT = `你是 ThunderClaw（虾策），一个 AI Native 交易引擎助手。

## 你的能力
- 帮用户创建、评估、优化交易特征（通过特征卡片交互）
- 解释交易概念、指标含义
- 分析已有特征的效果和参数
- 回答关于虾策架构和功能的问题
- 提供交易策略建议

## 虾策交易架构
- 特征库：用户创建的交易特征，每个是运行在 Freqtrade 中的 Python 代码
- 策略库：由多个特征组合而成的交易策略
- 四层架构：信号层 → 仓位层 → 风控层 → 执行层
- 支持回测验证和特征级评估

## 回复规则
1. 用中文回复，简洁清晰
2. 参考「当前系统状态」中的信息回答关于已有特征的问题
3. 如果用户想创建新特征，告知可以直接描述需求
4. 不要直接输出代码——代码生成通过特征卡片流程完成`;

export function createChatHandler(deps = {}) {
  const {
    readJsonBody, sendJson, appendChatEvent,
    getXbrainStateSnapshot, getCurrentRuntimeModelRef,
    getModelConfig, detectAndClarify,
    strategyLabStore, conversationContext, memoryLayer,
    updateChatCardStatus,
    taskRuntime,
  } = deps;

  function getActiveChatSessionId() {
    return conversationContext && typeof conversationContext.getActiveSessionId === "function"
      ? String(conversationContext.getActiveSessionId() || "").trim()
      : "";
  }

  function createTaskTracker(params = {}) {
    const runtime = taskRuntime && typeof taskRuntime.createTask === "function" ? taskRuntime : null;
    const fallbackTask = {
      taskId: `${String(params.taskType || "task")}-${Date.now()}`,
      taskType: String(params.taskType || "task"),
      sessionId: String(params.sessionId || ""),
      plan: String(params.plan || ""),
      currentStage: "created",
      attempts: 0,
      finalStatus: "running",
      resultRef: null,
      planArtifact: null,
      traces: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const task = runtime ? runtime.createTask(params) : fallbackTask;
    const traces = [];
    return {
      task,
      emit(sendLike, phase, message, status = "running", extra = {}) {
        const trace = runtime
          ? runtime.addTrace(task, { phase, message, status, ...extra })
          : {
              taskId: task.taskId,
              taskType: task.taskType,
              phase,
              status,
              message,
              ts: new Date().toISOString(),
            };
        if (trace) traces.push({ ...trace });
        if (typeof sendLike === "function") {
          sendLike("thinking", {
            ...trace,
            step: trace?.phase || phase,
            task: runtime ? runtime.snapshotTask(task) : { ...task, traces: traces.slice() },
          });
        }
        return trace;
      },
      finalize(status, resultRef) {
        if (runtime) runtime.updateTask(task, { finalStatus: status, resultRef, currentStage: status });
        else {
          task.finalStatus = status;
          task.resultRef = resultRef || null;
          task.currentStage = status;
        }
      },
      update(fields = {}) {
        if (runtime) runtime.updateTask(task, fields);
        else {
          if (fields.plan != null) task.plan = String(fields.plan || "");
          if (fields.currentStage != null) task.currentStage = String(fields.currentStage || "");
          if (fields.finalStatus != null) task.finalStatus = String(fields.finalStatus || "");
          if (fields.planArtifact !== undefined) task.planArtifact = fields.planArtifact || null;
          if (fields.resultRef && typeof fields.resultRef === "object") task.resultRef = { ...fields.resultRef };
        }
      },
      snapshot() {
        return runtime ? runtime.snapshotTask(task) : { ...task, traces: traces.slice() };
      },
      getTraces() {
        return traces.slice();
      },
    };
  }

  // ─── /api/ai/chat ──────────────────────────────────────────────────
  async function handleAiChat(req, res) {
    const body = await readJsonBody(req);
    const message = String(body.message ?? "").trim();
    if (!message) {
      sendJson(res, 400, { ok: false, error: "message is required" });
      return;
    }
    appendChatEvent({ role: "user", source: "dashboard", text: message, sessionId: getActiveChatSessionId() });
    if (conversationContext) conversationContext.addMessage("user", message);

    // Build memory context (L1-L3)
    const ml = memoryLayer;
    if (ml) void ml.maybeCompressContext().catch(() => {});
    const memoryCtx = ml ? await ml.buildFullMemoryContext(message).catch(() => "") : "";

    // ── Intent Gating (Layer 0+1, rule-based) ──
    const existingFeatureNames = collectFeatureNames();
    const shouldCallLlm = shouldCallLlmForIntent(message, existingFeatureNames);

    // ── Clarification Fast Path ──
    if (shouldCallLlm && typeof detectAndClarify === "function") {
      const card = await tryClarification(message, memoryCtx, existingFeatureNames);
      if (card) {
        trackCardShown(card);
        sendJson(res, 200, {
          ok: true,
          reply: "",
          source: "clarification_fast_path",
          state: getXbrainStateSnapshot(),
          runtimeModelRef: getCurrentRuntimeModelRef(),
          clarification: card,
        });
        return;
      }
    }

    // ── Chat Path: LLM direct with architecture context ──
    const gatingPreCheck = runIntentGating({ message, existingFeatureNames });
    const reply = await generateChatReply(message, memoryCtx, gatingPreCheck.shouldTriggerClarification);

    if (conversationContext) conversationContext.addMessage("assistant", reply);
    appendChatEvent({ role: "bot", source: "dashboard", text: reply, sessionId: getActiveChatSessionId() });

    sendJson(res, 200, {
      ok: true,
      reply,
      source: "llm_direct",
      state: getXbrainStateSnapshot(),
      runtimeModelRef: getCurrentRuntimeModelRef(),
      clarification: null,
    });
  }

  /**
   * Attempt clarification with retry. Returns card data or null.
   */
  async function tryClarification(message, memoryCtx, existingFeatureNames) {
    const rawHistory = conversationContext ? conversationContext.getRecentHistory(16) : [];
    // Clean: remove [系统] card events that confuse intent detection
    const cleanHistory = rawHistory.filter((m) =>
      !(m.role === "system" && String(m.content || "").startsWith("[系统]"))
    );

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const history = attempt === 0 ? cleanHistory : cleanHistory.filter((m) => m.role !== "system");
        const clarification = await detectAndClarify({
          userMessage: message,
          assistantReply: "",
          conversationHistory: history,
          memoryContext: attempt === 0 ? memoryCtx : "",
        });

        if (!clarification?.intentDetected) continue;

        // Layer 2+3: Calibrate with gating
        const gating = runIntentGating({
          message,
          existingFeatureNames,
          l2Result: { intentDetected: true, confidence: Number(clarification.confidence || 0), intent: "create" },
        });

        if (gating.shouldTriggerClarification) {
          return {
            intentDetected: true,
            confidence: Number(clarification.confidence || 0),
            headline: String(clarification.headline || ""),
            featureConcept: clarification.featureConcept || null,
            clarifyingQuestions: Array.isArray(clarification.clarifyingQuestions) ? clarification.clarifyingQuestions : [],
          };
        }
      } catch (err) {
        console.warn(`[chat] clarification attempt ${attempt + 1} failed:`, String(err?.message || err).slice(0, 120));
      }
    }
    return null;
  }

  /**
   * Generate a chat reply via LLM with full architecture context.
   */
  async function generateChatReply(message, memoryCtx, creationIntentDetected) {
    const history = conversationContext ? conversationContext.getRecentHistory(16) : [];
    const extra = creationIntentDetected
      ? "\n\n## 注意\n用户想创建特征，但特征卡片未能生成。请引导用户更具体地描述需求（指标类型、参数、时间周期等），不要直接输出代码。"
      : "";
    const systemPrompt = SYSTEM_PROMPT + extra + (memoryCtx || "");
    const messages = [
      { role: "system", content: systemPrompt },
      ...history,
      { role: "user", content: message },
    ];

    try {
      const cfg = typeof getModelConfig === "function" ? getModelConfig() : null;
      if (!cfg?.apiKey) return "请先在虾脑中配置模型 API Key 后再对话。";
      const llm = createLlmClient({ getModelConfig });
      const result = await llm.chatCompletion({
        messages,
        temperature: 0.4,
        maxTokens: 2048,
        timeoutMs: 60_000,
      });
      if (result.ok && result.content) return String(result.content).trim();
    } catch {}
    return "收到，但当前模型暂不可用。请在虾脑中确认模型配置后重试。";
  }

  function collectFeatureNames() {
    const names = [];
    try {
      if (strategyLabStore && typeof strategyLabStore.listFeatures === "function") {
        const features = strategyLabStore.listFeatures({ limit: 100 }).features || [];
        features.forEach((f) => { if (f.name) names.push(f.name); });
      }
    } catch {}
    return names;
  }

  function trackCardShown(card, options = {}) {
    if (!conversationContext) return;
    conversationContext.addMessage("assistant", card.headline || "", {
      type: "clarification_card",
      cardData: card,
    });
    if (typeof conversationContext.addCardEvent === "function") {
      conversationContext.addCardEvent("card_shown", {
        headline: card.headline || "",
        featureName: card.featureConcept?.name || "",
      });
    }
    const cardEvent = appendChatEvent ? appendChatEvent({
      role: "bot",
      source: "clarification_fast_path",
      text: card.headline || "交易特征建议",
      sessionId: getActiveChatSessionId(),
      meta: {
        type: "clarification_card",
        cardData: {
          ...card,
          task: options.task && typeof options.task === "object" ? options.task : undefined,
          traces: Array.isArray(options.traces) ? options.traces : undefined,
        },
      },
      traces: Array.isArray(options.traces) ? options.traces : undefined,
    }) : null;
    if (cardEvent && typeof conversationContext.updateLatestClarificationCard === "function") {
      conversationContext.updateLatestClarificationCard({ eventId: cardEvent.id });
    }
    return cardEvent;
  }

  // ─── /api/chat/history ──────────────────────────────────────────────
  async function handleChatHistory(req, res) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const afterId = Math.max(0, Number.parseInt(url.searchParams.get("afterId") || "0", 10) || 0);
    const limit = Math.min(1000, Math.max(1, Number.parseInt(url.searchParams.get("limit") || "220", 10) || 220));
    const targetSessionId = String(url.searchParams.get("sessionId") || getActiveChatSessionId() || "").trim();
    const chatHist = deps.chatHistory || { events: [] };
    const events = (chatHist.events || [])
      .filter((ev) => {
        if (!(Number(ev?.id) > afterId)) return false;
        if (!targetSessionId) return true;
        return String(ev?.sessionId || "").trim() === targetSessionId;
      })
      .slice(0, limit);
    sendJson(res, 200, { ok: true, events });
  }

  // ─── /api/chat/cards/status ────────────────────────────────────────
  async function handleChatCardStatus(req, res) {
    if (typeof updateChatCardStatus !== "function") {
      sendJson(res, 500, { ok: false, error: "not available" });
      return;
    }
    const body = await readJsonBody(req);
    const eventId = Number(body?.eventId);
    const cardId = String(body?.cardId || "").trim();
    const status = String(body?.status || "").trim().toLowerCase();
    if (!Number.isFinite(eventId) || eventId <= 0 || !cardId) {
      sendJson(res, 400, { ok: false, error: "eventId and cardId required" });
      return;
    }
    if (!["proposed", "accepted", "ignored", "registered"].includes(status)) {
      sendJson(res, 400, { ok: false, error: "invalid status" });
      return;
    }
    const updated = updateChatCardStatus({ eventId, cardId, status });
    sendJson(res, updated?.ok ? 200 : 404, updated || { ok: false });
  }

  // ─── /api/ai/chat/stream (SSE) ──────────────────────────────────────
  async function handleAiChatStream(req, res) {
    const body = await readJsonBody(req);
    const message = String(body.message ?? "").trim();
    if (!message) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "message is required" }));
      return;
    }

    // SSE headers
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });

    function sendSSE(event, data) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }

    appendChatEvent({ role: "user", source: "dashboard", text: message, sessionId: getActiveChatSessionId() });
    if (conversationContext) conversationContext.addMessage("user", message);

    const tracker = createTaskTracker({
      taskType: "chat_reply",
      sessionId: conversationContext && typeof conversationContext.getActiveSessionId === "function"
        ? conversationContext.getActiveSessionId()
        : "",
      plan: "先理解用户意图，再决定是进入澄清卡片还是直接生成回复，最后输出结果总结。",
    });

    tracker.emit(sendSSE, "understand", "收到消息，开始理解用户需求...", "running");

    // Build memory context
    const ml = memoryLayer;
    if (ml) void ml.maybeCompressContext().catch(() => {});
    tracker.emit(sendSSE, "understand", "加载对话上下文和特征库...", "running");
    const memoryCtx = ml ? await ml.buildFullMemoryContext(message).catch(() => "") : "";
    tracker.emit(sendSSE, "understand", "上下文加载完成", "done");

    // Intent gating
    const existingFeatureNames = collectFeatureNames();
    tracker.emit(sendSSE, "plan", "分析用户意图并制定执行计划...", "running");
    const shouldCallLlm = shouldCallLlmForIntent(message, existingFeatureNames);
    const gatingPreCheck = runIntentGating({ message, existingFeatureNames });

    if (gatingPreCheck.shouldTriggerClarification) {
      tracker.emit(sendSSE, "plan", `检测到特征创建意图，优先尝试生成澄清卡片（${gatingPreCheck.reason}）`, "done");
    } else {
      tracker.emit(sendSSE, "plan", `判断为普通对话，直接生成回复（${gatingPreCheck.reason}）`, "done");
    }

    // Clarification fast path
    if (shouldCallLlm && typeof detectAndClarify === "function") {
      tracker.emit(sendSSE, "execute", "正在梳理特征需求并生成澄清卡片...", "running");
      const card = await tryClarification(message, memoryCtx, existingFeatureNames);
      if (card) {
        tracker.emit(sendSSE, "execute", `已识别特征方向：${card.headline || "特征概念"}`, "done");
        tracker.emit(sendSSE, "summarize", "已生成澄清卡片，等待用户确认后进入特征生成。", "done");
        tracker.finalize("completed", { type: "clarification_card", headline: card.headline || "" });
        const taskSnapshot = tracker.snapshot();
        const traceList = tracker.getTraces();
        const cardEvent = trackCardShown(card, { task: taskSnapshot, traces: traceList });
        sendSSE("card", {
          ...card,
          eventId: Number(cardEvent?.id) || 0,
          task: taskSnapshot,
          traces: traceList,
        });
        sendSSE("done", {
          source: "clarification_fast_path",
          cardEventId: Number(cardEvent?.id) || 0,
          state: getXbrainStateSnapshot(),
          task: taskSnapshot,
          traces: traceList,
        });
        res.end();
        return;
      }
      tracker.emit(sendSSE, "execute", "当前不适合直接给出卡片，转入普通对话回复。", "done");
    }

    // Chat path: streaming LLM response
    tracker.emit(sendSSE, "execute", "正在生成回复...", "running");

    const history = conversationContext ? conversationContext.getRecentHistory(16) : [];
    const extra = gatingPreCheck.shouldTriggerClarification
      ? "\n\n## 注意\n用户想创建特征，但特征卡片未能生成。请引导用户更具体地描述需求，不要直接输出代码。"
      : "";
    const systemPrompt = SYSTEM_PROMPT + extra + (memoryCtx || "");
    const messages = [
      { role: "system", content: systemPrompt },
      ...history,
      { role: "user", content: message },
    ];

    let fullReply = "";
    try {
      const cfg = typeof getModelConfig === "function" ? getModelConfig() : null;
      if (!cfg?.apiKey) {
        tracker.emit(sendSSE, "execute", "模型未配置 API Key", "error");
        sendSSE("token", { text: "请先在虾脑中配置模型 API Key 后再对话。" });
        fullReply = "请先在虾脑中配置模型 API Key 后再对话。";
      } else {
        const llm = createLlmClient({ getModelConfig });
        tracker.emit(sendSSE, "execute", `调用 ${cfg.provider}/${cfg.model} 生成回复...`, "running");

        const stream = llm.chatCompletionStream({
          messages,
          temperature: 0.4,
          maxTokens: 2048,
          timeoutMs: 60_000,
        });

        for await (const chunk of stream) {
          if (chunk.type === "token" && chunk.text) {
            fullReply += chunk.text;
            sendSSE("token", { text: chunk.text });
          } else if (chunk.type === "error") {
            tracker.emit(sendSSE, "validate", `回复生成阶段出现错误：${chunk.error}`, "error");
            if (!fullReply) {
              fullReply = "模型调用失败，请稍后重试。";
              sendSSE("token", { text: fullReply });
            }
            break;
          } else if (chunk.type === "done") {
            break;
          }
        }
        tracker.emit(sendSSE, "execute", "回复生成完成", "done");
      }
    } catch (err) {
      if (!fullReply) {
        fullReply = "模型调用失败，请稍后重试。";
        sendSSE("token", { text: fullReply });
      }
      tracker.emit(sendSSE, "validate", `执行失败：${String(err?.message || err || "unknown error")}`, "error");
    }

    // Save to context
    if (fullReply && conversationContext) {
      conversationContext.addMessage("assistant", fullReply, {
        task: tracker.snapshot(),
        traces: tracker.getTraces(),
      });
    }
    tracker.emit(sendSSE, "summarize", fullReply ? "已完成本轮回复并写入历史。" : "本轮没有生成有效内容。", "done");
    tracker.finalize(fullReply ? "completed" : "empty", {
      type: "chat_reply",
      hasReply: Boolean(fullReply),
    });
    if (fullReply) {
      const replyEvent = appendChatEvent({
        role: "bot",
        source: "dashboard",
        text: fullReply,
        sessionId: getActiveChatSessionId(),
        meta: {
          task: tracker.snapshot(),
        },
        traces: tracker.getTraces(),
      });
      sendSSE("done", {
        source: "llm_direct",
        replyEventId: Number(replyEvent?.id) || 0,
        state: getXbrainStateSnapshot(),
        runtimeModelRef: getCurrentRuntimeModelRef(),
        task: tracker.snapshot(),
        traces: tracker.getTraces(),
      });
      res.end();
      return;
    }

    sendSSE("done", {
      source: "llm_direct",
      replyEventId: 0,
      state: getXbrainStateSnapshot(),
      runtimeModelRef: getCurrentRuntimeModelRef(),
      task: tracker.snapshot(),
      traces: tracker.getTraces(),
    });
    res.end();
  }

  // ─── /api/config/chat (slash command handler) ───────────────────────
  async function handleConfigChat(req, res) {
    const body = await readJsonBody(req);
    const message = String(body?.message ?? "").trim();
    if (!message) {
      sendJson(res, 200, { ok: true, handled: false, reply: "" });
      return;
    }
    // Handle /model switch commands
    if (message.startsWith("/model ")) {
      const modelRef = message.slice(7).trim();
      if (!modelRef || !modelRef.includes("/")) {
        sendJson(res, 200, { ok: true, handled: true, reply: "请使用格式：/model provider/model" });
        return;
      }
      // Switch model
      const { provider } = deps.inferProviderFromModelRef ? deps.inferProviderFromModelRef(modelRef) : { provider: modelRef.split("/")[0] };
      const xb = deps.xbrainStore || {};
      const parts = modelRef.split("/");
      xb.base.runtimeModelProvider = parts[0];
      xb.base.runtimeModelId = parts.slice(1).join("/");
      if (deps.saveXbrainStore) deps.saveXbrainStore();
      sendJson(res, 200, {
        ok: true,
        handled: true,
        reply: `模型已切换：${modelRef}`,
        runtimeModelRef: modelRef,
        state: getXbrainStateSnapshot(),
      });
      return;
    }
    // Not a recognized config command
    sendJson(res, 200, { ok: true, handled: false, reply: "" });
  }

  // ─── /api/ai/health ─────────────────────────────────────────────────
  async function handleAiHealth(req, res) {
    const cfg = typeof getModelConfig === "function" ? getModelConfig() : {};
    const hasKey = Boolean(cfg?.apiKey);
    const provider = cfg?.provider || "";
    sendJson(res, 200, {
      ok: hasKey,
      healthy: hasKey,
      modelReady: hasKey,
      provider,
      model: cfg?.model || "",
    });
  }

  return { handleAiChat, handleAiChatStream, handleAiHealth, handleConfigChat, handleChatHistory, handleChatCardStatus };
}
