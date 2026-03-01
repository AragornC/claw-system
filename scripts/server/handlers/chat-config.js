export function createChatConfigHandlers(deps = {}) {
  const {
    normalizeProviderKey,
    uniqStrings,
    inferProviderFromModelRef,
    PROVIDER_DEFAULT_MODEL_REFS,
    readJsonBody,
    runSetupFromInput,
    sendJson,
    runOpenClawCommand,
    switchThunderSessionModel,
    waitGatewayHealthy,
    startGateway,
    startOAuthLogin,
    getOauthStatus,
    getXbrainStateSnapshot,
    runAgentTurn,
    appendChatEvent,
    syncXbrainFromOpenClaw,
    getCurrentRuntimeModelRefFromStore,
    refreshRuntimeModelFromSession,
    extractModelSwitchIntent,
    saveXbrainStore,
    toModelRef,
    maskSecret,
    parseJsonSafe,
    extractTradingIntentCandidates,
    updateChatCardStatus,
  } = deps;

  const xbrainStore = deps.xbrainStore;
  const chatHistory = deps.chatHistory;
  const gatewayState = deps.gatewayState;

  if (!xbrainStore || typeof xbrainStore !== 'object') throw new Error('xbrainStore is required');
  if (!chatHistory || typeof chatHistory !== 'object') throw new Error('chatHistory is required');
  if (!gatewayState || typeof gatewayState !== 'object') throw new Error('gatewayState is required');

function pickRegisteredModelRefByProvider(providerLike) {
  const provider = normalizeProviderKey(providerLike || "");
  const registry = uniqStrings(xbrainStore?.base?.modelRegistry || []);
  const picked = registry.find((ref) => inferProviderFromModelRef(ref).provider === provider);
  return String(picked || PROVIDER_DEFAULT_MODEL_REFS[provider] || "").trim();
}

function parseSlashCommandMessage(messageRaw) {
  const message = String(messageRaw || "").trim();
  if (!message.startsWith("/")) return { command: "", args: "", message };
  const spaceIdx = message.indexOf(" ");
  if (spaceIdx < 0) {
    return { command: message.toLowerCase(), args: "", message };
  }
  return {
    command: message.slice(0, spaceIdx).toLowerCase(),
    args: message.slice(spaceIdx + 1).trim(),
    message,
  };
}

function findTokenStartingWith(partsLike, prefixLike) {
  const parts = Array.isArray(partsLike) ? partsLike : [];
  const prefix = String(prefixLike || "").toLowerCase();
  for (const partRaw of parts) {
    const part = String(partRaw || "").trim();
    if (!part) continue;
    if (part.toLowerCase().startsWith(prefix)) return part;
  }
  return "";
}

function isDigitsOnly(valueRaw) {
  const value = String(valueRaw || "").trim();
  if (!value) return false;
  for (const ch of value) {
    if (ch < "0" || ch > "9") return false;
  }
  return true;
}

function resolveModelRefFromToken(tokenRaw) {
  const token = String(tokenRaw || "").trim();
  if (!token) return "";
  const normalized = token.toLowerCase();
  if (token.includes("/")) return token;

  if (normalized === "deepseek") return pickRegisteredModelRefByProvider("deepseek");
  if (normalized === "chatgpt" || normalized === "openai" || normalized === "codex" || normalized === "gpt") {
    return pickRegisteredModelRefByProvider("chatgpt");
  }
  if (normalized === "anthropic" || normalized === "claude") return pickRegisteredModelRefByProvider("anthropic");
  if (normalized === "openrouter") return pickRegisteredModelRefByProvider("openrouter");
  if (normalized === "gemini" || normalized === "google") return pickRegisteredModelRefByProvider("gemini");
  if (normalized === "zai" || normalized === "glm") return pickRegisteredModelRefByProvider("zai");

  const registry = uniqStrings(xbrainStore?.base?.modelRegistry || []);
  for (const refRaw of registry) {
    const ref = String(refRaw || "").trim();
    if (!ref) continue;
    const lower = ref.toLowerCase();
    const modelPart = lower.includes("/") ? lower.split("/").slice(1).join("/") : lower;
    if (normalized === lower || normalized === modelPart) return ref;
  }
  return "";
}

function parseSlashModelSwitchRef(messageRaw) {
  const { command, args } = parseSlashCommandMessage(messageRaw);
  if (command !== "/model" && command !== "/models") return "";
  const firstArg = String(args || "").split(/\s+/, 1)[0] || "";
  const target = String(firstArg || "").trim();
  if (!target) return "";
  const lower = target.toLowerCase();
  if (lower === "list" || lower === "status" || isDigitsOnly(target)) return "";
  return resolveModelRefFromToken(target);
}

function parseConfigIntent(messageRaw) {
  const message = String(messageRaw || "").trim();
  if (!message) return null;
  const { command, args } = parseSlashCommandMessage(message);
  if (!command) return null;

  if (command === "/model" || command === "/models") {
    const modelRef = parseSlashModelSwitchRef(message);
    if (!modelRef) return null;
    return { type: "switch_model", modelRef, from: "slash_command" };
  }

  if (command === "/deepseek") {
    const token = findTokenStartingWith(String(args || "").split(/\s+/), "sk-");
    if (!token) return { type: "deepseek_help" };
    return { type: "deepseek_key", key: token };
  }

  if (command === "/telegram") {
    const token = String(args || "").trim();
    if (!token) return { type: "telegram_help" };
    return { type: "telegram_token", token };
  }

  if (command === "/oauth" || command === "/openai" || command === "/chatgpt" || command === "/codex-login") {
    const providerText = String(args || "").trim().toLowerCase();
    if (providerText.includes("anthropic") || providerText.includes("claude")) {
      return { type: "oauth", provider: "anthropic" };
    }
    return { type: "oauth", provider: "chatgpt" };
  }

  if (command === "/anthropic" || command === "/claude-login") {
    return { type: "oauth", provider: "anthropic" };
  }

  if (command === "/xbrain" || command === "/xbrain-open" || command === "/onboard") {
    return { type: "open_xbrain" };
  }
  return null;
}

function looksLikeSessionModelMismatch(errorTextLike) {
  const text = String(errorTextLike || "").trim().toLowerCase();
  if (!text) return false;
  if (text.includes("unknown model")) return true;
  if (text.includes("invalid model")) return true;
  if (text.includes("unsupported model")) return true;
  if (text.includes("unknown sessionid")) return true;
  if (text.includes("session status")) return true;
  return false;
}

async function handleSetup(req, res) {
  const body = await readJsonBody(req);
  const outcome = await runSetupFromInput(body);
  sendJson(res, outcome.statusCode, outcome);
}

async function handleQuickSetup(req, res) {
  const body = await readJsonBody(req);
  const provider = String(body.provider ?? "deepseek-api-key").trim() || "deepseek-api-key";
  const setup = await runSetupFromInput({
    provider,
    apiKey: body.apiKey,
    gatewayPort: 18789,
    gatewayAuth: "token",
  });
  if (!setup.ok) {
    sendJson(res, setup.statusCode, {
      ok: false,
      stage: "setup",
      provider,
      error: setup.error ?? "setup failed",
      command: setup.command,
      stdout: setup.stdout,
      stderr: setup.stderr,
    });
    return;
  }

  let modelSetResult = null;
  let deepseekTune = null;
  if (provider === "deepseek-api-key") {
    const tuneContext = await runOpenClawCommand(
      [
        "config",
        "set",
        "models.providers.deepseek.models[0].contextWindow",
        "128000",
        "--strict-json",
      ],
      { timeoutMs: 30_000 },
    );
    const tuneMaxTokens = await runOpenClawCommand(
      [
        "config",
        "set",
        "models.providers.deepseek.models[0].maxTokens",
        "8192",
        "--strict-json",
      ],
      { timeoutMs: 30_000 },
    );
    deepseekTune = {
      contextWindowOk: tuneContext.ok,
      maxTokensOk: tuneMaxTokens.ok,
      error: [
        tuneContext.ok ? "" : (tuneContext.stderr || tuneContext.stdout || "").trim(),
        tuneMaxTokens.ok ? "" : (tuneMaxTokens.stderr || tuneMaxTokens.stdout || "").trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    };
    modelSetResult = await switchThunderSessionModel({
      modelRef: "deepseek/deepseek-chat",
      sessionId: "thunderclaw-main",
    });
  }

  const healthBeforeStart = await waitGatewayHealthy({ timeoutMs: 5_000, pollMs: 800 });
  const gatewayStart = healthBeforeStart.ok
    ? {
        started: false,
        message: "Gateway already healthy",
        pid: gatewayState.pid ?? null,
      }
    : startGateway();
  const gatewayHealth = healthBeforeStart.ok
    ? healthBeforeStart
    : await waitGatewayHealthy({ timeoutMs: 25_000, pollMs: 1_500 });
  const gatewayWarning = !gatewayHealth.ok;

  sendJson(res, 200, {
    ok: true,
    stage: gatewayWarning ? "ready_with_gateway_warning" : "ready",
    provider,
    configured: true,
    gateway: {
      started: gatewayStart.started,
      message: gatewayStart.message,
      pid: gatewayStart.pid ?? null,
      healthy: gatewayHealth.ok,
      error: gatewayHealth.ok ? null : gatewayHealth.error,
      warning: gatewayWarning
        ? "Gateway 未就绪（不影响基础登录与页面对话，可稍后在状态页排查）。"
        : null,
    },
    model: modelSetResult
      ? {
          attempted: true,
          ok: modelSetResult.ok,
          stderr: modelSetResult.ok ? null : String(modelSetResult?.sessionSync?.error || "session /model failed"),
          warning: modelSetResult?.defaultSync?.attempted && modelSetResult?.defaultSync?.ok === false
            ? String(modelSetResult?.defaultSync?.error || "默认模型同步失败")
            : "",
        }
      : { attempted: false, ok: null, stderr: null },
    deepseekTune,
    next: gatewayWarning
      ? "基础配置已完成。Gateway 当前未就绪，但不影响在页面内继续对话；可稍后再排查 Gateway。"
      : "基础配置已完成，直接在下方聊天区发送消息即可。",
  });
}

async function handleOAuthStart(req, res) {
  const body = await readJsonBody(req);
  const provider = String(body.provider ?? "openai-codex").trim().toLowerCase();
  const outcome = startOAuthLogin(provider);
  sendJson(res, outcome.ok ? 200 : 400, outcome);
}

async function handleOAuthStatus(req, res) {
  sendJson(res, 200, { ok: true, ...getOauthStatus() });
}

async function handleSetModel(req, res) {
  const body = await readJsonBody(req);
  const model = String(body.model ?? "").trim();
  const sessionId = String(body.sessionId ?? "thunderclaw-main").trim() || "thunderclaw-main";
  if (!model) {
    sendJson(res, 400, { ok: false, error: "model is required" });
    return;
  }
  const switched = await switchThunderSessionModel({ modelRef: model, sessionId });
  sendJson(res, switched.ok ? 200 : 500, {
    ok: switched.ok,
    modelRef: model,
    sessionId,
    state: switched?.state || getXbrainStateSnapshot(),
    sessionSync: switched?.sessionSync || null,
    defaultSync: switched?.defaultSync || null,
    error: switched.ok ? null : String(switched?.sessionSync?.error || "session /model failed"),
  });
}

async function handleChat(req, res) {
  const body = await readJsonBody(req);
  const message = String(body.message ?? "").trim();
  const sessionId = String(body.sessionId ?? "thunderclaw-main").trim() || "thunderclaw-main";
  const thinking = String(body.thinking ?? "").trim();

  if (!message) {
    sendJson(res, 400, { ok: false, error: "message is required" });
    return;
  }

  const { result, payload, reply } = await runAgentTurn({ message, sessionId, thinking });

  appendChatEvent({
    role: "user",
    source: "dashboard",
    text: message,
  });
  if (reply) {
    appendChatEvent({
      role: "bot",
      source: "dashboard",
      text: reply,
    });
  }

  sendJson(res, result.ok ? 200 : 500, {
    ok: result.ok,
    exitCode: result.code,
    timedOut: result.timedOut,
    reply,
    payload,
    stdout: result.stdout,
    stderr: result.stderr,
  });
}

async function handleAiChat(req, res) {
  const body = await readJsonBody(req);
  const message = String(body.message ?? "").trim();
  if (!message) {
    sendJson(res, 400, { ok: false, error: "message is required" });
    return;
  }
  appendChatEvent({ role: "user", source: "dashboard", text: message });

  // ═══ FAST PATH: Try clarification first (DeepSeek direct, ~10s) ═══
  // If trading intent detected → return card immediately, skip slow openclaw CLI.
  if (typeof deps.detectAndClarify === "function") {
    try {
      const clarification = await deps.detectAndClarify({
        userMessage: message,
        assistantReply: "",
      });
      if (clarification.intentDetected) {
        const shortReply = clarification.headline || "正在理解你的需求...";
        appendChatEvent({ role: "bot", source: "dashboard", text: shortReply, cards: [] });
        sendJson(res, 200, {
          ok: true,
          reply: shortReply,
          source: "clarification_fast_path",
          actions: [],
          executionTrace: [],
          state: getXbrainStateSnapshot(),
          modelRefUsed: getCurrentRuntimeModelRefFromStore(),
          runtimeModelRef: getCurrentRuntimeModelRefFromStore(),
          sessionIdUsed: "thunderclaw-main",
          modelAutoSync: { detected: false },
          modelSyncIntent: { ok: false, shouldProbeSessionModel: false, confidence: 0, reasoning: "", error: "" },
          intentCandidates: [],
          intentSkill: { ok: false, intentDetected: false, confidence: 0, reasoning: "", error: "" },
          clarification: {
            intentDetected: true,
            confidence: Number(clarification.confidence || 0),
            headline: String(clarification.headline || ""),
            featureConcept: clarification.featureConcept || null,
            clarifyingQuestions: Array.isArray(clarification.clarifyingQuestions) ? clarification.clarifyingQuestions : [],
          },
          replyEventId: null,
        });
        return;
      }
    } catch {}
    // If clarification didn't detect intent → fall through to normal chat
  }

  // ═══ SLOW PATH: Regular chat via OpenClaw CLI ═══
  const runtimeModelRefBefore = getCurrentRuntimeModelRefFromStore();
  let turnResult = await runAgentTurn({
    message,
    sessionId: "thunderclaw-main",
    modelRef: runtimeModelRefBefore,
    thinking: "medium",
  });
  if (!turnResult?.result?.ok) {
    const errText = [turnResult?.result?.stderr, turnResult?.result?.stdout].filter(Boolean).join("\n");
    if (looksLikeSessionModelMismatch(errText) && runtimeModelRefBefore && runtimeModelRefBefore.includes("/")) {
      const healed = await switchThunderSessionModel({
        modelRef: runtimeModelRefBefore,
        sessionId: "thunderclaw-main",
      }).catch(() => ({ ok: false }));
      if (healed?.ok) {
        turnResult = await runAgentTurn({ message, sessionId: "thunderclaw-main", modelRef: runtimeModelRefBefore, thinking: "medium" });
      }
    }
  }
  const { result, payload, reply, sessionId: sessionIdUsed } = turnResult;
  const stateAfter = getXbrainStateSnapshot();
  const runtimeModelRefAfter = toModelRef(stateAfter?.base?.runtimeModelProvider, stateAfter?.base?.runtimeModelId);
  let replyEvent = null;
  if (reply) {
    replyEvent = appendChatEvent({ role: "bot", source: "dashboard", text: reply, cards: [] });
  }
  if (!result.ok) {
    sendJson(res, 500, {
      ok: false,
      error: (result.stderr || result.stdout || "").trim() || "openclaw chat failed",
      reply: "",
      source: "openclaw",
      actions: [],
      executionTrace: [],
      state: stateAfter,
      modelRefUsed: runtimeModelRefBefore,
      runtimeModelRef: runtimeModelRefAfter,
      sessionIdUsed,
      modelAutoSync: { detected: false },
      modelSyncIntent: { ok: false, shouldProbeSessionModel: false, confidence: 0, reasoning: "", error: "" },
      intentCandidates: [],
      intentSkill: { ok: false, intentDetected: false, confidence: 0, reasoning: "", error: "" },
      clarification: null,
    });
    return;
  }
  sendJson(res, 200, {
    ok: true,
    reply: String(reply || "").trim(),
    source: "openclaw",
    actions: [],
    executionTrace: [],
    state: stateAfter,
    modelRefUsed: runtimeModelRefBefore,
    runtimeModelRef: runtimeModelRefAfter,
    sessionIdUsed,
    modelAutoSync: { detected: false },
    modelSyncIntent: { ok: false, shouldProbeSessionModel: false, confidence: 0, reasoning: "", error: "" },
    intentCandidates: [],
    intentSkill: { ok: false, intentDetected: false, confidence: 0, reasoning: "", error: "" },
    clarification: null,
    replyEventId: Number(replyEvent?.id || 0) || null,
  });
}

async function handleConfigChat(req, res) {
  const body = await readJsonBody(req);
  const message = String(body.message ?? "").trim();
  if (!message) {
    sendJson(res, 400, { ok: false, error: "message is required" });
    return;
  }
  const intent = parseConfigIntent(message);
  if (!intent) {
    sendJson(res, 200, { ok: true, handled: false, reply: "" });
    return;
  }

  if (intent.type === "switch_model") {
    appendChatEvent({ role: "user", source: "dashboard", text: message });
    await syncXbrainFromOpenClaw().catch(() => null);
    const stateBefore = getXbrainStateSnapshot();
    const registry = uniqStrings(stateBefore?.base?.modelRegistry || []);
    const modelRef = String(intent.modelRef || "").trim();
    if (!modelRef) {
      const reply = "未识别到目标模型。请使用：/model provider/model";
      appendChatEvent({ role: "bot", source: "system", text: reply });
      sendJson(res, 200, { ok: true, handled: true, reply, state: stateBefore });
      return;
    }
    if (!registry.includes(modelRef)) {
      const preview = registry.slice(0, 8).join("、");
      const reply = preview
        ? (`模型 ${modelRef} 尚未在虾脑注册。请先在虾脑注册后再切换。\n已注册：${preview}`)
        : `模型 ${modelRef} 尚未在虾脑注册。请先在虾脑完成模型注册。`;
      appendChatEvent({ role: "bot", source: "system", text: reply });
      sendJson(res, 200, { ok: true, handled: true, reply, state: stateBefore });
      return;
    }
    const targetProvider = inferProviderFromModelRef(modelRef).provider;
    const providerConnected = Boolean(stateBefore?.base?.providerAuth?.[targetProvider]?.configured);
    if (!providerConnected) {
      const reply = `模型 ${modelRef} 对应 Provider（${targetProvider}）未连接，请先在虾脑完成连接。`;
      appendChatEvent({ role: "bot", source: "system", text: reply });
      sendJson(res, 200, { ok: true, handled: true, reply, state: stateBefore });
      return;
    }
    const switched = await switchThunderSessionModel({
      modelRef,
      sessionId: "thunderclaw-main",
    });
    if (!switched.ok) {
      const err = String(switched?.sessionSync?.error || "session /model failed");
      const reply = `模型切换失败：${err}`;
      appendChatEvent({ role: "bot", source: "system", text: reply });
      sendJson(res, 200, {
        ok: true,
        handled: true,
        reply,
        state: stateBefore,
        openclawModelSync: {
          ok: false,
          error: err,
          sessionSync: switched?.sessionSync || null,
          defaultSync: switched?.defaultSync || null,
        },
      });
      return;
    }
    const finalState = switched?.state || getXbrainStateSnapshot();
    const runtimeRef = toModelRef(finalState?.base?.runtimeModelProvider, finalState?.base?.runtimeModelId);
    const defaultWarn = switched?.defaultSync?.attempted && switched?.defaultSync?.ok === false
      ? `（会话已切换，默认模型同步失败：${String(switched?.defaultSync?.error || "unknown")}）`
      : "";
    const reply = defaultWarn ? (`模型已切换：${runtimeRef}\n${defaultWarn}`) : `模型已切换：${runtimeRef}`;
    appendChatEvent({ role: "bot", source: "system", text: reply });
    sendJson(res, 200, {
      ok: true,
      handled: true,
      reply,
      state: finalState,
      modelRefUsed: modelRef,
      runtimeModelRef: runtimeRef,
      openclawModelSync: {
        ok: true,
        error: null,
        warning: defaultWarn,
        sessionSync: switched?.sessionSync || null,
        defaultSync: switched?.defaultSync || null,
      },
    });
    return;
  }

  if (intent.type === "deepseek_help") {
    appendChatEvent({ role: "user", source: "dashboard", text: message });
    const reply = "请使用命令：/deepseek sk-你的DeepSeekKey";
    appendChatEvent({ role: "bot", source: "system", text: reply });
    sendJson(res, 200, { ok: true, handled: true, reply, state: getXbrainStateSnapshot() });
    return;
  }

  if (intent.type === "telegram_help") {
    appendChatEvent({ role: "user", source: "dashboard", text: message });
    const reply = "请使用命令：/telegram 你的TelegramBotToken";
    appendChatEvent({ role: "bot", source: "system", text: reply });
    sendJson(res, 200, { ok: true, handled: true, reply, state: getXbrainStateSnapshot() });
    return;
  }

  if (intent.type === "open_xbrain") {
    appendChatEvent({ role: "user", source: "dashboard", text: message });
    appendChatEvent({
      role: "bot",
      source: "system",
      text: "请进入「虾脑」页面使用内置快速登录引导（DeepSeek 一键登录 / OpenAI OAuth）。",
    });
    sendJson(res, 200, {
      ok: true,
      handled: true,
      reply: "请进入「虾脑」页面使用内置快速登录引导（DeepSeek 一键登录 / OpenAI OAuth）。",
    });
    return;
  }

  if (intent.type === "deepseek_key") {
    appendChatEvent({ role: "user", source: "dashboard", text: message });
    xbrainStore.base.deepseekApiKey = intent.key;
    xbrainStore.base.providerAuth = xbrainStore.base.providerAuth || {};
    xbrainStore.base.providerAuth.deepseek = {
      configured: true,
      masked: maskSecret(intent.key),
      plain: intent.key,
      source: "chat_config",
      error: "",
      type: "apiKey",
    };
    saveXbrainStore();
    const setup = await runSetupFromInput({
      provider: "deepseek-api-key",
      apiKey: intent.key,
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
      await syncXbrainFromOpenClaw();
      const freshState = getXbrainStateSnapshot();
      const reply = "DeepSeek Key 已保存并完成基础配置。现在可以直接开始对话。";
      appendChatEvent({ role: "bot", source: "system", text: reply });
      sendJson(res, 200, { ok: true, handled: true, reply, state: freshState, runtimeModelRef: "deepseek/deepseek-chat" });
      return;
    }
    const err = setup.error || setup.stderr || setup.stdout || "DeepSeek 配置失败";
    const reply = `DeepSeek 配置失败：${String(err).trim()}`;
    appendChatEvent({ role: "bot", source: "system", text: reply });
    sendJson(res, 200, { ok: true, handled: true, reply, state: getXbrainStateSnapshot() });
    return;
  }

  if (intent.type === "telegram_token") {
    appendChatEvent({ role: "user", source: "dashboard", text: message });
    xbrainStore.base.telegramTokenValue = intent.token;
    xbrainStore.base.telegramRelayEnabled = true;
    saveXbrainStore();
    const freshState = getXbrainStateSnapshot();
    const reply = "Telegram Token 已保存，可在虾脑中继续测试与开关控制。";
    appendChatEvent({ role: "bot", source: "system", text: reply });
    sendJson(res, 200, { ok: true, handled: true, reply, state: freshState });
    return;
  }

  if (intent.type === "oauth") {
    appendChatEvent({ role: "user", source: "dashboard", text: message });
    if (intent.provider === "anthropic") {
      const reply = "Anthropic 目前建议在终端执行：openclaw models auth setup-token --provider anthropic --yes";
      appendChatEvent({ role: "bot", source: "system", text: reply });
      sendJson(res, 200, { ok: true, handled: true, reply });
      return;
    }
    const oauth = startOAuthLogin("openai-codex");
    const reply = oauth.ok
      ? "已发起 OpenAI(Codex) 登录流程，请在启动 thunderclaw 的终端完成授权。"
      : `无法发起 OAuth：${String(oauth.error || "unknown")}`;
    appendChatEvent({ role: "bot", source: "system", text: reply });
    sendJson(res, 200, { ok: true, handled: true, reply, state: getXbrainStateSnapshot() });
    return;
  }

  sendJson(res, 200, { ok: true, handled: false, reply: "" });
}

async function handleAiHealth(req, res) {
  const healthRes = await runOpenClawCommand(["gateway", "health", "--json"], { timeoutMs: 8_000 });
  const payload = parseJsonSafe(healthRes.stdout);
  const modelsRes = await runOpenClawCommand(["models", "status", "--json"], { timeoutMs: 10_000 });
  const modelsJson = parseJsonSafe(modelsRes.stdout);
  const modelReady = Boolean(
    modelsRes.ok
      && String(modelsJson?.resolvedDefault || modelsJson?.defaultModel || "").trim(),
  );
  const gatewayHealthy = Boolean(healthRes.ok);
  const fallbackMode = !gatewayHealthy && modelReady;
  sendJson(res, 200, {
    ok: gatewayHealthy || modelReady,
    healthy: gatewayHealthy,
    gatewayHealthy,
    modelReady,
    fallbackMode,
    health: payload,
    error: healthRes.ok ? null : (healthRes.stderr || healthRes.stdout || "").trim() || null,
  });
}

function parsePositiveInt(raw, fallback, max) {
  const n = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  if (Number.isFinite(max)) return Math.min(n, max);
  return n;
}

async function handleChatHistory(req, res) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const afterId = parsePositiveInt(url.searchParams.get("afterId"), 0, 10_000_000);
  const limit = parsePositiveInt(url.searchParams.get("limit"), 220, 1_000);
  const events = (chatHistory.events || [])
    .filter((ev) => Number(ev.id) > afterId)
    .slice(0, Math.max(1, limit));
  sendJson(res, 200, {
    ok: true,
    events,
  });
}

async function handleChatCardStatus(req, res) {
  const body = await readJsonBody(req);
  if (typeof updateChatCardStatus !== "function") {
    sendJson(res, 500, { ok: false, error: "chat card status updater not available" });
    return;
  }
  const eventId = Number(body?.eventId);
  const cardId = String(body?.cardId || "").trim();
  const status = String(body?.status || "").trim().toLowerCase();
  if (!Number.isFinite(eventId) || eventId <= 0) {
    sendJson(res, 400, { ok: false, error: "eventId is required" });
    return;
  }
  if (!cardId) {
    sendJson(res, 400, { ok: false, error: "cardId is required" });
    return;
  }
  if (!["proposed", "accepted", "ignored", "registered"].includes(status)) {
    sendJson(res, 400, { ok: false, error: "invalid status" });
    return;
  }
  const updated = updateChatCardStatus({ eventId, cardId, status });
  if (!updated?.ok) {
    sendJson(res, 404, { ok: false, error: String(updated?.error || "update failed") });
    return;
  }
  sendJson(res, 200, {
    ok: true,
    eventId,
    cardId,
    status,
    card: updated.card || null,
  });
}


  return {
    handleSetup,
    handleQuickSetup,
    handleOAuthStart,
    handleOAuthStatus,
    handleSetModel,
    handleChat,
    handleAiChat,
    handleConfigChat,
    handleAiHealth,
    handleChatHistory,
    handleChatCardStatus,
  };
}
