#!/usr/bin/env node
/**
 * 数据层：只负责产出报告所需的数据文件，不写 HTML。
 * 1) 引擎/运行数据：从 bitget-perp-cycle-decisions.jsonl 读出最近 N 条，写入 report/decisions.json
 * 2) K 线数据：拉取或使用缓存，写入 report/ohlcv.json
 *
 * Usage: node scripts/perp-report-data.js [maxDecisions]
 * Env: PERP_CHART_SYMBOL, OPENCLAW_WORKDIR
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ccxt from 'ccxt';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKDIR = process.env.OPENCLAW_WORKDIR || process.cwd();
const DECISIONS_JSONL = path.resolve(WORKDIR, 'memory/bitget-perp-cycle-decisions.jsonl');
const OHLCV_CACHE = path.resolve(WORKDIR, 'memory/perp-ohlcv-multi-tf.json');
const REPORT_DIR = path.resolve(WORKDIR, 'memory/report');
const DECISIONS_JSON = path.resolve(REPORT_DIR, 'decisions.json');
const OHLCV_JSON = path.resolve(REPORT_DIR, 'ohlcv.json');

const MAX_DECISIONS = Math.min(1000, Math.max(50, parseInt(process.argv[2], 10) || 200));
const SYMBOL = process.env.PERP_CHART_SYMBOL || 'BTC/USDT:USDT';

const TF_CONFIG = [
  { key: '1m', limit: 480 },
  { key: '5m', limit: 320 },
  { key: '15m', limit: 200 },
  { key: '1h', limit: 300 },
  { key: '4h', limit: 150 },
  { key: '1d', limit: 60 },
];

function readJsonl(p, maxLines) {
  try {
    const s = fs.readFileSync(p, 'utf8');
    const lines = s.split('\n').filter(Boolean);
    const trimmed = lines.slice(-maxLines);
    return trimmed.map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

async function fetchOHLCVMulti() {
  const ex = new ccxt.bitget({ enableRateLimit: true });
  const result = {};
  for (const { key, limit } of TF_CONFIG) {
    try {
      const raw = await ex.fetchOHLCV(SYMBOL, key, undefined, limit);
      result[key] = raw.map((c) => ({
        time: Math.floor(c[0] / 1000),
        open: Number(c[1]),
        high: Number(c[2]),
        low: Number(c[3]),
        close: Number(c[4]),
      }));
    } catch (e) {
      console.error('Fetch', key, 'failed:', e.message);
      result[key] = [];
    }
  }
  fs.mkdirSync(path.dirname(OHLCV_CACHE), { recursive: true });
  fs.writeFileSync(OHLCV_CACHE, JSON.stringify({ symbol: SYMBOL, data: result, fetchedAt: new Date().toISOString() }), 'utf8');
  return result;
}

function loadOHLCVFromCache() {
  try {
    const cached = JSON.parse(fs.readFileSync(OHLCV_CACHE, 'utf8'));
    if (cached.data && Object.keys(cached.data).length) return cached.data;
  } catch {}
  return null;
}

async function main() {
  fs.mkdirSync(REPORT_DIR, { recursive: true });

  const records = readJsonl(DECISIONS_JSONL, MAX_DECISIONS);
  fs.writeFileSync(DECISIONS_JSON, JSON.stringify(records), 'utf8');
  console.log('Wrote report/decisions.json:', records.length, 'records');

  let ohlcvByTf = loadOHLCVFromCache();
  if (!ohlcvByTf) {
    console.log('Fetching OHLCV...');
    ohlcvByTf = await fetchOHLCVMulti();
    Object.entries(ohlcvByTf).forEach(([k, v]) => console.log('  ', k, v.length, 'bars'));
  }
  const payload = { symbol: SYMBOL, data: ohlcvByTf, fetchedAt: new Date().toISOString() };
  fs.writeFileSync(OHLCV_JSON, JSON.stringify(payload), 'utf8');
  console.log('Wrote report/ohlcv.json');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
