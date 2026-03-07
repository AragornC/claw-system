#!/usr/bin/env node
/**
 * E2E Model Config Test
 *
 * Tests that model configuration works correctly via xbrain API.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const PORT = 13463;
const BASE = `http://127.0.0.1:${PORT}`;
const API_KEY = process.env.DEEPSEEK_API_KEY || "sk-4f09f8d07cf24711b398274ee11a13f9";

function log(tag, msg) { console.log(`[${tag}] ${msg}`); }

async function post(urlPath, body, timeoutMs = 30000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const resp = await fetch(BASE + urlPath, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: ac.signal,
    });
    return await resp.json();
  } finally { clearTimeout(timer); }
}

async function get(urlPath) {
  const resp = await fetch(BASE + urlPath, { signal: AbortSignal.timeout(10000) });
  return resp.json();
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
  const checks = {};

  log("SETUP", "Starting server...");
  const serverProc = spawn("node", ["scripts/thunderclaw-server.js"], {
    cwd: ROOT_DIR,
    env: { ...process.env, THUNDERCLAW_PORT: String(PORT), DEEPSEEK_API_KEY: API_KEY,
      THUNDERCLAW_EXTERNAL_SIGNAL_LIVE: "0", THUNDERCLAW_EXTERNAL_SIGNAL_STRICT: "0" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  serverProc.stderr.on("data", () => {});

  try {
    if (!await waitForServer()) throw new Error("Server not ready");
    log("SETUP", "✅ Server ready");

    // Test xbrain state
    const state = await get("/api/xbrain/state");
    checks.stateOk = Boolean(state?.ok);
    log("TEST", `Xbrain state: ${checks.stateOk}`);

    // Test model update
    const update = await post("/api/xbrain/update", { provider: "deepseek", apiKey: API_KEY });
    checks.updateOk = Boolean(update?.ok);
    log("TEST", `Model update: ${checks.updateOk}`);

    // Verify key is stored
    const stateAfter = await get("/api/xbrain/state");
    const authConfigured = stateAfter?.state?.base?.providerAuth?.deepseek?.configured;
    checks.keyStored = Boolean(authConfigured);
    log("TEST", `Key stored: ${checks.keyStored}`);

    // Test chat works with configured model
    const chat = await post("/api/ai/chat", { message: "你好" }, 60000);
    checks.chatOk = Boolean(chat?.ok && chat?.reply);
    log("TEST", `Chat works: ${checks.chatOk}`);

    // Summary
    const allPassed = Object.values(checks).every(Boolean);
    log("VERDICT", allPassed ? "✅ ALL PASSED" : "⚠️ SOME FAILED");
    log("SUMMARY", JSON.stringify(checks));
    process.exit(allPassed ? 0 : 1);
  } finally {
    try { serverProc.kill("SIGTERM"); } catch {}
    await new Promise((r) => setTimeout(r, 1000));
    try { serverProc.kill("SIGKILL"); } catch {}
  }
}

main().catch((err) => { console.error("Crashed:", err); process.exit(1); });
