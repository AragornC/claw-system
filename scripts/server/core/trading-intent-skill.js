import {
  normalizeLayerFramework,
  summarizeLayerFramework,
} from "./strategy-layer-framework.js";
import { runHeuristicIntentSkills } from "./intent-skills/index.js";

function clampNumber(valueLike, min, max, fallback = 0) {
  const n = Number(valueLike);
  if (!Number.isFinite(n)) return fallback;
  if (Number.isFinite(min) && n < min) return min;
  if (Number.isFinite(max) && n > max) return max;
  return n;
}

function toText(valueLike, fallback = "") {
  const s = String(valueLike ?? "").trim();
  return s || fallback;
}

function uniqStrings(valuesLike) {
  const rows = Array.isArray(valuesLike) ? valuesLike : [];
  const set = new Set();
  rows.forEach((item) => {
    const v = String(item ?? "").trim();
    if (v) set.add(v);
  });
  return Array.from(set);
}

function parseJsonLoose(textLike) {
  const text = String(textLike ?? "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {}
  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    try {
      return JSON.parse(String(fencedMatch[1]).trim());
    } catch {}
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {}
  }
  return null;
}

function pickEnum(valueLike, allowedSet, fallback) {
  const v = String(valueLike ?? "").trim().toLowerCase();
  if (allowedSet.has(v)) return v;
  return fallback;
}

const FEATURE_GROUPS = new Set(["trend", "momentum", "volatility", "risk", "execution", "signal_external", "custom"]);
const FEATURE_KINDS = new Set([
  "ema",
  "sma",
  "rsi",
  "adx",
  "atr",
  "volume",
  "price_action",
  "risk_rule",
  "news_sentiment",
  "social_sentiment",
  "prediction_market",
  "custom",
]);
const STRATEGY_HORIZONS = new Set(["scalp", "intraday", "swing", "position"]);
const STRATEGY_RISK_LEVELS = new Set(["conservative", "balanced", "aggressive"]);

function normalizeFeature(rawLike = {}) {
  const raw = rawLike && typeof rawLike === "object" ? rawLike : {};
  const name = toText(raw.name || raw.featureId || raw.title || "");
  if (!name) return null;
  const group = pickEnum(raw.group, FEATURE_GROUPS, "custom");
  const kind = pickEnum(raw.kind, FEATURE_KINDS, "custom");
  const description = toText(raw.description || raw.summary || "来自对话候选");
  const paramsRaw = raw.params && typeof raw.params === "object" ? raw.params : {};
  const params = {};
  Object.entries(paramsRaw)
    .slice(0, 16)
    .forEach(([k, v]) => {
      const key = toText(k).replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 32);
      if (!key) return;
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        params[key] = v;
      }
    });
  return {
    name,
    group,
    kind,
    description,
    params,
  };
}

function normalizeStrategy(rawLike = {}) {
  const raw = rawLike && typeof rawLike === "object" ? rawLike : {};
  const title = toText(raw.title || raw.name || "");
  if (!title) return null;
  const thesis = toText(raw.thesis || raw.objective || raw.summary || "");
  const horizon = pickEnum(raw.horizon, STRATEGY_HORIZONS, "intraday");
  const riskLevel = pickEnum(raw.riskLevel || raw.risk, STRATEGY_RISK_LEVELS, "balanced");
  const entry = toText(raw.entry || raw.entryRule || "");
  const riskControl = toText(raw.riskControl || raw.riskRule || "");
  const exit = toText(raw.exit || raw.exitRule || "");
  const featureRefs = uniqStrings([
    ...(Array.isArray(raw.featureRefs) ? raw.featureRefs : []),
    ...(Array.isArray(raw.features)
      ? raw.features.map((item) => (typeof item === "string" ? item : toText(item?.name || item?.featureId || "")))
      : []),
  ]).slice(0, 12);
  const features = (Array.isArray(raw.features) ? raw.features : [])
    .map((item) => normalizeFeature(item))
    .filter(Boolean)
    .slice(0, 8);
  const dsl = raw.dsl && typeof raw.dsl === "object" ? raw.dsl : null;
  const layers = normalizeLayerFramework({
    signalLayer: {
      signalType: "composite",
      signalLogic: entry || "ema_fast > ema_slow",
      featureRefs,
    },
    positionLayer: {},
    riskLayer: {
      riskPauseCondition: riskControl,
    },
    executionLayer: {},
  });
  return {
    title,
    thesis,
    horizon,
    riskLevel,
    entry,
    riskControl,
    exit,
    featureRefs,
    features,
    dsl,
    layers,
    frameworkSummary: summarizeLayerFramework(layers),
  };
}

function normalizeCandidate(rawLike = {}, index = 0) {
  const raw = rawLike && typeof rawLike === "object" ? rawLike : {};
  const kind = String(raw.kind || "").trim().toLowerCase();
  const confidence = clampNumber(raw.confidence, 0, 1, 0.6);
  if (kind === "feature") {
    const feature = normalizeFeature(raw.feature || raw);
    if (!feature) return null;
    const title = toText(raw.title || feature.name || `特征候选 ${index + 1}`);
    const summary = toText(raw.summary || feature.description || "来自交易对话的特征候选");
    return {
      candidateId: toText(raw.candidateId || `cand_feature_${index + 1}`),
      kind: "feature",
      title,
      summary,
      confidence,
      feature,
    };
  }
  if (kind === "strategy") {
    const strategy = normalizeStrategy(raw.strategy || raw);
    if (!strategy) return null;
    const title = toText(raw.title || strategy.title || `策略候选 ${index + 1}`);
    const summary = toText(raw.summary || strategy.thesis || "来自交易对话的策略候选");
    return {
      candidateId: toText(raw.candidateId || `cand_strategy_${index + 1}`),
      kind: "strategy",
      title,
      summary,
      confidence,
      strategy,
    };
  }
  return null;
}

function normalizeSkillResult(rawLike = {}) {
  const raw = rawLike && typeof rawLike === "object" ? rawLike : {};
  const candidates = (Array.isArray(raw.candidates) ? raw.candidates : [])
    .map((item, idx) => normalizeCandidate(item, idx))
    .filter(Boolean)
    .slice(0, 4);
  const intentDetected = Boolean(raw.intentDetected) && candidates.length > 0;
  const confidence = clampNumber(raw.confidence, 0, 1, candidates.length ? 0.72 : 0.15);
  return {
    intentDetected,
    confidence,
    reasoning: toText(raw.reasoning || raw.rationale || ""),
    candidates,
  };
}


function buildHeuristicIntentFromText(params = {}) {
  const userMessage = toText(params.userMessage).toLowerCase();
  const assistantReply = toText(params.assistantReply).toLowerCase();
  const merged = `${userMessage}
${assistantReply}`;

  const skillPack = runHeuristicIntentSkills({
    userMessage,
    assistantReply,
    mergedText: merged,
  });

  if (!skillPack.intentDetected) {
    return {
      intentDetected: false,
      confidence: 0.2,
      reasoning: toText(skillPack.reasoning || "对话中缺少明确交易对象或策略描述"),
      candidates: [],
    };
  }

  const featureCandidates = Array.isArray(skillPack.featureCandidates)
    ? skillPack.featureCandidates.slice(0, 4)
    : [];

  if (featureCandidates.length === 0) {
    featureCandidates.push({
      candidateId: "cand_feature_ema_default",
      kind: "feature",
      title: "EMA 趋势特征",
      summary: "默认趋势特征（降级兜底）",
      confidence: 0.68,
      feature: {
        name: "ema_trend",
        group: "trend",
        kind: "ema",
        description: "EMA 快慢线趋势判断",
        params: { fast: 12, slow: 26 },
      },
    });
    featureCandidates.push({
      candidateId: "cand_feature_atr_default",
      kind: "feature",
      title: "ATR 波动过滤",
      summary: "默认波动特征（降级兜底）",
      confidence: 0.66,
      feature: {
        name: "atr_filter",
        group: "volatility",
        kind: "atr",
        description: "ATR 波动率过滤",
        params: { period: 14 },
      },
    });
  }

  const strategyHints = skillPack.strategyHints && typeof skillPack.strategyHints === "object"
    ? skillPack.strategyHints
    : {};

  const strategyCandidate = {
    candidateId: "cand_strategy_heuristic",
    kind: "strategy",
    title: "对话驱动短线策略",
    summary: "根据对话自动生成的可回测策略",
    confidence: clampNumber(skillPack.confidence, 0, 1, 0.74),
    strategy: {
      title: "对话驱动短线策略",
      thesis: "结合趋势、波动与外部信号进行短线交易",
      horizon: "intraday",
      riskLevel: "balanced",
      entry: toText(strategyHints.entry || "趋势方向一致且波动过滤通过时入场"),
      riskControl: toText(strategyHints.riskControl || "止损1%-2%，单笔风险不超过总资金1%"),
      exit: toText(strategyHints.exit || "止盈2%-4%或趋势反转离场"),
      featureRefs: featureCandidates.map((item) => item.feature?.name).filter(Boolean),
      features: featureCandidates.map((item) => item.feature).filter(Boolean),
      dsl: {
        entry: "trend_confirm && feature_signal_confirm",
        risk: "sl_1_2_pct",
        exit: "tp_2_4_pct_or_reversal",
      },
    },
  };

  return {
    intentDetected: true,
    confidence: clampNumber(skillPack.confidence, 0, 1, 0.74),
    reasoning: toText(skillPack.reasoning || "启用本地技能编排交易意图提取"),
    candidates: [...featureCandidates.slice(0, 3), strategyCandidate],
  };
}

function buildSkillPrompt(params = {}) {
  const userMessage = toText(params.userMessage).slice(0, 1600);
  const assistantReply = toText(params.assistantReply).slice(0, 2000);
  const runtimeModelRef = toText(params.runtimeModelRef);
  const clientContext = params.clientContext && typeof params.clientContext === "object"
    ? params.clientContext
    : {};
  const context = {
    userMessage,
    assistantReply,
    runtimeModelRef,
    clientContext,
  };
  return [
    "你是 ThunderClaw 的 Trading Intent Skill（交易意图技能）。",
    "你的职责：基于用户与助手本轮对话，判断是否存在“可落地到虾策”的交易特征或策略候选。",
    "必须输出严格 JSON，不要 markdown，不要解释文本。",
    "",
    "输出 Schema：",
    "{",
    '  "intentDetected": boolean,',
    '  "confidence": number,',
    '  "reasoning": string,',
    '  "candidates": [',
    "    {",
    '      "candidateId": "string",',
    '      "kind": "feature" | "strategy",',
    '      "title": "string",',
    '      "summary": "string",',
    '      "confidence": number,',
    '      "feature": {',
    '        "name": "string",',
    '        "group": "trend|momentum|volatility|risk|execution|signal_external|custom",',
    '        "kind": "ema|sma|rsi|adx|atr|volume|price_action|risk_rule|news_sentiment|social_sentiment|prediction_market|custom",',
    '        "description": "string",',
    '        "params": {}',
    "      },",
    '      "strategy": {',
    '        "title": "string",',
    '        "thesis": "string",',
    '        "horizon": "scalp|intraday|swing|position",',
    '        "riskLevel": "conservative|balanced|aggressive",',
    '        "entry": "string",',
    '        "riskControl": "string",',
    '        "exit": "string",',
    '        "featureRefs": ["string"],',
    '        "features": [],',
    '        "dsl": {}',
    "      }",
    "    }",
    "  ]",
    "}",
    "",
    "决策规则：",
    "1) 只有在“交易目标/风格/约束/策略构思/指标偏好”明确时，intentDetected 才为 true。",
    "2) 若信息不足，intentDetected=false，candidates=[]。",
    "3) 候选最多 3 个；优先可执行、可验证、低歧义。",
    "4) 不要编造不存在的上下文。",
    "",
    "[CONTEXT]",
    JSON.stringify(context),
  ].join("\n");
}

export function createTradingIntentSkill(deps = {}) {
  const runOpenClawCommand = deps.runOpenClawCommand;
  const parseJsonSafe = deps.parseJsonSafe;
  const extractAgentReply = deps.extractAgentReply;
  const normalizeSessionId = deps.normalizeSessionId;
  if (typeof runOpenClawCommand !== "function") throw new Error("runOpenClawCommand is required");
  if (typeof parseJsonSafe !== "function") throw new Error("parseJsonSafe is required");
  if (typeof extractAgentReply !== "function") throw new Error("extractAgentReply is required");
  if (typeof normalizeSessionId !== "function") throw new Error("normalizeSessionId is required");

  async function extractTradingIntentCandidates(params = {}) {
    const userMessage = toText(params.userMessage);
    const assistantReply = toText(params.assistantReply);
    if (!userMessage && !assistantReply) {
      return {
        ok: true,
        intentDetected: false,
        confidence: 0,
        reasoning: "",
        candidates: [],
      };
    }
    const baseSessionId = normalizeSessionId(toText(params.sessionId || "thunderclaw-main", "thunderclaw-main"));
    const skillSessionId = normalizeSessionId(`${baseSessionId}-xstrategy-skill`);
    const runtimeModelRef = toText(params.runtimeModelRef || "");
    const message = buildSkillPrompt({
      userMessage,
      assistantReply,
      runtimeModelRef,
      clientContext: params.clientContext,
    });
    const args = [
      "agent",
      "--session-id",
      skillSessionId,
      "--message",
      message,
      "--json",
    ];
    const result = await runOpenClawCommand(args, { timeoutMs: 120_000 });
    if (!result.ok) {
      const heuristic = buildHeuristicIntentFromText({ userMessage, assistantReply });
      return {
        ok: true,
        intentDetected: heuristic.intentDetected,
        confidence: heuristic.confidence,
        reasoning: heuristic.reasoning,
        candidates: heuristic.candidates,
        modelRef: runtimeModelRef,
        sessionId: skillSessionId,
        error: toText(result.stderr || result.stdout || "intent skill fallback"),
      };
    }
    const payload = parseJsonSafe(result.stdout);
    const replyText = toText(extractAgentReply(payload) || "");
    const parsed = parseJsonLoose(replyText) || parseJsonLoose(result.stdout) || payload || null;
    const normalized = normalizeSkillResult(parsed || {});
    if (!normalized.intentDetected || !Array.isArray(normalized.candidates) || normalized.candidates.length === 0) {
      const heuristic = buildHeuristicIntentFromText({ userMessage, assistantReply });
      return {
        ok: true,
        intentDetected: heuristic.intentDetected,
        confidence: heuristic.confidence,
        reasoning: heuristic.reasoning,
        candidates: heuristic.candidates,
        modelRef: runtimeModelRef,
        sessionId: skillSessionId,
      };
    }
    return {
      ok: true,
      intentDetected: normalized.intentDetected,
      confidence: normalized.confidence,
      reasoning: normalized.reasoning,
      candidates: normalized.candidates,
      modelRef: runtimeModelRef,
      sessionId: skillSessionId,
    };
  }

  return {
    extractTradingIntentCandidates,
  };
}
