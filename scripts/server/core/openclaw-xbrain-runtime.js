import { createChatIntentUtils } from "../domain/chat-intent.js";

const MODEL_CATALOG_CACHE_TTL_MS = 60_000;

export function createOpenClawXbrainRuntime(deps = {}) {
  const {
    normalizeProviderKey,
    providerSupportsOAuth,
    PROVIDER_TO_SETUP_PROVIDER,
    runOpenClawCommand,
    startGateway,
    parseJsonSafe,
    xbrainStore,
    saveXbrainStore,
    ensureProviderAuthEntry,
    isProviderConfigured,
    markProviderAuthSyncError,
    modelCatalogCache,
    sessionModelProbeCache,
    inferProviderFromModelRef,
    toModelRef,
    PROVIDER_DEFAULT_MODEL_REFS,
    uniqStrings,
    extractAgentReply,
    maskSecret,
    providerAuthType,
  } = deps;

  if (!xbrainStore || typeof xbrainStore !== "object") throw new Error("xbrainStore is required");
  if (!modelCatalogCache || typeof modelCatalogCache !== "object") throw new Error("modelCatalogCache is required");
  if (!sessionModelProbeCache || typeof sessionModelProbeCache !== "object") throw new Error("sessionModelProbeCache is required");
  const oauthState = deps.oauthState && typeof deps.oauthState === "object" ? deps.oauthState : {};
  const oauthIsRunning = typeof deps.oauthIsRunning === "function"
    ? deps.oauthIsRunning
    : () => Boolean(oauthState?.active);

function isSupportedProviderKey(providerLike) {
  const provider = normalizeProviderKey(providerLike || "");
  if (!provider) return false;
  if (Object.prototype.hasOwnProperty.call(PROVIDER_DEFAULT_MODEL_REFS, provider)) return true;
  if (Object.prototype.hasOwnProperty.call(PROVIDER_TO_SETUP_PROVIDER, provider)) return true;
  if (typeof providerSupportsOAuth === "function" && providerSupportsOAuth(provider)) return true;
  return false;
}

function isAllowedModelRefShape(modelRefLike) {
  const modelRef = String(modelRefLike || "").trim();
  if (!modelRef || !modelRef.includes("/")) return false;
  const inferred = inferProviderFromModelRef(modelRef);
  if (!isSupportedProviderKey(inferred.provider)) return false;
  const modelId = String(inferred.modelId || "").trim();
  if (!modelId) return false;
  if (modelId.length > 180) return false;
  return true;
}

function getKnownCatalogRefSetFromCache() {
  const refs = [];
  const allRows = Array.isArray(modelCatalogCache?.all) ? modelCatalogCache.all : [];
  const configuredRows = Array.isArray(modelCatalogCache?.configured) ? modelCatalogCache.configured : [];
  allRows.forEach((item) => {
    const key = String(item?.key || "").trim();
    if (key) refs.push(key);
  });
  configuredRows.forEach((item) => {
    const key = String(item?.key || "").trim();
    if (key) refs.push(key);
  });
  return new Set(uniqStrings(refs).map((item) => String(item || "").trim().toLowerCase()));
}

function sanitizeRegistryModelRefs(registryLike) {
  const rows = uniqStrings(Array.isArray(registryLike) ? registryLike : []);
  const knownSet = getKnownCatalogRefSetFromCache();
  const hasKnownSet = knownSet.size > 0;
  const out = rows.filter((itemLike) => {
    const item = String(itemLike || "").trim();
    if (!isAllowedModelRefShape(item)) return false;
    if (!hasKnownSet) return true;
    return knownSet.has(item.toLowerCase());
  });
  return uniqStrings(out);
}

function providerToAuthConfig(provider) {
  const map = {
    "openai-api-key": {
      authChoice: "openai-api-key",
      flag: "--openai-api-key",
      mode: "single-flag",
    },
    "anthropic-api-key": {
      authChoice: "apiKey",
      flag: "--anthropic-api-key",
      mode: "single-flag",
    },
    "openrouter-api-key": {
      authChoice: "openrouter-api-key",
      flag: "--openrouter-api-key",
      mode: "single-flag",
    },
    "gemini-api-key": {
      authChoice: "gemini-api-key",
      flag: "--gemini-api-key",
      mode: "single-flag",
    },
    "zai-api-key": {
      authChoice: "zai-api-key",
      flag: "--zai-api-key",
      mode: "single-flag",
    },
    "deepseek-api-key": {
      authChoice: "custom-api-key",
      mode: "custom-api-key",
      customBaseUrl: "https://api.deepseek.com/v1",
      customModelId: "deepseek-chat",
      customProviderId: "deepseek",
      customCompatibility: "openai",
    },
  };
  return map[provider] ?? null;
}

function buildOnboardArgs(params) {
  const { providerConfig, apiKey, gatewayPort, gatewayAuth } = params;
  const args = [
    "onboard",
    "--non-interactive",
    "--accept-risk",
    "--mode",
    "local",
    "--flow",
    "quickstart",
    "--skip-channels",
    "--skip-skills",
    "--skip-health",
    "--skip-ui",
    "--gateway-bind",
    "loopback",
    "--gateway-auth",
    gatewayAuth,
    "--gateway-port",
    String(gatewayPort),
    "--auth-choice",
    providerConfig.authChoice,
  ];
  if (providerConfig.mode === "custom-api-key") {
    args.push(
      "--custom-base-url",
      providerConfig.customBaseUrl,
      "--custom-model-id",
      providerConfig.customModelId,
      "--custom-provider-id",
      providerConfig.customProviderId,
      "--custom-compatibility",
      providerConfig.customCompatibility,
      "--custom-api-key",
      apiKey,
    );
  } else {
    args.push(providerConfig.flag, apiKey);
  }
  return args;
}

async function runSetupFromInput(input) {
  const provider = String(input.provider ?? "").trim();
  const apiKey = String(input.apiKey ?? "").trim();
  const gatewayPort = Number.parseInt(String(input.gatewayPort ?? "18789"), 10) || 18789;
  const gatewayAuth = String(input.gatewayAuth ?? "token").trim() === "password" ? "password" : "token";
  const providerConfig = providerToAuthConfig(provider);
  if (!providerConfig) {
    return {
      ok: false,
      statusCode: 400,
      error: "Unsupported provider",
    };
  }
  if (!apiKey) {
    return {
      ok: false,
      statusCode: 400,
      error: "API Key is required",
    };
  }
  const args = buildOnboardArgs({ providerConfig, apiKey, gatewayPort, gatewayAuth });
  const result = await runOpenClawCommand(args, { timeoutMs: 240_000 });
  return {
    ok: result.ok,
    statusCode: result.ok ? 200 : 500,
    provider,
    gatewayPort,
    gatewayAuth,
    command: ["openclaw", ...args.slice(0, -1), "***"].join(" "),
    exitCode: result.code,
    timedOut: result.timedOut,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function waitGatewayHealthy(params = {}) {
  const timeoutMs = Number.isFinite(params.timeoutMs) ? params.timeoutMs : 20_000;
  const pollMs = Number.isFinite(params.pollMs) ? params.pollMs : 1_200;
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    const healthRes = await runOpenClawCommand(["gateway", "health", "--json"], { timeoutMs: 5_000 });
    if (healthRes.ok) {
      return { ok: true, payload: parseJsonSafe(healthRes.stdout) };
    }
    lastError = (healthRes.stderr || healthRes.stdout || "").trim() || "gateway health check failed";
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return { ok: false, error: lastError || "gateway health check timeout" };
}

function sanitizeProviderCatalog(items) {
  const out = uniqStrings(items)
    .map((p) => normalizeProviderKey(p))
    .filter(Boolean);
  if (!out.length) {
    return ["deepseek", "chatgpt", "anthropic"];
  }
  return out;
}

function getAuthProviderEntry(modelsJson, provider) {
  const providers = Array.isArray(modelsJson?.auth?.providers) ? modelsJson.auth.providers : [];
  return providers.find((item) => normalizeProviderKey(item?.provider) === provider) ?? null;
}

function normalizeModelCatalogEntry(itemLike) {
  const item = itemLike && typeof itemLike === "object" ? itemLike : {};
  const key = String(item.key || item.model || "").trim();
  if (!key || !key.includes("/")) return null;
  const inferred = inferProviderFromModelRef(key);
  return {
    key,
    name: String(item.name || inferred.modelId || key),
    provider: inferred.provider,
    input: String(item.input || "text"),
    contextWindow: Number.isFinite(Number(item.contextWindow)) ? Number(item.contextWindow) : null,
    local: Boolean(item.local),
    available: item.available === true,
    missing: item.missing === true,
    tags: uniqStrings(item.tags || []),
  };
}

async function listOpenClawModelsCatalog(force = false) {
  const now = Date.now();
  const cacheValid = !force
    && Array.isArray(modelCatalogCache.all)
    && Array.isArray(modelCatalogCache.configured)
    && (now - modelCatalogCache.at) < MODEL_CATALOG_CACHE_TTL_MS;
  if (cacheValid) {
    return {
      ok: true,
      all: modelCatalogCache.all,
      configured: modelCatalogCache.configured,
      cached: true,
      updatedAt: modelCatalogCache.at,
    };
  }

  const allRes = await runOpenClawCommand(["models", "list", "--all", "--json"], { timeoutMs: 90_000 });
  if (!allRes.ok) {
    return { ok: false, error: (allRes.stderr || allRes.stdout || "").trim() || "models list --all failed" };
  }
  const allJson = parseJsonSafe(allRes.stdout);
  const allModels = Array.isArray(allJson?.models)
    ? allJson.models.map((item) => normalizeModelCatalogEntry(item)).filter(Boolean)
    : [];
  allModels.sort((a, b) => {
    const p = String(a.provider || "").localeCompare(String(b.provider || ""));
    if (p !== 0) return p;
    return String(a.key || "").localeCompare(String(b.key || ""));
  });

  const configuredRes = await runOpenClawCommand(["models", "list", "--json"], { timeoutMs: 25_000 });
  const configuredJson = parseJsonSafe(configuredRes.stdout);
  const configuredModels = Array.isArray(configuredJson?.models)
    ? configuredJson.models.map((item) => normalizeModelCatalogEntry(item)).filter(Boolean)
    : [];
  configuredModels.sort((a, b) => String(a.key || "").localeCompare(String(b.key || "")));

  modelCatalogCache.all = allModels;
  modelCatalogCache.configured = configuredModels;
  modelCatalogCache.at = now;
  return {
    ok: true,
    all: allModels,
    configured: configuredModels,
    cached: false,
    updatedAt: now,
  };
}

async function tuneDeepseekDefaults() {
  const tuneContext = await runOpenClawCommand(
    ["config", "set", "models.providers.deepseek.models[0].contextWindow", "128000", "--strict-json"],
    { timeoutMs: 30_000 },
  );
  const tuneMaxTokens = await runOpenClawCommand(
    ["config", "set", "models.providers.deepseek.models[0].maxTokens", "8192", "--strict-json"],
    { timeoutMs: 30_000 },
  );
  return {
    contextWindowOk: tuneContext.ok,
    maxTokensOk: tuneMaxTokens.ok,
    error: [
      tuneContext.ok ? "" : (tuneContext.stderr || tuneContext.stdout || "").trim(),
      tuneMaxTokens.ok ? "" : (tuneMaxTokens.stderr || tuneMaxTokens.stdout || "").trim(),
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

async function syncXbrainFromOpenClaw() {
  const modelsRes = await runOpenClawCommand(["models", "status", "--json"], {
    timeoutMs: 20_000,
  });
  if (!modelsRes.ok) {
    markProviderAuthSyncError((modelsRes.stderr || modelsRes.stdout || "").trim() || "models status failed");
    return {
      ok: false,
      error: (modelsRes.stderr || modelsRes.stdout || "").trim() || "models status failed",
    };
  }
  const modelsJson = parseJsonSafe(modelsRes.stdout);
  if (!modelsJson || typeof modelsJson !== "object") {
    markProviderAuthSyncError("invalid models status payload");
    return { ok: false, error: "invalid models status payload" };
  }

  const defaultModelRef = String(modelsJson.defaultModel || modelsJson.resolvedDefault || "").trim();
  if (defaultModelRef) {
    const inferred = inferProviderFromModelRef(defaultModelRef);
    xbrainStore.base.modelProvider = inferred.provider;
    xbrainStore.base.modelId = inferred.modelId;
    const hasRuntimeModelId = Boolean(String(xbrainStore.base.runtimeModelId || "").trim());
    if (!hasRuntimeModelId) {
      xbrainStore.base.runtimeModelProvider = inferred.provider;
      xbrainStore.base.runtimeModelId = inferred.modelId;
    }
  }
  if (!String(xbrainStore.base.runtimeModelProvider || "").trim()) {
    xbrainStore.base.runtimeModelProvider = xbrainStore.base.modelProvider || "deepseek";
  }
  if (!String(xbrainStore.base.runtimeModelId || "").trim()) {
    xbrainStore.base.runtimeModelId = String(xbrainStore.base.modelId || "deepseek-chat");
  }

  const registrySeed = Array.isArray(xbrainStore.base.modelRegistry)
    ? xbrainStore.base.modelRegistry
    : [];
  let sanitizedRegistry = sanitizeRegistryModelRefs(registrySeed);
  if (!sanitizedRegistry.length && defaultModelRef && isAllowedModelRefShape(defaultModelRef)) {
    sanitizedRegistry = [defaultModelRef];
  }
  // No longer force a default model — user configures via 虾脑
  xbrainStore.base.modelRegistry = sanitizedRegistry;

  const providerCatalog = new Set(
    sanitizeProviderCatalog(xbrainStore.base.providerCatalog).filter((provider) => isSupportedProviderKey(provider)),
  );
  for (const modelRef of xbrainStore.base.modelRegistry || []) {
    const provider = inferProviderFromModelRef(modelRef).provider;
    if (isSupportedProviderKey(provider)) {
      providerCatalog.add(provider);
    }
  }
  const currentProvider = normalizeProviderKey(xbrainStore.base.modelProvider);
  if (isSupportedProviderKey(currentProvider)) {
    providerCatalog.add(currentProvider);
  }
  xbrainStore.base.providerCatalog = sanitizeProviderCatalog(Array.from(providerCatalog));

  const baseAuth = xbrainStore.base.providerAuth && typeof xbrainStore.base.providerAuth === "object"
    ? xbrainStore.base.providerAuth
    : {};
  const deepseekEntry = getAuthProviderEntry(modelsJson, "deepseek");
  const openaiEntry = getAuthProviderEntry(modelsJson, "chatgpt");
  const anthropicEntry = getAuthProviderEntry(modelsJson, "anthropic");
  const oauthRunningProvider = oauthIsRunning() ? normalizeProviderKey(oauthState.provider) : "";
  const oauthLastProvider = normalizeProviderKey(oauthState?.last?.provider || "");
  const oauthLastError = String(oauthState?.last?.error || "").trim();
  const effectiveKind = (entryLike) => String(entryLike?.effective?.kind || "").trim();
  const effectiveDetail = (entryLike) => String(entryLike?.effective?.detail || "").trim();
  const hasEffectiveAuth = (entryLike) => Boolean(entryLike?.effective && String(entryLike.effective.kind || "") !== "none");

  const deepseekKey = String(xbrainStore.base.deepseekApiKey || "").trim();
  const deepseekDetail = effectiveDetail(deepseekEntry);
  const deepseekConfigured = Boolean(
    deepseekKey || deepseekDetail || hasEffectiveAuth(deepseekEntry),
  );
  const chatgptConfigured = hasEffectiveAuth(openaiEntry);
  const chatgptPending = oauthRunningProvider === "chatgpt";
  const anthropicConfigured = hasEffectiveAuth(anthropicEntry);
  const anthropicPending = oauthRunningProvider === "anthropic";
  const providerAuth = {
    ...(baseAuth || {}),
    deepseek: {
      configured: deepseekConfigured,
      masked: deepseekKey ? maskSecret(deepseekKey) : deepseekDetail || "(未设置)",
      plain: deepseekKey,
      source: String(effectiveKind(deepseekEntry) || (deepseekConfigured ? "xbrain" : "-")),
      error: "",
      type: "apiKey",
    },
    chatgpt: {
      configured: chatgptConfigured,
      masked: chatgptConfigured ? "oauth-connected" : (chatgptPending ? "等待授权" : "(未设置)"),
      plain: "",
      source: chatgptConfigured ? String(effectiveKind(openaiEntry) || "oauth") : (chatgptPending ? "oauth_pending" : "-"),
      error: !chatgptConfigured && !chatgptPending && oauthLastProvider === "chatgpt" ? oauthLastError : "",
      type: String(baseAuth?.chatgpt?.type || "oauth"),
    },
    anthropic: {
      configured: anthropicConfigured,
      masked: anthropicConfigured ? "oauth-connected" : (anthropicPending ? "等待授权" : "(未设置)"),
      plain: "",
      source: anthropicConfigured ? String(effectiveKind(anthropicEntry) || "oauth") : (anthropicPending ? "oauth_pending" : "-"),
      error: !anthropicConfigured && !anthropicPending && oauthLastProvider === "anthropic" ? oauthLastError : "",
      type: String(baseAuth?.anthropic?.type || "oauth"),
    },
  };
  for (const provider of xbrainStore.base.providerCatalog || []) {
    const key = normalizeProviderKey(provider);
    if (!providerAuth[key]) {
      const entry = getAuthProviderEntry(modelsJson, key);
      const configured = hasEffectiveAuth(entry);
      const pending = oauthRunningProvider === key;
      const detail = effectiveDetail(entry);
      providerAuth[key] = {
        configured,
        masked: configured ? (detail || "configured") : (pending ? "等待授权" : "(未设置)"),
        plain: "",
        source: configured ? String(effectiveKind(entry) || "openclaw") : (pending ? "oauth_pending" : "-"),
        error: !configured && !pending && oauthLastProvider === key ? oauthLastError : "",
        type: providerAuthType(key),
      };
    }
    providerAuth[key] = {
      configured: Boolean(providerAuth[key].configured),
      masked: String(providerAuth[key].masked || "(未设置)"),
      plain: String(providerAuth[key].plain || ""),
      source: String(providerAuth[key].source || "-"),
      error: String(providerAuth[key].error || ""),
      type: String(providerAuth[key].type || providerAuthType(key)),
    };
  }
  xbrainStore.base.providerAuth = providerAuth;
  const runtimeSanitize = sanitizeRuntimeModelRefInStore({ save: false, syncConfiguredModel: false });
  xbrainStore.base.telegramRelayEnabled = Boolean(xbrainStore.base.telegramRelayEnabled);
  xbrainStore.base.chatChannel = String(xbrainStore.base.chatChannel || "dashboard");
  saveXbrainStore();
  return { ok: true, modelsJson, runtimeSanitize };
}

function getLocksSnapshot() {
  const out = {};
  for (const section of ["base", "channel", "exchange", "strategy"]) {
    const lockInfo = xbrainStore?.locks?.[section] || {};
    out[section] = {
      locked: Boolean(lockInfo.locked),
      hasPassword: Boolean(lockInfo.hasPassword),
    };
  }
  return out;
}

function getXbrainStateSnapshot() {
  const base = xbrainStore.base || {};
  const exchange = xbrainStore.exchange || {};
  const strategy = xbrainStore.strategy || {};
  const locks = getLocksSnapshot();
  const providerCatalog = sanitizeProviderCatalog(base.providerCatalog);
  const providerAuthRaw = base.providerAuth && typeof base.providerAuth === "object" ? base.providerAuth : {};
  const providerAuth = {};
  for (const [providerLike, metaLike] of Object.entries(providerAuthRaw)) {
    const providerKey = normalizeProviderKey(providerLike);
    const meta = metaLike && typeof metaLike === "object" ? metaLike : {};
    providerAuth[providerKey] = {
      configured: Boolean(meta.configured),
      masked: String(meta.masked || "(未设置)"),
      plain: String(meta.plain || ""),
      source: String(meta.source || "-"),
      error: String(meta.error || ""),
      type: String(meta.type || providerAuthType(providerKey)),
    };
  }
  const modelProvider = normalizeProviderKey(base.modelProvider || "deepseek");
  const modelId = String(base.modelId || "deepseek-chat");
  const runtimeProvider = normalizeProviderKey(base.runtimeModelProvider || modelProvider);
  const runtimeModelId = String(base.runtimeModelId || modelId);
  const modelRegistrySeed = Array.isArray(base.modelRegistry) && base.modelRegistry.length
    ? base.modelRegistry
    : [toModelRef(modelProvider, modelId)];
  const modelRegistry = getRegisteredModelRefs(modelRegistrySeed);
  if (!modelRegistry.length) {
    modelRegistry.push(toModelRef(modelProvider, modelId));
  }
  const rawRuntimeModelRef = toModelRef(runtimeProvider, runtimeModelId);
  const runtimeModelRef = isModelRefRegistered(rawRuntimeModelRef, modelRegistry)
    ? rawRuntimeModelRef
    : (pickConfiguredRegistryModelRef(modelRegistry) || rawRuntimeModelRef);
  const runtimeResolved = inferProviderFromModelRef(runtimeModelRef);
  const telegramToken = String(base.telegramTokenValue || "").trim();
  const telegramConfigured = Boolean(telegramToken);
  if (!providerAuth.deepseek) {
    providerAuth.deepseek = {
      configured: Boolean(base.deepseekApiKey),
      masked: maskSecret(base.deepseekApiKey),
      plain: String(base.deepseekApiKey || ""),
      source: base.deepseekApiKey ? "xbrain" : "-",
      error: "",
      type: "apiKey",
    };
  }
  if (!providerAuth.chatgpt) {
    providerAuth.chatgpt = {
      configured: false,
      masked: "(未设置)",
      plain: "",
      source: "-",
      error: "",
      type: "oauth",
    };
  }
  if (!providerAuth.anthropic) {
    providerAuth.anthropic = {
      configured: false,
      masked: "(未设置)",
      plain: "",
      source: "-",
      error: "",
      type: "oauth",
    };
  }
  providerAuth.deepseek.masked = String(providerAuth.deepseek.masked || maskSecret(base.deepseekApiKey));
  providerAuth.deepseek.plain = String(providerAuth.deepseek.plain || base.deepseekApiKey || "");

  return {
    base: {
      modelProvider,
      modelId,
      modelRef: toModelRef(modelProvider, modelId),
      configuredModelRef: toModelRef(modelProvider, modelId),
      runtimeModelProvider: runtimeResolved.provider,
      runtimeModelId: runtimeResolved.modelId,
      runtimeModelRef,
      providerCatalog,
      modelRegistry,
      providerAuth,
      modelAuthConfigured: Boolean(providerAuth?.[modelProvider]?.configured),
      modelAuthMasked: String(providerAuth?.[modelProvider]?.masked || "(未设置)"),
      modelAuthSource: String(providerAuth?.[modelProvider]?.source || "-"),
      modelAuthError: String(providerAuth?.[modelProvider]?.error || ""),
      telegramTokenValue: telegramToken,
      telegramTokenMasked: maskSecret(telegramToken),
      telegramConfigured,
      telegramRelayEnabled: Boolean(base.telegramRelayEnabled),
      chatChannel: String(base.chatChannel || "dashboard"),
    },
    exchange: {
      apiKeyMasked: maskSecret(exchange.apiKeyValue),
      apiSecretMasked: maskSecret(exchange.apiSecretValue),
      passphraseMasked: maskSecret(exchange.passphraseValue),
    },
    strategy: {
      profileName: String(strategy.profileName || "default"),
      activeStrategy: String(strategy.activeStrategy || strategy.profileName || "default"),
      symbol: String(strategy.symbol || "BTC/USDT:USDT"),
      leverage: Number.isFinite(Number(strategy.leverage)) ? Number(strategy.leverage) : 10,
      sizeMode: String(strategy.sizeMode || "risk"),
      orderSize: Number.isFinite(Number(strategy.orderSize)) ? Number(strategy.orderSize) : 8,
      riskPct: Number.isFinite(Number(strategy.riskPct)) ? Number(strategy.riskPct) : 0.015,
      minNotional: Number.isFinite(Number(strategy.minNotional)) ? Number(strategy.minNotional) : 5,
      maxNotional: Number.isFinite(Number(strategy.maxNotional)) ? Number(strategy.maxNotional) : 80,
      runtimeMode: String(strategy.runtimeMode || "dryrun") === "live" ? "live" : "dryrun",
    },
    locks,
  };
}

async function buildXbrainState(forceRefresh = false) {
  if (forceRefresh) {
    await syncXbrainFromOpenClaw().catch(() => null);
    const now = Date.now();
    const probeIntervalMs = 8_000;
    const shouldProbeSession = (now - Number(sessionModelProbeCache.at || 0)) > probeIntervalMs;
    if (shouldProbeSession) {
      const refreshed = await refreshRuntimeModelFromSession({
        sessionId: "thunderclaw-main",
        syncDefault: false,
      }).catch((error) => ({
        ok: false,
        changed: false,
        modelRef: "",
        probe: { error: String(error?.message || error || "session probe failed") },
      }));
      sessionModelProbeCache.at = now;
      sessionModelProbeCache.modelRef = String(refreshed?.modelRef || "");
      sessionModelProbeCache.error = String(refreshed?.probe?.error || "");
      if (refreshed?.changed) {
        await syncXbrainFromOpenClaw().catch(() => null);
      }
    }
  }
  return getXbrainStateSnapshot();
}

function getRegisteredModelRefs(registryLike = null) {
  const source = Array.isArray(registryLike)
    ? registryLike
    : (xbrainStore?.base?.modelRegistry || []);
  const sanitized = sanitizeRegistryModelRefs(source);
  if (sanitized.length) return sanitized;
  return uniqStrings(source)
    .map((item) => String(item || "").trim())
    .filter((item) => Boolean(item && item.includes("/") && isAllowedModelRefShape(item)));
}

function isModelRefRegistered(modelRefRaw, registryLike = null) {
  const modelRef = String(modelRefRaw || "").trim();
  if (!modelRef || !modelRef.includes("/")) return false;
  const registry = getRegisteredModelRefs(registryLike);
  const key = modelRef.toLowerCase();
  return registry.some((item) => String(item || "").trim().toLowerCase() === key);
}

function pickConfiguredRegistryModelRef(registryLike = null) {
  const registry = getRegisteredModelRefs(registryLike);
  if (!registry.length) return "";
  const providerAuth = xbrainStore?.base?.providerAuth && typeof xbrainStore.base.providerAuth === "object"
    ? xbrainStore.base.providerAuth
    : {};
  const configuredHit = registry.find((ref) => {
    const provider = inferProviderFromModelRef(ref).provider;
    const auth = providerAuth?.[provider];
    return !auth || auth.configured !== false;
  });
  return String(configuredHit || registry[0] || "");
}

function sanitizeRuntimeModelRefInStore(options = {}) {
  const runtimeProvider = normalizeProviderKey(
    xbrainStore?.base?.runtimeModelProvider
      || xbrainStore?.base?.modelProvider
      || "deepseek",
  );
  const runtimeModelId = String(
    xbrainStore?.base?.runtimeModelId
      || xbrainStore?.base?.modelId
      || "",
  ).trim();
  const currentRuntimeRef = toModelRef(runtimeProvider, runtimeModelId);
  const registry = getRegisteredModelRefs();
  if (!registry.length || isModelRefRegistered(currentRuntimeRef, registry)) {
    return { changed: false, modelRef: currentRuntimeRef, fallbackApplied: false };
  }
  const fallbackRef = pickConfiguredRegistryModelRef(registry);
  if (!fallbackRef) {
    return { changed: false, modelRef: currentRuntimeRef, fallbackApplied: false };
  }
  const inferred = inferProviderFromModelRef(fallbackRef);
  xbrainStore.base.runtimeModelProvider = inferred.provider;
  xbrainStore.base.runtimeModelId = inferred.modelId;
  if (options.syncConfiguredModel === true) {
    xbrainStore.base.modelProvider = inferred.provider;
    xbrainStore.base.modelId = inferred.modelId;
  }
  if (options.save === true) {
    saveXbrainStore();
  }
  return { changed: true, modelRef: fallbackRef, fallbackApplied: true };
}

function getCurrentRuntimeModelRefFromStore() {
  const runtimeProvider = normalizeProviderKey(
    xbrainStore?.base?.runtimeModelProvider
      || xbrainStore?.base?.modelProvider
      || "deepseek",
  );
  const runtimeModelId = String(
    xbrainStore?.base?.runtimeModelId
      || xbrainStore?.base?.modelId
      || "",
  ).trim();
  const runtimeRef = toModelRef(runtimeProvider, runtimeModelId);
  const registry = getRegisteredModelRefs();
  if (!registry.length || isModelRefRegistered(runtimeRef, registry)) {
    return runtimeRef;
  }
  return pickConfiguredRegistryModelRef(registry) || runtimeRef;
}

function normalizeSessionId(sessionIdLike) {
  const normalizeSessionPart = (valueLike, fallback) => {
    const raw = String(valueLike ?? "").trim().toLowerCase();
    const normalized = raw
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 72);
    return normalized || fallback;
  };
  return normalizeSessionPart(sessionIdLike ?? "thunderclaw-main", "thunderclaw-main");
}

function looksLikeGatewayTransportError(textLike) {
  const text = String(textLike || "").toLowerCase();
  if (!text) return false;
  return /gateway closed|abnormal closure|1006|websocket|ecconnrefused|pairing required|gateway agent failed/.test(text);
}

async function setOpenClawDefaultModel(modelRefRaw, timeoutMs = 40_000) {
  const modelRef = String(modelRefRaw || "").trim();
  if (!modelRef) {
    return {
      ok: false,
      modelRef: "",
      error: "modelRef is required",
      result: { ok: false, stdout: "", stderr: "modelRef is required" },
    };
  }
  let setRes = await runOpenClawCommand(["models", "set", modelRef], { timeoutMs });
  if (!setRes.ok) {
    const setErrText = [setRes.stderr, setRes.stdout].filter(Boolean).join("\n");
    if (looksLikeGatewayTransportError(setErrText)) {
      startGateway();
      await waitGatewayHealthy({ timeoutMs: 15_000, pollMs: 1_000 }).catch(() => null);
      setRes = await runOpenClawCommand(["models", "set", modelRef], { timeoutMs });
    }
  }
  return {
    ok: Boolean(setRes.ok),
    modelRef,
    error: setRes.ok ? null : ((setRes.stderr || setRes.stdout || "").trim() || "models set failed"),
    result: setRes,
  };
}

function applyRuntimeModelRefToStore(modelRefRaw, options = {}) {
  const modelRef = String(modelRefRaw || "").trim();
  if (!modelRef || !modelRef.includes("/")) return false;
  if (options.requireRegistry === true && !isModelRefRegistered(modelRef)) {
    return false;
  }
  const inferred = inferProviderFromModelRef(modelRef);
  xbrainStore.base.modelProvider = inferred.provider;
  xbrainStore.base.modelId = inferred.modelId;
  xbrainStore.base.runtimeModelProvider = inferred.provider;
  xbrainStore.base.runtimeModelId = inferred.modelId;
  if (options.ensureRegistry === true) {
    xbrainStore.base.modelRegistry = uniqStrings([...(xbrainStore.base.modelRegistry || []), modelRef]);
  }
  if (options.save !== false) {
    saveXbrainStore();
  }
  return true;
}

function extractModelRefsFromText(textLike) {
  const text = String(textLike || "");
  if (!text) return [];
  const refs = [];
  const re = /\b([a-z0-9][a-z0-9-]*(?:\/[a-z0-9._-]+)+)\b/ig;
  let m = null;
  while ((m = re.exec(text)) !== null) {
    refs.push(String(m[1] || "").trim());
    if (refs.length >= 120) break;
  }
  return uniqStrings(refs);
}

function pickCurrentModelRefFromText(textLike, fallbackRefRaw = "") {
  const text = String(textLike || "").trim();
  if (!text) return "";
  const fallbackRef = String(fallbackRefRaw || "").trim();
  const strongPatterns = [
    /(?:当前(?:运行)?模型|current(?:\s+running)?\s+model|active\s+model|selected\s+model|using(?:\s+the)?\s+model|session\s+model|默认模型|default\s+model|模型已切换|switched\s+to|session status)[^\n]{0,180}?([a-z0-9][a-z0-9-]*(?:\/[a-z0-9._-]+)+)/i,
    /\/model\s+([a-z0-9][a-z0-9-]*(?:\/[a-z0-9._-]+)+)/i,
  ];
  for (const pattern of strongPatterns) {
    const m = text.match(pattern);
    if (!m?.[1]) continue;
    const candidate = resolveModelRefFromToken(String(m[1] || "").trim());
    if (candidate) return candidate;
  }

  const lines = text.split(/\r?\n/).slice(0, 200);
  for (const lineRaw of lines) {
    const line = String(lineRaw || "").trim();
    if (!line) continue;
    if (!/(current|active|selected|using|session|default|当前|运行|已切换|切换|模型)/i.test(line)) continue;
    const refs = uniqStrings(
      extractModelRefsFromText(line)
        .map((ref) => resolveModelRefFromToken(ref))
        .filter(Boolean),
    );
    if (refs.length === 1) return refs[0];
    if (refs.length > 1 && fallbackRef && refs.includes(fallbackRef)) return fallbackRef;
  }

  const refs = uniqStrings(
    extractModelRefsFromText(text)
      .map((ref) => resolveModelRefFromToken(ref))
      .filter(Boolean),
  );
  if (!refs.length) return "";
  if (refs.length === 1) return refs[0];
  if (fallbackRef && refs.includes(fallbackRef)) return fallbackRef;
  return "";
}

function detectModelRefChangeFromAgentOutput(params = {}) {
  const message = String(params?.message || "").trim();
  const reply = String(params?.reply || "").trim();
  const stdout = String(params?.stdout || "").trim();
  const stderr = String(params?.stderr || "").trim();
  const payload = params?.payload && typeof params.payload === "object" ? params.payload : null;
  const currentModelRef = String(params?.currentModelRef || "").trim();
  const registry = uniqStrings(params?.registry || xbrainStore?.base?.modelRegistry || []);
  const registrySet = new Set(registry.map((ref) => String(ref || "").trim().toLowerCase()).filter(Boolean));
  const slashModelRef = parseSlashModelSwitchRef(message);
  if (
    slashModelRef
    && slashModelRef !== currentModelRef
    && registrySet.has(String(slashModelRef).toLowerCase())
  ) {
    return slashModelRef;
  }
  const textParts = [reply, stdout, stderr];
  if (payload) {
    try {
      textParts.push(JSON.stringify(payload));
    } catch {}
  }
  const text = textParts.filter(Boolean).join("\n");
  if (!text) return "";
  const strongCandidate = pickCurrentModelRefFromText(text, currentModelRef);
  if (
    strongCandidate
    && strongCandidate !== currentModelRef
    && registrySet.has(String(strongCandidate).toLowerCase())
  ) {
    return strongCandidate;
  }

  const hasChangeHint = /(?:当前(?:运行)?模型|current(?:\s+running)?\s+model|session status|\/model|模型已切换|切换模型|switched\s+to|switch\s+model|set\s+model)/i.test(text);
  if (!hasChangeHint) return "";

  const candidates = extractModelRefsFromText(text)
    .map((ref) => resolveModelRefFromToken(ref))
    .filter(Boolean);
  if (!candidates.length) return "";

  const currentLower = currentModelRef.toLowerCase();
  const registryHits = uniqStrings(
    candidates.filter((ref) => registrySet.has(String(ref).toLowerCase())),
  ).filter((ref) => String(ref).toLowerCase() !== currentLower);
  if (registryHits.length === 1) {
    return registryHits[0];
  }
  return "";
}

async function probeThunderSessionModelRef(params = {}) {
  const sessionId = normalizeSessionId(String(params?.sessionId || "thunderclaw-main").trim() || "thunderclaw-main");
  const fallbackRef = String(params?.fallbackRef || getCurrentRuntimeModelRefFromStore()).trim();
  const args = [
    "agent",
    "--session-id",
    sessionId,
    "--message",
    "/model",
    "--json",
  ];
  let result = await runOpenClawCommand(args, { timeoutMs: 120_000 });
  if (!result.ok) {
    const errText = [result.stderr, result.stdout].filter(Boolean).join("\n");
    if (looksLikeGatewayTransportError(errText)) {
      startGateway();
      await waitGatewayHealthy({ timeoutMs: 15_000, pollMs: 1_000 }).catch(() => null);
      result = await runOpenClawCommand(args, { timeoutMs: 120_000 });
    }
  }
  const payload = parseJsonSafe(result.stdout);
  const reply = extractAgentReply(payload);
  const text = [reply, result.stdout, result.stderr].filter(Boolean).join("\n");
  const modelRef = pickCurrentModelRefFromText(text, fallbackRef);
  return {
    ok: Boolean(result.ok),
    sessionId,
    modelRef: String(modelRef || "").trim(),
    reply: String(reply || "").trim(),
    error: result.ok ? null : ((result.stderr || result.stdout || "").trim() || "session model probe failed"),
  };
}

async function refreshRuntimeModelFromSession(params = {}) {
  const sessionId = normalizeSessionId(String(params?.sessionId || "thunderclaw-main").trim() || "thunderclaw-main");
  const syncDefault = params?.syncDefault !== false;
  const fallbackRef = String(params?.fallbackRef || getCurrentRuntimeModelRefFromStore()).trim();
  const probe = await probeThunderSessionModelRef({ sessionId, fallbackRef });
  const rawModelRef = String(probe?.modelRef || "").trim();
  const registry = getRegisteredModelRefs();
  const modelRef = isModelRefRegistered(rawModelRef, registry) ? rawModelRef : "";
  const changed = Boolean(modelRef && modelRef !== fallbackRef);
  const defaultSync = {
    attempted: false,
    ok: null,
    error: null,
  };
  let applied = false;
  if (changed) {
    applied = applyRuntimeModelRefToStore(modelRef, {
      save: false,
      ensureRegistry: false,
      requireRegistry: true,
    });
    if (syncDefault) {
      const setRes = await setOpenClawDefaultModel(modelRef, 40_000);
      defaultSync.attempted = true;
      defaultSync.ok = Boolean(setRes.ok);
      defaultSync.error = setRes.ok ? null : setRes.error;
    }
    if (applied) {
      saveXbrainStore();
    }
  }
  return {
    ok: probe.ok,
    sessionId,
    changed,
    applied,
    modelRef,
    ignoredModelRef: rawModelRef && !modelRef ? rawModelRef : "",
    fallbackRef,
    defaultSync,
    probe,
  };
}

async function switchThunderSessionModel(params = {}) {
  const modelRefRaw = String(params?.modelRef || "").trim();
  const modelRef = resolveModelRefFromToken(modelRefRaw) || modelRefRaw;
  const sessionId = normalizeSessionId(String(params?.sessionId || "thunderclaw-main").trim() || "thunderclaw-main");
  if (!modelRef) {
    return {
      ok: false,
      modelRef: "",
      sessionId,
      sessionSync: { ok: false, error: "modelRef is required", reply: "" },
      defaultSync: { attempted: false, ok: null, error: null },
      state: getXbrainStateSnapshot(),
      runtimeModelRef: getCurrentRuntimeModelRefFromStore(),
    };
  }
  const args = [
    "agent",
    "--session-id",
    sessionId,
    "--message",
    `/model ${modelRef}`,
    "--json",
  ];
  let result = await runOpenClawCommand(args, { timeoutMs: 180_000 });
  if (!result.ok) {
    const errText = [result.stderr, result.stdout].filter(Boolean).join("\n");
    if (looksLikeGatewayTransportError(errText)) {
      startGateway();
      await waitGatewayHealthy({ timeoutMs: 15_000, pollMs: 1_000 }).catch(() => null);
      result = await runOpenClawCommand(args, { timeoutMs: 180_000 });
    }
  }
  const payload = parseJsonSafe(result.stdout);
  const reply = extractAgentReply(payload);
  const sessionSync = {
    ok: Boolean(result.ok),
    error: result.ok ? null : ((result.stderr || result.stdout || "").trim() || "session /model failed"),
    reply: String(reply || "").trim(),
  };
  const defaultSync = {
    attempted: false,
    ok: null,
    error: null,
  };
  if (sessionSync.ok) {
    const setRes = await setOpenClawDefaultModel(modelRef, 40_000);
    defaultSync.attempted = true;
    defaultSync.ok = Boolean(setRes.ok);
    defaultSync.error = setRes.ok ? null : setRes.error;
    applyRuntimeModelRefToStore(modelRef, { save: true, ensureRegistry: true });
  }
  await syncXbrainFromOpenClaw().catch(() => null);
  const state = getXbrainStateSnapshot();
  const runtimeModelRef = toModelRef(
    state?.base?.runtimeModelProvider,
    state?.base?.runtimeModelId,
  );
  return {
    ok: sessionSync.ok,
    modelRef,
    sessionId,
    sessionSync,
    defaultSync,
    state,
    runtimeModelRef,
  };
}

const {
  resolveModelRefFromToken,
  parseSlashModelSwitchRef,
} = createChatIntentUtils({
  normalizeProviderKey,
  uniqStrings,
  inferProviderFromModelRef,
  PROVIDER_DEFAULT_MODEL_REFS,
  getModelRegistry: () => uniqStrings(xbrainStore?.base?.modelRegistry || []),
});


  return {
    providerToAuthConfig,
    buildOnboardArgs,
    runSetupFromInput,
    waitGatewayHealthy,
    sanitizeProviderCatalog,
    getAuthProviderEntry,
    normalizeModelCatalogEntry,
    listOpenClawModelsCatalog,
    tuneDeepseekDefaults,
    syncXbrainFromOpenClaw,
    getLocksSnapshot,
    getXbrainStateSnapshot,
    buildXbrainState,
    getCurrentRuntimeModelRefFromStore,
    normalizeSessionId,
    looksLikeGatewayTransportError,
    setOpenClawDefaultModel,
    applyRuntimeModelRefToStore,
    extractModelRefsFromText,
    pickCurrentModelRefFromText,
    detectModelRefChangeFromAgentOutput,
    probeThunderSessionModelRef,
    refreshRuntimeModelFromSession,
    switchThunderSessionModel,
    resolveModelRefFromToken,
    parseSlashModelSwitchRef,
  };
}
