#!/usr/bin/env node
/**
 * Migrate perp trades jsonl timestamp:
 * - ts (ISO Z) -> tsUtc
 * - add tsLocal (Asia/Shanghai, RFC3339-like) and ts (alias to tsLocal)
 */

import fs from 'node:fs';
import path from 'node:path';

const WORKDIR = process.env.OPENCLAW_WORKDIR || process.cwd();
const file = path.resolve(WORKDIR, 'memory/bitget-perp-autotrade-trades.jsonl');

function toShanghai(iso) {
  try {
    const d = new Date(iso);
    const parts = new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(d);
    const get = (t) => parts.find(p => p.type === t)?.value;
    // sv-SE gives YYYY-MM-DD HH:mm:ss
    const s = `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}+08:00`;
    return s;
  } catch {
    return null;
  }
}

if (!fs.existsSync(file)) process.exit(0);
const raw = fs.readFileSync(file, 'utf8');
const lines = raw.split('\n').filter(Boolean);
const out = [];
for (const line of lines) {
  let obj;
  try { obj = JSON.parse(line); } catch { continue; }
  const ts = obj.ts;
  if (typeof ts === 'string' && ts.endsWith('Z')) {
    const local = toShanghai(ts);
    if (local) {
      obj.tsUtc = ts;
      obj.tsLocal = local;
      obj.ts = local;
    }
  }
  out.push(JSON.stringify(obj));
}
fs.writeFileSync(file, out.join('\n') + '\n');
