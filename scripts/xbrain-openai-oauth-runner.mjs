#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function emit(event) {
  try {
    process.stdout.write(JSON.stringify(event) + '\n');
  } catch {}
}

function loadOpenAICodexLogin() {
  const candidates = [
    path.resolve(process.cwd(), 'openclaw/node_modules/@mariozechner/pi-ai/dist/utils/oauth/openai-codex.js'),
    path.resolve(os.homedir(), '.npm-global/lib/node_modules/openclaw/node_modules/@mariozechner/pi-ai/dist/utils/oauth/openai-codex.js'),
    path.resolve('/usr/local/lib/node_modules/openclaw/node_modules/@mariozechner/pi-ai/dist/utils/oauth/openai-codex.js'),
  ];
  const target = candidates.find((p) => fs.existsSync(p));
  if (!target) {
    throw new Error('未找到 OpenAI OAuth 运行库（pi-ai/openai-codex.js）。');
  }
  return import(pathToFileURL(target).href).then((mod) => {
    if (!mod || typeof mod.loginOpenAICodex !== 'function') {
      throw new Error('OAuth 运行库缺少 loginOpenAICodex 导出。');
    }
    return mod.loginOpenAICodex;
  });
}

async function main() {
  try {
    const loginOpenAICodex = await loadOpenAICodexLogin();
    const creds = await loginOpenAICodex({
      onAuth: (info) => {
        emit({
          type: 'auth_url',
          url: String(info?.url || ''),
          instructions: String(info?.instructions || ''),
        });
      },
      onPrompt: async (prompt) => {
        emit({
          type: 'auto_callback_unavailable',
          message: String(prompt?.message || '自动回调不可用'),
          placeholder: String(prompt?.placeholder || ''),
        });
        throw new Error('自动回调不可用：请在发起登录的同一台机器浏览器中完成授权，并允许访问 localhost:1455。');
      },
      onProgress: (message) => emit({ type: 'progress', message: String(message || '') }),
      originator: 'openclaw',
    });
    emit({ type: 'done', credentials: creds || null });
    process.exit(0);
  } catch (err) {
    emit({ type: 'error', error: String(err?.message || err) });
    process.exit(1);
  }
}

void main();
