export function createChatHistoryStore(optionsLike = {}) {
  const options = optionsLike && typeof optionsLike === "object" ? optionsLike : {};
  const fs = options.fsModule;
  const memoryDir = String(options.memoryDir || "");
  const chatHistoryPath = String(options.chatHistoryPath || "");
  const maxChatEvents = Math.max(100, Number(options.maxChatEvents || 2000) || 2000);

  function cloneStructured(valueLike) {
    if (valueLike == null) return null;
    try {
      return JSON.parse(JSON.stringify(valueLike));
    } catch {
      return null;
    }
  }

  function normalizeEventMeta(metaLike) {
    const meta = cloneStructured(metaLike);
    return meta && typeof meta === "object" ? meta : null;
  }

  function normalizeTraceStep(stepLike) {
    const raw = stepLike && typeof stepLike === "object" ? stepLike : null;
    if (!raw) return null;
    const phase = String(raw.phase || raw.step || "").trim();
    const message = String(raw.message || raw.summary || "").trim();
    if (!phase && !message) return null;
    const normalized = {
      taskId: String(raw.taskId || "").trim(),
      taskType: String(raw.taskType || "").trim(),
      phase: phase || "step",
      status: String(raw.status || "done").trim().toLowerCase(),
      message: message || phase || "处理中",
      ts: String(raw.ts || new Date().toISOString()),
      attempt: Number.isFinite(Number(raw.attempt)) ? Number(raw.attempt) : undefined,
      kind: String(raw.kind || "").trim() || undefined,
    };
    const title = String(raw.title || "").trim();
    if (title) normalized.title = title;
    const details = cloneStructured(raw.details);
    if (details && typeof details === "object" && Object.keys(details).length) {
      normalized.details = details;
    }
    return normalized;
  }

  function normalizeTraceSteps(stepsLike) {
    const steps = Array.isArray(stepsLike) ? stepsLike : [];
    return steps.map(normalizeTraceStep).filter(Boolean).slice(-80);
  }

  function createInitialChatHistory() {
    return { nextId: 1, events: [] };
  }

  function normalizeCardStatus(statusLike) {
    const status = String(statusLike || "").trim().toLowerCase();
    if (status === "accepted" || status === "ignored" || status === "registered") return status;
    return "proposed";
  }

  function normalizeChatCard(cardLike, eventIdLike, indexLike) {
    const eventId = Number(eventIdLike) || 0;
    const index = Number(indexLike) || 0;
    const raw = cardLike && typeof cardLike === "object" ? cardLike : null;
    if (!raw) return null;
    let cloned = null;
    try {
      cloned = JSON.parse(JSON.stringify(raw));
    } catch {
      return null;
    }
    if (!cloned || typeof cloned !== "object") return null;
    const id = String(cloned.id || cloned.cardId || cloned.candidateId || `m${eventId}-c${index + 1}`).trim();
    const kind = String(cloned.kind || "").trim().toLowerCase();
    if (kind !== "feature" && kind !== "strategy") return null;
    const confidenceRaw = Number(cloned.confidence);
    const confidence = Number.isFinite(confidenceRaw)
      ? Math.max(0, Math.min(1, confidenceRaw))
      : 0.6;
    cloned.id = id || `m${eventId}-c${index + 1}`;
    cloned.kind = kind;
    cloned.confidence = confidence;
    cloned.status = normalizeCardStatus(cloned.status);
    return cloned;
  }

  function normalizeChatCards(cardsLike, eventIdLike) {
    const cards = Array.isArray(cardsLike) ? cardsLike : [];
    return cards
      .map((card, index) => normalizeChatCard(card, eventIdLike, index))
      .filter(Boolean)
      .slice(0, 8);
  }

  function loadChatHistory() {
    try {
      if (!chatHistoryPath || !fs?.existsSync || !fs.existsSync(chatHistoryPath)) {
        return createInitialChatHistory();
      }
      const raw = fs.readFileSync(chatHistoryPath, "utf8");
      const parsed = JSON.parse(raw);
      const events = Array.isArray(parsed?.events)
        ? parsed.events
            .filter((ev) => ev && typeof ev === "object")
            .map((ev) => ({
              id: Number(ev.id) || 0,
              ts: String(ev.ts || new Date().toISOString()),
              role: ev.role === "user" ? "user" : "bot",
              source: String(ev.source || "dashboard"),
              text: String(ev.text || ""),
              from: typeof ev.from === "string" ? ev.from : undefined,
              chatId: ev.chatId != null ? String(ev.chatId) : undefined,
              sessionId: ev.sessionId != null ? String(ev.sessionId) : undefined,
              cards: normalizeChatCards(ev.cards, Number(ev.id) || 0),
              meta: normalizeEventMeta(ev.meta),
              traces: normalizeTraceSteps(ev.traces),
            }))
        : [];
      const maxId = events.reduce((m, ev) => Math.max(m, Number(ev.id) || 0), 0);
      return {
        nextId: Number(parsed?.nextId) > maxId ? Number(parsed.nextId) : maxId + 1,
        events: events.slice(-maxChatEvents),
      };
    } catch {
      return createInitialChatHistory();
    }
  }

  const chatHistory = loadChatHistory();

  function saveChatHistory() {
    try {
      if (!fs?.mkdirSync || !fs?.writeFileSync || !chatHistoryPath || !memoryDir) return;
      fs.mkdirSync(memoryDir, { recursive: true });
      fs.writeFileSync(chatHistoryPath, JSON.stringify(chatHistory, null, 2), "utf8");
    } catch {}
  }

  function appendChatEvent(eventLike) {
    const item = eventLike && typeof eventLike === "object" ? eventLike : {};
    const event = {
      id: chatHistory.nextId,
      ts: String(item.ts || new Date().toISOString()),
      role: item.role === "user" ? "user" : "bot",
      source: String(item.source || "dashboard"),
      text: String(item.text || "").trim(),
    };
    if (!event.text) return null;
    if (item.from != null) event.from = String(item.from);
    if (item.chatId != null) event.chatId = String(item.chatId);
    if (item.sessionId != null) event.sessionId = String(item.sessionId);
    const normalizedCards = normalizeChatCards(item.cards, event.id);
    if (normalizedCards.length) {
      event.cards = normalizedCards;
    }
    const meta = normalizeEventMeta(item.meta);
    if (meta) event.meta = meta;
    const traces = normalizeTraceSteps(item.traces);
    if (traces.length) event.traces = traces;
    chatHistory.nextId += 1;
    chatHistory.events.push(event);
    if (chatHistory.events.length > maxChatEvents) {
      chatHistory.events.splice(0, chatHistory.events.length - maxChatEvents);
    }
    saveChatHistory();
    return event;
  }

  function updateChatCardStatus(params = {}) {
    const eventId = Number(params.eventId);
    const cardId = String(params.cardId || "").trim();
    const status = normalizeCardStatus(params.status);
    if (!Number.isFinite(eventId) || eventId <= 0) {
      return { ok: false, error: "eventId is required" };
    }
    if (!cardId) {
      return { ok: false, error: "cardId is required" };
    }
    const event = (chatHistory.events || []).find((ev) => Number(ev?.id) === eventId);
    if (!event) {
      return { ok: false, error: "event not found" };
    }
    if (!Array.isArray(event.cards) || !event.cards.length) {
      return { ok: false, error: "event has no cards" };
    }
    const card = event.cards.find((item) => String(item?.id || "").trim() === cardId);
    if (!card) {
      return { ok: false, error: "card not found" };
    }
    card.status = status;
    if (params.extra && typeof params.extra === "object") {
      card.extra = { ...(card.extra && typeof card.extra === "object" ? card.extra : {}), ...params.extra };
    }
    if (params.strategy && typeof params.strategy === "object") {
      card.strategy = { ...(card.strategy && typeof card.strategy === "object" ? card.strategy : {}), ...params.strategy };
    }
    if (params.message != null) {
      card.message = String(params.message || "");
    }
    card.updatedAt = new Date().toISOString();
    saveChatHistory();
    return { ok: true, event, card };
  }

  function updateChatEvent(eventIdLike, patchLike) {
    const eventId = Number(eventIdLike);
    if (!Number.isFinite(eventId) || eventId <= 0) {
      return { ok: false, error: "eventId is required" };
    }
    const event = (chatHistory.events || []).find((ev) => Number(ev?.id) === eventId);
    if (!event) {
      return { ok: false, error: "event not found" };
    }
    const patch = typeof patchLike === "function" ? patchLike(cloneStructured(event) || {}) : patchLike;
    const next = patch && typeof patch === "object" ? patch : {};
    if (next.text != null) {
      event.text = String(next.text || "").trim() || event.text;
    }
    if (next.source != null) {
      event.source = String(next.source || "").trim() || event.source;
    }
    if (next.meta && typeof next.meta === "object") {
      event.meta = {
        ...(event.meta && typeof event.meta === "object" ? event.meta : {}),
        ...(normalizeEventMeta(next.meta) || {}),
      };
    }
    if (Array.isArray(next.traces)) {
      event.traces = normalizeTraceSteps(next.traces);
    }
    if (Array.isArray(next.cards)) {
      const normalizedCards = normalizeChatCards(next.cards, event.id);
      if (normalizedCards.length) event.cards = normalizedCards;
    }
    saveChatHistory();
    return { ok: true, event };
  }

  return {
    chatHistory,
    appendChatEvent,
    updateChatCardStatus,
    updateChatEvent,
  };
}
