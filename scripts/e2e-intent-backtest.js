#!/usr/bin/env node

const base = process.env.THUNDERCLAW_BASE_URL || "http://127.0.0.1:3456";
const deepseekApiKey = String(process.env.DEEPSEEK_API_KEY || process.env.THUNDERCLAW_DEEPSEEK_API_KEY || "").trim();

async function request(name, path, init = {}, timeoutMs = 120000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort("timeout"), timeoutMs);
  try {
    const resp = await fetch(base + path, { ...init, signal: ac.signal });
    const body = await resp.json().catch(() => ({}));
    return { name, status: resp.status, okHttp: resp.ok, ok: Boolean(body?.ok), body };
  } finally {
    clearTimeout(timer);
  }
}

function assertOk(ret) {
  if (!ret.okHttp || !ret.ok) {
    const err = new Error(`${ret.name} failed: HTTP ${ret.status} ok=${ret.ok} error=${ret.body?.error || ""}`);
    err.payload = ret;
    throw err;
  }
}

(async function main() {
  const results = [];
  results.push(await request("status", "/api/status"));
  if (deepseekApiKey) {
    results.push(await request("setup", "/api/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "deepseek-api-key", apiKey: deepseekApiKey }),
    }));
  }
  results.push(await request("gateway-start", "/api/gateway/start", { method: "POST" }));
  results.push(await request("ai-chat", "/api/ai/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "请给一个BTC短线策略，包含止盈止损。", clientContext: { from: "e2e" } }),
  }, 180000));

  const intentBody = {
    userMessage: "BTC 15m 做多策略，带止损1%，止盈2%",
    assistantReply: String(results[results.length - 1].body?.reply || ""),
    sessionId: "thunderclaw-e2e",
    clientContext: { source: "e2e" },
  };
  const intent = await request("intent-candidates", "/api/strategy/intent-candidates", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(intentBody),
  });
  results.push(intent);

  if (!intent.body?.intentDetected || !Array.isArray(intent.body?.candidates) || intent.body.candidates.length === 0) {
    throw new Error("intent-candidates produced no executable candidates");
  }

  const candidate = Array.isArray(intent.body?.candidates)
    ? (intent.body.candidates.find((c) => c && c.kind === "strategy") || intent.body.candidates[0])
    : null;
  if (!candidate) {
    throw new Error("intent-candidates returned no candidate");
  }

  const apply = await request("intent-apply", "/api/strategy/intent-candidates/apply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ candidate, source: "e2e_intent", sessionId: "thunderclaw-e2e" }),
  });
  results.push(apply);
  const strategyId = String(apply.body?.applied?.strategy?.strategyId || "").trim();
  if (!strategyId) {
    throw new Error("intent-apply did not return strategyId");
  }

  results.push(await request("replay", "/api/strategy/entities/replay", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ strategyId, rangeDays: 14, tradeType: "all", label: "E2E Replay" }),
  }));

  results.push(await request("publish", "/api/strategy/entities/publish", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ strategyId, note: "E2E Publish" }),
  }));

  const detail = await request("detail", `/api/strategy/entities/detail?strategyId=${encodeURIComponent(strategyId)}&rangeDays=14&tradeType=all`);
  results.push(detail);

  results.forEach(assertOk);
  const featureCatalog = Array.isArray(detail.body?.version?.executionReport?.featureCatalog)
    ? detail.body.version.executionReport.featureCatalog
    : [];
  if (featureCatalog.length === 0) {
    throw new Error("detail version missing featureCatalog mapping");
  }
  console.log(JSON.stringify({
    ok: true,
    base,
    strategyId,
    featureCatalogCount: featureCatalog.length,
    steps: results.map((r) => ({ name: r.name, status: r.status })),
  }, null, 2));
})().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: String(error?.message || error), payload: error?.payload || null }, null, 2));
  process.exit(1);
});
