#!/usr/bin/env node
import crypto from 'node:crypto';

const baseUrl = process.env.BITGET_API_BASE_URL || 'https://api.bitget.com';
const apiKey = process.env.BITGET_API_KEY || '';
const secret = process.env.BITGET_API_SECRET || '';
const passphrase = process.env.BITGET_API_PASSPHRASE || '';

function sign(tsMs, method, path, body) {
  const prehash = `${tsMs}${method.toUpperCase()}${path}${body}`;
  return crypto.createHmac('sha256', secret).update(prehash).digest('base64');
}

async function req(path, method, bodyObj) {
  const body = bodyObj ? JSON.stringify(bodyObj) : '';
  const tsMs = String(Date.now());
  const sig = sign(tsMs, method, path, body);
  const res = await fetch(baseUrl + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'ACCESS-KEY': apiKey,
      'ACCESS-SIGN': sig,
      'ACCESS-TIMESTAMP': tsMs,
      'ACCESS-PASSPHRASE': passphrase,
      'locale': 'en-US',
    },
    body: body || undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, ok: res.ok, body: json ?? text };
}

async function main() {
  // Use values that should NEVER execute:
  // - delegateAmount/size=0
  // - triggerPrice=0
  const placeOrder = await req('/api/v2/spot/trade/place-order', 'POST', {
    symbol: 'BTCUSDT',
    side: 'buy',
    orderType: 'market',
    // required by API according to previous error
    delegateAmount: '0',
    // keep size too, in case API expects base size in some modes
    size: '0'
  });

  const triggerTypeCandidates = ['fill_price', 'market_price', 'mark_price', 'last_price', 'price'];
  const placePlan = [];
  for (const triggerType of triggerTypeCandidates) {
    const r = await req('/api/v2/spot/trade/place-plan-order', 'POST', {
      symbol: 'BTCUSDT',
      side: 'sell',
      orderType: 'market',
      triggerType,
      triggerPrice: '0',
      size: '0'
    });
    placePlan.push({ triggerType, ...r });
  }

  console.log(JSON.stringify({ placeOrder, placePlan }, null, 2));
}

main().catch((e) => {
  console.error(String(e?.stack || e));
  process.exit(1);
});
