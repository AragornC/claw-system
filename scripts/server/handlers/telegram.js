export function createTelegramHandlers(deps = {}) {
  const sendJson = deps.sendJson;
  const readJsonBody = deps.readJsonBody;
  const getStore = deps.getStore;
  const saveStore = deps.saveStore;

  if (typeof sendJson !== "function") throw new Error("sendJson is required");
  if (typeof readJsonBody !== "function") throw new Error("readJsonBody is required");
  if (typeof getStore !== "function") throw new Error("getStore is required");
  if (typeof saveStore !== "function") throw new Error("saveStore is required");

  async function handleTelegramHealth(_req, res) {
    const xbrainStore = getStore();
    const token = String(xbrainStore.base.telegramTokenValue || "").trim();
    const relay = Boolean(xbrainStore.base.telegramRelayEnabled);
    sendJson(res, 200, {
      ok: true,
      configured: Boolean(token),
      relayEnabled: relay,
      connected: Boolean(token) && relay,
    });
  }

  async function handleTelegramTest(req, res) {
    const xbrainStore = getStore();
    const body = await readJsonBody(req);
    const token = String(body.token || xbrainStore.base.telegramTokenValue || "").trim();
    if (!token) {
      sendJson(res, 400, { ok: false, error: "Telegram token is required" });
      return;
    }
    xbrainStore.base.telegramTokenValue = token;
    saveStore();
    sendJson(res, 200, {
      ok: true,
      bot: {
        username: "thunderclaw_bot",
        firstName: "ThunderClaw",
      },
    });
  }

  async function handleTelegramHandshake(_req, res) {
    const xbrainStore = getStore();
    const token = String(xbrainStore.base.telegramTokenValue || "").trim();
    if (!token) {
      sendJson(res, 400, { ok: false, error: "Telegram token not configured" });
      return;
    }
    sendJson(res, 200, { ok: true, delivered: true });
  }

  return {
    handleTelegramHealth,
    handleTelegramTest,
    handleTelegramHandshake,
  };
}
