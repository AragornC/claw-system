/**
 * Xbrain Handlers — Model configuration management (虾脑)
 *
 * Self-contained: stores API keys, manages model registry, switches models.
 * Self-contained — stores config locally, no external CLI dependency.
 */

export function createXbrainHandlers(deps = {}) {
  const {
    readJsonBody, sendJson, xbrainStore, saveXbrainStore,
    normalizeProviderKey, inferProviderFromModelRef,
    PROVIDER_DEFAULT_MODEL_REFS, providerSupportsApiKey,
    ensureProviderAuthEntry, isProviderConfigured,
    maskSecret, uniqStrings, toModelRef,
  } = deps;

  function getStateSnapshot() {
    return { base: { ...xbrainStore.base } };
  }

  // ─── GET /api/xbrain/state ─────────────────────────────────────────
  async function handleXbrainState(req, res) {
    sendJson(res, 200, { ok: true, state: getStateSnapshot() });
  }

  // ─── POST /api/xbrain/update ───────────────────────────────────────
  async function handleXbrainUpdate(req, res) {
    const body = await readJsonBody(req);
    const values = body && typeof body === "object" ? body : {};

    // Update API key for a provider
    if (values.provider && values.apiKey) {
      const provider = normalizeProviderKey(values.provider);
      if (!provider) {
        sendJson(res, 400, { ok: false, error: "invalid provider" });
        return;
      }
      xbrainStore.base.providerAuth = xbrainStore.base.providerAuth || {};
      xbrainStore.base.providerAuth[provider] = {
        configured: true,
        type: "apiKey",
        plain: String(values.apiKey).trim(),
        masked: maskSecret(String(values.apiKey).trim()),
        source: "xbrain_ui",
        error: "",
      };
      // If this is the first configured provider, set as runtime model
      if (!xbrainStore.base.runtimeModelProvider || !isProviderConfigured(xbrainStore.base.runtimeModelProvider)) {
        const defaultRef = PROVIDER_DEFAULT_MODEL_REFS[provider] || "";
        if (defaultRef) {
          const parts = defaultRef.split("/");
          xbrainStore.base.runtimeModelProvider = parts[0] || provider;
          xbrainStore.base.runtimeModelId = parts.slice(1).join("/") || "";
          if (!xbrainStore.base.modelRegistry?.includes(defaultRef)) {
            xbrainStore.base.modelRegistry = uniqStrings([...(xbrainStore.base.modelRegistry || []), defaultRef]);
          }
        }
      }
      // Legacy deepseek key compat
      if (provider === "deepseek") {
        xbrainStore.base.deepseekApiKey = String(values.apiKey).trim();
      }
      saveXbrainStore();
    }

    sendJson(res, 200, { ok: true, state: getStateSnapshot() });
  }

  // ─── POST /api/xbrain/model/switch ─────────────────────────────────
  async function handleXbrainModelSwitch(req, res) {
    const body = await readJsonBody(req);
    const modelRef = String(body.modelRef || body.model || "").trim();
    if (!modelRef || !modelRef.includes("/")) {
      sendJson(res, 400, { ok: false, error: "modelRef is required (format: provider/model)" });
      return;
    }
    const { provider } = inferProviderFromModelRef(modelRef);
    if (!isProviderConfigured(provider)) {
      sendJson(res, 400, {
        ok: false,
        error: `Provider "${provider}" 未配置 API Key。请先在虾脑中配置。`,
      });
      return;
    }
    const parts = modelRef.split("/");
    xbrainStore.base.runtimeModelProvider = parts[0];
    xbrainStore.base.runtimeModelId = parts.slice(1).join("/");
    if (!xbrainStore.base.modelRegistry?.includes(modelRef)) {
      xbrainStore.base.modelRegistry = uniqStrings([...(xbrainStore.base.modelRegistry || []), modelRef]);
    }
    saveXbrainStore();
    sendJson(res, 200, {
      ok: true,
      modelRef,
      runtimeModelRef: toModelRef(xbrainStore.base.runtimeModelProvider, xbrainStore.base.runtimeModelId),
      state: getStateSnapshot(),
    });
  }

  return { handleXbrainState, handleXbrainUpdate, handleXbrainModelSwitch };
}
