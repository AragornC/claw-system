export function createXbrainCoreHandlers(deps = {}) {
  const {
    readJsonBody,
    buildXbrainState,
    sendJson,
    sanitizeProviderCatalog,
    uniqStrings,
    maskSecret,
    runSetupFromInput,
    runOpenClawCommand,
    switchThunderSessionModel,
    syncXbrainFromOpenClaw,
    getXbrainStateSnapshot,
    normalizeProviderKey,
    toModelRef,
    inferProviderFromModelRef,
    listOpenClawModelsCatalog,
    PROVIDER_DEFAULT_MODEL_REFS,
    providerSupportsApiKey,
    providerSupportsOAuth,
    isProviderConfigured,
    PROVIDER_TO_SETUP_PROVIDER,
    PROVIDER_TO_OAUTH_PROVIDER,
    tuneDeepseekDefaults,
    ensureProviderAuthEntry,
    startOAuthLogin,
    sleepMs,
    getOauthStatus,
    providerAuthType,
    saveXbrainStore,
    submitOauthPromptInput,
  } = deps;

  const xbrainStore = deps.xbrainStore;

  if (!xbrainStore || typeof xbrainStore !== 'object') throw new Error('xbrainStore is required');

async function handleXbrainState(req, res) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const refresh = String(url.searchParams.get("refresh") || "0") === "1";
  const state = await buildXbrainState(refresh);
  sendJson(res, 200, { ok: true, state });
}

async function handleXbrainUpdate(req, res) {
  const body = await readJsonBody(req);
  const section = String(body.section || "").trim();
  const values = body.values && typeof body.values === "object" ? body.values : {};

  if (section === "base") {
    if (Array.isArray(values.providerCatalog)) {
      xbrainStore.base.providerCatalog = sanitizeProviderCatalog(values.providerCatalog);
    }
    if (Array.isArray(values.modelRegistry)) {
      xbrainStore.base.modelRegistry = uniqStrings(values.modelRegistry);
    }
    if (typeof values.deepseekApiKey === "string" && values.deepseekApiKey.trim()) {
      const key = String(values.deepseekApiKey).trim();
      xbrainStore.base.deepseekApiKey = key;
      xbrainStore.base.providerAuth = xbrainStore.base.providerAuth || {};
      xbrainStore.base.providerAuth.deepseek = {
        configured: true,
        masked: maskSecret(key),
        plain: key,
        source: "xbrain",
        error: "",
        type: "apiKey",
      };
      const setup = await runSetupFromInput({
        provider: "deepseek-api-key",
        apiKey: key,
        gatewayPort: 18789,
        gatewayAuth: "token",
      });
      if (setup.ok) {
        await runOpenClawCommand(
          ["config", "set", "models.providers.deepseek.models[0].contextWindow", "128000", "--strict-json"],
          { timeoutMs: 30_000 },
        );
        await runOpenClawCommand(
          ["config", "set", "models.providers.deepseek.models[0].maxTokens", "8192", "--strict-json"],
          { timeoutMs: 30_000 },
        );
        await switchThunderSessionModel({
          modelRef: "deepseek/deepseek-chat",
          sessionId: "thunderclaw-main",
        }).catch(() => null);
      }
    }
    if (typeof values.telegramRelayEnabled === "boolean") {
      xbrainStore.base.telegramRelayEnabled = Boolean(values.telegramRelayEnabled);
    }
    if (typeof values.chatChannel === "string" && values.chatChannel.trim()) {
      xbrainStore.base.chatChannel = values.chatChannel.trim();
    }
    if (typeof values.telegramToken === "string" && values.telegramToken.trim()) {
      xbrainStore.base.telegramTokenValue = values.telegramToken.trim();
    }
  } else if (section === "channel") {
    if (typeof values.telegramRelayEnabled === "boolean") {
      xbrainStore.base.telegramRelayEnabled = Boolean(values.telegramRelayEnabled);
    }
    if (typeof values.telegramToken === "string" && values.telegramToken.trim()) {
      xbrainStore.base.telegramTokenValue = values.telegramToken.trim();
    }
    if (typeof values.chatChannel === "string" && values.chatChannel.trim()) {
      xbrainStore.base.chatChannel = values.chatChannel.trim();
    }
  } else if (section === "exchange") {
    if (typeof values.apiKey === "string" && values.apiKey.trim()) {
      xbrainStore.exchange.apiKeyValue = values.apiKey.trim();
    }
    if (typeof values.apiSecret === "string" && values.apiSecret.trim()) {
      xbrainStore.exchange.apiSecretValue = values.apiSecret.trim();
    }
    if (typeof values.apiPassphrase === "string" && values.apiPassphrase.trim()) {
      xbrainStore.exchange.passphraseValue = values.apiPassphrase.trim();
    }
  } else if (section === "strategy") {
    xbrainStore.strategy = {
      ...xbrainStore.strategy,
      ...values,
      leverage: Number.isFinite(Number(values.leverage))
        ? Number(values.leverage)
        : Number(xbrainStore.strategy.leverage || 10),
      orderSize: Number.isFinite(Number(values.orderSize))
        ? Number(values.orderSize)
        : Number(xbrainStore.strategy.orderSize || 8),
      riskPct: Number.isFinite(Number(values.riskPct))
        ? Number(values.riskPct)
        : Number(xbrainStore.strategy.riskPct || 0.015),
      minNotional: Number.isFinite(Number(values.minNotional))
        ? Number(values.minNotional)
        : Number(xbrainStore.strategy.minNotional || 5),
      maxNotional: Number.isFinite(Number(values.maxNotional))
        ? Number(values.maxNotional)
        : Number(xbrainStore.strategy.maxNotional || 80),
      runtimeMode: String(values.runtimeMode || xbrainStore.strategy.runtimeMode || "dryrun") === "live"
        ? "live"
        : "dryrun",
    };
  }

  saveXbrainStore();
  await syncXbrainFromOpenClaw();
  sendJson(res, 200, {
    ok: true,
    state: getXbrainStateSnapshot(),
  });
}

async function handleXbrainModelSwitch(req, res) {
  const body = await readJsonBody(req);
  const modelRefInput = String(body.modelId || body.modelRef || "").trim();
  const provider = normalizeProviderKey(body.modelProvider || "");
  if (!modelRefInput) {
    sendJson(res, 400, { ok: false, error: "modelRef is required" });
    return;
  }
  const modelRef = modelRefInput.includes("/")
    ? modelRefInput
    : toModelRef(provider || xbrainStore.base.modelProvider, modelRefInput);
  const registry = uniqStrings(xbrainStore.base.modelRegistry || []);
  if (!registry.includes(modelRef)) {
    sendJson(res, 400, {
      ok: false,
      error: "model is not registered in ThunderClaw model registry",
      modelRef,
      registered: registry,
    });
    return;
  }
  await syncXbrainFromOpenClaw().catch(() => null);
  const stateBeforeSwitch = getXbrainStateSnapshot();
  const targetProvider = inferProviderFromModelRef(modelRef).provider;
  const providerConnected = Boolean(stateBeforeSwitch?.base?.providerAuth?.[targetProvider]?.configured);
  if (!providerConnected) {
    sendJson(res, 400, {
      ok: false,
      error: `provider ${targetProvider} is not connected`,
      hint: "请先在虾脑-模型注册中心完成该 Provider 连接，然后再切换模型。",
      modelRef,
      provider: targetProvider,
      state: stateBeforeSwitch,
    });
    return;
  }
  const switched = await switchThunderSessionModel({
    modelRef,
    sessionId: "thunderclaw-main",
  });
  if (!switched.ok) {
    sendJson(res, 400, {
      ok: false,
      error: String(switched?.sessionSync?.error || "session /model failed"),
      modelRef,
      openclawModelSync: {
        ok: false,
        error: String(switched?.sessionSync?.error || "session /model failed"),
        sessionSync: switched?.sessionSync || null,
        defaultSync: switched?.defaultSync || null,
      },
    });
    return;
  }
  const defaultWarn = switched?.defaultSync?.attempted && switched?.defaultSync?.ok === false
    ? `默认模型同步失败：${String(switched?.defaultSync?.error || "unknown")}`
    : "";
  sendJson(res, 200, {
    ok: true,
    state: switched?.state || getXbrainStateSnapshot(),
    openclawModelSync: {
      ok: true,
      error: null,
      warning: defaultWarn,
      sessionSync: switched?.sessionSync || null,
      defaultSync: switched?.defaultSync || null,
    },
  });
}

async function handleXbrainModelsCatalog(req, res) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const refresh = String(url.searchParams.get("refresh") || "0") === "1";
  if (refresh) {
    await syncXbrainFromOpenClaw().catch(() => null);
  }
  const catalog = await listOpenClawModelsCatalog(refresh);
  if (!catalog.ok) {
    sendJson(res, 500, { ok: false, error: catalog.error || "获取模型目录失败" });
    return;
  }
  const catalogKeySet = new Set(
    (Array.isArray(catalog.all) ? catalog.all : [])
      .map((item) => String(item?.key || "").trim())
      .filter(Boolean),
  );
  const currentRegistry = uniqStrings(xbrainStore.base.modelRegistry || []);
  const prunedRegistry = currentRegistry.filter((ref) => catalogKeySet.has(ref));
  if (prunedRegistry.length !== currentRegistry.length) {
    xbrainStore.base.modelRegistry = prunedRegistry.length
      ? prunedRegistry
      : [PROVIDER_DEFAULT_MODEL_REFS.deepseek];
    saveXbrainStore();
    if (refresh) {
      await syncXbrainFromOpenClaw().catch(() => null);
    }
  }
  const providers = sanitizeProviderCatalog([
    ...(xbrainStore.base.providerCatalog || []),
    ...catalog.all.map((item) => item.provider),
  ]);
  const authSupport = {};
  const state = getXbrainStateSnapshot();
  const registry = Array.isArray(state?.base?.modelRegistry) ? state.base.modelRegistry : [];
  const providerAuth = state?.base?.providerAuth && typeof state.base.providerAuth === "object"
    ? state.base.providerAuth
    : {};
  const providerState = {};
  for (const provider of providers) {
    authSupport[provider] = {
      apiKey: providerSupportsApiKey(provider),
      oauth: providerSupportsOAuth(provider),
    };
    providerState[provider] = {
      auth: providerAuth?.[provider] || null,
      models: registry.filter((ref) => inferProviderFromModelRef(ref).provider === provider),
    };
  }
  sendJson(res, 200, {
    ok: true,
    updatedAt: catalog.updatedAt,
    cached: catalog.cached,
    count: catalog.all.length,
    providers,
    authSupport,
    providerState,
    catalog: catalog.all,
    configured: catalog.configured,
    connected: uniqStrings(registry),
    state,
  });
}

async function handleXbrainModelConnect(req, res) {
  const body = await readJsonBody(req);
  const providerInputRaw = String(body.provider || body.modelProvider || "").trim();
  const registerModel = body.registerModel !== false;
  const setAsCurrent = body.setAsCurrent !== false;
  const inputRefs = uniqStrings([
    ...(Array.isArray(body.modelRefs) ? body.modelRefs : []),
    body.model,
    body.modelRef,
    body.modelId,
  ]);
  let provider = normalizeProviderKey(providerInputRaw || xbrainStore.base.modelProvider || "deepseek");
  let modelRefs = inputRefs.map((item) => {
    const value = String(item || "").trim();
    if (!value) return "";
    return value.includes("/") ? value : toModelRef(provider, value);
  }).filter(Boolean);
  if (modelRefs.length) {
    provider = inferProviderFromModelRef(modelRefs[0]).provider;
    modelRefs = modelRefs.map((ref) => {
      const value = String(ref || "").trim();
      return value.includes("/") ? value : toModelRef(provider, value);
    });
  }
  modelRefs = uniqStrings(modelRefs);
  if (registerModel && !modelRefs.length) {
    sendJson(res, 400, { ok: false, error: "model is required when registerModel=true" });
    return;
  }
  const mixedProvider = modelRefs.some((ref) => inferProviderFromModelRef(ref).provider !== provider);
  if (mixedProvider) {
    sendJson(res, 400, { ok: false, error: "all models in one request must belong to same provider" });
    return;
  }
  const providerCatalogBeforeConnect = sanitizeProviderCatalog(xbrainStore.base.providerCatalog || []);
  const modelRegistryBeforeConnect = uniqStrings(xbrainStore.base.modelRegistry || []);
  const providerAuthBeforeConnect = JSON.parse(JSON.stringify(
    xbrainStore.base.providerAuth && typeof xbrainStore.base.providerAuth === "object"
      ? xbrainStore.base.providerAuth
      : {},
  ));

  const apiKey = String(body.apiKey || "").trim();
  let authMethod = String(body.authMethod || "").trim().toLowerCase();
  if (authMethod === "apikey") authMethod = "api-key";
  if (authMethod === "register-only") authMethod = "register";
  if (authMethod === "connect-only") authMethod = providerSupportsApiKey(provider) ? "api-key" : "oauth";
  if (!authMethod) {
    if (providerSupportsApiKey(provider) && apiKey) authMethod = "api-key";
    else if (providerSupportsOAuth(provider) && !isProviderConfigured(provider)) authMethod = "oauth";
    else authMethod = "register";
  }
  if (!["api-key", "oauth", "register"].includes(authMethod)) {
    sendJson(res, 400, { ok: false, error: "invalid authMethod" });
    return;
  }

  let setupInfo = null;
  let oauthInfo = null;
  let providerConfiguredAfterAuth = isProviderConfigured(provider);
  let oauthAttemptId = 0;
  let oauthAttemptStartedAt = "";
  let oauthLoginUrl = "";
  if (authMethod === "api-key") {
    const setupProvider = PROVIDER_TO_SETUP_PROVIDER[provider];
    if (!setupProvider) {
      sendJson(res, 400, { ok: false, error: `provider ${provider} does not support API key connect in xbrain` });
      return;
    }
    if (apiKey) {
      const setup = await runSetupFromInput({
        provider: setupProvider,
        apiKey,
        gatewayPort: 18789,
        gatewayAuth: "token",
      });
      if (!setup.ok) {
        sendJson(res, setup.statusCode || 500, {
          ok: false,
          stage: "setup",
          error: setup.error || setup.stderr || setup.stdout || "模型连接失败",
        });
        return;
      }
      let deepseekTune = null;
      if (setupProvider === "deepseek-api-key") {
        deepseekTune = await tuneDeepseekDefaults();
        xbrainStore.base.deepseekApiKey = apiKey;
      }
      ensureProviderAuthEntry(provider, {
        configured: true,
        masked: maskSecret(apiKey),
        plain: apiKey,
        source: "xbrain_connect",
        error: "",
        type: "apiKey",
      });
      setupInfo = {
        ok: true,
        provider: setupProvider,
        deepseekTune,
        reused: false,
      };
      providerConfiguredAfterAuth = true;
    } else if (isProviderConfigured(provider)) {
      ensureProviderAuthEntry(provider, {
        configured: true,
        error: "",
        source: String(xbrainStore.base.providerAuth?.[provider]?.source || "openclaw_existing"),
      });
      setupInfo = {
        ok: true,
        provider: setupProvider,
        deepseekTune: null,
        reused: true,
      };
      providerConfiguredAfterAuth = true;
    } else {
      sendJson(res, 400, { ok: false, error: "apiKey is required for api-key connect" });
      return;
    }
  } else if (authMethod === "oauth") {
    const oauthProvider = PROVIDER_TO_OAUTH_PROVIDER[provider];
    if (!oauthProvider) {
      sendJson(res, 400, { ok: false, error: `provider ${provider} does not support oauth connect in xbrain` });
      return;
    }
    const syncBeforeOauth = await syncXbrainFromOpenClaw().catch(() => ({ ok: false, error: "sync_before_oauth_failed" }));
    providerConfiguredAfterAuth = Boolean(syncBeforeOauth?.ok && isProviderConfigured(provider));
    const outcome = startOAuthLogin(oauthProvider);
    if (!outcome.ok) {
      sendJson(res, 400, outcome);
      return;
    }
    oauthAttemptId = Number(outcome?.attemptId || outcome?.state?.attemptId || 0);
    oauthAttemptStartedAt = String(outcome?.startedAt || outcome?.state?.startedAt || "");
    ensureProviderAuthEntry(provider, {
      configured: false,
      masked: "等待授权",
      plain: "",
      source: "oauth_pending",
      error: "",
      type: "oauth",
    });
    oauthInfo = outcome;
    await sleepMs(1000);
    const oauthStatus = getOauthStatus();
    oauthLoginUrl = String(oauthStatus?.url || oauthStatus?.last?.url || "");
  } else {
    ensureProviderAuthEntry(provider, {
      source: "model_registry",
      type: providerAuthType(provider),
    });
  }

  const registerApplied = registerModel && !(authMethod === "oauth" && !providerConfiguredAfterAuth);
  xbrainStore.base.providerCatalog = sanitizeProviderCatalog([...(xbrainStore.base.providerCatalog || []), provider]);
  if (registerApplied && modelRefs.length) {
    xbrainStore.base.modelRegistry = uniqStrings([...(xbrainStore.base.modelRegistry || []), ...modelRefs]);
  }

  let modelSet = { attempted: false, ok: null, error: null, modelRef: null, deferred: false };
  const deferModelSetForOAuth = authMethod === "oauth" && (!providerConfiguredAfterAuth || !registerApplied);
  if (registerApplied && setAsCurrent && modelRefs.length && !deferModelSetForOAuth) {
    const targetModelRef = String(body.defaultModelRef || modelRefs[0] || "").trim();
    const switched = await switchThunderSessionModel({
      modelRef: targetModelRef,
      sessionId: "thunderclaw-main",
    });
    const defaultWarn = switched?.defaultSync?.attempted && switched?.defaultSync?.ok === false
      ? `默认模型同步失败：${String(switched?.defaultSync?.error || "unknown")}`
      : "";
    modelSet = {
      attempted: true,
      ok: switched?.ok === true,
      error: switched?.ok === true ? null : String(switched?.sessionSync?.error || "session /model failed"),
      warning: defaultWarn,
      modelRef: targetModelRef,
      deferred: false,
      sessionSync: switched?.sessionSync || null,
      defaultSync: switched?.defaultSync || null,
    };
  } else if (registerModel && setAsCurrent && modelRefs.length && deferModelSetForOAuth) {
    modelSet = {
      attempted: false,
      ok: null,
      error: null,
      modelRef: String(body.defaultModelRef || modelRefs[0] || "").trim(),
      deferred: true,
    };
  }

  saveXbrainStore();
  await syncXbrainFromOpenClaw();
  const finalState = getXbrainStateSnapshot();
  const providerConfiguredFinal = Boolean(finalState?.base?.providerAuth?.[provider]?.configured);
  const oauthStatusFinal = getOauthStatus();
  const oauthCurrentAttemptId = Number(oauthStatusFinal?.attemptId || 0);
  const oauthLastAttemptId = Number(oauthStatusFinal?.last?.attemptId || 0);
  const oauthPending = authMethod === "oauth"
    && Boolean(oauthStatusFinal?.running)
    && normalizeProviderKey(oauthStatusFinal?.provider || "") === provider
    && (!oauthAttemptId || oauthCurrentAttemptId === oauthAttemptId);
  const oauthAttemptMatchedLast = authMethod === "oauth"
    && oauthAttemptId > 0
    && oauthLastAttemptId === oauthAttemptId;
  const oauthAttemptSucceeded = authMethod === "oauth"
    && oauthAttemptMatchedLast
    && Number(oauthStatusFinal?.last?.code) === 0
    && !String(oauthStatusFinal?.last?.error || "").trim();
  const oauthAttemptFailed = authMethod === "oauth"
    && oauthAttemptMatchedLast
    && !oauthAttemptSucceeded;
  const oauthUrl = String(oauthStatusFinal?.url || oauthStatusFinal?.last?.url || oauthLoginUrl || "").trim();
  const oauthNoProgress = authMethod === "oauth"
    && !oauthPending
    && !oauthAttemptSucceeded
    && !oauthAttemptFailed;
  const oauthNeedsRollback = authMethod === "oauth" && (
    oauthAttemptFailed
    || oauthNoProgress
    || (!oauthPending && !providerConfiguredFinal)
  );
  if (oauthNeedsRollback) {
    xbrainStore.base.providerCatalog = providerCatalogBeforeConnect;
    xbrainStore.base.modelRegistry = modelRegistryBeforeConnect;
    xbrainStore.base.providerAuth = providerAuthBeforeConnect;
    saveXbrainStore();
    await syncXbrainFromOpenClaw().catch(() => null);
    const rollbackState = getXbrainStateSnapshot();
    const oauthError = String(oauthStatusFinal?.last?.error || "").trim();
    const fallbackError = oauthNoProgress
      ? "OAuth 未进入可追踪流程（未拿到登录页面或未开始授权）。"
      : "OAuth 未完成，未检测到有效授权。";
    sendJson(res, 400, {
      ok: false,
      stage: "oauth",
      error: oauthError || fallbackError,
      provider,
      modelRefs,
      registerModel,
      registerApplied,
      authMethod,
      commandHint: String(oauthStatusFinal?.commandHint || oauthInfo?.commandHint || ""),
      oauthPending,
      oauthAttemptId,
      oauthAttemptStartedAt,
      oauthAttemptMatchedLast,
      oauthAttemptSucceeded,
      oauthAttemptFailed,
      oauthUrl,
      oauth: oauthInfo,
      state: rollbackState,
      rolledBack: true,
    });
    return;
  }
  const primaryModelRef = modelRefs[0] || "";
  sendJson(res, 200, {
    ok: true,
    provider,
    modelRef: primaryModelRef,
    modelRefs,
    registerModel,
      registerApplied,
    setAsCurrent,
    authMethod,
    setup: setupInfo,
    oauth: oauthInfo,
    oauthPending,
    oauthAttemptId,
    oauthAttemptStartedAt,
    oauthAttemptMatchedLast,
    oauthAttemptSucceeded,
    oauthAttemptFailed,
    oauthUrl,
    providerConfigured: providerConfiguredFinal,
    commandHint: String(oauthStatusFinal?.commandHint || oauthInfo?.commandHint || ""),
    modelSet,
    state: finalState,
    message: (authMethod === "oauth" && oauthPending && registerModel && !registerApplied)
        ? "OAuth 已发起，等待浏览器授权。授权完成后请点击“仅注册（已有连接）”。"
      : (authMethod === "oauth" && oauthPending)
        ? "OAuth 已发起，等待浏览器授权完成后自动生效。"
      : (authMethod === "oauth" && oauthAttemptSucceeded && providerConfiguredFinal && !registerApplied)
        ? "OAuth 已完成，Provider 已连接。请再点一次“仅注册（已有连接）”把模型加入切换列表。"
      : (authMethod === "oauth" && oauthAttemptSucceeded && providerConfiguredFinal)
        ? (!registerModel ? "OAuth 已完成，Provider 已连接。" : "OAuth 已完成，模型已连接并可切换。")
      : (authMethod === "oauth" && !oauthAttemptSucceeded)
        ? "OAuth 未完成，请先完成授权页面操作后再继续。"
      : (authMethod === "oauth" && !providerConfiguredFinal)
        ? (!registerModel ? "OAuth 未完成，连接尚未生效。" : "OAuth 未完成，模型未注册到切换列表。")
      : !registerModel
        ? "连接信息已更新（未加入切换列表）。"
      : (modelSet.attempted && modelSet.ok)
        ? "模型已连接并注册到 ThunderClaw 切换列表。"
        : "模型已注册到切换列表。",
  });
}

async function handleXbrainModelDisconnect(req, res) {
  const body = await readJsonBody(req);
  const providerInput = String(body.provider || body.modelProvider || "").trim();
  const modelInputs = uniqStrings([
    ...(Array.isArray(body.modelRefs) ? body.modelRefs : []),
    body.model,
    body.modelRef,
    body.modelId,
  ]);
  const currentRegistry = uniqStrings(xbrainStore.base.modelRegistry || []);
  let modelRefs = modelInputs.map((item) => {
    const text = String(item || "").trim();
    if (!text) return "";
    if (text.includes("/")) return text;
    const provider = normalizeProviderKey(providerInput || xbrainStore.base.modelProvider || "deepseek");
    return toModelRef(provider, text);
  }).filter(Boolean);
  if (!modelRefs.length && providerInput) {
    const provider = normalizeProviderKey(providerInput);
    modelRefs = currentRegistry.filter((ref) => inferProviderFromModelRef(ref).provider === provider);
  }
  modelRefs = uniqStrings(modelRefs);
  if (!modelRefs.length) {
    sendJson(res, 400, { ok: false, error: "modelRefs or provider is required" });
    return;
  }

  const removeSet = new Set(modelRefs);
  const nextRegistry = currentRegistry.filter((item) => !removeSet.has(item));
  if (nextRegistry.length === currentRegistry.length) {
    sendJson(res, 200, { ok: true, removed: false, modelRefs, state: getXbrainStateSnapshot() });
    return;
  }

  let fallbackInserted = false;
  if (!nextRegistry.length) {
    nextRegistry.push(PROVIDER_DEFAULT_MODEL_REFS.deepseek);
    fallbackInserted = true;
  }
  xbrainStore.base.modelRegistry = uniqStrings(nextRegistry);

  const currentModelRef = toModelRef(xbrainStore.base.modelProvider, xbrainStore.base.modelId);
  let switched = null;
  if (!xbrainStore.base.modelRegistry.includes(currentModelRef) || modelRefs.includes(currentModelRef)) {
    const fallbackRef = xbrainStore.base.modelRegistry[0];
    const switchRes = await switchThunderSessionModel({
      modelRef: fallbackRef,
      sessionId: "thunderclaw-main",
    });
    const defaultWarn = switchRes?.defaultSync?.attempted && switchRes?.defaultSync?.ok === false
      ? `默认模型同步失败：${String(switchRes?.defaultSync?.error || "unknown")}`
      : "";
    switched = {
      ok: switchRes?.ok === true,
      modelRef: fallbackRef,
      error: switchRes?.ok === true ? null : String(switchRes?.sessionSync?.error || "session /model failed"),
      warning: defaultWarn,
      sessionSync: switchRes?.sessionSync || null,
      defaultSync: switchRes?.defaultSync || null,
    };
  }

  saveXbrainStore();
  await syncXbrainFromOpenClaw();
  sendJson(res, 200, {
    ok: true,
    removed: true,
    modelRef: modelRefs[0] || "",
    fallbackInserted,
    switched,
    modelRefs,
    removedCount: currentRegistry.length - nextRegistry.length,
    state: getXbrainStateSnapshot(),
  });
}

async function handleXbrainAuthStart(req, res) {
  const body = await readJsonBody(req);
  const provider = normalizeProviderKey(body.provider || "chatgpt");
  if (provider === "anthropic") {
    sendJson(res, 400, {
      ok: false,
      error: "Anthropic token flow: please run `openclaw models auth setup-token --provider anthropic --yes`",
    });
    return;
  }
  const oauthProvider = PROVIDER_TO_OAUTH_PROVIDER[provider];
  if (!oauthProvider) {
    sendJson(res, 400, {
      ok: false,
      error: `provider ${provider} does not support oauth login`,
    });
    return;
  }
  const outcome = startOAuthLogin(oauthProvider);
  if (!outcome.ok) {
    sendJson(res, 400, outcome);
    return;
  }
  await sleepMs(1200);
  const status = getOauthStatus();
  const relatedProvider = normalizeProviderKey(status?.provider || status?.last?.provider || "");
  const attemptId = Number(outcome?.attemptId || status?.attemptId || 0);
  const lastAttemptId = Number(status?.last?.attemptId || 0);
  const pending = Boolean(status.running)
    && relatedProvider === provider
    && (!attemptId || Number(status?.attemptId || 0) === attemptId);
  const attemptMatched = attemptId > 0 && lastAttemptId === attemptId;
  const attemptSucceeded = attemptMatched && Number(status?.last?.code) === 0 && !String(status?.last?.error || "").trim();
  const attemptFailed = attemptMatched && !attemptSucceeded;
  if (!pending) {
    await syncXbrainFromOpenClaw().catch(() => null);
  }
  const configured = isProviderConfigured(provider);
  if (attemptFailed || (!pending && !attemptSucceeded) || (!pending && !configured)) {
    sendJson(res, 400, {
      ok: false,
      stage: "oauth",
      error: String(status?.last?.error || "OAuth 流程未完成，未检测到有效授权。"),
      commandHint: String(status?.commandHint || status?.last?.commandHint || outcome.commandHint || ""),
      attemptId,
      pending,
      attemptMatched,
      attemptSucceeded,
      attemptFailed,
      status,
    });
    return;
  }
  sendJson(res, 200, {
    ...outcome,
    pending,
    attemptId,
    attemptMatched,
    attemptSucceeded,
    attemptFailed,
    providerConfigured: configured,
    oauthUrl: String(status?.url || status?.last?.url || ""),
    commandHint: String(status?.commandHint || outcome.commandHint || ""),
    status,
  });
}

async function handleXbrainAuthStatus(req, res) {
  const status = getOauthStatus();
  sendJson(res, 200, {
    ok: true,
    status: {
      running: Boolean(status.running),
      provider: normalizeProviderKey(status.provider),
      phase: status.running ? "running" : "idle",
      attemptId: Number(status?.attemptId || 0),
      lastAttemptId: Number(status?.last?.attemptId || 0),
      url: String(status.url || status?.last?.url || ""),
      commandHint: String(status.commandHint || status?.last?.commandHint || ""),
      exitCode: status?.last?.code ?? null,
      error: status?.last?.error ?? null,
      startedAt: status.startedAt ?? null,
      prompt: status?.prompt && typeof status.prompt === "object" ? status.prompt : null,
      logsTail: Array.isArray(status.logsTail) ? status.logsTail : [],
    },
  });
}

async function handleXbrainAuthInput(req, res) {
  const body = await readJsonBody(req);
  const input = String(body.input ?? body.code ?? body.value ?? "").trim();
  const attemptId = Number.isFinite(Number(body.attemptId)) ? Number(body.attemptId) : 0;
  if (!input) {
    sendJson(res, 400, { ok: false, error: "input is required" });
    return;
  }
  const submitted = submitOauthPromptInput(input, attemptId);
  if (!submitted.ok) {
    sendJson(res, 400, submitted);
    return;
  }
  sendJson(res, 200, {
    ok: true,
    accepted: true,
    attemptId,
    status: getOauthStatus(),
  });
}

async function handleXbrainAuthDisconnect(req, res) {
  const body = await readJsonBody(req);
  const provider = normalizeProviderKey(body.provider || "chatgpt");
  xbrainStore.base.providerAuth = xbrainStore.base.providerAuth || {};
  const current = xbrainStore.base.providerAuth[provider] || {};
  xbrainStore.base.providerAuth[provider] = {
    ...current,
    configured: false,
    masked: "(未设置)",
    plain: "",
    source: "manual_disconnect",
    error: "",
    type: providerAuthType(provider),
  };
  if (provider === "deepseek") {
    xbrainStore.base.deepseekApiKey = "";
  }
  saveXbrainStore();
  sendJson(res, 200, { ok: true, state: getXbrainStateSnapshot() });
}

async function handleXbrainProviderRemove(req, res) {
  const body = await readJsonBody(req);
  const provider = normalizeProviderKey(body.provider || "");
  const nextCatalog = sanitizeProviderCatalog((xbrainStore.base.providerCatalog || []).filter((p) => p !== provider));
  if (!nextCatalog.length) {
    sendJson(res, 400, { ok: false, error: "at least one provider is required" });
    return;
  }
  xbrainStore.base.providerCatalog = nextCatalog;
  xbrainStore.base.modelRegistry = uniqStrings((xbrainStore.base.modelRegistry || []).filter((ref) => {
    return inferProviderFromModelRef(ref).provider !== provider;
  }));
  xbrainStore.base.providerAuth = xbrainStore.base.providerAuth || {};
  delete xbrainStore.base.providerAuth[provider];
  if (provider === "deepseek") {
    xbrainStore.base.deepseekApiKey = "";
  }
  if (!nextCatalog.includes(normalizeProviderKey(xbrainStore.base.modelProvider))) {
    const fallback = nextCatalog[0];
    xbrainStore.base.modelProvider = fallback;
    xbrainStore.base.runtimeModelProvider = fallback;
    const fallbackRef = toModelRef(fallback, "");
    const inferred = inferProviderFromModelRef(fallbackRef);
    xbrainStore.base.modelId = inferred.modelId;
    xbrainStore.base.runtimeModelId = inferred.modelId;
  }
  saveXbrainStore();
  sendJson(res, 200, { ok: true, state: getXbrainStateSnapshot() });
}

async function handleXbrainLock(req, res) {
  const body = await readJsonBody(req);
  const section = String(body.section || "").trim();
  const action = String(body.action || "").trim();
  if (!["base", "channel", "exchange", "strategy"].includes(section)) {
    sendJson(res, 400, { ok: false, error: "invalid section" });
    return;
  }
  const lockInfo = xbrainStore.locks[section] || { locked: false, hasPassword: false, password: "" };
  const pass = String(body.password || "").trim();
  const currentPassword = String(body.currentPassword || body.password || "").trim();

  if (action === "set_password") {
    if (!pass) {
      sendJson(res, 400, { ok: false, error: "password is required" });
      return;
    }
    lockInfo.password = pass;
    lockInfo.hasPassword = true;
    lockInfo.locked = true;
  } else if (action === "unlock") {
    if (lockInfo.hasPassword && lockInfo.password && currentPassword !== lockInfo.password) {
      sendJson(res, 400, { ok: false, error: "password mismatch" });
      return;
    }
    lockInfo.locked = false;
  } else if (action === "lock") {
    lockInfo.locked = true;
  } else {
    sendJson(res, 400, { ok: false, error: "invalid action" });
    return;
  }

  xbrainStore.locks[section] = lockInfo;
  saveXbrainStore();
  sendJson(res, 200, { ok: true, state: getXbrainStateSnapshot() });
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
