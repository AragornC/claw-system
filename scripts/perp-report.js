#!/usr/bin/env node
/**
 * 报告入口：数据与展示分离。
 * - data: 只更新数据（report/decisions.json, report/ohlcv.json）
 * - viewer: 只生成展示页（report/index.html，不嵌数据）
 * - serve: 启动本地服务，通过 http 打开报告（需先 data + viewer）
 * - 无参数或 open: 先 data，再 viewer，再 serve
 *
 * Usage:
 *   node scripts/perp-report.js           # data + viewer + serve
 *   node scripts/perp-report.js data      # 仅更新数据
 *   node scripts/perp-report.js viewer    # 仅生成 index.html
 *   node scripts/perp-report.js serve     # 仅启动服务
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cmd = process.argv[2] || 'open';

async function run(script, args = []) {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [path.resolve(__dirname, script), ...args], { stdio: 'inherit', cwd: process.cwd() });
    c.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('exit ' + code))));
  });
}

async function main() {
  if (cmd === 'data') {
    await run('perp-report-data.js', process.argv.slice(3));
    return;
  }
  if (cmd === 'viewer') {
    await run('perp-report-viewer.js');
    return;
  }
  if (cmd === 'serve') {
    await run('serve-report.js', process.argv.slice(3));
    return;
  }
  if (cmd === 'open' || cmd === '') {
    await run('perp-report-data.js', process.argv.slice(2).filter((a) => a !== 'open' && a !== ''));
    await run('perp-report-viewer.js');
    await run('serve-report.js');
    return;
  }
  console.error('Usage: perp-report.js [data|viewer|serve|open]');
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
