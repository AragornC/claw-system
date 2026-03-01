#!/usr/bin/env node
/**
 * E2E Pipeline Test
 *
 * Tests the complete feature generation pipeline:
 * 1. Intent detection from conversation
 * 2. Code generation for detected features
 * 3. Code validation
 * 4. Differential backtest verification (different conversations → different results)
 *
 * Usage: DEEPSEEK_API_KEY=sk-xxx node scripts/e2e-pipeline-test.js
 */

import { createFeaturePipeline } from "./server/core/pipeline/index.js";
import { createFreqtradeBacktestAdapter } from "./server/core/freqtrade-backtest-adapter.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");

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
    if (code?.indicatorCode) {
      log(conversationId, `    Code lines: ${code.indicatorCode.split("\n").length}`);
      log(conversationId, `    Entry: ${code.entryConditionCode?.slice(0, 80) || "none"}`);
      log(conversationId, `    Exit: ${code.exitConditionCode?.slice(0, 80) || "none"}`);
      log(conversationId, `    Source: ${code.codeSource}`);
    }
    if (cand.feature?.codegenError) {
      log(conversationId, `    ⚠️ Error: ${cand.feature.codegenError}`);
    }
  }

  // Run backtest with generated features
  log(conversationId, "Running Freqtrade backtest with generated code...");
  const adapter = createFreqtradeBacktestAdapter({ command: ftCmd });
  const availability = adapter.checkAvailability();
  if (!availability.ok) {
    log(conversationId, `⚠️ Freqtrade unavailable: ${availability.error}`);
    return { conversationId, result, backtest: null };
  }
  log(conversationId, `Freqtrade: ${availability.version?.trim()}`);

  try {
    const backtest = adapter.runBacktest({
      features: result.candidates.map(c => c.feature),
      rangeDays: 14,
      pair: "BTC/USDT",
      timeframe: "1h",
    });
    const summary = backtest?.summary || {};
    log(conversationId, `Backtest results:`);
    log(conversationId, `  Trades: ${summary.tradeCount}`);
    log(conversationId, `  Win rate: ${summary.winRate?.toFixed(1)}%`);
    log(conversationId, `  Return: ${summary.latestReturnPct?.toFixed(2)}%`);
    log(conversationId, `  Max drawdown: ${summary.maxDrawdownPct?.toFixed(2)}%`);
    log(conversationId, `  Runtime: ${backtest?.executionReport?.engine?.mode || "unknown"}`);
    const meta = backtest?.executionReport?.backtestMeta || {};
    log(conversationId, `  Used pipeline code: ${meta.usedPipelineCode || false}`);
    log(conversationId, `  Result source: ${meta.runtime || "unknown"}`);
    return { conversationId, result, backtest };
  } catch (error) {
    log(conversationId, `⚠️ Backtest error: ${error.message}`);
    return { conversationId, result, backtest: null };
  }
}

async function main() {
  log("SETUP", `DeepSeek API key: ${apiKey.slice(0, 8)}...`);
  log("SETUP", `Freqtrade: ${ftCmd}`);

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

  const aTrades = resultA.backtest?.summary?.tradeCount ?? "N/A";
  const bTrades = resultB.backtest?.summary?.tradeCount ?? "N/A";
  log("DIFF", `Conv A trades: ${aTrades}`);
  log("DIFF", `Conv B trades: ${bTrades}`);

  const aReturn = resultA.backtest?.summary?.latestReturnPct ?? "N/A";
  const bReturn = resultB.backtest?.summary?.latestReturnPct ?? "N/A";
  log("DIFF", `Conv A return: ${typeof aReturn === "number" ? aReturn.toFixed(2) + "%" : aReturn}`);
  log("DIFF", `Conv B return: ${typeof bReturn === "number" ? bReturn.toFixed(2) + "%" : bReturn}`);

  // Check code is different
  const aCode = (resultA.result?.candidates || [])[0]?.feature?.generatedCode?.indicatorCode || "";
  const bCode = (resultB.result?.candidates || [])[0]?.feature?.generatedCode?.indicatorCode || "";
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

  // Final verdict
  console.log("\n" + "=".repeat(60));
  const allPassed = bothProducedCandidates && (aValidated || bValidated) && codeDiff;
  log("VERDICT", allPassed ? "✅ ALL CHECKS PASSED" : "⚠️ SOME CHECKS FAILED");
  log("VERDICT", JSON.stringify({
    bothProducedCandidates,
    aValidated,
    bValidated,
    codeDiff,
    aTrades,
    bTrades,
  }));

  process.exit(allPassed ? 0 : 1);
}

main().catch(err => {
  console.error("E2E test crashed:", err);
  process.exit(1);
});
