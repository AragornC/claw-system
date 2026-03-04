import { runIntentGating, shouldCallLlmForIntent } from "../core/intent-gating.js";
import { createLlmClient } from "../core/llm-client.js";

const THUNDERCLAW_SYSTEM_PROMPT = `你是 ThunderClaw（虾策），一个 AI Native 交易引擎助手。

## 你的能力
- 帮用户创建、评估、优化交易特征（通过特征卡片交互）
- 解释交易概念、指标含义
- 分析已有特征的效果和参数
- 回答关于虾策架构和功能的问题
- 提供交易策略建议

## 虾策交易架构
- 特征库（虾策）：存储用户创建的交易特征，每个特征是一段运行在 Freqtrade 框架中的 Python 代码
- 策略库：由多个特征组合而成的交易策略
- 四层架构：信号层（特征组合）→ 仓位层 → 风控层 → 执行层
- 支持回测验证和特征级评估

## 回复规则
1. 用中文回复
2. 如果用户询问已有特征，参考「当前系统状态」中的信息回答
3. 如果用户想创建新特征，告知他们可以直接描述需求，系统会生成特征卡片
4. 保持简洁，不要过度解释
5. 如果涉及具体代码问题，可以给出技术建议`;

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

  // Used for slow path healing — sets default model without sending /model agent message
  const setOpenClawDefaultModel = typeof deps.setOpenClawDefaultModel === "function" ? deps.setOpenClawDefaultModel : null;
  const applyRuntimeModelRefToStore = typeof deps.applyRuntimeModelRefToStore === "function" ? deps.applyRuntimeModelRefToStore : null;

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

  // Track message in conversation context
  const ctx = deps.conversationContext;
  if (ctx) ctx.addMessage("user", message);

  // ═══ FAST PATH: Try clarification first (LLM direct, ~10s) ═══
  // L2: Trigger evolution compression if needed (non-blocking)
  const ml = deps.memoryLayer;
  if (ml) void ml.maybeCompressContext().catch(() => {});

  // Build memory context (L2+L3+L4) for injection into system prompt
  const memoryContext = ml ? await ml.buildFullMemoryContext(message).catch(() => "") : "";

  // ── Intent Gating: Layer 0 + Layer 1 (rule-based, <1ms) ──
  // Collect existing feature names for reference detection
  const existingFeatureNames = [];
  try {
    const strategyLabStore = deps.strategyLabStore || null;
    if (strategyLabStore && typeof strategyLabStore.listFeatures === "function") {
      const features = strategyLabStore.listFeatures({ limit: 100 }).features || [];
      features.forEach((f) => {
        if (f.name) existingFeatureNames.push(f.name);
        if (f.description) existingFeatureNames.push(f.description.slice(0, 30));
      });
    }
  } catch {}

  const shouldCallLlm = shouldCallLlmForIntent(message, existingFeatureNames);

  if (shouldCallLlm && typeof deps.detectAndClarify === "function") {
    try {
      const conversationHistory = ctx ? ctx.getRecentHistory(16) : [];
      const clarification = await deps.detectAndClarify({
        userMessage: message,
        assistantReply: "",
        conversationHistory,
        memoryContext,
      });

      // ── Intent Gating: Layer 2 + Layer 3 (LLM result + calibration) ──
      const gatingResult = runIntentGating({
        message,
        existingFeatureNames,
        l2Result: clarification.intentDetected ? {
          intentDetected: true,
          confidence: Number(clarification.confidence || 0),
          intent: "create",
        } : {
          intentDetected: false,
          confidence: Number(clarification.confidence || 0),
          intent: "non_create",
        },
      });

      if (gatingResult.shouldTriggerClarification && clarification.intentDetected) {
        const shortReply = clarification.headline || "正在理解你的需求...";
        if (ctx) {
          ctx.addMessage("assistant", shortReply, {
            type: "clarification_card",
            cardData: {
              headline: String(clarification.headline || ""),
              featureConcept: clarification.featureConcept || null,
              clarifyingQuestions: Array.isArray(clarification.clarifyingQuestions) ? clarification.clarifyingQuestions : [],
            },
          });
          ctx.addCardEvent("card_shown", {
            headline: String(clarification.headline || ""),
            featureName: String(clarification.featureConcept?.name || ""),
          });
        }
        appendChatEvent({ role: "bot", source: "dashboard", text: shortReply, cards: [] });
        // Reply is empty — the clarification card IS the response.
        // Frontend should render only the card, not an extra text bubble.
        sendJson(res, 200, {
          ok: true,
          reply: "",
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

  // ═══ CHAT PATH: LLM direct with full architecture context ═══
  const runtimeModelRefBefore = getCurrentRuntimeModelRefFromStore();
  const conversationHistory = ctx ? ctx.getRecentHistory(16) : [];

  // Build LLM messages with system context
  const systemPrompt = THUNDERCLAW_SYSTEM_PROMPT + (memoryContext || "");
  const llmMessages = [
    { role: "system", content: systemPrompt },
    ...conversationHistory,
    { role: "user", content: message },
  ];

  let reply = "";
  let chatSource = "llm_direct";
  try {
    const getModelConfig = typeof deps.getModelConfig === "function" ? deps.getModelConfig : null;
    if (!getModelConfig) throw new Error("model config not available");
    const chatLlmClient = createLlmClient({ getModelConfig });
    const llmResult = await chatLlmClient.chatCompletion({
      messages: llmMessages,
      temperature: 0.4,
      maxTokens: 2048,
      timeoutMs: 60_000,
    });
    if (llmResult.ok && llmResult.content) {
      reply = String(llmResult.content).trim();
    }
  } catch {}

  // Fallback: try OpenClaw CLI if LLM direct failed
  if (!reply) {
    try {
      const turnResult = await runAgentTurn({
        message,
        sessionId: "thunderclaw-main",
        modelRef: runtimeModelRefBefore,
        thinking: "medium",
      });
      if (turnResult?.result?.ok && turnResult?.reply) {
        reply = String(turnResult.reply).trim();
        chatSource = "openclaw";
      }
    } catch {}
  }

  // Final fallback: rule-based
  if (!reply) {
    reply = "收到，但当前模型暂不可用。请在虾脑中确认模型配置后重试。";
    chatSource = "rule_fallback";
  }

  const stateAfter = getXbrainStateSnapshot();
  const runtimeModelRefAfter = toModelRef(stateAfter?.base?.runtimeModelProvider, stateAfter?.base?.runtimeModelId);
  if (ctx) ctx.addMessage("assistant", reply);
  const replyEvent = appendChatEvent({ role: "bot", source: "dashboard", text: reply, cards: [] });

  sendJson(res, 200, {
    ok: true,
    reply,
    source: chatSource,
    actions: [],
    executionTrace: [],
    state: stateAfter,
    modelRefUsed: runtimeModelRefBefore,
    runtimeModelRef: runtimeModelRefAfter,
    sessionIdUsed: "thunderclaw-main",
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


  // ─── Session Management ─────────────────────────────────────────────
  async function handleSessionArchive(req, res) {
    if (!deps.conversationContext) {
      sendJson(res, 200, { ok: false, error: "conversation context not available" });
      return;
    }
    // Generate LLM summary before archiving (L2)
    const ml = deps.memoryLayer;
    if (ml) {
      try {
        const history = deps.conversationContext.getRecentHistory(30);
        const summary = await ml.generateSessionSummary(history);
        if (summary) {
          // The archiveCurrentSession will use this as session.summary
          const session = deps.conversationContext.getSessionDetail(deps.conversationContext.getActiveSessionId());
          if (session) session.summary = summary;
        }
      } catch {}
    }
    const result = deps.conversationContext.archiveCurrentSession();
    sendJson(res, 200, result);
  }

  async function handleSessionList(req, res) {
    if (!deps.conversationContext) {
      sendJson(res, 200, { ok: true, active: null, archived: [], totalArchived: 0 });
      return;
    }
    sendJson(res, 200, { ok: true, ...deps.conversationContext.listSessions() });
  }

  async function handleSessionRestore(req, res) {
    if (!deps.conversationContext) {
      sendJson(res, 200, { ok: false, error: "conversation context not available" });
      return;
    }
    const body = await readJsonBody(req);
    const sessionId = String(body.sessionId || "").trim();
    if (!sessionId) {
      sendJson(res, 400, { ok: false, error: "sessionId is required" });
      return;
    }
    const result = deps.conversationContext.restoreSession(sessionId);
    // If restored, also return the session messages for UI to render
    if (result.ok) {
      const detail = deps.conversationContext.getSessionDetail(sessionId);
      sendJson(res, 200, { ...result, messages: detail?.messages || [] });
    } else {
      sendJson(res, 200, result);
    }
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
    handleSessionArchive,
    handleSessionList,
    handleSessionRestore,
  };
}
