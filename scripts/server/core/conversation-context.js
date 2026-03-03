/**
 * Conversation Context Manager
 *
 * Maintains per-session conversation history with a sliding window.
 * Persists to disk so context survives server restart.
 * Compatible with OpenClaw's session-id scheme.
 *
 * Features:
 * - Sliding window (configurable, default 20 messages)
 * - Session archival with summary
 * - Multi-session support
 * - Linked assets tracking (features/strategies produced in this session)
 */

import fs from "node:fs";
import path from "node:path";

function toText(v, fb = "") { return String(v ?? "").trim() || fb; }
function nowIso() { return new Date().toISOString(); }

export function createConversationContextManager(deps = {}) {
  const memoryDir = toText(deps.memoryDir, "");
  const contextPath = memoryDir ? path.join(memoryDir, "conversation-sessions.json") : "";
  const maxMessagesPerSession = Math.max(10, Number(deps.maxMessages || 30) || 30);

  // In-memory state
  let store = loadStore();

  function createEmptyStore() {
    return {
      version: 1,
      activeSessionId: "session-" + Date.now(),
      sessions: {},
      archivedOrder: [], // session IDs in archive order (newest first)
    };
  }

  function createSession(sessionId) {
    return {
      id: sessionId || ("session-" + Date.now()),
      messages: [],
      assets: [],  // { type: "feature"|"strategy", id, name, createdAt }
      createdAt: nowIso(),
      updatedAt: nowIso(),
      archived: false,
      summary: "",
      messageCount: 0,
    };
  }

  function loadStore() {
    try {
      if (!contextPath || !fs.existsSync(contextPath)) return createEmptyStore();
      const raw = fs.readFileSync(contextPath, "utf8");
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return createEmptyStore();
      // Ensure structure
      parsed.sessions = parsed.sessions && typeof parsed.sessions === "object" ? parsed.sessions : {};
      parsed.archivedOrder = Array.isArray(parsed.archivedOrder) ? parsed.archivedOrder : [];
      parsed.activeSessionId = toText(parsed.activeSessionId, "session-" + Date.now());
      return parsed;
    } catch {
      return createEmptyStore();
    }
  }

  function saveStore() {
    try {
      if (!contextPath || !memoryDir) return;
      fs.mkdirSync(memoryDir, { recursive: true });
      fs.writeFileSync(contextPath, JSON.stringify(store, null, 2), "utf8");
    } catch {}
  }

  function getActiveSession() {
    const id = store.activeSessionId;
    if (!store.sessions[id]) {
      store.sessions[id] = createSession(id);
      saveStore();
    }
    return store.sessions[id];
  }

  /**
   * Add a message to the active session's context.
   * @param {string} role - "user" | "assistant" | "system"
   * @param {string} content - message text
   * @param {Object} [meta] - optional metadata (e.g. card data for history restore)
   */
  function addMessage(role, content, meta) {
    const session = getActiveSession();
    const msg = {
      role: toText(role, "user"),
      content: toText(content, ""),
      ts: nowIso(),
    };
    if (meta && typeof meta === "object") {
      msg.meta = meta;
    }
    session.messages.push(msg);
    session.messageCount = (session.totalMessageCount || session.messages.length) + 1;
    session.totalMessageCount = session.messageCount;
    session.updatedAt = nowIso();
    // Sliding window: keep last N messages (compressed prefix preserved)
    if (session.messages.length > maxMessagesPerSession) {
      session.messages = session.messages.slice(-maxMessagesPerSession);
    }
    saveStore();
  }

  /**
   * Add a structured card event to the active session.
   * These events are injected into conversation history as system messages
   * so the LLM can reference card interactions (feature creation, errors, etc.).
   *
   * @param {string} eventType - "card_shown" | "card_choices" | "card_generated" | "card_applied" | "card_error"
   * @param {Object} data - event-specific payload
   */
  function addCardEvent(eventType, data) {
    const session = getActiveSession();
    if (!Array.isArray(session.cardEvents)) session.cardEvents = [];
    const event = {
      type: toText(eventType, "card_event"),
      data: data && typeof data === "object" ? data : {},
      ts: nowIso(),
    };
    session.cardEvents.push(event);
    // Keep last 30 card events
    if (session.cardEvents.length > 30) {
      session.cardEvents = session.cardEvents.slice(-30);
    }
    session.updatedAt = nowIso();

    // Also add as a system message so it appears in conversation context
    const description = formatCardEventForContext(event);
    if (description) {
      session.messages.push({
        role: "system",
        content: description,
        ts: event.ts,
        meta: { cardEvent: event },
      });
      if (session.messages.length > maxMessagesPerSession) {
        session.messages = session.messages.slice(-maxMessagesPerSession);
      }
    }
    saveStore();
  }

  /**
   * Format a card event as a human-readable system message for LLM context.
   */
  function formatCardEventForContext(event) {
    const type = toText(event?.type, "");
    const data = event?.data && typeof event.data === "object" ? event.data : {};
    switch (type) {
      case "card_shown":
        return `[系统] 已向用户展示特征建议卡片：${toText(data.headline, "交易特征建议")}` +
          (data.featureName ? `（特征：${data.featureName}）` : "");
      case "card_choices":
        return `[系统] 用户选择了特征偏好：${JSON.stringify(data.userChoices || {}).slice(0, 200)}`;
      case "card_generated": {
        const ok = Boolean(data.success);
        const name = toText(data.featureName, "特征");
        return ok
          ? `[系统] 特征「${name}」代码已成功生成${data.resultSummary ? "：" + toText(data.resultSummary, "").slice(0, 150) : ""}`
          : `[系统] 特征「${name}」代码生成失败：${toText(data.error, "未知错误").slice(0, 150)}`;
      }
      case "card_applied": {
        const ok = Boolean(data.success);
        const name = toText(data.featureName, "特征");
        return ok
          ? `[系统] 特征「${name}」已成功加入虾策特征库`
          : `[系统] 特征「${name}」加入特征库失败：${toText(data.error, "未知错误").slice(0, 150)}`;
      }
      case "card_error":
        return `[系统] 特征操作错误：${toText(data.error, "未知错误").slice(0, 200)}`;
      default:
        return "";
    }
  }

  /**
   * Set a compressed prefix for the active session.
   * Used by evolution compression to replace old messages with a summary.
   */
  function setCompressedPrefix(summary) {
    const session = getActiveSession();
    session.compressedPrefix = toText(summary, "");
    session.updatedAt = nowIso();
    saveStore();
  }

  /**
   * Get recent conversation history for LLM context.
   * Returns array of { role, content } suitable for prompt injection.
   */
  function getRecentHistory(maxCount = 20) {
    const session = getActiveSession();
    const messages = session.messages.slice(-Math.max(1, maxCount)).map((m) => ({
      role: m.role,
      content: m.content,
    }));
    // Prepend compressed prefix as a system context message
    const prefix = toText(session.compressedPrefix, "");
    if (prefix) {
      messages.unshift({ role: "system", content: `[对话历史摘要] ${prefix}` });
    }
    // Note: card events are already embedded as system messages in session.messages
    // via addCardEvent(), so they naturally appear in the history.
    return messages;
  }

  /**
   * Track an asset (feature/strategy) produced in this session.
   */
  function trackAsset(type, id, name) {
    const session = getActiveSession();
    const exists = session.assets.some((a) => a.id === id);
    if (exists) return;
    session.assets.push({
      type: toText(type, "feature"),
      id: toText(id, ""),
      name: toText(name, ""),
      createdAt: nowIso(),
    });
    session.updatedAt = nowIso();
    saveStore();
  }

  /**
   * Archive the current session and start a new one.
   */
  function archiveCurrentSession() {
    const session = getActiveSession();
    if (session.messages.length === 0) {
      return { ok: true, archived: false, reason: "session is empty" };
    }
    session.archived = true;
    session.updatedAt = nowIso();
    // Generate summary from first and last messages
    const first = session.messages[0];
    const last = session.messages[session.messages.length - 1];
    session.summary = toText(first?.content, "").slice(0, 100);
    // Add to archive order
    if (!store.archivedOrder.includes(session.id)) {
      store.archivedOrder.unshift(session.id);
    }
    // Keep max 50 archived sessions
    if (store.archivedOrder.length > 50) {
      const removed = store.archivedOrder.splice(50);
      removed.forEach((id) => { delete store.sessions[id]; });
    }
    // Start new session
    const newId = "session-" + Date.now();
    store.activeSessionId = newId;
    store.sessions[newId] = createSession(newId);
    saveStore();
    return {
      ok: true,
      archived: true,
      archivedSessionId: session.id,
      newSessionId: newId,
      messageCount: session.messageCount,
      assetCount: session.assets.length,
    };
  }

  /**
   * List all sessions (active + archived).
   */
  function listSessions() {
    const active = getActiveSession();
    const archived = store.archivedOrder
      .map((id) => store.sessions[id])
      .filter(Boolean)
      .map((s) => ({
        id: s.id,
        summary: toText(s.summary, ""),
        messageCount: s.messageCount || s.messages?.length || 0,
        assetCount: (s.assets || []).length,
        assets: (s.assets || []).slice(0, 5),
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      }));
    return {
      active: {
        id: active.id,
        messageCount: active.messageCount || active.messages?.length || 0,
        assetCount: (active.assets || []).length,
        assets: (active.assets || []).slice(0, 5),
        createdAt: active.createdAt,
        updatedAt: active.updatedAt,
      },
      archived,
      totalArchived: archived.length,
    };
  }

  /**
   * Restore an archived session as the active session.
   */
  function restoreSession(sessionId) {
    const target = store.sessions[toText(sessionId, "")];
    if (!target) return { ok: false, error: "session not found" };
    // Archive current if it has messages
    const current = getActiveSession();
    if (current.messages.length > 0 && current.id !== target.id) {
      current.archived = true;
      current.updatedAt = nowIso();
      current.summary = toText(current.messages[0]?.content, "").slice(0, 100);
      if (!store.archivedOrder.includes(current.id)) {
        store.archivedOrder.unshift(current.id);
      }
    }
    // Restore target
    target.archived = false;
    store.activeSessionId = target.id;
    // Remove from archived order
    store.archivedOrder = store.archivedOrder.filter((id) => id !== target.id);
    saveStore();
    return {
      ok: true,
      sessionId: target.id,
      messageCount: target.messageCount || target.messages?.length || 0,
      assetCount: (target.assets || []).length,
    };
  }

  /**
   * Get full session detail (for restoring chat history in UI).
   */
  function getSessionDetail(sessionId) {
    const session = store.sessions[toText(sessionId, "")];
    if (!session) return null;
    return {
      id: session.id,
      messages: (session.messages || []).map((m) => ({
        role: m.role,
        content: m.content,
        ts: m.ts,
        meta: m.meta || null,
      })),
      assets: session.assets || [],
      cardEvents: session.cardEvents || [],
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      summary: session.summary || "",
      messageCount: session.messageCount || session.messages?.length || 0,
    };
  }

  return {
    addMessage,
    addCardEvent,
    getRecentHistory,
    setCompressedPrefix,
    trackAsset,
    archiveCurrentSession,
    listSessions,
    restoreSession,
    getSessionDetail,
    getActiveSessionId: () => store.activeSessionId,
  };
}
