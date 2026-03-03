/**
 * Pipeline Stage 1: Intent Detection
 *
 * Analyzes conversation to extract actionable trading feature candidates.
 * Uses LLM API directly for speed, falls back to declarative skill
 * keyword matching when the API is unavailable.
 */

import { toText, clampNumber, parseJsonLoose } from "../../lib/utils.js";
import {
  INTENT_DETECTION_SYSTEM_PROMPT,
  buildIntentDetectionUserMessage,
} from "./prompts/intent-detection.js";
import { runHeuristicIntentSkills } from "../intent-skills/index.js";

const FEATURE_GROUPS = new Set(["trend", "momentum", "volatility", "risk", "execution", "signal_external", "custom"]);
const FEATURE_KINDS = new Set([
  "ema", "sma", "rsi", "adx", "atr", "volume", "price_action",
  "macd", "bollinger", "stochastic", "cci", "mfi", "obv",
  "news_sentiment", "social_sentiment", "prediction_market", "custom",
]);

function normalizeCandidate(rawLike, index = 0) {
  const raw = rawLike && typeof rawLike === "object" ? rawLike : {};
  const feature = raw.feature && typeof raw.feature === "object" ? raw.feature : {};
  const name = toText(feature.name || raw.name || "").toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 48);
  if (!name) return null;
  const group = FEATURE_GROUPS.has(toText(feature.group, "").toLowerCase())
    ? toText(feature.group).toLowerCase()
    : "custom";
  const kind = FEATURE_KINDS.has(toText(feature.kind, "").toLowerCase())
    ? toText(feature.kind).toLowerCase()
    : "custom";
  const params = feature.params && typeof feature.params === "object" ? { ...feature.params } : {};
  return {
    candidateId: toText(raw.candidateId, `cand_feature_${name}_${index}`),
    kind: "feature",
    title: toText(raw.title || feature.name || name),
    summary: toText(raw.summary || feature.description || "来自对话的交易特征候选"),
    confidence: clampNumber(raw.confidence, 0, 1, 0.7),
    feature: {
      name,
      group,
      kind,
      description: toText(feature.description, "交易特征"),
      params,
      indicatorLogic: toText(feature.indicatorLogic, ""),
      entryCondition: toText(feature.entryCondition, ""),
      exitCondition: toText(feature.exitCondition, ""),
    },
  };
}

function buildHeuristicFallback(params = {}) {
  const userMessage = toText(params.userMessage).toLowerCase();
  const assistantReply = toText(params.assistantReply).toLowerCase();
  const merged = `${userMessage}\n${assistantReply}`;

  const skillResult = runHeuristicIntentSkills({
    userMessage,
    assistantReply,
    mergedText: merged,
  });

  if (!skillResult.intentDetected) {
    return {
      intentDetected: false,
      confidence: 0.2,
      reasoning: toText(skillResult.reasoning, "对话中缺少明确交易意图"),
      candidates: [],
      source: "heuristic",
    };
  }

  const candidates = (Array.isArray(skillResult.featureCandidates) ? skillResult.featureCandidates : [])
    .map((c, i) => normalizeCandidate(c, i))
    .filter(Boolean)
    .slice(0, 4);

  // If heuristic found intent but no feature candidates, add defaults based on detected context
  if (candidates.length === 0) {
    const hasEma = merged.includes("ema") || merged.includes("均线") || merged.includes("趋势");
    const hasRsi = merged.includes("rsi") || merged.includes("超买") || merged.includes("超卖");
    if (hasEma) {
      candidates.push(normalizeCandidate({
        candidateId: "cand_feature_ema_trend",
        kind: "feature",
        title: "EMA 趋势特征",
        confidence: 0.68,
        feature: {
          name: "ema_crossover",
          group: "trend",
          kind: "ema",
          description: "EMA快慢线交叉信号",
          params: { fast_period: 12, slow_period: 26 },
          indicatorLogic: "EMA12与EMA26的交叉",
          entryCondition: "快线上穿慢线",
          exitCondition: "快线下穿慢线",
        },
      }));
    }
    if (hasRsi) {
      candidates.push(normalizeCandidate({
        candidateId: "cand_feature_rsi",
        kind: "feature",
        title: "RSI 动量特征",
        confidence: 0.66,
        feature: {
          name: "rsi_signal",
          group: "momentum",
          kind: "rsi",
          description: "RSI超买超卖信号",
          params: { period: 14, oversold: 30, overbought: 70 },
          indicatorLogic: "RSI(14)的超买超卖判断",
          entryCondition: "RSI低于30",
          exitCondition: "RSI高于70",
        },
      }));
    }
    if (candidates.length === 0) {
      candidates.push(normalizeCandidate({
        candidateId: "cand_feature_ema_default",
        kind: "feature",
        title: "EMA 趋势特征",
        confidence: 0.6,
        feature: {
          name: "ema_crossover",
          group: "trend",
          kind: "ema",
          description: "默认EMA趋势特征",
          params: { fast_period: 12, slow_period: 26 },
          indicatorLogic: "EMA12/26交叉",
          entryCondition: "快线上穿慢线",
          exitCondition: "快线下穿慢线",
        },
      }));
    }
  }

  return {
    intentDetected: true,
    confidence: clampNumber(skillResult.confidence, 0, 1, 0.7),
    reasoning: toText(skillResult.reasoning, "启用本地技能提取交易意图"),
    candidates,
    source: "heuristic",
  };
}

/**
 * Create the intent detector with an LLM client dependency.
 * @param {{ llmClient: Object }} deps
 */
export function createIntentDetector(deps = {}) {
  const llmClient = deps.llmClient;

  /**
   * Detect trading intent from conversation.
   * @param {Object} params
   * @param {string} params.userMessage
   * @param {string} params.assistantReply
   * @returns {Promise<Object>}
   */
  async function detectIntent(params = {}) {
    const userMessage = toText(params.userMessage);
    const assistantReply = toText(params.assistantReply);
    if (!userMessage && !assistantReply) {
      return { intentDetected: false, confidence: 0, reasoning: "", candidates: [], source: "empty" };
    }

    // Try LLM API first
    if (llmClient) {
      try {
        const result = await llmClient.chatCompletionJson({
          messages: [
            { role: "system", content: INTENT_DETECTION_SYSTEM_PROMPT },
            { role: "user", content: buildIntentDetectionUserMessage({ userMessage, assistantReply }) },
          ],
          temperature: 0.2,
          maxTokens: 2048,
          timeoutMs: 60_000,
        });
        if (result.ok && result.data) {
          const data = result.data;
          const candidates = (Array.isArray(data.candidates) ? data.candidates : [])
            .map((c, i) => normalizeCandidate(c, i))
            .filter(Boolean)
            .slice(0, 4);
          const intentDetected = Boolean(data.intentDetected) && candidates.length > 0;
          return {
            intentDetected,
            confidence: clampNumber(data.confidence, 0, 1, intentDetected ? 0.75 : 0.15),
            reasoning: toText(data.reasoning, ""),
            candidates,
            source: "llm",
          };
        }
        // API call succeeded but no valid data → fall through to heuristic
      } catch {
        // API error → fall through to heuristic
      }
    }

    // Fallback: heuristic keyword matching
    return buildHeuristicFallback({ userMessage, assistantReply });
  }

  return { detectIntent };
}
