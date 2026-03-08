/**
 * Four-Layer Memory Manager for ThunderClaw
 *
 * L1: Short-term window (from conversation-context.js)
 * L2: Session summaries + evolution compression
 * L3: Structured state (feature/strategy store snapshot)
 * L4: (reserved for future long-term retrieval)
 *
 * This module composes all four layers into a unified system prompt injection.
 */

import fs from "node:fs";
import path from "node:path";

function toText(v, fb = "") { return String(v ?? "").trim() || fb; }
function nowIso() { return new Date().toISOString(); }

export function createMemoryLayer(deps = {}) {
  const conversationContext = deps.conversationContext;
  const strategyLabStore = deps.strategyLabStore;
  const llmClient = deps.llmClient || null;

  // ═══ L3: Structured State Snapshot ═══════════════════════════════

  /**
   * Build a natural-language snapshot of the current system state.
   * Injected into every system prompt so the model knows what exists.
   */
  function buildStructuredStateSnapshot() {
    const sections = [];

    // Features
    if (strategyLabStore && typeof strategyLabStore.listFeatures === "function") {
      try {
        const result = strategyLabStore.listFeatures({ limit: 50 });
        const features = (result.features || []).filter((f) => f && f.name);
        if (features.length > 0) {
          const featureLines = features.slice(0, 20).map((f) => {
            const name = toText(f.name, "unnamed");
            const group = toText(f.group || f.mainCategory, "");
            const kind = toText(f.kind, "");
            const hasCode = Boolean(f.generatedCode?.indicatorCode || f.params?.pythonIndicator);
            const status = hasCode ? "已验证" : "待生成代码";
            const desc = toText(f.description, "").slice(0, 60);
            return `  - ${name} (${[group, kind].filter(Boolean).join("/")}/${status}) ${desc ? "— " + desc : ""}`;
          });
          sections.push(`特征库 (${features.length}个):\n${featureLines.join("\n")}`);
        } else {
          sections.push("特征库: 空（用户尚未创建任何特征）");
        }
      } catch {
        sections.push("特征库: 读取失败");
      }
    }

    // Strategies
    if (strategyLabStore && typeof strategyLabStore.listStrategies === "function") {
      try {
        const result = strategyLabStore.listStrategies({ page: 1, pageSize: 20 });
        const strategies = (result.strategies || []).filter((s) => s && s.name);
        if (strategies.length > 0) {
          const strategyLines = strategies.slice(0, 10).map((s) => {
            const name = toText(s.name, "unnamed");
            const status = toText(s.status, "draft");
            const featureCount = s.featureCount || 0;
            return `  - ${name} (${status}, ${featureCount}个特征)`;
          });
          sections.push(`策略库 (${strategies.length}个):\n${strategyLines.join("\n")}`);
        } else {
          sections.push("策略库: 空");
        }
      } catch {}
    }

    if (!sections.length) return "";
    return `\n## 当前虾策系统状态\n${sections.join("\n")}`;
  }

  // ═══ L2: Session Summaries + Evolution Compression ════════════════

  /**
   * Get compressed summaries from recent archived sessions.
   */
  function getRecentSessionSummaries(maxCount = 3) {
    if (!conversationContext) return "";
    const sessions = conversationContext.listSessions();
    const archived = (sessions.archived || []).slice(0, maxCount);
    if (!archived.length) return "";
    const lines = archived.map((s) => {
      const summary = toText(s.summary, "无摘要");
      const time = s.updatedAt ? new Date(s.updatedAt).toLocaleDateString("zh-CN") : "未知时间";
      const assets = (s.assets || []).map((a) => toText(a.name, "")).filter(Boolean).join(", ");
      return `  - [${time}] ${summary.slice(0, 100)}${assets ? " → 产出: " + assets : ""}`;
    });
    return `\n## 近期历史对话摘要\n${lines.join("\n")}`;
  }

  /**
   * Generate a session summary by calling LLM.
   * Called during archival to compress the session.
   */
  async function generateSessionSummary(messages) {
    if (!llmClient || !Array.isArray(messages) || messages.length < 2) {
      // Fallback: use first user message as summary
      const firstUser = messages?.find((m) => m.role === "user");
      return toText(firstUser?.content, "").slice(0, 150) || "对话记录";
    }
    try {
      const condensed = messages.slice(0, 20).map((m) =>
        `${m.role === "user" ? "用户" : "助手"}: ${toText(m.content, "").slice(0, 200)}`
      ).join("\n");
      const result = await llmClient.chatCompletion({
        messages: [
          { role: "system", content: "用一句中文概括这段对话的主题和结果（不超过80字）。只输出概括文本，不要其他内容。" },
          { role: "user", content: condensed },
        ],
        temperature: 0.1,
        maxTokens: 100,
        timeoutMs: 15_000,
      });
      if (result.ok && result.content) return toText(result.content, "").slice(0, 150);
    } catch {}
    const firstUser = messages?.find((m) => m.role === "user");
    return toText(firstUser?.content, "").slice(0, 150) || "对话记录";
  }

  /**
   * Evolution compression: compress oldest messages into a summary.
   * Called automatically when session exceeds threshold.
   */
  async function maybeCompressContext() {
    if (!conversationContext) return;
    const history = conversationContext.getRecentHistory(100);
    if (history.length < 20) return; // Not enough to compress

    // Take the oldest 10 messages and compress them
    const toCompress = history.slice(0, 10);
    const condensed = toCompress.map((m) =>
      `${m.role === "user" ? "用户" : "助手"}: ${toText(m.content, "").slice(0, 200)}`
    ).join("\n");

    let summary = "";
    if (llmClient) {
      try {
        const result = await llmClient.chatCompletion({
          messages: [
            { role: "system", content: "将以下对话压缩为一段简洁的上下文摘要（100-200字），保留关键信息、用户意图和任何决策结果。只输出摘要文本。" },
            { role: "user", content: condensed },
          ],
          temperature: 0.1,
          maxTokens: 300,
          timeoutMs: 20_000,
        });
        if (result.ok) summary = toText(result.content, "");
      } catch {}
    }
    if (!summary) {
      // Fallback: just concatenate key messages
      summary = toCompress
        .filter((m) => m.role === "user")
        .map((m) => toText(m.content, "").slice(0, 80))
        .join("; ");
    }

    // Replace oldest messages with the summary in context
    // This is done by updating the session's compressed prefix
    if (conversationContext.setCompressedPrefix) {
      conversationContext.setCompressedPrefix(summary);
    }
  }

  // ═══ Unified System Prompt Injection ══════════════════════════════

  /**
   * Build the complete memory injection for system prompts.
   * Combines all four layers into one coherent context block.
   *
   * @param {string} userMessage - Current user message (for L4 search query)
   * @returns {Promise<string>} Memory context to append to system prompt
   */
  async function buildFullMemoryContext(userMessage = "") {
    const parts = [];

    // L3: Structured state (always included, synchronous)
    const stateSnapshot = buildStructuredStateSnapshot();
    if (stateSnapshot) parts.push(stateSnapshot);

    // L2: Recent session summaries (synchronous)
    const sessionSummaries = getRecentSessionSummaries(3);
    if (sessionSummaries) parts.push(sessionSummaries);

    if (!parts.length) return "";
    return "\n\n# 系统记忆上下文（以下信息帮助你理解用户的历史和当前状态）" + parts.join("");
  }

  return {
    buildStructuredStateSnapshot,
    getRecentSessionSummaries,
    generateSessionSummary,
    maybeCompressContext,
    buildFullMemoryContext,
  };
}
