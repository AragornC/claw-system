#!/usr/bin/env node
/**
 * E2E Pipeline Test
 *
 * Tests the complete feature generation pipeline:
 * 1. Intent detection from conversation
 * 2. Code generation for detected features
 * 3. Code validation
 * 4. Feature evaluation verification (different conversations → different code/value series)
 *
 * Usage: DEEPSEEK_API_KEY=sk-xxx node scripts/e2e-pipeline-test.js
 */

import { createFeaturePipeline } from "../server/core/pipeline/index.js";
import { createFreqtradeBacktestAdapter } from "../server/core/freqtrade-backtest-adapter.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..", "..");

const apiKey = process.env.DEEPSEEK_API_KEY || "sk-4f09f8d07cf24711b398274ee11a13f9";
process.env.DEEPSEEK_API_KEY = apiKey;
// Set freqtrade command
const ftCmd = path.join(ROOT_DIR, ".thunderclaw", "freqtrade-venv", "bin", "freqtrade");
process.env.THUNDERCLAW_FREQTRADE_CMD = ftCmd;
// Disable external live signal fetches for deterministic tests
process.env.THUNDERCLAW_EXTERNAL_SIGNAL_LIVE = "0";
process.env.THUNDERCLAW_EXTERNAL_SIGNAL_STRICT = "0";

function log(stage, msg) {
  console.log(`[${stage}] ${msg}`);
}

async function testPipeline(conversationId, userMessage, assistantReply) {
  log(conversationId, `Starting pipeline for: "${userMessage.slice(0, 60)}..."`);
  const pipeline = createFeaturePipeline({ getApiKey: () => apiKey });

  // Stage 1+2+3: Full pipeline run
  log(conversationId, "Running full pipeline (intent → code → validate)...");
  const result = await pipeline.run({ userMessage, assistantReply });

  log(conversationId, `Intent detected: ${result.intentDetected} (confidence: ${result.confidence?.toFixed(2)}, source: ${result.source})`);
  log(conversationId, `Reasoning: ${result.reasoning?.slice(0, 100)}`);
  log(conversationId, `Candidates: ${result.candidates?.length || 0}`);

  if (!result.candidates?.length) {
    log(conversationId, "⚠️ No candidates produced");
    return { conversationId, result, backtest: null };
  }

  // Show each candidate's code
  for (const cand of result.candidates) {
    const code = cand.feature?.generatedCode;
    const status = cand.feature?.codegenStatus || "unknown";
    log(conversationId, `  Feature: ${cand.feature?.name} (${cand.feature?.kind}) → codegen: ${status}`);
    if (code?.featureCode) {
      log(conversationId, `    Code lines: ${code.featureCode.split("\n").length}`);
      log(conversationId, `    Has compute_feature: ${code.featureCode.includes("def compute_feature")}`);
      log(conversationId, `    Source: ${code.codeSource}`);
    }
    if (cand.feature?.codegenError) {
      log(conversationId, `    ⚠️ Error: ${cand.feature.codegenError}`);
    }
  }

  // Run feature evaluation with generated features
  log(conversationId, "Running feature evaluation with generated code...");
  const adapter = createFreqtradeBacktestAdapter({ command: ftCmd });
  try {
    const evaluation = await adapter.runFeatureEvaluation({
      features: result.candidates.map(c => c.feature),
      rangeDays: 14,
      pair: "BTC/USDT",
      timeframe: "1h",
    });
    log(conversationId, `Evaluation results:`);
    log(conversationId, `  Bars: ${evaluation?.barCount || 0}`);
    log(conversationId, `  Columns: ${(evaluation?.featureColumns || []).join(", ") || "(none)"}`);
    return { conversationId, result, evaluation };
  } catch (error) {
    log(conversationId, `⚠️ Evaluation error: ${error.message}`);
    return { conversationId, result, evaluation: null };
  }
}

async function testNonFeatureConversation(conversationId, userMessage, assistantReply) {
  log(conversationId, `Checking non-feature conversation: "${userMessage}"`);
  const pipeline = createFeaturePipeline({ getApiKey: () => apiKey });
  const result = await pipeline.run({ userMessage, assistantReply });
  log(conversationId, `Intent detected: ${result.intentDetected}`);
  return result;
}

async function main() {
  log("SETUP", `DeepSeek API key: ${apiKey.slice(0, 8)}...`);
  log("SETUP", `Freqtrade/Python bridge: ${ftCmd}`);

  // Test 1: DeepSeek connectivity
  log("HEALTH", "Testing DeepSeek API connectivity...");
  const pipeline = createFeaturePipeline({ getApiKey: () => apiKey });
  const health = await pipeline.healthCheck();
  log("HEALTH", `DeepSeek API: ${health.ok ? "✅ OK" : `❌ ${health.error}`}`);

  // Test 2: Conversation A - EMA trend strategy
  const resultA = await testPipeline(
    "CONV_A",
    "帮我做一个BTC的EMA趋势跟踪策略，用12和26周期的EMA交叉作为入场信号，同时加一个ATR波动率过滤",
    "好的，我建议使用EMA 12/26交叉策略，当快线(EMA12)上穿慢线(EMA26)时做多。同时加入ATR(14)作为波动率过滤器，只在ATR显示合理波动时才入场。止损设在2%，止盈设在4%。",
  );

  console.log("\n" + "=".repeat(60) + "\n");

  // Test 3: Conversation B - RSI reversal strategy
  const resultB = await testPipeline(
    "CONV_B",
    "我想要一个ETH的RSI超卖反弹策略，RSI低于25就做多，配合MACD确认",
    "理解，我推荐RSI(14)超卖策略配合MACD确认。当RSI降到25以下时标记超卖区域，然后等MACD柱状图由负转正确认反弹，此时入场做多。RSI回到70以上或MACD转负时出场。",
  );

  console.log("\n" + "=".repeat(60) + "\n");

  // Differential analysis
  log("DIFF", "=== Differential Analysis ===");
  const aFeatures = (resultA.result?.candidates || []).map(c => c.feature?.name).join(", ");
  const bFeatures = (resultB.result?.candidates || []).map(c => c.feature?.name).join(", ");
  log("DIFF", `Conv A features: ${aFeatures || "(none)"}`);
  log("DIFF", `Conv B features: ${bFeatures || "(none)"}`);

  const aColumns = (resultA.evaluation?.featureColumns || []).join(", ");
  const bColumns = (resultB.evaluation?.featureColumns || []).join(", ");
  log("DIFF", `Conv A columns: ${aColumns || "(none)"}`);
  log("DIFF", `Conv B columns: ${bColumns || "(none)"}`);

  // Check code is different
  const aCode = (resultA.result?.candidates || [])[0]?.feature?.generatedCode?.featureCode || "";
  const bCode = (resultB.result?.candidates || [])[0]?.feature?.generatedCode?.featureCode || "";
  const codeDiff = aCode !== bCode;
  log("DIFF", `Generated code differs: ${codeDiff ? "✅ YES" : "❌ NO (same code!)"}`);

  // Verify both produced candidates
  const bothProducedCandidates = (resultA.result?.candidates?.length > 0) && (resultB.result?.candidates?.length > 0);
  log("DIFF", `Both produced candidates: ${bothProducedCandidates ? "✅ YES" : "❌ NO"}`);

  // Verify both have validated code
  const aValidated = (resultA.result?.candidates || []).some(c => c.feature?.codegenStatus === "validated");
  const bValidated = (resultB.result?.candidates || []).some(c => c.feature?.codegenStatus === "validated");
  log("DIFF", `Conv A has validated code: ${aValidated ? "✅ YES" : "❌ NO"}`);
  log("DIFF", `Conv B has validated code: ${bValidated ? "✅ YES" : "❌ NO"}`);

  const nonFeatureA = await testNonFeatureConversation(
    "NON_FEATURE_A",
    "今天比特币行情怎么样",
    "给我简单讲讲。",
  );
  const nonFeatureB = await testNonFeatureConversation(
    "NON_FEATURE_B",
    "解释一下 RSI 指标是什么",
    "我想先了解概念。",
  );

  // Final verdict
  console.log("\n" + "=".repeat(60));
  const allPassed = bothProducedCandidates
    && aValidated
    && bValidated
    && codeDiff
    && nonFeatureA.intentDetected === false
    && nonFeatureB.intentDetected === false;
  log("VERDICT", allPassed ? "✅ ALL CHECKS PASSED" : "⚠️ SOME CHECKS FAILED");
  log("VERDICT", JSON.stringify({
    bothProducedCandidates,
    aValidated,
    bValidated,
    codeDiff,
    nonFeatureA: nonFeatureA.intentDetected,
    nonFeatureB: nonFeatureB.intentDetected,
  }));

  process.exit(allPassed ? 0 : 1);
}

main().catch(err => {
  console.error("E2E test crashed:", err);
  process.exit(1);
});
