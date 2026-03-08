export function createXbrainStoreManager(optionsLike = {}) {
  const options = optionsLike && typeof optionsLike === "object" ? optionsLike : {};
  const fs = options.fsModule;
  const memoryDir = String(options.memoryDir || "");
  const xbrainStatePath = String(options.xbrainStatePath || "");
  const normalizeProviderKey = typeof options.normalizeProviderKey === "function"
    ? options.normalizeProviderKey
    : (v) => String(v || "").trim().toLowerCase();
  const providerAuthType = typeof options.providerAuthType === "function"
    ? options.providerAuthType
    : () => "apiKey";
  const providerSupportsOAuth = typeof options.providerSupportsOAuth === "function"
    ? options.providerSupportsOAuth
    : () => false;
  const sanitizeProviderCatalog = typeof options.sanitizeProviderCatalog === "function"
    ? options.sanitizeProviderCatalog
    : (items) => (Array.isArray(items) ? items : []);

  function createInitialXbrainStore() {
    return {
      base: {
        modelProvider: "",
        modelId: "",
        runtimeModelProvider: "",
        runtimeModelId: "",
        providerCatalog: ["deepseek", "chatgpt", "anthropic", "openrouter", "gemini", "zai"],
        modelRegistry: [],
        deepseekApiKey: "",
        providerAuth: {},
        telegramTokenValue: "",
        telegramRelayEnabled: false,
        chatChannel: "dashboard",
      },
      exchange: {
        apiKeyValue: "",
        apiSecretValue: "",
        passphraseValue: "",
      },
      strategy: {
        profileName: "default",
        symbol: "BTC/USDT:USDT",
        leverage: 10,
        sizeMode: "risk",
        orderSize: 8,
        riskPct: 0.015,
        minNotional: 5,
        maxNotional: 80,
        runtimeMode: "dryrun",
        activeStrategy: "default",
      },
      locks: {
        base: { locked: false, hasPassword: false, password: "" },
        channel: { locked: false, hasPassword: false, password: "" },
        exchange: { locked: false, hasPassword: false, password: "" },
        strategy: { locked: false, hasPassword: false, password: "" },
      },
    };
  }

  function loadXbrainStore() {
    const store = createInitialXbrainStore();
    try {
      if (!xbrainStatePath || !fs?.existsSync || !fs.existsSync(xbrainStatePath)) {
        return store;
      }
      const raw = fs.readFileSync(xbrainStatePath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        store.base = { ...store.base, ...(parsed.base || {}) };
        store.exchange = { ...store.exchange, ...(parsed.exchange || {}) };
        store.strategy = { ...store.strategy, ...(parsed.strategy || {}) };
        for (const section of ["base", "channel", "exchange", "strategy"]) {
          const lockInfo = parsed?.locks?.[section];
          if (lockInfo && typeof lockInfo === "object") {
            store.locks[section] = { ...store.locks[section], ...lockInfo };
          }
        }
      }
    } catch {}
    return store;
  }

  const xbrainStore = loadXbrainStore();

  function saveXbrainStore() {
    try {
      if (!fs?.mkdirSync || !fs?.writeFileSync || !xbrainStatePath || !memoryDir) return;
      fs.mkdirSync(memoryDir, { recursive: true });
      fs.writeFileSync(xbrainStatePath, JSON.stringify(xbrainStore, null, 2), "utf8");
    } catch {}
  }

  function ensureProviderAuthEntry(providerRaw, patchLike = {}) {
    const provider = normalizeProviderKey(providerRaw);
    xbrainStore.base.providerAuth = xbrainStore.base.providerAuth && typeof xbrainStore.base.providerAuth === "object"
      ? xbrainStore.base.providerAuth
      : {};
    const current = xbrainStore.base.providerAuth[provider] && typeof xbrainStore.base.providerAuth[provider] === "object"
      ? xbrainStore.base.providerAuth[provider]
      : {
          configured: false,
          masked: "(未设置)",
          plain: "",
          source: "-",
          error: "",
          type: providerAuthType(provider),
        };
    const patch = patchLike && typeof patchLike === "object" ? patchLike : {};
    const next = {
      ...current,
      ...patch,
      type: String(patch.type || current.type || providerAuthType(provider)),
    };
    xbrainStore.base.providerAuth[provider] = next;
    return next;
  }

  function isProviderConfigured(providerRaw) {
    const provider = normalizeProviderKey(providerRaw);
    const authMeta = xbrainStore.base?.providerAuth?.[provider];
    return Boolean(authMeta && typeof authMeta === "object" && authMeta.configured);
  }

  function markProviderAuthSyncError(errorLike) {
    const errorText = String(errorLike || "models status sync failed").trim() || "models status sync failed";
    const providerCatalog = sanitizeProviderCatalog([
      ...(xbrainStore.base.providerCatalog || []),
      ...Object.keys(xbrainStore.base.providerAuth || {}),
    ]);
    for (const provider of providerCatalog) {
      if (!providerSupportsOAuth(provider)) continue;
      ensureProviderAuthEntry(provider, {
        configured: false,
        masked: "(未设置)",
        plain: "",
        source: "sync_error",
        error: errorText,
        type: "oauth",
      });
    }
    saveXbrainStore();
  }

  return {
    xbrainStore,
    saveXbrainStore,
    ensureProviderAuthEntry,
    isProviderConfigured,
    markProviderAuthSyncError,
  };
}
