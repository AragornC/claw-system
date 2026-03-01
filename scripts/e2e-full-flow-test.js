#!/usr/bin/env node
/**
 * E2E Full Flow Test — HTTP level
 *
 * Starts the ThunderClaw server, sends non-professional conversation scenarios,
 * confirms features, runs feature evaluation, and outputs all generated code.
 *
 * Usage:
 *   DEEPSEEK_API_KEY=sk-xxx node scripts/e2e-full-flow-test.js
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const PORT = 13457; // Use a non-default port to avoid conflicts
const BASE = `http://127.0.0.1:${PORT}`;
const API_KEY = process.env.DEEPSEEK_API_KEY || "sk-4f09f8d07cf24711b398274ee11a13f9";
const REPORT_PATH = path.join(ROOT_DIR, "memory", "e2e-generated-code-report.json");

// Non-professional conversation scenarios (no finance background)
const SCENARIOS = [
  {
    id: "daily_buy_timing",
    message: "帮我看看什么时候比特币价格比较稳定适合买，我完全不懂这些",
    description: "日常用户想知道买入时机",
  },
  {
    id: "market_high_low",
    message: "市场涨涨跌跌的，有没有办法判断现在是高点还是低点呢？",
    description: "日常用户想判断市场位置",
  },
  {
    id: "moving_average_tool",
    message: "我听说均线很有用，能帮我做一个简单的提醒工具吗？当价格穿过某条线的时候提醒我",
    description: "日常用户听说了均线概念",
  },
];

function log(tag, msg) { console.log(`[${tag}] ${msg}`); }

async function request(path, init = {}, timeoutMs = 120000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort("timeout"), timeoutMs);
  try {
    const resp = await fetch(BASE + path, { ...init, signal: ac.signal });
    const body = await resp.json().catch(() => ({}));
    return { status: resp.status, ok: resp.ok, body };
  } finally { clearTimeout(timer); }
}

async function waitForServer(maxMs = 30000) {
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

async function runScenario(scenario) {
  const result = { id: scenario.id, description: scenario.description, message: scenario.message };
  log(scenario.id, `💬 Sending: "${scenario.message.slice(0, 50)}..."`);

  // Step 1: Send chat message
  const chat = await request("/api/ai/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: scenario.message }),
  }, 180000);
  result.chatOk = chat.ok && chat.body?.ok;
  result.reply = String(chat.body?.reply || "").slice(0, 200);
  result.intentDetected = Boolean(chat.body?.intentSkill?.intentDetected);
  result.intentConfidence = Number(chat.body?.intentSkill?.confidence || 0);
  result.candidateCount = Array.isArray(chat.body?.intentCandidates) ? chat.body.intentCandidates.length : 0;
  result.candidates = (chat.body?.intentCandidates || []).map((c) => ({
    id: c.candidateId,
    title: c.title,
    featureName: c.feature?.name,
    featureKind: c.feature?.kind,
    codegenStatus: c.feature?.codegenStatus,
    hasCode: Boolean(c.feature?.generatedCode?.indicatorCode),
    indicatorCode: c.feature?.generatedCode?.indicatorCode || c.feature?.params?.pythonIndicator || "",
    entryCode: c.feature?.generatedCode?.entryConditionCode || "",
    exitCode: c.feature?.generatedCode?.exitConditionCode || "",
    codeSource: c.feature?.generatedCode?.codeSource || "",
  }));

  log(scenario.id, `  Reply: ${result.reply.slice(0, 80)}...`);
  log(scenario.id, `  Intent: ${result.intentDetected} (${result.intentConfidence.toFixed(2)}) Candidates: ${result.candidateCount}`);

  // Step 2: Apply first feature candidate (if any)
  const firstCandidate = (chat.body?.intentCandidates || [])[0];
  if (firstCandidate && firstCandidate.kind === "feature") {
    log(scenario.id, `  Applying: ${firstCandidate.feature?.name || firstCandidate.title}`);
    const apply = await request("/api/strategy/intent-candidates/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        candidate: firstCandidate,
        source: "e2e_test",
        sessionId: `e2e-${scenario.id}`,
      }),
    });
    result.applyOk = apply.ok && apply.body?.ok;
    result.applyFeatureName = apply.body?.applied?.feature?.name || "";
    result.applyError = apply.body?.error || "";
    if (result.applyOk) {
      log(scenario.id, `  ✅ Feature applied: ${result.applyFeatureName}`);
    } else {
      log(scenario.id, `  ⚠️ Apply failed: ${result.applyError}`);
    }

    // Step 3: Run feature evaluation
    if (result.applyOk && result.applyFeatureName) {
      log(scenario.id, `  Running feature evaluation...`);
      const evalResult = await request("/api/strategy/features/evaluate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          featureIds: [result.applyFeatureName],
          rangeDays: 7,
        }),
      });
      result.evalOk = evalResult.ok && evalResult.body?.ok;
      result.evalBarCount = evalResult.body?.barCount || 0;
      result.evalColumns = evalResult.body?.featureColumns || [];
      result.evalStats = evalResult.body?.featureStats || {};
      result.evalError = evalResult.body?.error || "";
      if (result.evalOk) {
        log(scenario.id, `  ✅ Feature evaluated: ${result.evalBarCount} bars, columns: ${result.evalColumns.join(", ")}`);
        // Show stats for tc_feat_ columns
        Object.entries(result.evalStats).forEach(([col, stats]) => {
          if (col.startsWith("tc_feat_")) {
            log(scenario.id, `    ${col}: mean=${stats.mean?.toFixed(4)} std=${stats.std?.toFixed(4)} min=${stats.min?.toFixed(4)} max=${stats.max?.toFixed(4)}`);
          }
        });
      } else {
        log(scenario.id, `  ⚠️ Eval failed: ${result.evalError}`);
      }
    }
  } else {
    result.applyOk = false;
    result.applyError = "no feature candidate to apply";
    log(scenario.id, `  ⚠️ No feature candidate to apply`);
  }

  return result;
}

async function main() {
  log("SETUP", `DeepSeek API key: ${API_KEY.slice(0, 8)}...`);
  log("SETUP", `Server port: ${PORT}`);

  // Start server as child process
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
  const serverPid = serverProc.pid;
  log("SETUP", `Server PID: ${serverPid}`);

  // Collect server stderr for debugging
  let serverStderr = "";
  serverProc.stderr.on("data", (d) => { serverStderr += String(d); });
  serverProc.stdout.on("data", (d) => { /* suppress */ });

  try {
    // Wait for server to be ready
    const ready = await waitForServer(45000);
    if (!ready) {
      log("ERROR", `Server failed to start. stderr: ${serverStderr.slice(-500)}`);
      throw new Error("Server did not become ready");
    }
    log("SETUP", "✅ Server is ready");

    // Configure DeepSeek API key
    log("SETUP", "Configuring API key...");
    const setup = await request("/api/setup/quick", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "deepseek-api-key", apiKey: API_KEY }),
    }, 60000);
    log("SETUP", `Setup: ${setup.body?.ok ? "✅" : "⚠️"} ${setup.body?.stage || "unknown"}`);

    // Run all scenarios
    const results = [];
    for (const scenario of SCENARIOS) {
      console.log("\n" + "─".repeat(60));
      const result = await runScenario(scenario);
      results.push(result);
    }

    // Summary
    console.log("\n" + "═".repeat(60));
    log("SUMMARY", "=== E2E Full Flow Test Results ===");
    const passed = results.filter((r) => r.intentDetected && r.candidateCount > 0);
    const withCode = results.filter((r) => r.candidates?.some((c) => c.hasCode));
    const applied = results.filter((r) => r.applyOk);
    const evaluated = results.filter((r) => r.evalOk);
    log("SUMMARY", `Scenarios: ${results.length}`);
    log("SUMMARY", `Intent detected: ${passed.length}/${results.length}`);
    log("SUMMARY", `With generated code: ${withCode.length}/${results.length}`);
    log("SUMMARY", `Features applied: ${applied.length}/${results.length}`);
    log("SUMMARY", `Features evaluated: ${evaluated.length}/${results.length}`);

    // Check different features generated
    const allFeatureNames = new Set();
    results.forEach((r) => (r.candidates || []).forEach((c) => {
      if (c.featureName) allFeatureNames.add(c.featureName);
    }));
    log("SUMMARY", `Unique features: ${allFeatureNames.size} (${[...allFeatureNames].join(", ")})`);

    // Output generated code report
    const report = {
      timestamp: new Date().toISOString(),
      scenarios: results.length,
      intentDetectedCount: passed.length,
      withCodeCount: withCode.length,
      appliedCount: applied.length,
      evaluatedCount: evaluated.length,
      uniqueFeatures: [...allFeatureNames],
      details: results,
    };
    fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
    fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), "utf8");
    log("REPORT", `Generated code report: ${REPORT_PATH}`);

    // Print all generated code for user review
    console.log("\n" + "═".repeat(60));
    log("CODE", "=== All Generated Python Code ===");
    results.forEach((r) => {
      (r.candidates || []).forEach((c) => {
        if (c.indicatorCode) {
          console.log(`\n--- ${r.id} / ${c.featureName} (${c.codeSource}) ---`);
          console.log(c.indicatorCode);
          if (c.entryCode) console.log(`# Entry: ${c.entryCode}`);
          if (c.exitCode) console.log(`# Exit:  ${c.exitCode}`);
        }
      });
    });

    const allPassed = passed.length >= 2 && withCode.length >= 1 && allFeatureNames.size >= 2;
    console.log("\n" + "═".repeat(60));
    log("VERDICT", allPassed ? "✅ E2E FULL FLOW TEST PASSED" : "⚠️ SOME CHECKS DID NOT MEET THRESHOLD");
    process.exit(allPassed ? 0 : 1);

  } finally {
    // Clean up server
    try { serverProc.kill("SIGTERM"); } catch {}
    await new Promise((r) => setTimeout(r, 1000));
    try { serverProc.kill("SIGKILL"); } catch {}
  }
}

main().catch((err) => {
  console.error("E2E test crashed:", err);
  process.exit(1);
});
