#!/usr/bin/env node
/**
 * E2E Clarification Flow Test
 *
 * Tests the complete new interaction flow:
 * 1. Start server
 * 2. Send non-professional chat message
 * 3. Get clarification card (AI-generated questions)
 * 4. Submit user choices → get feature with code + result description
 * 5. Apply feature to store
 * 6. Run feature evaluation
 * 7. Verify feature values are computed
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const PORT = 13458;
const BASE = `http://127.0.0.1:${PORT}`;
const API_KEY = process.env.DEEPSEEK_API_KEY || "sk-4f09f8d07cf24711b398274ee11a13f9";

function log(tag, msg) { console.log(`[${tag}] ${msg}`); }

async function post(path, body, timeoutMs = 120000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const resp = await fetch(BASE + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    return await resp.json();
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
    // API key set via env var

    // ━━━━━ Step 1: Intent Clarification ━━━━━
    log("STEP1", "Sending non-professional message...");
    const clarifyResult = await post("/api/strategy/intent-clarify", {
      userMessage: "帮我看看什么时候比特币价格比较稳定适合买，我完全不懂这些",
      assistantReply: "让我帮你分析一下比特币的价格稳定性。我推荐使用一些技术指标来判断价格波动情况。",
    }, 60000);
    log("STEP1", `Intent detected: ${clarifyResult.intentDetected}`);
    log("STEP1", `Headline: ${clarifyResult.headline || "(none)"}`);
    log("STEP1", `Feature concept: ${JSON.stringify(clarifyResult.featureConcept || null)}`);
    log("STEP1", `Questions: ${(clarifyResult.clarifyingQuestions || []).length}`);
    (clarifyResult.clarifyingQuestions || []).forEach((q, i) => {
      log("STEP1", `  Q${i+1}: ${q.question}`);
      (q.options || []).forEach((o) => log("STEP1", `    - [${o.value}] ${o.label}`));
    });

    if (!clarifyResult.intentDetected) {
      log("STEP1", "⚠️ No intent detected — testing fallback");
    }

    // ━━━━━ Step 2: Confirm with user choices ━━━━━
    log("STEP2", "Submitting user choices...");
    const questions = clarifyResult.clarifyingQuestions || [];
    const userChoices = {};
    questions.forEach((q) => {
      // Pick first option for each question
      if (q.options && q.options.length) {
        userChoices[q.id] = q.options[0].value;
      }
    });
    log("STEP2", `Choices: ${JSON.stringify(userChoices)}`);

    const confirmResult = await post("/api/strategy/intent-confirm", {
      featureConcept: clarifyResult.featureConcept || { name: "price_stability", description: "价格稳定性检测", category: "volatility" },
      userChoices,
      userMessage: "帮我看看什么时候比特币价格比较稳定适合买",
      assistantReply: "让我帮你分析一下比特币的价格稳定性。",
    }, 120000);
    log("STEP2", `OK: ${confirmResult.ok}`);
    log("STEP2", `Feature: ${JSON.stringify(confirmResult.feature?.name || confirmResult.feature || null)}`);
    log("STEP2", `Result summary: ${confirmResult.resultSummary || "(none)"}`);
    log("STEP2", `Code source: ${confirmResult.source || "(none)"}`);
    if (confirmResult.generatedCode?.indicatorCode) {
      log("STEP2", `Code lines: ${confirmResult.generatedCode.indicatorCode.split("\n").length}`);
      log("STEP2", `--- Generated Code ---`);
      console.log(confirmResult.generatedCode.indicatorCode);
      log("STEP2", `--- Entry: ${confirmResult.generatedCode.entryConditionCode || "none"} ---`);
      log("STEP2", `--- Exit: ${confirmResult.generatedCode.exitConditionCode || "none"} ---`);
    }
    if (confirmResult.error) {
      log("STEP2", `Error: ${confirmResult.error}`);
    }

    // ━━━━━ Step 3: Apply to feature store ━━━━━
    if (confirmResult.ok && confirmResult.feature) {
      log("STEP3", "Applying feature to store...");
      const applyResult = await post("/api/strategy/intent-candidates/apply", {
        candidate: {
          candidateId: "clarify_test",
          kind: "feature",
          title: confirmResult.feature.name || "test_feature",
          feature: {
            ...confirmResult.feature,
            generatedCode: confirmResult.generatedCode || null,
          },
        },
        source: "clarification_flow_test",
      });
      log("STEP3", `Applied: ${applyResult.ok} — ${applyResult.reply || applyResult.error || ""}`);

      // ━━━━━ Step 4: Evaluate feature ━━━━━
      if (applyResult.ok) {
        const featureName = confirmResult.feature.name || applyResult.applied?.feature?.name || "";
        log("STEP4", `Evaluating feature: ${featureName}...`);
        const evalResult = await post("/api/strategy/features/evaluate", {
          featureIds: [featureName],
          rangeDays: 14,
        });
        log("STEP4", `Evaluated: ${evalResult.ok}`);
        if (evalResult.ok) {
          log("STEP4", `Bars: ${evalResult.barCount}, Columns: ${(evalResult.featureColumns || []).join(", ")}`);
          Object.entries(evalResult.featureStats || {}).forEach(([col, stats]) => {
            if (col.startsWith("tc_feat_")) {
              log("STEP4", `  ${col}: mean=${stats.mean?.toFixed(4)} std=${stats.std?.toFixed(4)} min=${stats.min?.toFixed(4)} max=${stats.max?.toFixed(4)}`);
            }
          });
        } else {
          log("STEP4", `Eval error: ${evalResult.error || "unknown"}`);
        }
      }
    }

    // ━━━━━ Step 5: Test /api/ai/chat fast path (card-only, no extra text) ━━━━━
    log("STEP5", "Testing /api/ai/chat fast path for card-only response...");
    const chatResult = await post("/api/ai/chat", {
      message: "帮我做一个判断市场波动率高低的工具",
    }, 90000);
    const chatChecks = {
      chatOk: Boolean(chatResult?.ok),
      isFastPath: chatResult?.source === "clarification_fast_path",
      emptyReply: !String(chatResult?.reply || "").trim(),
      hasClarification: Boolean(chatResult?.clarification?.intentDetected),
    };
    log("STEP5", `Chat OK: ${chatChecks.chatOk}, Fast path: ${chatChecks.isFastPath}`);
    log("STEP5", `Empty reply (no extra text): ${chatChecks.emptyReply}`);
    log("STEP5", `Has clarification card: ${chatChecks.hasClarification}`);
    if (chatResult?.clarification?.headline) {
      log("STEP5", `Headline: ${chatResult.clarification.headline}`);
    }

    // ━━━━━ Step 6: Test session archive/restore completeness ━━━━━
    log("STEP6", "Testing session archive + restore...");
    const archiveResult = await post("/api/session/archive", {});
    log("STEP6", `Archive: ${archiveResult?.ok}, Archived: ${archiveResult?.archived}`);
    const archivedId = archiveResult?.archivedSessionId || "";
    let restoreChecks = { restoreOk: false, messageCount: 0, hasCardMeta: false };
    if (archivedId) {
      const restoreResult = await post("/api/session/restore", { sessionId: archivedId });
      restoreChecks.restoreOk = Boolean(restoreResult?.ok);
      restoreChecks.messageCount = (restoreResult?.messages || []).length;
      restoreChecks.hasCardMeta = (restoreResult?.messages || []).some((m) =>
        m.meta && typeof m.meta === "object"
      );
      log("STEP6", `Restore: ${restoreChecks.restoreOk}, Messages: ${restoreChecks.messageCount}, Card meta: ${restoreChecks.hasCardMeta}`);
    }

    // ━━━━━ Summary ━━━━━
    console.log("\n" + "═".repeat(60));
    const checks = {
      intentDetected: clarifyResult.intentDetected || false,
      hasQuestions: (clarifyResult.clarifyingQuestions || []).length >= 1,
      featureGenerated: confirmResult.ok || false,
      hasCode: Boolean(confirmResult.generatedCode?.indicatorCode),
      hasResultSummary: Boolean(confirmResult.resultSummary),
      fastPathCardOnly: chatChecks.isFastPath && chatChecks.emptyReply && chatChecks.hasClarification,
      sessionRestoreOk: restoreChecks.restoreOk,
    };
    log("RESULT", JSON.stringify(checks, null, 2));
    const allPassed = checks.intentDetected && checks.hasQuestions && checks.featureGenerated && checks.hasCode;
    log("VERDICT", allPassed ? "✅ CLARIFICATION FLOW TEST PASSED" : "⚠️ SOME CHECKS FAILED");
    process.exit(allPassed ? 0 : 1);

  } finally {
    try { serverProc.kill("SIGTERM"); } catch {}
    await new Promise((r) => setTimeout(r, 1000));
    try { serverProc.kill("SIGKILL"); } catch {}
  }
}

main().catch((err) => { console.error("E2E crashed:", err); process.exit(1); });
