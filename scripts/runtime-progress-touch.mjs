#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const ROOT_DIR = process.cwd();
const OUT_PATH = path.resolve(ROOT_DIR, 'memory/runtime/runtime-progress.json');

const note = String(process.argv.slice(2).join(' ').trim() || 'heartbeat');
const now = new Date().toISOString();

let prev = {
  updatedAt: null,
  history: [],
};
try {
  if (fs.existsSync(OUT_PATH)) {
    prev = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8'));
  }
} catch {}

const history = Array.isArray(prev.history) ? prev.history : [];
history.push({ ts: now, note });
const next = {
  updatedAt: now,
  latest: note,
  history: history.slice(-120),
};

fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
fs.writeFileSync(OUT_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
process.stdout.write(`[progress] updated ${OUT_PATH}\n`);
