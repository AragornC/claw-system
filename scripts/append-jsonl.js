#!/usr/bin/env node
/** Append JSON (from stdin) as one line into a jsonl file. */
import fs from 'node:fs';
import path from 'node:path';

const outPath = process.argv[2];
if (!outPath) process.exit(0);

const input = await new Promise((resolve) => {
  let s = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => (s += c));
  process.stdin.on('end', () => resolve(s));
});

let obj;
try { obj = JSON.parse(input); } catch { process.exit(0); }

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.appendFileSync(outPath, JSON.stringify(obj) + '\n');
