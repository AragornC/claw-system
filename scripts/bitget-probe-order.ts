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
  const prehash = tsMs + method.toUpperCase() + path + body;
  return crypto.createHmac("sha256", secret).update(prehash).digest("base64");
}

async function req(path: string, method: string, bodyObj?: any) {
  const body = bodyObj ? JSON.stringify(bodyObj) : "";
  const tsMs = String(Date.now());
  const sig = sign(tsMs, method, path, body);

  const res = await fetch(baseUrl + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      "ACCESS-KEY": apiKey,
      "ACCESS-SIGN": sig,
      "ACCESS-TIMESTAMP": tsMs,
      "ACCESS-PASSPHRASE": passphrase,
      "locale": "en-US",
    },
    body: body || undefined,
  });

  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, ok: res.ok, body: json ?? text };
}

async function main() {
  const r = await req("/api/v2/spot/trade/place-order", "POST", {});
  // Print a compact shape
  console.log(JSON.stringify(r));
}

main().catch((e) => {
  console.error(String(e?.message || e));
  process.exit(1);
});
