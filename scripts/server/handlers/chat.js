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
  } = deps;

  // ─── /api/ai/chat ──────────────────────────────────────────────────
  async function handleAiChat(req, res) {
    const body = await readJsonBody(req);
    const message = String(body.message ?? "").trim();
    if (!message) {
      sendJson(res, 400, { ok: false, error: "message is required" });
      return;
    }
    appendChatEvent({ role: "user", source: "dashboard", text: message });
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
    appendChatEvent({ role: "bot", source: "dashboard", text: reply });

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

  function trackCardShown(card) {
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
  }

  // ─── /api/chat/history ──────────────────────────────────────────────
  async function handleChatHistory(req, res) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const afterId = Math.max(0, Number.parseInt(url.searchParams.get("afterId") || "0", 10) || 0);
    const limit = Math.min(1000, Math.max(1, Number.parseInt(url.searchParams.get("limit") || "220", 10) || 220));
    const chatHist = deps.chatHistory || { events: [] };
    const events = (chatHist.events || []).filter((ev) => Number(ev.id) > afterId).slice(0, limit);
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

  return { handleAiChat, handleChatHistory, handleChatCardStatus };
}
