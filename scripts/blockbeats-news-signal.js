#!/usr/bin/env node
/**
 * BlockBeats (theblockbeats.info) newsflash signal extractor.
 *
 * Goal: find recent (default <=120min) BTC/ETH positive news (abc categories) and output
 * a compact JSON for downstream auto-trade gating.
 *
 * Output:
 * {
 *   ok: true,
 *   nowMs,
 *   windowHours: 3,
 *   recencyMinutes: 120,
 *   items:[{ id, tsLocal, title, url, keys:["BTC"|"ETH"], tags:[...], score }],
 *   allow:{ BTC:true|false, ETH:true|false },
 *   block:{ BTC:true|false, ETH:true|false },
 *   reasons:{ BTC:[...], ETH:[...] },
 *   blockReasons:{ BTC:[...], ETH:[...] }
 * }
 */

import fs from 'node:fs';
import path from 'node:path';
import { installStdoutEpipeGuard } from './_stdout-epipe-guard.js';

installStdoutEpipeGuard();

const WORKDIR = process.env.OPENCLAW_WORKDIR || process.cwd();
const STATE_PATH = path.resolve(WORKDIR, 'memory/blockbeats-news-state.json');

const NEWSFLASH_URL = 'https://www.theblockbeats.info/newsflash';

// Only look back a short window to reduce stale/news-repeat bias.
const windowHours = Number(process.env.BB_WINDOW_HOURS || 3);
const recencyMinutes = Number(process.env.BB_RECENCY_MINUTES || 120);

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

function nowShanghai() {
  const d = new Date();
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(d);
  const get = (t) => parts.find(p => p.type === t)?.value;
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

function toShanghaiTimestampMs(dateStr, timeStr) {
  // dateStr: YYYY-MM-DD, timeStr: HH:MM (assumed Asia/Shanghai)
  // Convert by constructing an ISO-like string and adjusting using timeZone formatting.
  // Simpler: create Date in UTC from components then subtract timezone offset.
  const [Y, M, D] = dateStr.split('-').map(Number);
  const [h, m] = timeStr.split(':').map(Number);
  // Create a Date as if it's UTC, then shift by +8h to represent Shanghai.
  // Shanghai = UTC+8 => UTC time = local - 8h
  const utcMs = Date.UTC(Y, M - 1, D, h - 8, m, 0);
  return utcMs;
}

function stripTags(s) {
  return s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function uniq(arr) {
  return Array.from(new Set(arr));
}

function classify(title) {
  const t = title.toLowerCase();

  const keys = [];
  if (/(^|\b)btc(\b|$)|比特币/.test(t)) keys.push('BTC');
  if (/(^|\b)eth(\b|$)|以太坊/.test(t)) keys.push('ETH');
  // If no explicit mention, only treat as crypto-macro if it clearly references crypto context.
  const macroish = /(美联储|fomc|降息|加息|cpi|pce|dxy|国债|通胀|就业|关税|etf|现货etf|blackrock|贝莱德)/i.test(title);
  const cryptoContext = /(加密|数字货币|稳定币|比特币|以太坊|btc|eth|crypto)/i.test(title);
  if (!keys.length && macroish && cryptoContext) keys.push('BTC', 'ETH');

  // Positive/bullish heuristics (abc)
  const tags = [];
  let score = 0;

  // A: policy/regulation/ETF/macro
  if (/(批准|通过|落地|开放|允许|正面|利好|减税|放松监管|降息|降准|宽松|现货etf|etf净流入|申赎|增持|监管明确|立法进展)/i.test(title)) {
    tags.push('policy/etf/macro');
    score += 2;
  }

  // B: flows / institutions / onchain accumulation
  if (/(净流入|增持|买入|回购|存入|提币|从cex提币|机构|基金|贝莱德|blackrock|strategy|microstrategy|灰度|whale|巨鲸|链上数据|吸筹)/i.test(title)) {
    tags.push('flows/institution/onchain');
    score += 2;
  }

  // C: tech/ecosystem (ETH focused)
  if (/(升级|提案|主网|测试网|分叉|rollup|layer2|l2|eip|zk|性能|gas|交易费下降|基本面强劲|新增地址)/i.test(title)) {
    tags.push('tech/ecosystem');
    score += 1;
  }

  // Mild bullish price-action headlines (律动快讯常见短句)
  if (/(突破|站上|重回|回升|反弹|收复|涨超|上涨)/i.test(title)) {
    tags.push('price-action');
    score += 1;
  }

  // Negative filters (use as BLOCK signal, not just "not bullish")
  if (/(下探|走弱|利空|抛售|暴跌|清算|被盗|攻击|暂停|关闭|调查|起诉|处罚|极度恐慌|不会降息)/i.test(title)) {
    tags.push('negative');
    score -= 3;
  }

  // Bullish if score >= 1 and not explicitly negative
  const bullish = score >= 1 && !tags.includes('negative');
  const bearish = score <= -2 || tags.includes('negative');

  return { keys: uniq(keys), tags: uniq(tags), score, bullish, bearish };
}

async function fetchHtml(url, timeoutMs = 12000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: {
        'user-agent': 'openclaw-blockbeats/1.0',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

function extractItemsFromHtml(html) {
  // Heuristic parser:
  // - date markers look like: 2026-02-03
  // - flash anchors have href="/flash/\d+" and contain leading "HH:MM".

  const items = [];
  let currentDate = null;

  // Split into manageable chunks by 'flash/' occurrences
  const dateRe = /20\d{2}-\d{2}-\d{2}/g;
  const anchorRe = /href=\"(\/flash\/(\d+))\"[^>]*>([\s\S]*?)<\/a>/g;

  // Walk through html sequentially: update currentDate when we see a date near cursor.
  // We'll scan with a global regex over anchors and look backwards a bit for latest date.
  let m;
  while ((m = anchorRe.exec(html)) !== null) {
    const href = m[1];
    const id = m[2];
    const rawText = stripTags(m[3]);

    const timeMatch = rawText.match(/^(\d{2}:\d{2})\s+(.*)$/);
    if (!timeMatch) continue;

    // Find nearest preceding date within 20k chars
    const start = Math.max(0, m.index - 20000);
    const context = html.slice(start, m.index);
    const dates = Array.from(context.matchAll(dateRe));
    if (dates.length) currentDate = dates[dates.length - 1][0];
    if (!currentDate) continue;

    const time = timeMatch[1];
    const title = timeMatch[2].trim();

    items.push({
      id,
      date: currentDate,
      time,
      title,
      url: `https://www.theblockbeats.info${href}`,
    });
  }

  return items;
}

async function main() {
  const nowMs = Date.now();
  const state = readJson(STATE_PATH, { seen: {}, lastRunAtMs: 0 });
  const seen = state.seen && typeof state.seen === 'object' ? state.seen : {};

  let html = '';
  try {
    html = await fetchHtml(NEWSFLASH_URL);
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, error: `fetch_failed: ${String(e?.message || e)}` }));
    process.exit(0);
  }

  const rawItems = extractItemsFromHtml(html);

  const cutoffMs = nowMs - windowHours * 60 * 60 * 1000;
  const recencyCutoffMs = nowMs - recencyMinutes * 60 * 1000;

  const outItems = [];
  const allow = { BTC: false, ETH: false };
  const block = { BTC: false, ETH: false };
  const reasons = { BTC: [], ETH: [] };
  const blockReasons = { BTC: [], ETH: [] };

  for (const it of rawItems) {
    const tsMs = toShanghaiTimestampMs(it.date, it.time);
    if (!Number.isFinite(tsMs)) continue;
    if (tsMs < cutoffMs) continue;

    const { keys, tags, score, bullish, bearish } = classify(it.title);
    if (!keys.length) continue;

    // Avoid reusing the same flash as a trade trigger forever:
    // - keep seen, but allow it to show up in items list once.
    const alreadySeenAt = Number(seen[it.id] || 0);

    const isRecent = tsMs >= recencyCutoffMs;
    if (isRecent && !alreadySeenAt) {
      // If bullish, mark allow; if bearish, mark block.
      for (const k of keys) {
        if (k !== 'BTC' && k !== 'ETH') continue;
        if (bullish) {
          allow[k] = true;
          reasons[k].push(`${it.time} ${it.title}`);
        }
        if (bearish) {
          block[k] = true;
          blockReasons[k].push(`${it.time} ${it.title}`);
        }
      }
      // Mark seen so we don't repeatedly gate on the same flash.
      if (bullish || bearish) seen[it.id] = nowMs;
    }

    outItems.push({
      id: it.id,
      tsLocal: `${it.date} ${it.time}`,
      title: it.title,
      url: it.url,
      keys,
      tags,
      score,
    });
  }

  // prune seen older than 72h
  const pruneBefore = nowMs - 72 * 60 * 60 * 1000;
  for (const [id, t] of Object.entries(seen)) {
    if (Number(t) < pruneBefore) delete seen[id];
  }

  writeJson(STATE_PATH, { seen, lastRunAtMs: nowMs, lastRunAtLocal: nowShanghai() });

  process.stdout.write(JSON.stringify({
    ok: true,
    nowMs,
    windowHours,
    recencyMinutes,
    items: outItems.slice(0, 120),
    allow,
    block,
    reasons,
    blockReasons,
  }, null, 2));
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  process.exit(0);
});
