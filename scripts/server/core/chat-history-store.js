export function createChatHistoryStore(optionsLike = {}) {
  const options = optionsLike && typeof optionsLike === "object" ? optionsLike : {};
  const fs = options.fsModule;
  const memoryDir = String(options.memoryDir || "");
  const chatHistoryPath = String(options.chatHistoryPath || "");
  const maxChatEvents = Math.max(100, Number(options.maxChatEvents || 2000) || 2000);

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
              cards: normalizeChatCards(ev.cards, Number(ev.id) || 0),
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
    const normalizedCards = normalizeChatCards(item.cards, event.id);
    if (normalizedCards.length) {
      event.cards = normalizedCards;
    }
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
    saveChatHistory();
    return { ok: true, event, card };
  }

  return {
    chatHistory,
    appendChatEvent,
    updateChatCardStatus,
  };
}
