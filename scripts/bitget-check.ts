import crypto from "node:crypto";

const baseUrl = process.env.BITGET_API_BASE_URL || "https://api.bitget.com";
const apiKey = process.env.BITGET_API_KEY || "";
const secret = process.env.BITGET_API_SECRET || "";
const passphrase = process.env.BITGET_API_PASSPHRASE || "";

if (!apiKey || !secret || !passphrase) {
  console.error("Missing BITGET env vars: BITGET_API_KEY/BITGET_API_SECRET/BITGET_API_PASSPHRASE");
  process.exit(1);
}

function sign(tsMs: string, method: string, path: string, body: string) {
  // Bitget common pattern: prehash = timestamp + method + requestPath + body
  const prehash = tsMs + method.toUpperCase() + path + body;
  return crypto.createHmac("sha256", secret).update(prehash).digest("base64");
}

async function req(path: string, method: string = "GET", bodyObj?: any) {
  const body = bodyObj ? JSON.stringify(bodyObj) : "";
  const tsMs = String(Date.now());
  const sig = sign(tsMs, method, path, body);

  const res = await fetch(baseUrl + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      // Some Bitget endpoints use ACCESS-* headers
      "ACCESS-KEY": apiKey,
      "ACCESS-SIGN": sig,
      "ACCESS-TIMESTAMP": tsMs,
      "ACCESS-PASSPHRASE": passphrase,
      // Some deployments accept locale header; harmless if ignored
      "locale": "en-US",
    },
    body: body || undefined,
  });

  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return json ?? text;
}

async function main() {
  // Quick sanity: public time
  const pub = await fetch(baseUrl + "/api/v2/public/time").then(r => r.json());

  // Private test: spot assets (read permission required)
  const priv = await req("/api/v2/spot/account/assets", "GET");

  const ok = priv?.code === "00000";
  const code = priv?.code;
  const msg = priv?.msg;
  const hasData = Array.isArray(priv?.data);

  console.log(JSON.stringify({ ok, code, msg, hasData, pubTimeOk: pub?.code === "00000" }));
}

main().catch((e) => {
  console.error(String(e?.message || e));
  process.exit(1);
});
