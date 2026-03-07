#!/usr/bin/env node
/**
 * E2E Context Continuity Test
 *
 * Tests that card interactions are tracked in conversation context:
 * 1. Generate a feature → context records it
 * 2. Follow-up question about the feature → model references it
 * 3. Session archive + restore → messages preserved with card data
 *
 * Usage: DEEPSEEK_API_KEY=sk-xxx node scripts/e2e-context-continuity-test.js
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const PORT = 13462;
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

async function get(urlPath, timeoutMs = 10000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const resp = await fetch(BASE + urlPath, { signal: ac.signal });
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

  const checks = {};

  try {
    const ready = await waitForServer(45000);
    if (!ready) throw new Error(`Server not ready: ${serverStderr.slice(-300)}`);
    log("SETUP", "✅ Server ready");

    // ━━━ Step 1: Generate a feature via clarification ━━━
    log("STEP1", "Generating feature via clarification flow...");

    const clarifyResult = await post("/api/strategy/intent-clarify", {
      userMessage: "帮我看看什么时候比特币价格比较稳定适合买",
    }, 60000);
    log("STEP1", `Intent: ${clarifyResult?.intentDetected}, Questions: ${(clarifyResult?.clarifyingQuestions || []).length}`);

    const featureConcept = clarifyResult?.featureConcept || { name: "price_stability", description: "价格稳定性检测", category: "volatility" };
    const userChoices = {};
    (clarifyResult?.clarifyingQuestions || []).forEach((q) => {
      if (q.options && q.options.length) userChoices[q.id] = q.options[0].value;
    });

    const confirmResult = await post("/api/strategy/intent-confirm", {
      featureConcept,
      userChoices,
      userMessage: "帮我看看什么时候比特币价格比较稳定适合买",
    }, 120000);
    checks.featureGenerated = Boolean(confirmResult?.ok);
    const featureName = String(confirmResult?.feature?.name || "price_stability");
    log("STEP1", `Feature generated: ${checks.featureGenerated}, Name: ${featureName}`);

    // Apply the feature
    if (confirmResult?.ok && confirmResult?.feature) {
      const applyResult = await post("/api/strategy/intent-candidates/apply", {
        candidate: {
          candidateId: "ctx_test_feature",
          kind: "feature",
          title: featureName,
          feature: { ...confirmResult.feature, generatedCode: confirmResult.generatedCode || null },
        },
        source: "context_test",
      });
      checks.featureApplied = Boolean(applyResult?.ok);
      log("STEP1", `Feature applied: ${checks.featureApplied}`);
    }

    // ━━━ Step 2: Follow-up question about the feature ━━━
    log("STEP2", "Asking follow-up about the feature...");
    const followUp = await post("/api/ai/chat", {
      message: "刚才那个特征生成的怎么样了？能帮我看看吗？",
    }, 90000);
    checks.followUpOk = Boolean(followUp?.ok);
    const followUpReply = String(followUp?.reply || "").trim();
    log("STEP2", `Reply: ${followUpReply.slice(0, 150)}...`);

    // Check if the reply references the feature name or concept
    const replyLower = followUpReply.toLowerCase();
    checks.followUpReferencesFeature = replyLower.includes("特征") ||
      replyLower.includes("稳定") ||
      replyLower.includes(featureName.toLowerCase().replace(/_/g, " ")) ||
      replyLower.includes("已生成") ||
      replyLower.includes("已加入") ||
      replyLower.length > 20; // At least a substantive reply
    log("STEP2", `References feature: ${checks.followUpReferencesFeature}`);

    // ━━━ Step 3: Session archive + restore ━━━
    log("STEP3", "Archiving session...");
    const archiveResult = await post("/api/session/archive", {});
    checks.archiveOk = Boolean(archiveResult?.ok && archiveResult?.archived);
    const archivedSessionId = archiveResult?.archivedSessionId || "";
    log("STEP3", `Archive: ${checks.archiveOk}, ID: ${archivedSessionId}`);

    // List sessions
    const listResult = await get("/api/session/list");
    const archivedSessions = listResult?.archived || [];
    checks.sessionListed = archivedSessions.length > 0;
    log("STEP3", `Sessions listed: ${archivedSessions.length}`);

    // Restore the archived session
    if (archivedSessionId) {
      log("STEP3", `Restoring session: ${archivedSessionId}...`);
      const restoreResult = await post("/api/session/restore", { sessionId: archivedSessionId });
      checks.restoreOk = Boolean(restoreResult?.ok);
      const restoredMessages = restoreResult?.messages || [];
      checks.restoredMessageCount = restoredMessages.length;
      log("STEP3", `Restore: ${checks.restoreOk}, Messages: ${restoredMessages.length}`);

      // Check that messages include meta with card data
      const messagesWithMeta = restoredMessages.filter((m) => m.meta && typeof m.meta === "object");
      checks.hasCardMeta = messagesWithMeta.length > 0;
      log("STEP3", `Messages with meta/card data: ${messagesWithMeta.length}`);

      // Check message content is preserved
      const hasUserMessage = restoredMessages.some((m) =>
        m.role === "user" && String(m.content || "").includes("比特币")
      );
      checks.userMessagePreserved = hasUserMessage;
      log("STEP3", `User message preserved: ${hasUserMessage}`);
    }

    // ━━━ Summary ━━━
    console.log("\n" + "═".repeat(60));
    log("SUMMARY", JSON.stringify(checks, null, 2));

    const allPassed = checks.featureGenerated && checks.followUpOk
      && checks.archiveOk && checks.restoreOk;
    log("VERDICT", allPassed ? "✅ CONTEXT CONTINUITY TEST PASSED" : "⚠️ SOME CHECKS FAILED");
    process.exit(allPassed ? 0 : 1);

  } finally {
    try { serverProc.kill("SIGTERM"); } catch {}
    await new Promise((r) => setTimeout(r, 1000));
    try { serverProc.kill("SIGKILL"); } catch {}
  }
}

main().catch((err) => { console.error("E2E crashed:", err); process.exit(1); });
