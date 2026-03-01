/**
 * Trading Intent Skill — refactored to use the 3-stage pipeline.
 *
 * Public API (unchanged from original):
 *   - extractTradingIntentCandidates(params) → { ok, intentDetected, confidence, reasoning, candidates }
 *   - generateFeatureCodeForCandidate(params) → { ok, candidate, sessionId, modelRef }
 *
 * Internal change: all AI calls now go through the DeepSeek direct client
 * via the pipeline, instead of slow openclaw CLI invocations.
 */

import { createFeaturePipeline } from "./pipeline/index.js";

function toText(valueLike, fallback = "") {
  const s = String(valueLike ?? "").trim();
  return s || fallback;
}

function clampNumber(valueLike, min, max, fallback = 0) {
  const n = Number(valueLike);
  if (!Number.isFinite(n)) return fallback;
  if (Number.isFinite(min) && n < min) return min;
  if (Number.isFinite(max) && n > max) return max;
  return n;
}

const FEATURE_GROUPS = new Set(["trend", "momentum", "volatility", "risk", "execution", "signal_external", "custom"]);
const FEATURE_KINDS = new Set([
  "ema", "sma", "rsi", "adx", "atr", "volume", "price_action",
  "macd", "bollinger", "stochastic", "cci", "mfi", "obv",
  "news_sentiment", "social_sentiment", "prediction_market",
  "risk_rule", "custom",
]);

function pickEnum(valueLike, allowedSet, fallback) {
  const v = String(valueLike ?? "").trim().toLowerCase();
  if (allowedSet.has(v)) return v;
  return fallback;
}

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

  // Carry over generated code if present
  const generatedCode = raw.generatedCode && typeof raw.generatedCode === "object"
    ? raw.generatedCode
    : null;

  return {
    name,
    group,
    kind,
    description,
    params,
    indicatorLogic: toText(raw.indicatorLogic, ""),
    entryCondition: toText(raw.entryCondition, ""),
    exitCondition: toText(raw.exitCondition, ""),
    ...(generatedCode ? { generatedCode } : {}),
    codegenStatus: toText(raw.codegenStatus, ""),
    codegenError: toText(raw.codegenError, ""),
  };
}

function normalizeCandidate(rawLike = {}, index = 0) {
  const raw = rawLike && typeof rawLike === "object" ? rawLike : {};
  const kind = String(raw.kind || "").trim().toLowerCase();
  const confidence = clampNumber(raw.confidence, 0, 1, 0.6);
  if (kind === "feature" || !kind) {
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
  return null;
}


export function createTradingIntentSkill(deps = {}) {
  // Legacy deps kept for backward compat with server wiring
  const normalizeSessionId = deps.normalizeSessionId || ((s) => toText(s, "thunderclaw-main"));

  // Create the feature pipeline with model config from xbrain store
  // Supports model switching: when user changes model in 虾脑, pipeline follows.
  let pipeline = null;
  function getPipeline() {
    if (pipeline) return pipeline;
    if (typeof deps.getModelConfig === "function") {
      // Full model config: supports any provider (DeepSeek, OpenAI, Anthropic, etc.)
      pipeline = createFeaturePipeline({ getModelConfig: deps.getModelConfig });
    } else {
      // Backward compat: DeepSeek-only via getApiKey
      pipeline = createFeaturePipeline({
        getApiKey: () => {
          const storeKey = toText(typeof deps.getApiKey === "function" ? deps.getApiKey() : "");
          if (storeKey) return storeKey;
          return toText(process.env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_KEY || "");
        },
      });
    }
    return pipeline;
  }

  /**
   * Extract trading intent candidates from conversation.
   * Uses the 3-stage pipeline: intent detection → code generation → validation.
   */
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

    const runtimeModelRef = toText(params.runtimeModelRef || "");
    const sessionId = normalizeSessionId(toText(params.sessionId || "thunderclaw-main"));

    try {
      // Run the full pipeline: detect intent → generate code → validate
      const result = await getPipeline().run({
        userMessage,
        assistantReply,
      });

      if (!result.ok) {
        return {
          ok: true,
          intentDetected: false,
          confidence: 0,
          reasoning: toText(result.error || "pipeline error"),
          candidates: [],
          modelRef: runtimeModelRef,
          sessionId,
        };
      }

      // Normalize candidates to match existing API contract
      const candidates = (result.candidates || []).map((c, i) => {
        const normalized = normalizeCandidate(c, i);
        if (!normalized) return null;
        // Carry over generated code from pipeline
        if (c.feature?.generatedCode) {
          normalized.feature.generatedCode = c.feature.generatedCode;
          normalized.feature.codegenStatus = toText(c.feature.codegenStatus, "");
          normalized.feature.codegenError = toText(c.feature.codegenError, "");
          // Map to legacy params format for backward compat
          if (c.feature.generatedCode.indicatorCode) {
            normalized.feature.params.pythonIndicator = c.feature.generatedCode.indicatorCode;
            normalized.feature.params.codeSource = c.feature.generatedCode.codeSource || "pipeline";
          }
        }
        return normalized;
      }).filter(Boolean);

      return {
        ok: true,
        intentDetected: result.intentDetected,
        confidence: result.confidence,
        reasoning: result.reasoning,
        candidates,
        modelRef: runtimeModelRef,
        sessionId,
        source: result.source,
      };
    } catch (error) {
      return {
        ok: true,
        intentDetected: false,
        confidence: 0,
        reasoning: `pipeline error: ${toText(error?.message || error)}`,
        candidates: [],
        modelRef: runtimeModelRef,
        sessionId,
        error: toText(error?.message || error),
      };
    }
  }

  /**
   * Generate (or regenerate) feature code for a specific candidate.
   * Uses pipeline Stage 2 + 3 directly.
   */
  async function generateFeatureCodeForCandidate(params = {}) {
    const rawCandidate = params.candidate && typeof params.candidate === "object" ? params.candidate : {};
    const candidate = normalizeCandidate(rawCandidate, 0);
    if (!candidate || candidate.kind !== "feature") {
      return { ok: false, error: "feature candidate is required" };
    }
    const runtimeModelRef = toText(params.runtimeModelRef || "");
    const sessionId = normalizeSessionId(toText(params.sessionId || "thunderclaw-main"));

    try {
      const result = await getPipeline().generateAndValidate(candidate.feature);
      if (result.ok && result.code) {
        candidate.feature.generatedCode = result.code;
        candidate.feature.codegenStatus = "validated";
        candidate.feature.codegenError = "";
        // Legacy compat
        candidate.feature.params.pythonIndicator = result.code.indicatorCode || "";
        candidate.feature.params.codeSource = result.code.codeSource || "pipeline";
      } else {
        candidate.feature.codegenStatus = "validation_failed";
        candidate.feature.codegenError = (result.errors || []).join("; ") || "code generation failed";
        if (result.code) {
          candidate.feature.generatedCode = result.code;
        }
      }
      return {
        ok: true,
        candidate,
        sessionId,
        modelRef: runtimeModelRef,
      };
    } catch (error) {
      candidate.feature.codegenStatus = "error";
      candidate.feature.codegenError = toText(error?.message || error);
      return {
        ok: true,
        candidate,
        sessionId,
        modelRef: runtimeModelRef,
      };
    }
  }

  /**
   * Detect intent and generate clarifying questions (fast, no code generation).
   */
  async function detectAndClarify(params = {}) {
    const userMessage = toText(params.userMessage);
    const assistantReply = toText(params.assistantReply);
    if (!userMessage && !assistantReply) {
      return { ok: true, intentDetected: false, headline: "", featureConcept: null, clarifyingQuestions: [] };
    }
    try {
      return await getPipeline().detectAndClarify({ userMessage, assistantReply });
    } catch (error) {
      return { ok: false, intentDetected: false, error: toText(error?.message || error) };
    }
  }

  /**
   * Generate feature from user's clarification choices (heavy, deferred).
   */
  async function generateFromClarification(params = {}) {
    try {
      return await getPipeline().generateFromClarification(params);
    } catch (error) {
      return { ok: false, error: toText(error?.message || error) };
    }
  }

  return {
    extractTradingIntentCandidates,
    generateFeatureCodeForCandidate,
    detectAndClarify,
    generateFromClarification,
  };
}
