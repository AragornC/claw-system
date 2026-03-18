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
const ROOT_DIR = path.resolve(__dirname, "..", "..");
const PORT = Number(process.env.THUNDERCLAW_E2E_PORT || (13000 + Math.floor(Math.random() * 2000)));
const BASE = `http://127.0.0.1:${PORT}`;
const API_KEY = process.env.DEEPSEEK_API_KEY || "sk-4f09f8d07cf24711b398274ee11a13f9";

function log(tag, msg) { console.log(`[${tag}] ${msg}`); }

function pickStableOption(questionLike) {
  const options = Array.isArray(questionLike?.options) ? questionLike.options : [];
  if (!options.length) return null;
  const preferred = options.find((option) => {
    const value = String(option?.value || "").trim().toLowerCase();
    return value && !["custom", "custom_percentile"].includes(value);
  });
  return preferred || options[0] || null;
}

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

async function postStream(path, body, timeoutMs = 180000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const resp = await fetch(BASE + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!resp.ok || !resp.body) {
      throw new Error(`HTTP ${resp.status}`);
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let currentEvent = "";
    const events = [];
    let finalPayload = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("event: ")) {
          currentEvent = trimmed.slice(7);
        } else if (trimmed.startsWith("data: ")) {
          const payload = JSON.parse(trimmed.slice(6));
          events.push({ event: currentEvent || "message", data: payload });
          if (currentEvent === "done" || currentEvent === "result") {
            finalPayload = payload;
          }
          currentEvent = "";
        }
      }
    }
    return { ok: true, events, finalPayload };
  } finally {
    clearTimeout(timer);
  }
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
      const selected = pickStableOption(q);
      if (selected?.value) {
        userChoices[q.id] = selected.value;
      }
    });
    log("STEP2", `Choices: ${JSON.stringify(userChoices)}`);

    const confirmResult = await post("/api/strategy/intent-confirm", {
      featureConcept: clarifyResult.featureConcept || { name: "price_stability", description: "价格稳定性检测", category: "volatility" },
      userChoices,
      userMessage: "帮我看看什么时候比特币价格比较稳定适合买",
      assistantReply: "让我帮你分析一下比特币的价格稳定性。",
      bars: buildEvalBars(240),
      pair: "BTC/USDT",
      timeframe: "1h",
      rangeDays: 14,
    }, 120000);
    log("STEP2", `OK: ${confirmResult.ok}`);
    log("STEP2", `Feature: ${JSON.stringify(confirmResult.feature?.name || confirmResult.feature || null)}`);
    log("STEP2", `Result summary: ${confirmResult.resultSummary || "(none)"}`);
    log("STEP2", `Code source: ${confirmResult.source || "(none)"}`);
    if (confirmResult.generatedCode?.featureCode) {
      log("STEP2", `Code lines: ${confirmResult.generatedCode.featureCode.split("\n").length}`);
      log("STEP2", `--- Generated Code ---`);
      console.log(confirmResult.generatedCode.featureCode);
    }
    if (confirmResult.error) {
      log("STEP2", `Error: ${confirmResult.error}`);
    }
    log("STEP2", `Spec artifact: ${confirmResult.specArtifact ? "yes" : "no"}`);
    log("STEP2", `Run artifacts: ${confirmResult.runArtifacts ? "yes" : "no"}`);

    // ━━━━━ Step 2B: Stream confirm for workbench artifacts ━━━━━
    log("STEP2B", "Submitting dedicated stream flow to verify task/workbench artifacts...");
    const streamClarify = await post("/api/strategy/intent-clarify", {
      userMessage: "帮我做一个判断市场波动率高低的工具",
      assistantReply: "",
    }, 60000);
    const streamChoices = {};
    (streamClarify.clarifyingQuestions || []).forEach((q) => {
      const selected = pickStableOption(q);
      if (selected?.value) streamChoices[q.id] = selected.value;
    });
    const streamResult = await postStream("/api/strategy/intent-confirm/stream", {
      featureConcept: streamClarify.featureConcept || { name: "market_volatility_assessment", description: "波动率评估", category: "volatility" },
      userChoices: streamChoices,
      userMessage: "帮我做一个判断市场波动率高低的工具",
      assistantReply: "",
      bars: buildEvalBars(240),
      pair: "BTC/USDT",
      timeframe: "1h",
      rangeDays: 14,
    }, 300000);
    const streamPayload = streamResult.finalPayload || {};
    const thinkingEvents = (streamResult.events || []).filter((item) => item.event === "thinking");
    log("STEP2B", `Thinking events: ${thinkingEvents.length}`);
    log("STEP2B", `Stream OK: ${Boolean(streamPayload.ok)}`);
    log("STEP2B", `Task present: ${Boolean(streamPayload.task)}`);
    log("STEP2B", `Spec artifact present: ${Boolean(streamPayload.specArtifact)}`);
    log("STEP2B", `Traces count: ${(streamPayload.traces || []).length}`);
    log("STEP2B", `Run artifacts present: ${Boolean(streamPayload.runArtifacts || streamPayload.generatedCode?.runArtifacts)}`);

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
          pair: "BTC/USDT",
          timeframe: "1h",
          bars: buildEvalBars(240),
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
      hasCode: Boolean(confirmResult.generatedCode?.featureCode),
      hasResultSummary: Boolean(confirmResult.resultSummary),
      hasSpecArtifact: Boolean(confirmResult.specArtifact),
      streamFeatureGenerated: Boolean(streamPayload.ok),
      streamHasTask: Boolean(streamPayload.task),
      streamHasTraces: (streamPayload.traces || []).length > 0,
      streamHasSpecArtifact: Boolean(streamPayload.specArtifact),
      streamHasRunArtifacts: Boolean(streamPayload.runArtifacts || streamPayload.generatedCode?.runArtifacts),
      fastPathCardOnly: chatChecks.isFastPath && chatChecks.emptyReply && chatChecks.hasClarification,
      sessionRestoreOk: restoreChecks.restoreOk,
    };
    log("RESULT", JSON.stringify(checks, null, 2));
    const allPassed = checks.intentDetected
      && checks.hasQuestions
      && checks.featureGenerated
      && checks.hasCode
      && checks.hasSpecArtifact
      && checks.streamFeatureGenerated
      && checks.streamHasTask
      && checks.streamHasTraces
      && checks.streamHasSpecArtifact
      && checks.streamHasRunArtifacts;
    log("VERDICT", allPassed ? "✅ CLARIFICATION FLOW TEST PASSED" : "⚠️ SOME CHECKS FAILED");
    process.exit(allPassed ? 0 : 1);

  } finally {
    try { serverProc.kill("SIGTERM"); } catch {}
    await new Promise((r) => setTimeout(r, 1000));
    try { serverProc.kill("SIGKILL"); } catch {}
  }
}

main().catch((err) => { console.error("E2E crashed:", err); process.exit(1); });
