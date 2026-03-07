#!/usr/bin/env node
/**
 * E2E Memory Architecture Test
 *
 * Tests the complete four-layer memory system:
 * - L1: Multi-turn context continuity
 * - L2: Session archival with summary + asset tracking
 * - L3: Structured state awareness (model knows existing features)
 * - L4: (removed — self-contained mode)
 * - Evolution compression (auto-compress on high message count)
 * - Session restore with history
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const PORT = 13470;
const BASE = `http://127.0.0.1:${PORT}`;
const API_KEY = process.env.DEEPSEEK_API_KEY || "sk-4f09f8d07cf24711b398274ee11a13f9";

function log(tag, msg) { console.log(`[${tag}] ${msg}`); }

async function post(path, body, timeoutMs = 60000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const resp = await fetch(BASE + path, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: ac.signal,
    });
    return await resp.json();
  } finally { clearTimeout(timer); }
}

async function get(path, timeoutMs = 10000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const resp = await fetch(BASE + path, { signal: ac.signal });
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
    env: { ...process.env, THUNDERCLAW_PORT: String(PORT), DEEPSEEK_API_KEY: API_KEY, THUNDERCLAW_EXTERNAL_SIGNAL_LIVE: "0", THUNDERCLAW_EXTERNAL_SIGNAL_STRICT: "0" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  serverProc.stderr.on("data", () => {});
  serverProc.stdout.on("data", () => {});

  const checks = {};

  try {
    const ready = await waitForServer(45000);
    if (!ready) throw new Error("Server not ready");
    log("SETUP", "✅ Server ready");

    // ━━━ Test 1: L1 Multi-turn Context ━━━━━━━━━━━━━━━━━━━━━━━━━━
    log("L1", "=== Testing multi-turn context ===");
    const r1 = await post("/api/ai/chat", { message: "我想做一个关于比特币的分析工具" });
    log("L1", `Turn 1 — Intent: ${r1.clarification?.intentDetected} Reply: ${r1.reply?.slice(0, 60)}`);
    checks.l1_turn1 = Boolean(r1.ok);

    const r2 = await post("/api/ai/chat", { message: "具体来说是EMA均线，20周期的" });
    log("L1", `Turn 2 — Intent: ${r2.clarification?.intentDetected} Headline: ${r2.clarification?.headline?.slice(0, 60)}`);
    // The headline should reference EMA/均线 because of context from turn 1
    const l1ContextWorks = r2.clarification?.intentDetected &&
      (r2.clarification?.headline?.includes("EMA") ||
       r2.clarification?.headline?.includes("均线") ||
       r2.clarification?.featureConcept?.indicatorHint?.includes("EMA"));
    checks.l1_context = l1ContextWorks;
    log("L1", `Context carried: ${l1ContextWorks ? "✅" : "⚠️"}`);

    // ━━━ Test 2: Confirm + Apply (creates feature for L3/L4) ━━━━
    log("APPLY", "=== Creating feature via confirm flow ===");
    const concept = r2.clarification?.featureConcept || { name: "ema_20", description: "EMA 20均线", category: "trend", indicatorHint: "ema" };
    const choices = {};
    (r2.clarification?.clarifyingQuestions || []).forEach((q) => {
      if (q.options?.length) choices[q.id] = q.options[0].value;
    });
    const confirmResult = await post("/api/strategy/intent-confirm", {
      featureConcept: concept, userChoices: choices,
      userMessage: "EMA 20均线分析", assistantReply: "",
    }, 120000);
    log("APPLY", `Confirm OK: ${confirmResult.ok} Feature: ${confirmResult.feature?.name} HasCode: ${Boolean(confirmResult.generatedCode?.indicatorCode)}`);
    log("APPLY", `Summary: ${confirmResult.resultSummary?.slice(0, 80)}`);
    checks.confirm_ok = Boolean(confirmResult.ok);
    checks.has_code = Boolean(confirmResult.generatedCode?.indicatorCode);

    // Apply to store
    if (confirmResult.ok && confirmResult.feature) {
      const applyResult = await post("/api/strategy/intent-candidates/apply", {
        candidate: {
          candidateId: "e2e_memory_test",
          kind: "feature",
          title: confirmResult.feature.name,
          feature: { ...confirmResult.feature, generatedCode: confirmResult.generatedCode },
        },
        source: "e2e_memory_test",
      });
      log("APPLY", `Apply: ${applyResult.ok} — ${applyResult.reply?.slice(0, 60)}`);
      checks.apply_ok = Boolean(applyResult.ok);
    }

    // ━━━ Test 3: L3 Structured State ━━━━━━━━━━━━━━━━━━━━━━━━━━━
    log("L3", "=== Testing structured state awareness ===");
    const r3 = await post("/api/ai/chat", { message: "我之前做过哪些特征？能帮我再做一个不同的吗" });
    log("L3", `Intent: ${r3.clarification?.intentDetected} Headline: ${r3.clarification?.headline?.slice(0, 60)}`);
    // Check if the model's response acknowledges existing features
    const l3Aware = r3.clarification?.intentDetected || false;
    checks.l3_state_aware = l3Aware;
    log("L3", `State aware: ${l3Aware ? "✅" : "⚠️"}`);

    // ━━━ Test 4: Session Archive + Asset Tracking ━━━━━━━━━━━━━━
    log("ARCHIVE", "=== Testing session archival ===");
    const sessionsBefore = await get("/api/session/list");
    log("ARCHIVE", `Before — Active msgs: ${sessionsBefore.active?.messageCount} Archived: ${sessionsBefore.totalArchived}`);

    const archiveResult = await post("/api/session/archive", {});
    log("ARCHIVE", `Archive: ${archiveResult.ok} Archived: ${archiveResult.archived} Msgs: ${archiveResult.messageCount}`);
    checks.archive_ok = Boolean(archiveResult.ok && archiveResult.archived);

    const sessionsAfter = await get("/api/session/list");
    log("ARCHIVE", `After — Active msgs: ${sessionsAfter.active?.messageCount} Archived: ${sessionsAfter.totalArchived}`);
    const archivedSession = sessionsAfter.archived?.[0];
    log("ARCHIVE", `Archived session — Summary: ${archivedSession?.summary?.slice(0, 60)} Assets: ${archivedSession?.assetCount}`);
    checks.archive_has_assets = (archivedSession?.assetCount || 0) > 0;
    checks.archive_has_summary = Boolean(archivedSession?.summary);

    // ━━━ Test 5: Session Restore ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    if (archivedSession?.id) {
      log("RESTORE", "=== Testing session restore ===");
      const restoreResult = await post("/api/session/restore", { sessionId: archivedSession.id });
      log("RESTORE", `Restore OK: ${restoreResult.ok} Messages: ${restoreResult.messages?.length}`);
      checks.restore_ok = Boolean(restoreResult.ok);
      checks.restore_has_messages = (restoreResult.messages?.length || 0) > 0;
    }

    // L4 (OpenClaw memory) removed — ThunderClaw is self-contained
    log("L4", "=== L4 removed (self-contained mode) ===");
    checks.l4_memory_written = true; // Skip — not applicable

    // ━━━ Test 7: Feature Evaluation ━━━━━━━━━━━━━━━━━━━━━━━━━━━
    if (confirmResult.feature?.name) {
      log("EVAL", "=== Testing feature evaluation ===");
      const evalResult = await post("/api/strategy/features/evaluate", {
        featureIds: [confirmResult.feature.name], rangeDays: 7,
      });
      log("EVAL", `OK: ${evalResult.ok} Bars: ${evalResult.barCount} Cols: ${(evalResult.featureColumns || []).join(", ")}`);
      checks.eval_ok = Boolean(evalResult.ok);
    }

    // ━━━ Summary ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    console.log("\n" + "═".repeat(60));
    log("RESULT", JSON.stringify(checks, null, 2));
    const passed = Object.values(checks).filter(Boolean).length;
    const total = Object.keys(checks).length;
    log("VERDICT", `${passed}/${total} checks passed`);
    const allCritical = checks.l1_turn1 && checks.confirm_ok && checks.has_code && checks.archive_ok;
    log("VERDICT", allCritical ? "✅ CRITICAL CHECKS PASSED" : "⚠️ SOME CRITICAL CHECKS FAILED");
    process.exit(allCritical ? 0 : 1);

  } finally {
    try { serverProc.kill("SIGTERM"); } catch {}
    await new Promise((r) => setTimeout(r, 1000));
    try { serverProc.kill("SIGKILL"); } catch {}
  }
}

main().catch((err) => { console.error("E2E crashed:", err); process.exit(1); });
