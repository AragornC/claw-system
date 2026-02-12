#!/usr/bin/env bash
set -euo pipefail

if ! command -v openclaw >/dev/null 2>&1; then
  echo "[fatal] openclaw 未安装。先执行: npm install -g openclaw@latest"
  exit 1
fi

if [[ -z "${DEEPSEEK_API_KEY:-}" ]]; then
  echo "[fatal] 需要设置 DEEPSEEK_API_KEY 环境变量"
  echo "示例: export DEEPSEEK_API_KEY='sk-xxxx'"
  exit 1
fi

echo "[init] 写入 OpenClaw DeepSeek provider 配置..."
openclaw config set "models.mode" "merge" >/dev/null 2>&1 || true
openclaw config set "agents.defaults.model.primary" "deepseek/deepseek-chat" >/dev/null 2>&1 || true
openclaw config set --json "models.providers.deepseek" \
  '{"baseUrl":"https://api.deepseek.com/v1","apiKey":"${DEEPSEEK_API_KEY}","api":"openai-completions","models":[{"id":"deepseek-chat","name":"DeepSeek Chat"},{"id":"deepseek-reasoner","name":"DeepSeek Reasoner"}]}' >/dev/null 2>&1 || true

echo "[ok] OpenClaw DeepSeek provider 初始化完成"
echo "[next] 启动看板: OPENCLAW_AGENT_LOCAL=1 npm run report:start:cloud"
