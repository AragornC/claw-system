#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);

const THUNDERCLAW_HOME = path.resolve(process.env.THUNDERCLAW_HOME || path.join(os.homedir(), '.thunderclaw'));
const WORKSPACE_DIR = path.resolve(process.env.THUNDERCLAW_WORKSPACE || path.join(THUNDERCLAW_HOME, 'workspace'));
const REPO_URL = process.env.THUNDERCLAW_REPO || 'https://github.com/AragornC/claw-system.git';
const REPO_BRANCH = process.env.THUNDERCLAW_BRANCH || 'main';

const OPENCLAW_FALLBACK_ARGS = ['-y', 'openclaw@latest'];

function exists(p) {
  try {
    fs.accessSync(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function isExecutable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function which(cmd) {
  const pathEnv = String(process.env.PATH || '');
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const full = path.join(dir, cmd);
    if (isExecutable(full)) return full;
  }
  return null;
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      cwd: options.cwd || process.cwd(),
      env: options.env || process.env,
    });
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

async function runChecked(command, args, options = {}) {
  const code = await run(command, args, options);
  if (code !== 0) {
    process.exit(code);
  }
}

function resolveOpenClawRunner() {
  const fromEnv = (process.env.OPENCLAW_BIN || '').trim();
  if (fromEnv) return { command: fromEnv, prefix: [] };
  const bin = which('openclaw');
  if (bin) return { command: bin, prefix: [] };
  return { command: 'npx', prefix: OPENCLAW_FALLBACK_ARGS };
}

async function runOpenClaw(args) {
  const runner = resolveOpenClawRunner();
  return runChecked(runner.command, [...runner.prefix, ...args]);
}

async function ensureWorkspace() {
  const gitDir = path.join(WORKSPACE_DIR, '.git');
  fs.mkdirSync(THUNDERCLAW_HOME, { recursive: true });
  if (!exists(gitDir)) {
    console.log('[thunderclaw] 准备工作区:', WORKSPACE_DIR);
    await runChecked('git', ['clone', '--branch', REPO_BRANCH, REPO_URL, WORKSPACE_DIR]);
    return;
  }
  console.log('[thunderclaw] 更新工作区:', WORKSPACE_DIR);
  await runChecked('git', ['-C', WORKSPACE_DIR, 'fetch', 'origin', REPO_BRANCH]);
  await runChecked('git', ['-C', WORKSPACE_DIR, 'checkout', REPO_BRANCH]);
  await runChecked('git', ['-C', WORKSPACE_DIR, 'pull', 'origin', REPO_BRANCH]);
}

function needsDependencyInstall() {
  const packageJson = path.join(WORKSPACE_DIR, 'package.json');
  const nodeModules = path.join(WORKSPACE_DIR, 'node_modules');
  const ccxtPkg = path.join(nodeModules, 'ccxt', 'package.json');
  const lockPath = path.join(WORKSPACE_DIR, 'package-lock.json');
  const modulesLockPath = path.join(nodeModules, '.package-lock.json');
  if (!exists(packageJson)) return false;
  if (!exists(nodeModules)) return true;
  if (!exists(ccxtPkg)) return true;
  if (exists(lockPath) && exists(modulesLockPath)) {
    try {
      const src = fs.statSync(lockPath).mtimeMs;
      const dst = fs.statSync(modulesLockPath).mtimeMs;
      if (src > dst + 500) return true;
    } catch {}
  }
  return false;
}

async function ensureWorkspaceDependencies() {
  if (!needsDependencyInstall()) return;
  console.log('[thunderclaw] 安装项目依赖（npm install）...');
  await runChecked('npm', ['install', '--no-audit', '--no-fund'], { cwd: WORKSPACE_DIR });
}

async function runLocalScript(scriptName, extraEnv = {}) {
  const scriptPath = path.join(WORKSPACE_DIR, 'scripts', scriptName);
  if (!exists(scriptPath)) {
    console.error('[thunderclaw] 缺少脚本:', scriptPath);
    process.exit(1);
  }
  await runChecked('bash', [scriptPath], {
    cwd: WORKSPACE_DIR,
    env: {
      ...process.env,
      ...extraEnv,
    },
  });
}

function printHelp() {
  console.log(
    [
      'ThunderClaw CLI',
      '',
      'Usage:',
      '  thunderclaw onboard     # 拉取/更新工作区 + 本地引导配置 + 启动看板',
      '  thunderclaw onboard --no-start  # 仅引导配置，不启动服务',
      '  thunderclaw start       # 启动交易看板服务',
      '  thunderclaw workspace   # 查看本地工作区路径',
      '  thunderclaw update      # 仅更新工作区代码',
      '',
      'Other commands are forwarded to OpenClaw:',
      '  thunderclaw channels list',
      '  thunderclaw models status',
      '  thunderclaw configure',
      '',
      'Env overrides:',
      '  THUNDERCLAW_HOME, THUNDERCLAW_WORKSPACE, THUNDERCLAW_REPO, THUNDERCLAW_BRANCH',
    ].join('\n'),
  );
}

async function main() {
  const cmd = argv[0] || 'help';
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    printHelp();
    return;
  }
  if (cmd === '--version' || cmd === '-V' || cmd === 'version') {
    console.log('thunderclaw 0.1.0');
    return;
  }
  if (cmd === 'workspace') {
    console.log(WORKSPACE_DIR);
    return;
  }
  if (cmd === 'update') {
    await ensureWorkspace();
    return;
  }
  if (cmd === 'onboard') {
    const noStart = argv.includes('--no-start');
    await ensureWorkspace();
    await ensureWorkspaceDependencies();
    await runLocalScript('openclaw-local-setup.sh', {
      OPENCLAW_CLI_BIN: process.env.OPENCLAW_CLI_BIN || 'openclaw',
    });
    if (noStart) {
      console.log('[thunderclaw] 下一步: thunderclaw start');
      return;
    }
    console.log('[thunderclaw] 正在启动看板服务...');
    await runLocalScript('report-start-local.sh', {
      OPENCLAW_CLI_BIN: process.env.OPENCLAW_CLI_BIN || 'thunderclaw',
      OPENCLAW_AGENT_LOCAL: process.env.OPENCLAW_AGENT_LOCAL || '1',
    });
    return;
  }
  if (cmd === 'start') {
    await ensureWorkspace();
    await ensureWorkspaceDependencies();
    await runLocalScript('report-start-local.sh', {
      OPENCLAW_CLI_BIN: process.env.OPENCLAW_CLI_BIN || 'thunderclaw',
      OPENCLAW_AGENT_LOCAL: process.env.OPENCLAW_AGENT_LOCAL || '1',
    });
    return;
  }
  await runOpenClaw(argv);
}

main().catch((err) => {
  console.error('[thunderclaw] error:', String(err?.message || err));
  process.exit(1);
});
