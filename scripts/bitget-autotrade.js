#!/usr/bin/env node
/**
 * Bitget spot auto-trader (market buy + stop-loss plan order).
 *
 * Empirical behavior (from errors):
 * - place-order requires BOTH delegateAmount and size non-empty.
 * - size appears to be validated against min quote amount (e.g. >= 1 USDT),
 *   so for market BUY we treat `size` as quote amount (USDT), not base size.
 * - plan order requires triggerType (mark_price accepted), triggerPrice > 0 and size > 0.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const WORKDIR = process.env.OPENCLAW_WORKDIR || process.cwd();
const CONFIG_PATH = path.resolve(WORKDIR, 'memory/bitget-autotrade-config.json');
const STATE_PATH = path.resolve(WORKDIR, 'memory/bitget-autotrade-state.json');
const CYCLES_PATH = path.resolve(WORKDIR, 'memory/bitget-autotrade-cycles.jsonl');
const NOTIFY_PATH = path.resolve(WORKDIR, 'memory/bitget-autotrade-notify.json');

const baseUrl = process.env.BITGET_API_BASE_URL || 'https://api.bitget.com';
const apiKey = process.env.BITGET_API_KEY || '';
const secret = process.env.BITGET_API_SECRET || '';
const passphrase = process.env.BITGET_API_PASSPHRASE || '';

function die(msg) {
  process.stdout.write(JSON.stringify({ ok: false, error: msg }, null, 2));
  process.exit(0);
}

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

function appendCycle(obj) {
  try {
    fs.mkdirSync(path.dirname(CYCLES_PATH), { recursive: true });
    fs.appendFileSync(CYCLES_PATH, JSON.stringify(obj) + '\n');
  } catch {}
}

function todayCN() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

function sign(tsMs, method, requestPath, body) {
  const prehash = `${tsMs}${method.toUpperCase()}${requestPath}${body}`;
  return crypto.createHmac('sha256', secret).update(prehash).digest('base64');
}

async function bitgetRequest(requestPath, method = 'GET', bodyObj = undefined) {
  const body = bodyObj ? JSON.stringify(bodyObj) : '';
  const tsMs = String(Date.now());
  const sig = sign(tsMs, method, requestPath, body);

  const res = await fetch(baseUrl + requestPath, {
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

  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
  return json ?? text;
}

async function publicGet(urlPath) {
  const res = await fetch(baseUrl + urlPath, { headers: { accept: 'application/json' } });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
  return json ?? text;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function floorToPrecision(x, decimals) {
  const f = 10 ** decimals;
  return Math.floor(x * f) / f;
}

async function getSymbolMeta(symbol) {
  const j = await publicGet(`/api/v2/spot/public/symbols?symbol=${encodeURIComponent(symbol)}`);
  const item = Array.isArray(j?.data) ? j.data[0] : null;
  if (!item) throw new Error('symbol_meta_not_found');
  return {
    quantityPrecision: Number(item.quantityPrecision ?? 6),
    pricePrecision: Number(item.pricePrecision ?? 2),
  };
}

async function getLastPrice(symbol) {
  const j = await publicGet(`/api/v2/spot/market/tickers?symbol=${encodeURIComponent(symbol)}`);
  const item = Array.isArray(j?.data) ? j.data[0] : null;
  const p = Number(item?.lastPr);
  if (!Number.isFinite(p) || p <= 0) throw new Error('last_price_unavailable');
  return p;
}

async function getSpotAssets() {
  const j = await bitgetRequest('/api/v2/spot/account/assets', 'GET');
  if (j?.code !== '00000') throw new Error(`assets_failed: ${j?.code || 'NA'} ${j?.msg || ''}`);
  const items = Array.isArray(j?.data) ? j.data : [];
  const map = new Map();
  for (const it of items) {
    const coin = String(it?.coin || it?.asset || it?.currency || '').toUpperCase();
    const available = Number(it?.available || it?.availableAmount || it?.availableSize || it?.free || 0);
    if (coin) map.set(coin, Number.isFinite(available) ? available : 0);
  }
  return map;
}

async function placeMarketBuy(symbol, usdtAmount) {
  // Treat BOTH size and delegateAmount as quote (USDT) for market BUY.
  const payload = {
    symbol,
    side: 'buy',
    orderType: 'market',
    delegateAmount: String(usdtAmount),
    size: String(usdtAmount),
  };
  return await bitgetRequest('/api/v2/spot/trade/place-order', 'POST', payload);
}

async function placeStopLossPlan(symbol, baseSize, triggerPrice, triggerType = 'mark_price') {
  const payload = {
    symbol,
    side: 'sell',
    orderType: 'market',
    triggerType,
    triggerPrice: String(triggerPrice),
    size: String(baseSize),
  };
  return await bitgetRequest('/api/v2/spot/trade/place-plan-order', 'POST', payload);
}

function roundPrice(p, decimals = 2) {
  const f = 10 ** decimals;
  return Math.round(p * f) / f;
}

async function main() {
  if (!apiKey || !secret || !passphrase) die('Missing BITGET env vars');

  const cfg = readJson(CONFIG_PATH, null);
  if (!cfg?.enabled) {
    process.stdout.write(JSON.stringify({ ok: true, skipped: true, reason: 'auto_disabled' }, null, 2));
    return;
  }

  const state = readJson(STATE_PATH, { date: null, tradesToday: 0, lastTradeAtMs: {}, lastTradeIds: [] });
  const today = todayCN();
  if (state.date !== today) {
    state.date = today;
    state.tradesToday = 0;
    state.lastTradeAtMs = {};
    state.lastTradeIds = [];
  }

  const input = await new Promise((resolve) => {
    let s = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (s += c));
    process.stdin.on('end', () => resolve(s));
  });

  const signal = input ? JSON.parse(input) : null;
  const alerts = Array.isArray(signal?.alerts) ? signal.alerts : [];
  const newsOk = signal?.news?.ok === true;
  const newsAllow = newsOk && signal?.news?.allow && typeof signal.news.allow === 'object' ? signal.news.allow : null;
  const newsBlock = newsOk && signal?.news?.block && typeof signal.news.block === 'object' ? signal.news.block : null;
  const newsReasons = newsOk && signal?.news?.reasons && typeof signal.news.reasons === 'object' ? signal.news.reasons : {};
  const newsBlockReasons = newsOk && signal?.news?.blockReasons && typeof signal.news.blockReasons === 'object' ? signal.news.blockReasons : {};

  if (!alerts.length) {
    appendCycle({
      ts: new Date().toISOString(),
      date: state.date,
      tradesToday: state.tradesToday,
      newsOk,
      newsAllow,
      newsBlock,
      results: [],
      summary: 'no_alerts',
      shouldNotifyBlockedByNews: false,
      blockedByNewsSummary: [],
    });
    process.stdout.write(JSON.stringify({ ok: true, skipped: true, reason: 'no_alerts', newsOk, newsAllow, newsBlock }, null, 2));
    return;
  }

  const results = [];

  for (const a of alerts) {
    if (!['BTC', 'ETH'].includes(a.key)) continue;

    // News gate（放宽版）：
    // - 若新闻抓取成功：仅在出现“明确负面/利空”时阻止交易；否则不阻挡（技术信号为主）。
    // - 若新闻抓取失败：不阻止交易（但会在结果里标记 newsOk=false）。
    if (newsBlock && newsBlock[a.key] === true) {
      results.push({ key: a.key, skipped: true, reason: 'blocked_by_news', newsBlock: newsBlockReasons?.[a.key] || [] });
      continue;
    }

    if (state.tradesToday >= cfg.maxTradesPerDay) {
      results.push({ key: a.key, skipped: true, reason: 'daily_cap' });
      continue;
    }

    const last = Number(state.lastTradeAtMs?.[a.key] || 0);
    const minGapMs = (cfg.minIntervalMinutesPerSymbol || 20) * 60 * 1000;
    if (Date.now() - last < minGapMs) {
      results.push({ key: a.key, skipped: true, reason: 'min_interval' });
      continue;
    }

    const symbol = `${a.key}${cfg.quote}`;
    const usdtAmount = cfg.order.quoteAmountUSDT;

    try {
      const meta = await getSymbolMeta(symbol);
      const lastPx = await getLastPrice(symbol);

      const before = await getSpotAssets();
      const beforeAvail = before.get(a.key) || 0;

      const buyRes = await placeMarketBuy(symbol, usdtAmount);
      if (buyRes?.code !== '00000') throw new Error(`buy_failed: ${buyRes?.code || 'NA'} ${buyRes?.msg || ''}`);
      const buyOrderId = buyRes?.data?.orderId || buyRes?.data?.orderIdStr || buyRes?.data?.orderNo || null;

      await sleep(1200);
      const after = await getSpotAssets();
      const afterAvail = after.get(a.key) || 0;
      const delta = afterAvail - beforeAvail;

      const acquired = delta > 0 ? floorToPrecision(delta, meta.quantityPrecision) : null;
      if (!(acquired && acquired > 0)) {
        // Disable auto to avoid naked position (can't compute stop size)
        cfg.enabled = false;
        writeJson(CONFIG_PATH, cfg);
        throw new Error('missing_acquired_size_disable_auto');
      }

      const stopPrice = roundPrice(lastPx * (1 - cfg.risk.stopLossPct), meta.pricePrecision);
      if (!(stopPrice > 0)) throw new Error('stop_price_invalid');

      const planRes = await placeStopLossPlan(symbol, acquired, stopPrice, 'mark_price');
      if (planRes?.code !== '00000') {
        cfg.enabled = false;
        writeJson(CONFIG_PATH, cfg);
        throw new Error(`stoploss_failed_disable_auto: ${planRes?.code || 'NA'} ${planRes?.msg || ''}`);
      }

      state.tradesToday += 1;
      state.lastTradeAtMs[a.key] = Date.now();
      if (buyOrderId) state.lastTradeIds.unshift(buyOrderId);
      state.lastTradeIds = state.lastTradeIds.slice(0, 50);
      writeJson(STATE_PATH, state);

      results.push({
        key: a.key,
        executed: true,
        level: a.level,
        buyOrderId,
        usedLastPx: lastPx,
        acquiredSize: acquired,
        stopPrice,
        planOrderId: planRes?.data?.orderId || planRes?.data?.planOrderId || null,
      });
    } catch (e) {
      results.push({ key: a.key, executed: false, error: String(e?.message || e) });
    }
  }

  // Decide whether to notify (blocked-by-news) at most once per day.
  let shouldNotifyBlockedByNews = false;
  let blockedByNewsSummary = [];
  try {
    const notify = readJson(NOTIFY_PATH, { date: null, lastBlockedNotifyAtMs: 0 });
    const alreadyToday = notify?.date === state.date;
    const blocked = results.filter(r => r?.reason === 'blocked_by_news');
    if (blocked.length && !alreadyToday) {
      shouldNotifyBlockedByNews = true;
      blockedByNewsSummary = blocked.map(b => ({ key: b.key, newsBlock: b.newsBlock || [] }));
      notify.date = state.date;
      notify.lastBlockedNotifyAtMs = Date.now();
      writeJson(NOTIFY_PATH, notify);
    }
  } catch {}

  // Append cycle log (one line jsonl) for observability.
  appendCycle({
    ts: new Date().toISOString(),
    date: state.date,
    tradesToday: state.tradesToday,
    newsOk,
    newsAllow,
    newsBlock,
    results,
    shouldNotifyBlockedByNews,
    blockedByNewsSummary,
  });

  process.stdout.write(JSON.stringify({ ok: true, date: state.date, tradesToday: state.tradesToday, newsOk, newsAllow, newsBlock, results, shouldNotifyBlockedByNews, blockedByNewsSummary }, null, 2));
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({ ok: false, error: String(e?.stack || e) }, null, 2));
  process.exit(0);
});
