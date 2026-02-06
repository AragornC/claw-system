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
  // Use an intentionally invalid symbol to avoid any chance of execution,
  // while still learning which fields are required.
  const invalidSymbol = 'ZZZUSDT';

  const placeOrder = await req('/api/v2/spot/trade/place-order', 'POST', {
    symbol: invalidSymbol,
    side: 'buy',
    orderType: 'market',
    delegateAmount: '5',
    size: '1'
  });

  const placePlan = await req('/api/v2/spot/trade/place-plan-order', 'POST', {
    symbol: invalidSymbol,
    side: 'sell',
    orderType: 'market',
    triggerType: 'mark_price',
    triggerPrice: '1',
    size: '1'
  });

  console.log(JSON.stringify({ invalidSymbol, placeOrder, placePlan }, null, 2));
}

main().catch((e) => {
  console.error(String(e?.stack || e));
  process.exit(1);
});
