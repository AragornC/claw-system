import crypto from "node:crypto";

const baseUrl = process.env.OKX_API_BASE_URL || "https://www.okx.com";
const apiKey = process.env.OKX_API_KEY || "";
const secret = process.env.OKX_API_SECRET || "";
const passphrase = process.env.OKX_API_PASSPHRASE || "";

if (!apiKey || !secret || !passphrase) {
  console.error("Missing OKX env vars: OKX_API_KEY/OKX_API_SECRET/OKX_API_PASSPHRASE");
  process.exit(1);
}

function sign(ts: string, method: string, path: string, body: string) {
  const prehash = ts + method.toUpperCase() + path + body;
  return crypto.createHmac("sha256", secret).update(prehash).digest("base64");
}

async function okxRequest(path: string, method: string = "GET", bodyObj: any = undefined) {
  const body = bodyObj ? JSON.stringify(bodyObj) : "";
  const ts = new Date().toISOString();
  const signature = sign(ts, method, path, body);

  const res = await fetch(baseUrl + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      "OK-ACCESS-KEY": apiKey,
      "OK-ACCESS-SIGN": signature,
      "OK-ACCESS-TIMESTAMP": ts,
      "OK-ACCESS-PASSPHRASE": passphrase,
    },
    body: body || undefined,
  });

  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return json ?? text;
}

async function main() {
  // Basic auth + permissions check: fetch balances
  const data = await okxRequest("/api/v5/account/balance", "GET");
  // Print minimal summary to avoid leaking details
  const code = data?.code;
  const msg = data?.msg;
  const ts = data?.ts;
  const hasData = Array.isArray(data?.data) && data.data.length > 0;

  console.log(JSON.stringify({ ok: code === "0", code, msg, ts, hasData }));
}

main().catch((e) => {
  console.error(String(e?.message || e));
  process.exit(1);
});
