#!/usr/bin/env node
/**
 * E2E Realistic Flow Test
 *
 * Simulates real user interaction patterns 1:1:
 * - Should-trigger: feature creation requests
 * - Should-NOT-trigger: queries about existing features, evaluations, explanations
 * - Multi-turn: create feature → follow-up about it → modify
 * - Pressure: rapid sequential messages
 * - Full flow: chat → card → confirm → apply → evaluate
 *
 * Uses REAL LLM calls (requires DEEPSEEK_API_KEY).
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const PORT = 13465;
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

function hasClarification(chatResult) {
  return Boolean(chatResult?.clarification?.intentDetected);
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

  const results = { pass: 0, fail: 0, tests: [] };

  function check(name, condition, detail = "") {
    const ok = Boolean(condition);
    results.tests.push({ name, ok, detail });
    if (ok) { results.pass++; log("✅", name); }
    else { results.fail++; log("❌", `${name} — ${detail}`); }
  }

  try {
    const ready = await waitForServer(45000);
    if (!ready) throw new Error(`Server not ready: ${serverStderr.slice(-300)}`);
    log("SETUP", "✅ Server ready");

    // ━━━ SECTION 1: Should-Trigger Cases ━━━
    log("SECTION", "=== Should-Trigger (feature creation) ===");

    const triggerCases = [
      { msg: "帮我做一个EMA均线交叉的交易特征", label: "explicit EMA creation" },
      { msg: "我想要一个基于成交量突增的买入信号，当成交量超过20日均量2倍时触发", label: "volume spike creation" },
      { msg: "帮我做一个基于RSI的超卖反弹策略", label: "RSI strategy" },
    ];

    for (const tc of triggerCases) {
      const r = await post("/api/ai/chat", { message: tc.msg }, 90000);
      check(`trigger: ${tc.label}`, hasClarification(r) || r.source === "clarification_fast_path",
        `source=${r?.source}, hasClarification=${hasClarification(r)}`);
    }

    // ━━━ SECTION 2: Should-NOT-Trigger Cases ━━━
    log("SECTION", "=== Should-NOT-Trigger (queries, evaluations) ===");

    // First create a feature so we can reference it
    const clarify = await post("/api/strategy/intent-clarify", {
      userMessage: "帮我做一个波动率过滤特征",
    }, 60000);
    const concept = clarify?.featureConcept || { name: "volatility_filter", category: "volatility" };
    const choices = {};
    (clarify?.clarifyingQuestions || []).forEach((q) => {
      if (q.options?.length) choices[q.id] = q.options[0].value;
    });
    const confirm = await post("/api/strategy/intent-confirm", {
      featureConcept: concept, userChoices: choices,
      userMessage: "帮我做一个波动率过滤特征",
    }, 120000);
    if (confirm?.ok && confirm?.feature) {
      await post("/api/strategy/intent-candidates/apply", {
        candidate: {
          candidateId: "test_vol", kind: "feature",
          title: confirm.feature.name || "volatility_filter",
          feature: { ...confirm.feature, generatedCode: confirm.generatedCode },
        },
        source: "e2e_test",
      });
    }
    const featureName = confirm?.feature?.name || "volatility_filter";

    const noTriggerCases = [
      { msg: `${featureName}这个特征是什么意思？`, label: "ask meaning of feature" },
      { msg: "刚才那个特征做的怎么样了", label: "follow-up query" },
      { msg: "帮我评估一下这个波动率特征", label: "evaluate request" },
      { msg: "为什么我的特征值全是0", label: "debug question" },
      { msg: "你好", label: "greeting" },
      { msg: "谢谢", label: "thanks" },
      { msg: "什么是RSI指标", label: "concept explanation" },
      { msg: "之前那个特征能优化吗", label: "optimize existing" },
    ];

    for (const tc of noTriggerCases) {
      const r = await post("/api/ai/chat", { message: tc.msg }, 60000);
      const triggered = hasClarification(r);
      check(`no-trigger: ${tc.label}`, !triggered,
        `triggered=${triggered}, source=${r?.source}`);
    }

    // ━━━ SECTION 3: Multi-turn Context ━━━
    log("SECTION", "=== Multi-turn Context Continuity ===");

    // Ask about the feature we just created
    const followUp = await post("/api/ai/chat", { message: `帮我看看${featureName}这个特征的情况` }, 60000);
    check("context: follow-up has reply", Boolean(followUp?.reply),
      `reply length=${String(followUp?.reply || "").length}`);
    check("context: follow-up not empty card", !hasClarification(followUp),
      "should be text reply, not a card");

    // ━━━ SECTION 4: Full Flow (create → apply → evaluate) ━━━
    log("SECTION", "=== Full Flow: Create → Apply → Evaluate ===");

    const fullClarify = await post("/api/strategy/intent-clarify", {
      userMessage: "帮我做一个MACD柱状图的趋势判断特征",
    }, 60000);
    check("flow: intent detected", Boolean(fullClarify?.intentDetected));

    const fullChoices = {};
    (fullClarify?.clarifyingQuestions || []).forEach((q) => {
      if (q.options?.length) {
        // Randomly pick an option (not always first)
        const idx = Math.floor(Math.random() * q.options.length);
        fullChoices[q.id] = q.options[idx].value;
      }
    });

    const fullConfirm = await post("/api/strategy/intent-confirm", {
      featureConcept: fullClarify?.featureConcept || { name: "macd_trend", category: "trend" },
      userChoices: fullChoices,
      userMessage: "帮我做一个MACD柱状图的趋势判断特征",
    }, 120000);
    check("flow: feature generated", Boolean(fullConfirm?.ok), `error=${fullConfirm?.error || ""}`);
    check("flow: has code", Boolean(fullConfirm?.generatedCode?.indicatorCode));

    if (fullConfirm?.ok && fullConfirm?.feature) {
      const fullApply = await post("/api/strategy/intent-candidates/apply", {
        candidate: {
          candidateId: "flow_test",
          kind: "feature",
          title: fullConfirm.feature.name || "macd_trend",
          feature: { ...fullConfirm.feature, generatedCode: fullConfirm.generatedCode },
        },
        source: "e2e_realistic",
      });
      check("flow: apply ok", Boolean(fullApply?.ok), `error=${fullApply?.error || ""}`);

      // Run feature evaluation
      if (fullApply?.ok) {
        const evalName = fullConfirm.feature.name || fullApply.applied?.feature?.name || "";
        const evalResult = await post("/api/strategy/features/evaluate", {
          featureIds: [evalName],
          rangeDays: 7,
        });
        check("flow: evaluate ok", Boolean(evalResult?.ok), `error=${evalResult?.error || ""}`);
        if (evalResult?.ok) {
          check("flow: has bars", (evalResult?.barCount || 0) > 0, `bars=${evalResult?.barCount}`);
          // Check feature column exists and has meaningful values
          const stats = evalResult?.featureStats || {};
          const featureCol = Object.keys(stats).find((k) => k.startsWith("tc_feat_"));
          check("flow: has feature column", Boolean(featureCol), `columns=${Object.keys(stats).join(",")}`);
          if (featureCol && stats[featureCol]) {
            const s = stats[featureCol];
            check("flow: not all NaN", Number.isFinite(s.mean), `mean=${s.mean}`);
            check("flow: has variance", (s.std || 0) > 1e-8, `std=${s.std}`);
          }
        }
      }
    }

    // ━━━ SECTION 5: Pressure Test ━━━
    log("SECTION", "=== Pressure Test (rapid messages) ===");

    const rapidMessages = [
      "比特币最近怎么样",
      "帮我做一个简单的均线特征",
      "什么是止损",
      "帮我分析下趋势",
      "RSI超卖了吗",
    ];

    const rapidPromises = rapidMessages.map((msg) =>
      post("/api/ai/chat", { message: msg }, 60000)
        .then((r) => ({ msg: msg.slice(0, 20), ok: Boolean(r?.ok || r?.reply), source: r?.source }))
        .catch((e) => ({ msg: msg.slice(0, 20), ok: false, error: String(e?.message || e) }))
    );
    const rapidResults = await Promise.all(rapidPromises);
    const rapidOk = rapidResults.filter((r) => r.ok).length;
    check("pressure: all responded", rapidOk === rapidMessages.length,
      `${rapidOk}/${rapidMessages.length} responded`);

    // ━━━ Summary ━━━
    console.log("\n" + "═".repeat(60));
    log("SUMMARY", `PASS: ${results.pass}  FAIL: ${results.fail}  TOTAL: ${results.tests.length}`);
    results.tests.forEach((t) => {
      if (!t.ok) log("FAILED", `${t.name}: ${t.detail}`);
    });

    const success = results.fail === 0;
    log("VERDICT", success ? "✅ ALL REALISTIC FLOW TESTS PASSED" : `⚠️ ${results.fail} TESTS FAILED`);
    process.exit(success ? 0 : 1);

  } finally {
    try { serverProc.kill("SIGTERM"); } catch {}
    await new Promise((r) => setTimeout(r, 1000));
    try { serverProc.kill("SIGKILL"); } catch {}
  }
}

main().catch((err) => { console.error("E2E crashed:", err); process.exit(1); });
