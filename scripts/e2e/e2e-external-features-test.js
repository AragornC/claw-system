#!/usr/bin/env node
/**
 * E2E External Features Test
 *
 * Tests the complete flow for external data source features:
 * 1. News sentiment → clarification → generate → apply
 * 2. Social media sentiment → clarification → generate → apply
 * 3. Prediction market → clarification → generate → apply
 * 4. Verifies proxy mode code is generated and can be applied
 *
 * Usage: DEEPSEEK_API_KEY=sk-xxx node scripts/e2e-external-features-test.js
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..", "..");
const PORT = 13461;
const BASE = `http://127.0.0.1:${PORT}`;
const API_KEY = process.env.DEEPSEEK_API_KEY || "sk-4f09f8d07cf24711b398274ee11a13f9";

function log(tag, msg) { console.log(`[${tag}] ${msg}`); }

async function post(urlPath, body, timeoutMs = 120000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const resp = await fetch(BASE + urlPath, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    return await resp.json();
  } finally { clearTimeout(timer); }
}

async function waitForServer(maxMs = 45000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const resp = await fetch(`${BASE}/api/status`, { signal: AbortSignal.timeout(3000) });
      if (resp.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

function buildEvalBars(count = 240, stepSec = 3600) {
  const out = [];
  let price = 65000;
  for (let i = 0; i < count; i += 1) {
    const time = 1700000000 + i * stepSec;
    const drift = Math.sin(i / 9) * 0.006 + Math.cos(i / 15) * 0.003;
    const next = price * (1 + drift);
    out.push({
      time,
      open: price,
      high: Math.max(price, next) * 1.002,
      low: Math.min(price, next) * 0.998,
      close: next,
      volume: 1000 + i,
    });
    price = next;
  }
  return out;
}

const EXTERNAL_SCENARIOS = [
  {
    id: "news_sentiment",
    message: "帮我分析最近的加密货币新闻，判断市场情绪是偏多还是偏空，做一个新闻情绪特征",
    description: "新闻情绪特征 (external: news)",
    expectedKindHints: ["news", "sentiment"],
  },
  {
    id: "social_buzz",
    message: "twitter上大家都在讨论什么币？帮我做一个社交热度指标来判断市场情绪",
    description: "社交媒体热度特征 (external: social)",
    expectedKindHints: ["social", "twitter", "buzz"],
  },
  {
    id: "prediction_market",
    message: "polymarket的赔率数据可以用来预测加密货币走势吗？帮我做一个预测市场信号",
    description: "预测市场特征 (external: prediction)",
    expectedKindHints: ["prediction", "polymarket", "market"],
  },
];

async function runExternalScenario(scenario) {
  const result = { id: scenario.id, description: scenario.description, checks: {} };

  // Step 1: Send via /api/ai/chat to test full fast-path flow
  log(scenario.id, `💬 "${scenario.message.slice(0, 60)}..."`);
  const chatResult = await post("/api/ai/chat", { message: scenario.message }, 90000);

  result.checks.chatOk = Boolean(chatResult?.ok);
  result.checks.source = String(chatResult?.source || "");
  result.checks.hasClarification = Boolean(
    chatResult?.clarification?.intentDetected
  );
  result.checks.emptyReply = !String(chatResult?.reply || "").trim();

  log(scenario.id, `  Chat OK: ${result.checks.chatOk}, Source: ${result.checks.source}`);
  log(scenario.id, `  Clarification: ${result.checks.hasClarification}`);
  log(scenario.id, `  Reply empty (card-only): ${result.checks.emptyReply}`);

  if (chatResult?.clarification?.headline) {
    log(scenario.id, `  Headline: ${chatResult.clarification.headline}`);
  }

  // Step 2: Also test direct clarification endpoint
  log(scenario.id, `  Testing direct clarify...`);
  const clarifyResult = await post("/api/strategy/intent-clarify", {
    userMessage: scenario.message,
    assistantReply: "",
  }, 60000);
  result.checks.clarifyIntentDetected = Boolean(clarifyResult?.intentDetected);
  result.checks.hasQuestions = (clarifyResult?.clarifyingQuestions || []).length >= 1;
  log(scenario.id, `  Clarify: intent=${clarifyResult?.intentDetected}, questions=${(clarifyResult?.clarifyingQuestions || []).length}`);

  // Step 3: Confirm with default choices
  const questions = clarifyResult?.clarifyingQuestions || chatResult?.clarification?.clarifyingQuestions || [];
  const featureConcept = clarifyResult?.featureConcept || chatResult?.clarification?.featureConcept || { name: scenario.id, description: scenario.description, category: "custom" };
  const userChoices = {};
  questions.forEach((q) => {
    if (q.options && q.options.length) userChoices[q.id] = q.options[0].value;
  });

  log(scenario.id, `  Confirming with choices: ${JSON.stringify(userChoices)}`);
  const confirmResult = await post("/api/strategy/intent-confirm", {
    featureConcept,
    userChoices,
    userMessage: scenario.message,
  }, 180000);

  result.checks.confirmOk = Boolean(confirmResult?.ok);
  result.checks.hasCode = Boolean(confirmResult?.generatedCode?.featureCode);
  result.checks.hasResultSummary = Boolean(confirmResult?.resultSummary);
  result.checks.codeSource = String(confirmResult?.source || "");
  log(scenario.id, `  Confirm OK: ${result.checks.confirmOk}, Code: ${result.checks.hasCode}, Source: ${result.checks.codeSource}`);
  if (confirmResult?.resultSummary) {
    log(scenario.id, `  Summary: ${String(confirmResult.resultSummary).slice(0, 120)}...`);
  }
  if (confirmResult?.error) {
    log(scenario.id, `  Error: ${confirmResult.error}`);
  }

  // Step 4: Apply to feature store
  if (confirmResult?.ok && confirmResult?.feature) {
    log(scenario.id, `  Applying feature: ${confirmResult.feature.name || "unknown"}...`);
    const applyResult = await post("/api/strategy/intent-candidates/apply", {
      candidate: {
        candidateId: `ext_${scenario.id}`,
        kind: "feature",
        title: confirmResult.feature.name || scenario.id,
        feature: {
          ...confirmResult.feature,
          generatedCode: confirmResult.generatedCode || null,
        },
      },
      source: "e2e_external_test",
    });
    result.checks.applyOk = Boolean(applyResult?.ok);
    result.checks.applyError = String(applyResult?.error || "");
    log(scenario.id, `  Apply: ${result.checks.applyOk ? "✅" : "❌"} ${applyResult?.reply || applyResult?.error || ""}`);
  } else {
    result.checks.applyOk = false;
    result.checks.applyError = "no feature to apply";
  }

    // Step 5: Check for requiredConfig (external features may declare API key needs)
    const reqConfig = confirmResult?.generatedCode?.requiredConfig || [];
    result.checks.hasRequiredConfig = reqConfig.length > 0;
    result.checks.requiredConfigKeys = reqConfig.map((c) => c.key || "").filter(Boolean);
    log(scenario.id, `  Required config: ${result.checks.hasRequiredConfig ? reqConfig.map((c) => c.key).join(", ") : "none"}`);

    // Check that code contains real data-fetching patterns (not proxy)
    const code = String(confirmResult?.generatedCode?.featureCode || "");
    result.checks.hasRealDataFetch = code.includes("requests") || code.includes("urllib") || code.includes("http");
    result.checks.hasTryExcept = code.includes("try:") || code.includes("except");
    log(scenario.id, `  Real data fetch: ${result.checks.hasRealDataFetch}, Try/except: ${result.checks.hasTryExcept}`);

    if (confirmResult?.feature?.name) {
      const evalResult = await post("/api/strategy/features/evaluate", {
        featureIds: [confirmResult.feature.name],
        rangeDays: 14,
        pair: "BTC/USDT",
        timeframe: "1h",
        bars: buildEvalBars(240),
      });
      result.checks.evalOk = Boolean(evalResult?.ok);
      const featureCols = Array.isArray(evalResult?.featureColumns) ? evalResult.featureColumns : [];
      const featureCol = featureCols.find((col) => col.indexOf("tc_feat_") === 0) || "";
      const series = Array.isArray(evalResult?.featureTimeSeries) ? evalResult.featureTimeSeries : [];
      const nonZero = featureCol
        ? series.some((row) => {
            const value = Number(row && row[featureCol]);
            return Number.isFinite(value) && Math.abs(value) > 1e-8;
          })
        : false;
      result.checks.realSignalFetched = nonZero;
      log(scenario.id, `  Eval: ${result.checks.evalOk}, Non-zero signal: ${result.checks.realSignalFetched}`);
    }

  return result;
}

async function main() {
  log("SETUP", "Starting ThunderClaw server...");
  const serverProc = spawn("node", ["scripts/thunderclaw-server.js"], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      THUNDERCLAW_PORT: String(PORT),
      DEEPSEEK_API_KEY: API_KEY,
      THUNDERCLAW_EXTERNAL_SIGNAL_LIVE: "0",
      THUNDERCLAW_EXTERNAL_SIGNAL_STRICT: "0",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let serverStderr = "";
  serverProc.stderr.on("data", (d) => { serverStderr += String(d); });
  serverProc.stdout.on("data", () => {});

  try {
    const ready = await waitForServer(45000);
    if (!ready) throw new Error(`Server not ready: ${serverStderr.slice(-300)}`);
    log("SETUP", "✅ Server ready");

    const results = [];
    for (const scenario of EXTERNAL_SCENARIOS) {
      console.log("\n" + "─".repeat(60));
      results.push(await runExternalScenario(scenario));
    }

    // Summary
    console.log("\n" + "═".repeat(60));
    log("SUMMARY", "=== External Features E2E Results ===");
    const allChecks = {
      allChatOk: results.every((r) => r.checks.chatOk),
      allClarifyDetected: results.every((r) => r.checks.clarifyIntentDetected || r.checks.hasClarification),
      allConfirmOk: results.every((r) => r.checks.confirmOk),
      allHasCode: results.every((r) => r.checks.hasCode),
      allApplyOk: results.every((r) => r.checks.applyOk),
      allEmptyReply: results.every((r) => r.checks.emptyReply),
      anyRealDataFetch: results.some((r) => r.checks.hasRealDataFetch),
      anyTryExcept: results.some((r) => r.checks.hasTryExcept),
    };
    log("SUMMARY", JSON.stringify(allChecks, null, 2));

    results.forEach((r) => {
      const pass = r.checks.confirmOk && r.checks.applyOk;
      log("RESULT", `${pass ? "✅" : "❌"} ${r.id}: confirm=${r.checks.confirmOk} apply=${r.checks.applyOk} code=${r.checks.hasCode}`);
    });

    const passed = allChecks.allConfirmOk && allChecks.allApplyOk && allChecks.allHasCode;
    log("VERDICT", passed ? "✅ EXTERNAL FEATURES E2E PASSED" : "⚠️ SOME CHECKS FAILED");
    process.exit(passed ? 0 : 1);

  } finally {
    try { serverProc.kill("SIGTERM"); } catch {}
    await new Promise((r) => setTimeout(r, 1000));
    try { serverProc.kill("SIGKILL"); } catch {}
  }
}

main().catch((err) => { console.error("E2E crashed:", err); process.exit(1); });
