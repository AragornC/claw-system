#!/usr/bin/env node
/**
 * 把 jsonl 里老记录按新格式刷一遍：补全 signal.algorithm、decision.newsItems。
 * - algorithm：从 plan.reason 或 note 解析出 bias，无则用 note/reason 作为说明
 * - newsItems：拉取一次当前 BlockBeats 新闻，给所有缺 newsItems 的记录统一填上（仅作展示用）
 *
 * Usage: node scripts/backfill-decisions-format.js
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKDIR = process.env.OPENCLAW_WORKDIR || process.cwd();
const JSONL_PATH = path.resolve(WORKDIR, 'memory/bitget-perp-cycle-decisions.jsonl');

function runNode(scriptRel) {
  const script = path.resolve(WORKDIR, scriptRel);
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.setEncoding('utf8');
    p.stderr.setEncoding('utf8');
    p.stdout.on('data', (c) => (out += c));
    p.stderr.on('data', (c) => (err += c));
    p.on('close', () => resolve({ out, err }));
  });
}

function inferAlgorithm(r) {
  const reason = r.signal?.plan?.reason;
  const note = r.signal?.note;
  const s = String(reason || note || '');
  if (!s) return null;
  const meta = {};
  if (/bias=long/i.test(s)) meta.bias = 'long';
  else if (/bias=short/i.test(s)) meta.bias = 'short';
  const levelMatch = s.match(/level=([\d.]+)/i);
  if (levelMatch) meta.level = parseFloat(levelMatch[1]);
  const adxMatch = s.match(/adx[=:]?\s*([\d.]+)/i);
  if (adxMatch) meta.adx = parseFloat(adxMatch[1]);
  return {
    note: reason || note || s,
    meta: Object.keys(meta).length ? meta : undefined,
  };
}

async function fetchCurrentNewsItems() {
  const { out } = await runNode('scripts/blockbeats-news-signal.js');
  let j;
  try { j = JSON.parse(out); } catch { return []; }
  if (!j.ok || !Array.isArray(j.items)) return [];
  return j.items.slice(0, 20).map((it) => ({
    title: it.title,
    url: it.url,
    tsLocal: it.tsLocal,
  }));
}

async function main() {
  let raw = '';
  try {
    raw = fs.readFileSync(JSONL_PATH, 'utf8');
  } catch (e) {
    console.error('Read jsonl failed:', e.message);
    process.exit(1);
  }
  const lines = raw.split('\n').filter(Boolean);
  console.log('Current records:', lines.length);

  const newsItems = await fetchCurrentNewsItems();
  console.log('Fetched news items:', newsItems.length);

  const out = [];
  for (const line of lines) {
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      out.push(line);
      continue;
    }
    if (r.signal && !r.signal.algorithm) {
      const algo = inferAlgorithm(r);
      if (algo) {
        r.signal.algorithm = {};
        if (algo.note) r.signal.algorithm.note = algo.note;
        if (algo.meta) r.signal.algorithm.meta = algo.meta;
      }
    }
    if (r.decision && !r.decision.newsItems && Array.isArray(newsItems) && newsItems.length) {
      r.decision.newsItems = newsItems;
    }
    out.push(JSON.stringify(r));
  }

  fs.writeFileSync(JSONL_PATH, out.join('\n') + '\n', 'utf8');
  console.log('Backfilled', out.length, 'records to', JSONL_PATH);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
