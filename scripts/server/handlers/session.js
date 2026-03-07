/**
 * Session Handlers — /api/session/archive, /api/session/list, /api/session/restore
 */

export function createSessionHandlers(deps = {}) {
  const { readJsonBody, sendJson, conversationContext, memoryLayer } = deps;

  async function handleSessionArchive(req, res) {
    if (!conversationContext) {
      sendJson(res, 200, { ok: false, error: "conversation context not available" });
      return;
    }
    // Generate LLM summary before archiving
    if (memoryLayer) {
      try {
        const history = conversationContext.getRecentHistory(30);
        const summary = await memoryLayer.generateSessionSummary(history);
        if (summary) {
          const session = conversationContext.getSessionDetail(conversationContext.getActiveSessionId());
          if (session) session.summary = summary;
        }
      } catch {}
    }
    const result = conversationContext.archiveCurrentSession();
    sendJson(res, 200, result);
  }

  async function handleSessionList(req, res) {
    if (!conversationContext) {
      sendJson(res, 200, { ok: true, active: null, archived: [], totalArchived: 0 });
      return;
    }
    sendJson(res, 200, { ok: true, ...conversationContext.listSessions() });
  }

  async function handleSessionRestore(req, res) {
    if (!conversationContext) {
      sendJson(res, 200, { ok: false, error: "conversation context not available" });
      return;
    }
    const body = await readJsonBody(req);
    const sessionId = String(body.sessionId || "").trim();
    if (!sessionId) {
      sendJson(res, 400, { ok: false, error: "sessionId is required" });
      return;
    }
    const result = conversationContext.restoreSession(sessionId);
    if (result.ok) {
      const detail = conversationContext.getSessionDetail(sessionId);
      sendJson(res, 200, { ...result, messages: detail?.messages || [] });
    } else {
      sendJson(res, 200, result);
    }
  }

  return { handleSessionArchive, handleSessionList, handleSessionRestore };
}
