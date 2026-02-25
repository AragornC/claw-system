function msText(valueLike, fallback = "") {
  const s = String(valueLike == null ? "" : valueLike).trim();
  return s || String(fallback || "");
}

function msClamp(valueLike, min, max, fallback = 0) {
  const n = Number(valueLike);
  if (!Number.isFinite(n)) return Number(fallback || 0);
  if (Number.isFinite(min) && n < min) return min;
  if (Number.isFinite(max) && n > max) return max;
  return n;
}

function msExtractJsonObject(textLike) {
  const text = String(textLike ?? "");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {}
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  const maybe = text.slice(start, end + 1);
  try {
    return JSON.parse(maybe);
  } catch {}
  return null;
}

function msNormalizeResult(rawLike = {}) {
  const raw = rawLike && typeof rawLike === "object" ? rawLike : {};
  const shouldProbeSessionModel = Boolean(raw.shouldProbeSessionModel);
  const confidence = msClamp(raw.confidence, 0, 1, shouldProbeSessionModel ? 0.72 : 0.1);
  const reasoning = msText(raw.reasoning || "");
  return {
    shouldProbeSessionModel,
    confidence,
    reasoning,
  };
}

function buildModelSyncIntentPrompt(params = {}) {
  const userMessage = msText(params.userMessage).slice(0, 1400);
  const assistantReply = msText(params.assistantReply).slice(0, 1800);
  const runtimeModelRef = msText(params.runtimeModelRef || "");
  const registry = Array.isArray(params.registry)
    ? params.registry.map((x) => msText(x)).filter(Boolean).slice(0, 120)
    : [];
  const context = {
    userMessage,
    assistantReply,
    runtimeModelRef,
    registeredModels: registry,
  };
  return [
    "你是 ThunderClaw 的 Model Sync Intent Skill（模型同步门控技能）。",
    "目标：判断本轮是否需要进行“会话模型状态探测与同步”。",
    "严格输出 JSON，不要 markdown，不要解释文字。",
    "",
    "输出 Schema：",
    "{",
    '  "shouldProbeSessionModel": boolean,',
    '  "confidence": number,',
    '  "reasoning": string',
    "}",
    "",
    "判定规则：",
    "1) 只有当本轮明确涉及“模型切换/模型配置修改/切换到某模型”时，shouldProbeSessionModel=true。",
    "2) 仅讨论策略、周期、K线、交易参数（如 1H/4H）时，必须是 false。",
    "3) 模糊提问、普通聊天、策略讨论，默认 false。",
    "",
    "[CONTEXT]",
    JSON.stringify(context),
  ].join("\n");
}

export function createModelSwitchIntentSkill(deps = {}) {
  const runOpenClawCommand = deps.runOpenClawCommand;
  const parseJsonSafe = deps.parseJsonSafe;
  const extractAgentReply = deps.extractAgentReply;
  const normalizeSessionId = deps.normalizeSessionId;
  if (typeof runOpenClawCommand !== "function") throw new Error("runOpenClawCommand is required");
  if (typeof parseJsonSafe !== "function") throw new Error("parseJsonSafe is required");
  if (typeof extractAgentReply !== "function") throw new Error("extractAgentReply is required");
  if (typeof normalizeSessionId !== "function") throw new Error("normalizeSessionId is required");

  async function extractModelSwitchIntent(params = {}) {
    const userMessage = msText(params.userMessage || "");
    const assistantReply = msText(params.assistantReply || "");
    if (!userMessage && !assistantReply) {
      return {
        ok: true,
        shouldProbeSessionModel: false,
        confidence: 0,
        reasoning: "",
      };
    }
    const baseSessionId = normalizeSessionId(msText(params.sessionId || "thunderclaw-main", "thunderclaw-main"));
    const skillSessionId = normalizeSessionId(baseSessionId + "-model-sync-skill");
    const message = buildModelSyncIntentPrompt({
      userMessage,
      assistantReply,
      runtimeModelRef: params.runtimeModelRef,
      registry: params.registry,
    });
    const result = await runOpenClawCommand(
      ["agent", "--session-id", skillSessionId, "--message", message, "--json"],
      { timeoutMs: 90_000 },
    );
    if (!result.ok) {
      return {
        ok: false,
        shouldProbeSessionModel: false,
        confidence: 0,
        reasoning: "",
        error: msText(result.stderr || result.stdout || "model sync skill failed"),
      };
    }
    const payload = parseJsonSafe(result.stdout);
    const replyText = msText(extractAgentReply(payload) || "");
    const parsed = msExtractJsonObject(replyText) || msExtractJsonObject(result.stdout) || payload || {};
    const normalized = msNormalizeResult(parsed);
    return {
      ok: true,
      shouldProbeSessionModel: normalized.shouldProbeSessionModel,
      confidence: normalized.confidence,
      reasoning: normalized.reasoning,
      sessionId: skillSessionId,
    };
  }

  return {
    extractModelSwitchIntent,
  };
}

