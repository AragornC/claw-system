#!/usr/bin/env node
/**
 * E2E Model Sync Test
 *
 * Tests that /model commands don't leak into chat responses:
 * 1. Normal conversation should never contain "/model" text
 * 2. Agent reply sanitization filters /model artifacts
 * 3. Slow path fallback doesn't produce /model leakage
 *
 * Usage: DEEPSEEK_API_KEY=sk-xxx node scripts/e2e-model-sync-test.js
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractAgentReply } from "./server/core/agent-runtime.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const PORT = 13463;
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

function containsModelLeakage(textLike) {
  const text = String(textLike || "").trim().toLowerCase();
  if (!text) return false;
  // Check for /model command artifacts
  if (/\/model\s+\w/.test(text)) return true;
  if (text.includes("连续输入了/model")) return true;
  if (text.includes("输入了 /model")) return true;
  return false;
}

async function main() {
  const checks = {};

  // ━━━ Unit test: extractAgentReply filters /model ━━━
  log("UNIT", "Testing extractAgentReply /model filtering...");

  const mockPayloadWithModel = {
    result: {
      payloads: [
        { text: "你好！\n/model deepseek/deepseek-chat\n已切换到模型 deepseek/deepseek-chat\n有什么可以帮你的？" },
      ],
    },
  };
  const cleanedReply = extractAgentReply(mockPayloadWithModel);
  checks.unitFilterModel = !containsModelLeakage(cleanedReply);
  log("UNIT", `Filtered /model from reply: ${checks.unitFilterModel}`);
  log("UNIT", `Cleaned reply: "${cleanedReply.slice(0, 80)}..."`);

  const mockPayloadClean = {
    result: {
      payloads: [
        { text: "比特币目前的价格波动较大，建议关注RSI和EMA指标来判断趋势。" },
      ],
    },
  };
  const normalReply = extractAgentReply(mockPayloadClean);
  checks.unitNormalPreserved = !containsModelLeakage(normalReply) && normalReply.length > 10;
  log("UNIT", `Normal reply preserved: ${checks.unitNormalPreserved}`);
  log("UNIT", `Normal reply: "${normalReply.slice(0, 80)}"`);

  // Test with "连续输入了/model" pattern
  const mockPayloadChinese = {
    result: {
      payloads: [
        { text: "我注意到你连续输入了/model命令。让我帮你做些更有意义的事情吧。" },
      ],
    },
  };
  const chineseReply = extractAgentReply(mockPayloadChinese);
  checks.unitFilterChinese = !containsModelLeakage(chineseReply);
  log("UNIT", `Filtered Chinese /model leakage: ${checks.unitFilterChinese}`);

  // ━━━ Integration test: Normal chat has no /model leakage ━━━
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

    // Send normal conversations and check none contain /model
    const messages = [
      "你好，介绍一下你自己",
      "帮我分析一下比特币的趋势",
      "什么是RSI指标？",
    ];

    let allClean = true;
    for (const msg of messages) {
      log("CHAT", `Sending: "${msg.slice(0, 40)}"`);
      const result = await post("/api/ai/chat", { message: msg }, 90000);
      const reply = String(result?.reply || "").trim();
      const hasLeakage = containsModelLeakage(reply);
      if (hasLeakage) {
        log("CHAT", `  ❌ /model leakage detected in reply: "${reply.slice(0, 100)}"`);
        allClean = false;
      } else {
        log("CHAT", `  ✅ No leakage. Reply: "${reply.slice(0, 80)}..."`);
      }
    }
    checks.integrationNoLeakage = allClean;

    // ━━━ Summary ━━━
    console.log("\n" + "═".repeat(60));
    log("SUMMARY", JSON.stringify(checks, null, 2));

    const allPassed = checks.unitFilterModel && checks.unitNormalPreserved
      && checks.unitFilterChinese && checks.integrationNoLeakage;
    log("VERDICT", allPassed ? "✅ MODEL SYNC TEST PASSED" : "⚠️ SOME CHECKS FAILED");
    process.exit(allPassed ? 0 : 1);

  } finally {
    try { serverProc.kill("SIGTERM"); } catch {}
    await new Promise((r) => setTimeout(r, 1000));
    try { serverProc.kill("SIGKILL"); } catch {}
  }
}

main().catch((err) => { console.error("E2E crashed:", err); process.exit(1); });
