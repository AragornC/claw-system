#!/usr/bin/env node
/**
 * Prune a JSONL file to keep only the last N lines.
 * Usage:
 *   node prune-jsonl.js <path> <maxLines>
 */

import fs from 'node:fs';
import path from 'node:path';

const file = process.argv[2];
const maxLines = Math.max(1, Number(process.argv[3] || 2000));
if (!file) process.exit(0);

try {
  if (!fs.existsSync(file)) process.exit(0);
  const st = fs.statSync(file);
  if (!st.isFile()) process.exit(0);

  // Read whole file (safe because we prune frequently and cap maxLines).
  const data = fs.readFileSync(file, 'utf8');
  const lines = data.split('\n').filter(l => l.length);
  if (lines.length <= maxLines) process.exit(0);

  const kept = lines.slice(-maxLines).join('\n') + '\n';
  const tmp = file + '.tmp';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, kept);
  fs.renameSync(tmp, file);
} catch {
  // silent
}
