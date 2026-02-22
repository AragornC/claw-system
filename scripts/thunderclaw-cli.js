#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const cmd = String(args[0] || 'help').trim().toLowerCase();

function printHelp() {
  console.log(
    [
      'ThunderClaw CLI (壳子保留版)',
      '',
      '可用命令:',
      '  thunderclaw help',
      '  thunderclaw assets',
      '  thunderclaw idea',
      '',
      '说明:',
      '  当前仓库仅保留 ThunderClaw 壳子、产品页面、图片资产和产品思路。',
      '  复杂后端逻辑已移除，后续建议直接基于 OpenClaw 重建能力层。',
    ].join('\n'),
  );
}

if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
  printHelp();
  process.exit(0);
}

if (cmd === 'assets') {
  console.log(path.resolve(root, 'memory/report/index.html'));
  console.log(path.resolve(root, 'memory/report/app-icon.svg'));
  console.log(path.resolve(root, 'memory/report/app-icon-maskable.svg'));
  process.exit(0);
}

if (cmd === 'idea') {
  console.log(path.resolve(root, 'THUNDERCLAW_PRODUCT_IDEA.md'));
  process.exit(0);
}

printHelp();
