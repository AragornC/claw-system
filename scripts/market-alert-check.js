#!/usr/bin/env node
/**
 * Market strong-buy alert checker (Binance + Fear&Greed)
 * - BTC/ETH only (spot USDT) — gold alerts disabled by user.
 * - Computes RSI(14), MA20/MA50 on 1h close
 * - Applies strong / very-strong rules
 * - Frequency control via memory/market-alert-state.json
 *
 * Output JSON:
 * { nowMs, fng, fngOk, alerts:[{key, level, text, symbol, type}], nextState }
 */

import fs from 'node:fs';
import path from 'node:path';

const WORKDIR = process.env.OPENCLAW_WORKDIR || process.cwd();
const STATE_PATH = path.resolve(WORKDIR, 'memory/market-alert-state.json');

const BINANCE_BASE = 'https://api.binance.com';
const FNG_URL = 'https://api.alternative.me/fng/?limit=1&format=json';

const SYMBOLS = [
  { key: 'BTC', symbol: 'BTCUSDT' },
  { key: 'ETH', symbol: 'ETHUSDT' },
];

function safeNumber(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

async function fetchJson(url, timeoutMs = 12_000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: {
        'user-agent': 'openclaw-market-alert/1.0',
        accept: 'application/json,text/plain,*/*',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function sma(values, period) {
  if (values.length < period) return null;
  let s = 0;
  for (let i = values.length - period; i < values.length; i++) s += values[i];
  return s / period;
}

function rsi14(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses += -diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function readState() {
  try {
    const raw = fs.readFileSync(STATE_PATH, 'utf8');
    const s = JSON.parse(raw);
    return {
      lastSentAtMs: Number(s?.lastSentAtMs || 0),
      lastSent: s?.lastSent && typeof s.lastSent === 'object' ? s.lastSent : {},
    };
  } catch {
    return { lastSentAtMs: 0, lastSent: {} };
  }
}

function fmt(n, digits = 2) {
  if (n == null || !Number.isFinite(n)) return 'NA';
  return n.toFixed(digits);
}

function fmtPct(n, digits = 2) {
  if (n == null || !Number.isFinite(n)) return 'NA';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(digits)}%`;
}

function buildCryptoMessage({ key, level, price, changePct, low24, high24, rsi, ma20, ma50, fng }) {
  const range = low24 != null && high24 != null ? `${fmt(low24, 2)}~${fmt(high24, 2)}` : 'NA';
  const fngPart = fng != null ? `${Math.round(fng)}` : 'NA';

  const advice = level === 'very-strong'
    ? [
        '建议（中长线）：可考虑分2-4次逐步建仓，单品种仓位上限建议≤10%-15%。',
        '风险点：继续下跌/极端行情的流动性风险；务必设置总止损/分批止损或对冲预案。',
      ]
    : [
        '建议（中长线）：可小仓位试探+分批加仓，单品种仓位上限建议≤8%-12%。',
        '风险点：弱反弹后再破位；不要一次性满仓，注意仓位管理与回撤承受能力。',
      ];

  return [
    `【强买入提醒】${key}（${level}）`,
    `关键数据：现价 ${fmt(price, 2)}；24h涨跌 ${fmtPct(changePct, 2)}；24h区间 ${range}`,
    `RSI(14,1h) ${fmt(rsi, 1)}；MA20 ${fmt(ma20, 2)} / MA50 ${fmt(ma50, 2)}；Fear&Greed ${fngPart}`,
    ...advice,
    '（非投资建议）',
  ].join('\n');
}

async function main() {
  const nowMs = Date.now();
  const state = readState();

  // FNG (optional)
  let fng = null;
  let fngOk = false;
  try {
    const fngJson = await fetchJson(FNG_URL);
    const v = safeNumber(fngJson?.data?.[0]?.value);
    if (v != null) {
      fng = v;
      fngOk = true;
    }
  } catch {
    // ignore
  }

  const alerts = [];

  for (const s of SYMBOLS) {
    try {
      const tickerUrl = `${BINANCE_BASE}/api/v3/ticker/24hr?symbol=${encodeURIComponent(s.symbol)}`;
      const klineUrl = `${BINANCE_BASE}/api/v3/klines?symbol=${encodeURIComponent(s.symbol)}&interval=1h&limit=200`;

      const [ticker, klines] = await Promise.all([fetchJson(tickerUrl), fetchJson(klineUrl)]);

      const price = safeNumber(ticker?.lastPrice);
      const changePct = safeNumber(ticker?.priceChangePercent);
      const low24 = safeNumber(ticker?.lowPrice);
      const high24 = safeNumber(ticker?.highPrice);

      const closes = Array.isArray(klines) ? klines.map(k => safeNumber(k?.[4])).filter(v => v != null) : [];
      const ma20 = sma(closes, 20);
      const ma50 = sma(closes, 50);
      const rsi = rsi14(closes, 14);

      const nearLowPct = price != null && low24 != null ? ((price - low24) / low24 * 100) : null;
      const priceAboveMA20 = price != null && ma20 != null ? price > ma20 : null;

      const isStrong = (rsi != null && rsi <= 30) && (
        priceAboveMA20 === true ||
        (
          nearLowPct != null && nearLowPct <= 1.5 &&
          changePct != null && changePct <= -4 &&
          (fngOk ? fng <= 20 : false)
        )
      );

      const isVeryStrong = (rsi != null && rsi <= 25) &&
        (nearLowPct != null && nearLowPct <= 1.0) &&
        (changePct != null && changePct <= -6) &&
        (fngOk ? fng <= 15 : false);

      const level = isVeryStrong ? 'very-strong' : (isStrong ? 'strong' : null);
      if (!level) continue;

      const lastAny = Number(state.lastSentAtMs || 0);
      const lastThis = Number(state.lastSent?.[s.key] || 0);
      const within60m = nowMs - lastAny < 60 * 60 * 1000;
      const within60mThis = nowMs - lastThis < 60 * 60 * 1000;
      const allow = level === 'very-strong' || (!within60m && !within60mThis);
      if (!allow) continue;

      const text = buildCryptoMessage({
        key: s.key,
        level,
        price,
        changePct,
        low24,
        high24,
        rsi,
        ma20,
        ma50,
        fng: fngOk ? fng : null,
      });

      alerts.push({
        type: 'crypto',
        key: s.key,
        symbol: s.symbol,
        level,
        priority: level === 'very-strong' ? 2 : 1,
        text,
      });
    } catch {
      // ignore per-symbol errors
    }
  }

  alerts.sort((a, b) => (b.priority - a.priority) || String(a.key).localeCompare(String(b.key)));

  const nextState = structuredClone(state);
  for (const a of alerts) {
    nextState.lastSentAtMs = nowMs;
    nextState.lastSent = nextState.lastSent || {};
    nextState.lastSent[a.key] = nowMs;
  }

  process.stdout.write(JSON.stringify({ nowMs, fng, fngOk, statePath: STATE_PATH, alerts, nextState }, null, 2));
}

main().catch(err => {
  process.stdout.write(JSON.stringify({ nowMs: Date.now(), error: String(err?.stack || err) }, null, 2));
  process.exit(0);
});
