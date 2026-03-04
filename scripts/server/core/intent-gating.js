/**
 * Intent Gating Pipeline
 *
 * 4-layer filtering to prevent hallucinated feature-generation triggers:
 *
 * Layer 0: Hard Filter — regex/keyword rules for obvious non-creation intents
 * Layer 1: Fast Classifier — lightweight rule-based intent classification
 * Layer 2: LLM Deep Analysis — only runs if L0/L1 don't clearly reject
 * Layer 3: Confidence Calibration — combine all signals, threshold gate
 *
 * Returns: { shouldTriggerClarification: boolean, intent: string, confidence: number, reason: string }
 */

function toText(v, fb = "") { return String(v ?? "").trim() || fb; }

// ═══ Layer 0: Hard Filter (regex, <1ms) ════════════════════════════

/** Patterns that indicate QUERY/EXPLAIN intent, never creation */
const QUERY_PATTERNS = [
  /是什么意思/,
  /什么意思/,
  /什么是/,
  /是什么/,
  /是啥/,
  /啥意思/,
  /解释[一下]*$/,
  /帮我解释/,
  /请解释/,
  /能解释/,
  /说明[一下]*$/,
  /怎么理解/,
  /怎么看/,
  /看看怎么样/,
  /评估[一下]*/,
  /分析[一下]*这个/,
  /怎么优化/,
  /能优化/,
  /帮我优化/,
  /改进[一下]*/,
  /调整[一下]*/,
  /修改[一下]*/,
  /有什么问题/,
  /哪里有问题/,
  /为什么[会出]?[错失败]/,
  /报错/,
  /出错/,
  /失败了/,
  /不对/,
  /不太对/,
];

/** Patterns that strongly indicate CREATION intent */
const CREATION_PATTERNS = [
  /帮我[做创建生成制作搭建]/,
  /做一个.*[特征指标信号策略]/,
  /创建.*[特征指标信号策略]/,
  /生成.*[特征指标信号策略]/,
  /[新增添加加]一个/,
  /我想要一个/,
  /我需要一个/,
  /能不能做/,
  /可以做/,
];

/** Words that reference existing features (query context) */
const REFERENCE_WORDS = [
  "刚才", "刚刚", "之前", "上面", "上一个", "那个",
  "这个特征", "那个特征", "这个指标", "那个指标",
  "生成的", "创建的",
];

function layer0HardFilter(message, existingFeatureNames = []) {
  const text = toText(message).toLowerCase();
  if (!text || text.length < 4) return { pass: false, intent: "too_short", reason: "消息过短" };

  // Check if message references existing feature names → likely a query
  const referencesExisting = existingFeatureNames.some((name) => {
    const n = toText(name).toLowerCase();
    return n && text.includes(n);
  });

  // Check for query patterns
  const matchesQuery = QUERY_PATTERNS.some((pat) => pat.test(text));
  const hasReferenceWord = REFERENCE_WORDS.some((w) => text.includes(w));

  // If references existing feature AND uses query language → definitely not creation
  if (referencesExisting && matchesQuery) {
    return { pass: false, intent: "query_existing", reason: "引用已有特征并使用查询语句" };
  }

  // If uses query/evaluation language with reference words → likely not creation
  if (matchesQuery && hasReferenceWord) {
    return { pass: false, intent: "query_reference", reason: "引用之前内容并使用查询语句" };
  }

  // Pure query patterns with short messages → reject
  if (matchesQuery && text.length < 30) {
    return { pass: false, intent: "short_query", reason: "短查询语句" };
  }

  // Check for strong creation patterns
  const matchesCreation = CREATION_PATTERNS.some((pat) => pat.test(text));
  if (matchesCreation) {
    return { pass: true, intent: "creation_explicit", reason: "明确的创建意图" };
  }

  // Ambiguous — let Layer 1 decide
  return { pass: null, intent: "ambiguous", reason: "需要进一步判断" };
}

// ═══ Layer 1: Fast Classifier (keyword-based, <1ms) ════════════════

const INTENT_KEYWORDS = {
  create: ["做", "创建", "生成", "新增", "搭建", "设计", "实现", "制作", "开发", "构建"],
  query: ["查看", "查询", "看看", "显示", "列出", "展示"],
  evaluate: ["评估", "评价", "回测", "测试", "验证", "检验", "分析"],
  modify: ["优化", "改进", "调整", "修改", "更新", "升级", "改造"],
  explain: ["解释", "说明", "什么是", "含义", "理解", "意思"],
  chat: ["你好", "谢谢", "再见", "帮助", "你是谁", "能做什么"],
};

const TRADING_DOMAIN_KEYWORDS = [
  "特征", "指标", "信号", "策略", "趋势", "动量", "波动",
  "均线", "ema", "sma", "rsi", "macd", "bollinger", "atr", "adx",
  "新闻", "情绪", "社交", "twitter", "预测", "成交量",
  "买入", "卖出", "入场", "出场", "止损", "止盈",
  "比特币", "以太坊", "btc", "eth",
];

function layer1FastClassifier(message) {
  const text = toText(message).toLowerCase();
  const scores = {};

  for (const [intent, keywords] of Object.entries(INTENT_KEYWORDS)) {
    scores[intent] = keywords.filter((kw) => text.includes(kw)).length;
  }

  const hasTradingDomain = TRADING_DOMAIN_KEYWORDS.some((kw) => text.includes(kw));
  const topIntent = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  const topIntentName = topIntent?.[0] || "chat";
  const topIntentScore = topIntent?.[1] || 0;

  // Only "create" intent with trading domain keywords should proceed
  if (topIntentName === "create" && hasTradingDomain && topIntentScore >= 1) {
    return { pass: true, intent: "create", confidence: 0.7, reason: "创建意图+交易领域" };
  }

  // Explicit non-creation intents
  if (["query", "evaluate", "modify", "explain"].includes(topIntentName) && topIntentScore >= 1) {
    return { pass: false, intent: topIntentName, confidence: 0.6, reason: `${topIntentName}意图更强` };
  }

  // Has trading domain but no clear intent → might be creation (let LLM decide)
  if (hasTradingDomain && text.length > 15) {
    return { pass: null, intent: "trading_ambiguous", confidence: 0.4, reason: "交易领域但意图不明" };
  }

  // Chat or too vague
  if (!hasTradingDomain) {
    return { pass: false, intent: "chat", confidence: 0.3, reason: "非交易领域" };
  }

  return { pass: null, intent: "unclear", confidence: 0.3, reason: "无法确定" };
}

// ═══ Layer 3: Confidence Calibration ═══════════════════════════════

function layer3Calibrate(l0Result, l1Result, l2Result) {
  // L0 hard reject → always reject
  if (l0Result.pass === false) {
    return {
      shouldTriggerClarification: false,
      intent: l0Result.intent,
      confidence: 0,
      reason: `[L0] ${l0Result.reason}`,
      layer: 0,
    };
  }

  // L0 hard accept (explicit creation) → still check L1 confidence
  if (l0Result.pass === true) {
    const l1Boost = l1Result.pass === true ? 0.15 : 0;
    return {
      shouldTriggerClarification: true,
      intent: "create",
      confidence: Math.min(1, 0.8 + l1Boost),
      reason: `[L0] ${l0Result.reason}`,
      layer: 0,
    };
  }

  // L1 hard reject
  if (l1Result.pass === false) {
    return {
      shouldTriggerClarification: false,
      intent: l1Result.intent,
      confidence: 0,
      reason: `[L1] ${l1Result.reason}`,
      layer: 1,
    };
  }

  // L1 hard accept
  if (l1Result.pass === true && !l2Result) {
    return {
      shouldTriggerClarification: true,
      intent: "create",
      confidence: l1Result.confidence || 0.7,
      reason: `[L1] ${l1Result.reason}`,
      layer: 1,
    };
  }

  // L2 (LLM) result available
  if (l2Result) {
    const l2Confidence = Number(l2Result.confidence || 0);
    const l2Detected = Boolean(l2Result.intentDetected);

    // Calibrate: require higher confidence when L0/L1 were ambiguous
    const threshold = (l1Result.pass === true) ? 0.5 : 0.65;

    if (l2Detected && l2Confidence >= threshold) {
      return {
        shouldTriggerClarification: true,
        intent: "create",
        confidence: l2Confidence,
        reason: `[L2] LLM confidence ${(l2Confidence * 100).toFixed(0)}% ≥ threshold ${(threshold * 100).toFixed(0)}%`,
        layer: 2,
      };
    }

    return {
      shouldTriggerClarification: false,
      intent: l2Result.intent || l1Result.intent || "ambiguous",
      confidence: l2Confidence,
      reason: `[L2] LLM confidence ${(l2Confidence * 100).toFixed(0)}% < threshold ${(threshold * 100).toFixed(0)}%`,
      layer: 2,
    };
  }

  // No L2, L0/L1 both ambiguous → don't trigger (conservative)
  return {
    shouldTriggerClarification: false,
    intent: l1Result.intent || "ambiguous",
    confidence: l1Result.confidence || 0.3,
    reason: `[L1] 意图不明确，保守不触发`,
    layer: 1,
  };
}

// ═══ Public API ════════════════════════════════════════════════════

/**
 * Run the full intent gating pipeline.
 *
 * @param {Object} params
 * @param {string} params.message - User message
 * @param {string[]} [params.existingFeatureNames] - Names of existing features for reference detection
 * @param {Object} [params.l2Result] - Optional LLM clarification result (Layer 2)
 * @returns {{ shouldTriggerClarification: boolean, intent: string, confidence: number, reason: string, layer: number }}
 */
export function runIntentGating(params = {}) {
  const message = toText(params.message);
  const existingFeatureNames = Array.isArray(params.existingFeatureNames) ? params.existingFeatureNames : [];
  const l2Result = params.l2Result || null;

  const l0 = layer0HardFilter(message, existingFeatureNames);
  const l1 = layer1FastClassifier(message);

  return layer3Calibrate(l0, l1, l2Result);
}

/**
 * Quick check: should we even bother calling the LLM for intent detection?
 * Returns true if L0+L1 don't hard-reject.
 *
 * @param {string} message
 * @param {string[]} existingFeatureNames
 * @returns {boolean}
 */
export function shouldCallLlmForIntent(message, existingFeatureNames = []) {
  const l0 = layer0HardFilter(message, existingFeatureNames);
  if (l0.pass === false) return false;
  if (l0.pass === true) return true;

  const l1 = layer1FastClassifier(message);
  if (l1.pass === false) return false;
  return true; // ambiguous or positive → let LLM decide
}

// Export individual layers for testing
export { layer0HardFilter, layer1FastClassifier, layer3Calibrate };
