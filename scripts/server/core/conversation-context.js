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
   */
  function addMessage(role, content) {
    const session = getActiveSession();
    session.messages.push({
      role: toText(role, "user"),
      content: toText(content, ""),
      ts: nowIso(),
    });
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
      })),
      assets: session.assets || [],
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      summary: session.summary || "",
      messageCount: session.messageCount || session.messages?.length || 0,
    };
  }

  return {
    addMessage,
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
