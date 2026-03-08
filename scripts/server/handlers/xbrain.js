/**
 * Xbrain Handlers — Model configuration management (虾脑)
 *
 * Self-contained model registry, provider auth, and config management.
 * Supports API key auth for all providers. No external CLI dependency.
 */

function toText(v, fb = "") { return String(v ?? "").trim() || fb; }

export function createXbrainHandlers(deps = {}) {
  const {
    readJsonBody, sendJson, xbrainStore, saveXbrainStore,
    normalizeProviderKey, inferProviderFromModelRef,
    PROVIDER_DEFAULT_MODEL_REFS, providerSupportsApiKey,
    ensureProviderAuthEntry, isProviderConfigured,
    maskSecret, uniqStrings, toModelRef,
  } = deps;

  if (!xbrainStore || typeof xbrainStore !== "object") throw new Error("xbrainStore is required");

  function getStateSnapshot() {
    // Ensure locks exist with expected structure
    const locks = xbrainStore.locks && typeof xbrainStore.locks === "object" ? xbrainStore.locks : {};
    const defaultLock = { locked: false, hasPassword: false };
    return {
      base: { ...xbrainStore.base },
      exchange: xbrainStore.exchange || {},
      strategy: xbrainStore.strategy || {},
      locks: {
        base: locks.base && typeof locks.base === "object" ? locks.base : defaultLock,
        channel: locks.channel && typeof locks.channel === "object" ? locks.channel : defaultLock,
        exchange: locks.exchange && typeof locks.exchange === "object" ? locks.exchange : defaultLock,
        strategy: locks.strategy && typeof locks.strategy === "object" ? locks.strategy : defaultLock,
      },
    };
  }

  /** All known provider keys with their default model refs */
  const KNOWN_PROVIDERS = Object.keys(PROVIDER_DEFAULT_MODEL_REFS || {});

  /** Build catalog of models available per provider */
  function buildModelCatalog() {
    const catalog = {};
    for (const provider of KNOWN_PROVIDERS) {
      const defaultRef = PROVIDER_DEFAULT_MODEL_REFS[provider] || "";
      const configured = isProviderConfigured ? isProviderConfigured(provider) : false;
      catalog[provider] = {
        provider,
        configured,
        defaultModelRef: defaultRef,
        // Common models per provider — these are well-known model IDs
        models: getProviderModels(provider),
      };
    }
    return catalog;
  }

  function getProviderModels(provider) {
    const p = toText(provider).toLowerCase();
    const models = {
      deepseek: [
        { ref: "deepseek/deepseek-chat", name: "DeepSeek Chat", description: "通用对话模型" },
        { ref: "deepseek/deepseek-reasoner", name: "DeepSeek Reasoner", description: "推理模型" },
      ],
      chatgpt: [
        { ref: "chatgpt/gpt-4o", name: "GPT-4o", description: "多模态旗舰模型" },
        { ref: "chatgpt/gpt-4o-mini", name: "GPT-4o Mini", description: "快速高效模型" },
        { ref: "chatgpt/o3-mini", name: "o3-mini", description: "推理模型" },
      ],
      anthropic: [
        { ref: "anthropic/claude-sonnet-4-20250514", name: "Claude Sonnet 4", description: "平衡型模型" },
        { ref: "anthropic/claude-haiku-3-5", name: "Claude Haiku 3.5", description: "快速模型" },
      ],
      openrouter: [
        { ref: "openrouter/auto", name: "Auto", description: "自动选择最佳模型" },
      ],
      gemini: [
        { ref: "gemini/gemini-2.5-flash", name: "Gemini 2.5 Flash", description: "快速多模态模型" },
        { ref: "gemini/gemini-2.5-pro", name: "Gemini 2.5 Pro", description: "高级推理模型" },
      ],
      zai: [
        { ref: "zai/glm-4-plus", name: "GLM-4 Plus", description: "智谱高级模型" },
      ],
    };
    return models[p] || [];
  }

  // ─── GET /api/xbrain/state ─────────────────────────────────────────
  async function handleXbrainState(req, res) {
    sendJson(res, 200, { ok: true, state: getStateSnapshot() });
  }

  // ─── POST /api/xbrain/update ───────────────────────────────────────
  async function handleXbrainUpdate(req, res) {
    const body = await readJsonBody(req);
    const section = toText(body?.section, "base");
    const values = body?.values && typeof body.values === "object" ? body.values : body || {};

    // Direct field updates
    if (section === "base") {
      // Update API key for a provider
      if (values.provider && values.apiKey) {
        const provider = normalizeProviderKey(values.provider);
        if (provider) {
          ensureProviderAuth(provider, String(values.apiKey).trim(), "xbrain_ui");
        }
      }
      // Update provider catalog
      if (Array.isArray(values.providerCatalog)) {
        xbrainStore.base.providerCatalog = values.providerCatalog.map(String).filter(Boolean);
      }
      // Update model registry
      if (Array.isArray(values.modelRegistry)) {
        xbrainStore.base.modelRegistry = uniqStrings(values.modelRegistry.map(String).filter(Boolean));
      }
      // Update DeepSeek API key shortcut
      if (typeof values.deepseekApiKey === "string" && values.deepseekApiKey.trim()) {
        xbrainStore.base.deepseekApiKey = values.deepseekApiKey.trim();
        ensureProviderAuth("deepseek", values.deepseekApiKey.trim(), "xbrain_ui");
      }
      // Update telegram
      if (typeof values.telegramTokenValue === "string") {
        xbrainStore.base.telegramTokenValue = values.telegramTokenValue;
      }
      if (typeof values.telegramRelayEnabled === "boolean") {
        xbrainStore.base.telegramRelayEnabled = values.telegramRelayEnabled;
      }
    } else if (section === "exchange") {
      if (typeof values.apiKeyValue === "string") xbrainStore.exchange.apiKeyValue = values.apiKeyValue;
      if (typeof values.apiSecretValue === "string") xbrainStore.exchange.apiSecretValue = values.apiSecretValue;
    } else if (section === "strategy") {
      Object.assign(xbrainStore.strategy || {}, values);
    } else if (section === "channel") {
      if (typeof values.telegramToken === "string") {
        xbrainStore.base.telegramTokenValue = values.telegramToken;
      }
      if (typeof values.telegramRelayEnabled === "boolean") {
        xbrainStore.base.telegramRelayEnabled = values.telegramRelayEnabled;
      }
    }

    saveXbrainStore();
    sendJson(res, 200, { ok: true, state: getStateSnapshot() });
  }

  // ─── POST /api/xbrain/model/switch ─────────────────────────────────
  async function handleXbrainModelSwitch(req, res) {
    const body = await readJsonBody(req);
    const modelRef = toText(body?.modelRef || body?.modelId || body?.model, "");
    if (!modelRef || !modelRef.includes("/")) {
      sendJson(res, 400, { ok: false, error: "modelRef required (provider/model)" });
      return;
    }
    const { provider } = inferProviderFromModelRef(modelRef);
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

  // ─── GET /api/xbrain/models/catalog ────────────────────────────────
  async function handleXbrainModelsCatalog(req, res) {
    const catalog = buildModelCatalog();
    const registry = uniqStrings(xbrainStore.base?.modelRegistry || []);
    sendJson(res, 200, {
      ok: true,
      catalog,
      registry,
      runtimeModelRef: toModelRef(xbrainStore.base.runtimeModelProvider, xbrainStore.base.runtimeModelId),
      providers: KNOWN_PROVIDERS,
    });
  }

  // ─── POST /api/xbrain/models/connect ───────────────────────────────
  async function handleXbrainModelConnect(req, res) {
    const body = await readJsonBody(req);
    const provider = normalizeProviderKey(body?.provider || "");
    const modelRefs = Array.isArray(body?.modelRefs)
      ? body.modelRefs.map(String).filter((r) => r.includes("/"))
      : [];
    const apiKey = toText(body?.apiKey, "");
    const setAsCurrent = body?.setAsCurrent !== false;

    if (!provider) {
      sendJson(res, 400, { ok: false, error: "provider required" });
      return;
    }

    // Store API key if provided
    if (apiKey) {
      ensureProviderAuth(provider, apiKey, "model_center");
    }

    // Register model refs
    const currentRegistry = uniqStrings(xbrainStore.base?.modelRegistry || []);
    const newRefs = modelRefs.filter((ref) => !currentRegistry.includes(ref));
    const updatedRegistry = uniqStrings([...currentRegistry, ...modelRefs]);
    xbrainStore.base.modelRegistry = updatedRegistry;

    // Set as current runtime model if requested
    if (setAsCurrent && modelRefs.length > 0) {
      const firstRef = modelRefs[0];
      const parts = firstRef.split("/");
      xbrainStore.base.runtimeModelProvider = parts[0];
      xbrainStore.base.runtimeModelId = parts.slice(1).join("/");
    }

    saveXbrainStore();
    sendJson(res, 200, {
      ok: true,
      provider,
      registered: newRefs,
      registry: updatedRegistry,
      runtimeModelRef: toModelRef(xbrainStore.base.runtimeModelProvider, xbrainStore.base.runtimeModelId),
      state: getStateSnapshot(),
    });
  }

  // ─── POST /api/xbrain/models/disconnect ────────────────────────────
  async function handleXbrainModelDisconnect(req, res) {
    const body = await readJsonBody(req);
    const modelRef = toText(body?.modelRef, "");
    if (!modelRef) {
      sendJson(res, 400, { ok: false, error: "modelRef required" });
      return;
    }
    const registry = (xbrainStore.base?.modelRegistry || []).filter((r) => r !== modelRef);
    xbrainStore.base.modelRegistry = registry;
    // If removed the current runtime model, switch to first remaining
    const currentRef = toModelRef(xbrainStore.base.runtimeModelProvider, xbrainStore.base.runtimeModelId);
    if (currentRef === modelRef && registry.length > 0) {
      const parts = registry[0].split("/");
      xbrainStore.base.runtimeModelProvider = parts[0] || "";
      xbrainStore.base.runtimeModelId = parts.slice(1).join("/") || "";
    }
    saveXbrainStore();
    sendJson(res, 200, {
      ok: true,
      removed: modelRef,
      registry,
      state: getStateSnapshot(),
    });
  }

  // ─── GET /api/xbrain/auth/status ───────────────────────────────────
  async function handleXbrainAuthStatus(req, res) {
    const providerAuth = xbrainStore.base?.providerAuth || {};
    const status = {};
    for (const [provider, auth] of Object.entries(providerAuth)) {
      status[provider] = {
        configured: Boolean(auth?.configured),
        type: toText(auth?.type, "apiKey"),
        masked: toText(auth?.masked, ""),
        source: toText(auth?.source, ""),
      };
    }
    sendJson(res, 200, { ok: true, status, running: false });
  }

  // ─── POST /api/xbrain/auth/start ──────────────────────────────────
  async function handleXbrainAuthStart(req, res) {
    const body = await readJsonBody(req);
    const provider = normalizeProviderKey(body?.provider || "");
    if (!provider) {
      sendJson(res, 400, { ok: false, error: "provider required" });
      return;
    }
    // For API key providers, just return instructions
    sendJson(res, 200, {
      ok: true,
      provider,
      method: "apiKey",
      message: `请在「注册模型」面板中输入 ${provider} 的 API Key 完成连接。`,
    });
  }

  // ─── POST /api/xbrain/auth/input ──────────────────────────────────
  async function handleXbrainAuthInput(req, res) {
    const body = await readJsonBody(req);
    const input = toText(body?.input, "");
    // Direct API key input for self-contained auth
    if (input) {
      // Try to detect provider from key format
      let provider = toText(body?.provider, "");
      if (!provider) {
        if (input.startsWith("sk-")) provider = "deepseek";
        else provider = "chatgpt";
      }
      provider = normalizeProviderKey(provider);
      if (provider) {
        ensureProviderAuth(provider, input, "auth_input");
        saveXbrainStore();
        sendJson(res, 200, { ok: true, provider, configured: true, state: getStateSnapshot() });
        return;
      }
    }
    sendJson(res, 200, { ok: true, message: "输入已收到" });
  }

  // ─── POST /api/xbrain/auth/disconnect ─────────────────────────────
  async function handleXbrainAuthDisconnect(req, res) {
    const body = await readJsonBody(req);
    const provider = normalizeProviderKey(body?.provider || "");
    if (!provider) {
      sendJson(res, 400, { ok: false, error: "provider required" });
      return;
    }
    xbrainStore.base.providerAuth = xbrainStore.base.providerAuth || {};
    xbrainStore.base.providerAuth[provider] = {
      configured: false,
      type: "apiKey",
      plain: "",
      masked: "",
      source: "",
      error: "",
    };
    if (provider === "deepseek") {
      xbrainStore.base.deepseekApiKey = "";
    }
    saveXbrainStore();
    sendJson(res, 200, { ok: true, provider, disconnected: true, state: getStateSnapshot() });
  }

  // ─── POST /api/xbrain/provider/remove ─────────────────────────────
  async function handleXbrainProviderRemove(req, res) {
    const body = await readJsonBody(req);
    const provider = normalizeProviderKey(body?.provider || "");
    if (!provider) {
      sendJson(res, 400, { ok: false, error: "provider required" });
      return;
    }
    // Remove auth
    xbrainStore.base.providerAuth = xbrainStore.base.providerAuth || {};
    delete xbrainStore.base.providerAuth[provider];
    if (provider === "deepseek") {
      xbrainStore.base.deepseekApiKey = "";
    }
    // Remove models from registry
    const registry = (xbrainStore.base?.modelRegistry || []).filter((ref) => {
      const { provider: refProvider } = inferProviderFromModelRef(ref);
      return refProvider !== provider;
    });
    xbrainStore.base.modelRegistry = registry;
    // Remove from catalog
    xbrainStore.base.providerCatalog = (xbrainStore.base?.providerCatalog || []).filter((p) => p !== provider);
    // Switch runtime if was using this provider
    if (normalizeProviderKey(xbrainStore.base.runtimeModelProvider) === provider) {
      if (registry.length > 0) {
        const parts = registry[0].split("/");
        xbrainStore.base.runtimeModelProvider = parts[0] || "";
        xbrainStore.base.runtimeModelId = parts.slice(1).join("/") || "";
      } else {
        xbrainStore.base.runtimeModelProvider = "";
        xbrainStore.base.runtimeModelId = "";
      }
    }
    saveXbrainStore();
    sendJson(res, 200, { ok: true, provider, removed: true, state: getStateSnapshot() });
  }

  // ─── POST /api/xbrain/lock ─────────────────────────────────────────
  async function handleXbrainLock(req, res) {
    const body = await readJsonBody(req);
    const section = toText(body?.section, "");
    if (!section) {
      sendJson(res, 400, { ok: false, error: "section required" });
      return;
    }
    if (!xbrainStore.locks) xbrainStore.locks = {};
    const current = xbrainStore.locks[section] && typeof xbrainStore.locks[section] === "object"
      ? xbrainStore.locks[section]
      : { locked: false, hasPassword: false };

    // Support both {action: "lock"/"unlock"} and {lock: boolean} formats
    const action = toText(body?.action, "");
    let locked;
    if (action === "lock") locked = true;
    else if (action === "unlock") locked = false;
    else locked = body?.lock !== false;

    // Password handling
    const password = toText(body?.password, "");
    const currentPassword = toText(body?.currentPassword, "");
    const hasPassword = Boolean(password) || Boolean(current.hasPassword);

    // If unlocking with password required, verify
    if (!locked && current.hasPassword && current.passwordHash) {
      if (currentPassword !== current.passwordHash && password !== current.passwordHash) {
        sendJson(res, 403, { ok: false, error: "密码不正确" });
        return;
      }
    }

    xbrainStore.locks[section] = {
      locked,
      hasPassword: locked ? (Boolean(password) || current.hasPassword) : false,
      passwordHash: locked && password ? password : (locked ? current.passwordHash : ""),
    };
    saveXbrainStore();
    sendJson(res, 200, { ok: true, section, locked, state: getStateSnapshot() });
  }

  /** Helper: configure provider auth with API key */
  function ensureProviderAuth(provider, apiKey, source) {
    xbrainStore.base.providerAuth = xbrainStore.base.providerAuth || {};
    xbrainStore.base.providerAuth[provider] = {
      configured: Boolean(apiKey),
      type: "apiKey",
      plain: apiKey,
      masked: maskSecret(apiKey),
      source: source || "xbrain",
      error: "",
    };
    // Set runtime model if this is the first configured provider
    if (apiKey && (!xbrainStore.base.runtimeModelProvider || !isProviderConfigured(xbrainStore.base.runtimeModelProvider))) {
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
    if (provider === "deepseek") {
      xbrainStore.base.deepseekApiKey = apiKey;
    }
    saveXbrainStore();
  }

  return {
    handleXbrainState,
    handleXbrainUpdate,
    handleXbrainModelSwitch,
    handleXbrainModelsCatalog,
    handleXbrainModelConnect,
    handleXbrainModelDisconnect,
    handleXbrainAuthStart,
    handleXbrainAuthStatus,
    handleXbrainAuthInput,
    handleXbrainAuthDisconnect,
    handleXbrainProviderRemove,
    handleXbrainLock,
  };
}
