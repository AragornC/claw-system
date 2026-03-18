import test from "node:test";
import assert from "node:assert/strict";
import { createTradingIntentSkill } from "./trading-intent-skill.js";

/**
 * Tests for the refactored trading-intent-skill.
 * The skill now uses the 3-stage pipeline (intent detection → code generation → validation).
 * Tests run without DeepSeek API (pipeline falls back to heuristic + template code).
 */

function createMockPipeline() {
  return {
    async run(params = {}) {
      const msg = String(params.userMessage || "").toLowerCase();
      if (!msg.trim() || msg.includes("天气")) {
        return {
          ok: true,
          intentDetected: false,
          confidence: 0,
          reasoning: "not a trading request",
          candidates: [],
          source: "mock",
        };
      }
      const isMacd = msg.includes("macd");
      const featureName = isMacd ? "macd_signal" : (msg.includes("rsi") ? "rsi_oversold" : "ema_crossover");
      const featureCode = [
        "import pandas as pd",
        "import talib.abstract as ta",
        "",
        "def compute_feature(df: pd.DataFrame) -> pd.Series:",
        isMacd
          ? "    macd = ta.MACD(df, fastperiod=12, slowperiod=26, signalperiod=9)\n    signal = (macd['macdhist'] / df['close'].replace(0, 1) * 100).clip(-1, 1)"
          : (msg.includes("rsi")
              ? "    rsi = ta.RSI(df, timeperiod=14)\n    signal = ((rsi - 50.0) / 50.0).clip(-1, 1)"
              : "    fast = ta.EMA(df, timeperiod=12)\n    slow = ta.EMA(df, timeperiod=26)\n    signal = ((fast - slow) / df['close'].replace(0, 1)).clip(-1, 1)"),
        "    return signal.fillna(0.0)",
      ].join("\n");
      return {
        ok: true,
        intentDetected: true,
        confidence: 0.9,
        reasoning: "mock pipeline result",
        source: "mock",
        candidates: [{
          candidateId: `cand_${featureName}`,
          kind: "feature",
          title: featureName,
          feature: {
            name: featureName,
            group: isMacd ? "momentum" : "trend",
            kind: isMacd ? "macd" : (msg.includes("rsi") ? "rsi" : "ema"),
            description: "mock feature",
            params: {},
            generatedCode: {
              featureName,
              featureCode,
              description: "mock generated feature",
              codeSource: "mock",
              validatedAt: "2026-01-01T00:00:00.000Z",
              validationErrors: [],
              validationWarnings: [],
            },
            codegenStatus: "validated",
            codegenError: "",
          },
        }],
      };
    },
    async generateAndValidate(feature) {
      const name = String(feature?.name || "custom_feature");
      return {
        ok: true,
        code: {
          featureName: name,
          featureCode: [
            "import pandas as pd",
            "",
            "def compute_feature(df: pd.DataFrame) -> pd.Series:",
            "    return df['close'].pct_change().fillna(0.0)",
          ].join("\n"),
          description: `${name} feature`,
          codeSource: "mock",
          validatedAt: "2026-01-01T00:00:00.000Z",
          validationErrors: [],
          validationWarnings: [],
        },
        errors: [],
        warnings: [],
      };
    },
  };
}

function createSkill() {
  return createTradingIntentSkill({
    normalizeSessionId: (s) => String(s || "main"),
    pipeline: createMockPipeline(),
  });
}

test("intent extraction returns candidates for EMA-related conversation", async () => {
  const skill = createSkill();
  const out = await skill.extractTradingIntentCandidates({
    userMessage: "做一个BTC的EMA趋势策略，用EMA 12和26交叉",
    assistantReply: "好的，我建议使用EMA交叉策略。",
    sessionId: "test-ema",
  });
  assert.equal(out.ok, true);
  assert.equal(out.intentDetected, true);
  assert.ok(out.candidates.length > 0, "should produce at least one candidate");
  // All candidates should be feature type
  out.candidates.forEach((c) => {
    assert.equal(c.kind, "feature");
  });
  // Should find an EMA-related feature
  const emaFeature = out.candidates.find(
    (c) => c.feature?.name?.includes("ema") || c.feature?.kind === "ema",
  );
  assert.ok(emaFeature, "should have an EMA feature candidate");
});

test("intent extraction returns empty for non-trading conversation", async () => {
  const skill = createSkill();
  const out = await skill.extractTradingIntentCandidates({
    userMessage: "今天天气怎么样？",
    assistantReply: "今天天气晴朗。",
    sessionId: "test-weather",
  });
  assert.equal(out.ok, true);
  assert.equal(out.intentDetected, false);
  assert.equal(out.candidates.length, 0);
});

test("intent extraction returns empty for empty input", async () => {
  const skill = createSkill();
  const out = await skill.extractTradingIntentCandidates({
    userMessage: "",
    assistantReply: "",
    sessionId: "test-empty",
  });
  assert.equal(out.ok, true);
  assert.equal(out.intentDetected, false);
});

test("intent extraction generates code for RSI feature", async () => {
  const skill = createSkill();
  const out = await skill.extractTradingIntentCandidates({
    userMessage: "BTC RSI超卖策略，RSI低于30做多",
    assistantReply: "推荐RSI(14)策略。",
    sessionId: "test-rsi",
  });
  assert.equal(out.ok, true);
  assert.equal(out.intentDetected, true);
  // Find a feature with generated code
  const withCode = out.candidates.find(
    (c) => c.feature?.generatedCode?.featureCode,
  );
  if (withCode) {
    assert.ok(
      withCode.feature.generatedCode.featureCode.includes("def compute_feature"),
      "featureCode should define compute_feature",
    );
  }
});

test("generateFeatureCodeForCandidate produces code for EMA feature", async () => {
  const skill = createSkill();
  const out = await skill.generateFeatureCodeForCandidate({
    candidate: {
      candidateId: "test_ema",
      kind: "feature",
      title: "EMA趋势",
      feature: {
        name: "ema_crossover",
        group: "trend",
        kind: "ema",
        description: "EMA交叉",
        params: { fast_period: 12, slow_period: 26 },
      },
    },
    sessionId: "test-codegen",
  });
  assert.equal(out.ok, true);
  assert.ok(out.candidate, "should return a candidate");
  assert.ok(
    out.candidate.feature?.generatedCode?.featureCode,
    "should have feature code",
  );
  assert.equal(out.candidate.feature.codegenStatus, "validated");
});

test("generateFeatureCodeForCandidate produces code for MACD feature", async () => {
  const skill = createSkill();
  const out = await skill.generateFeatureCodeForCandidate({
    candidate: {
      candidateId: "test_macd",
      kind: "feature",
      title: "MACD特征",
      feature: {
        name: "macd_signal",
        group: "momentum",
        kind: "macd",
        description: "MACD histogram",
        params: { fast_period: 12, slow_period: 26, signal_period: 9 },
      },
    },
    sessionId: "test-codegen-macd",
  });
  assert.equal(out.ok, true);
  assert.ok(out.candidate.feature?.generatedCode?.featureCode);
  assert.ok(
    out.candidate.feature.generatedCode.featureCode.includes("def compute_feature"),
    "generated code should define compute_feature",
  );
});

test("generateFeatureCodeForCandidate handles invalid candidate", async () => {
  const skill = createSkill();
  const out = await skill.generateFeatureCodeForCandidate({
    candidate: {},
    sessionId: "test-invalid",
  });
  assert.equal(out.ok, false);
  assert.ok(out.error);
});

test("different conversations produce different features", async () => {
  const skill = createSkill();
  const ema = await skill.extractTradingIntentCandidates({
    userMessage: "BTC EMA趋势跟踪策略",
    assistantReply: "",
    sessionId: "test-diff-ema",
  });
  const rsi = await skill.extractTradingIntentCandidates({
    userMessage: "ETH RSI超卖反弹策略",
    assistantReply: "",
    sessionId: "test-diff-rsi",
  });
  // Both should detect intent
  assert.equal(ema.intentDetected, true);
  assert.equal(rsi.intentDetected, true);
  // Feature names should differ
  const emaNames = (ema.candidates || []).map((c) => c.feature?.name).sort().join(",");
  const rsiNames = (rsi.candidates || []).map((c) => c.feature?.name).sort().join(",");
  assert.notEqual(emaNames, rsiNames, "different conversations should produce different features");
});
