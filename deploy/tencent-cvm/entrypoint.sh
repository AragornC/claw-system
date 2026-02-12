#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${DEEPSEEK_API_KEY:-}" ]]; then
  echo "[fatal] DEEPSEEK_API_KEY is required"
  exit 1
fi

export OPENCLAW_WORKDIR="${OPENCLAW_WORKDIR:-/app}"
export OPENCLAW_CLI_BIN="${OPENCLAW_CLI_BIN:-openclaw}"
export OPENCLAW_AGENT_LOCAL="${OPENCLAW_AGENT_LOCAL:-1}"
export OPENCLAW_AGENT_ID="${OPENCLAW_AGENT_ID:-main}"
export OPENCLAW_TIMEOUT_SEC="${OPENCLAW_TIMEOUT_SEC:-90}"
export OPENCLAW_CHAT_TIMEOUT_MS="${OPENCLAW_CHAT_TIMEOUT_MS:-95000}"
export PORT="${PORT:-8765}"

cd /app

echo "[init] configuring OpenClaw deepseek provider..."
openclaw config set "models.mode" "merge" >/dev/null 2>&1 || true
openclaw config set "agents.defaults.model.primary" "deepseek/deepseek-chat" >/dev/null 2>&1 || true
openclaw config set --json "models.providers.deepseek" \
  '{"baseUrl":"https://api.deepseek.com/v1","apiKey":"${DEEPSEEK_API_KEY}","api":"openai-completions","models":[{"id":"deepseek-chat","name":"DeepSeek Chat"},{"id":"deepseek-reasoner","name":"DeepSeek Reasoner"}]}' >/dev/null 2>&1 || true

if [[ "${REFRESH_REPORT_DATA:-0}" == "1" ]]; then
  echo "[init] refreshing report data..."
  node scripts/perp-report-data.js "${REPORT_MAX_DECISIONS:-400}" || true
fi

echo "[init] generating report viewer..."
node scripts/perp-report-viewer.js

echo "[start] report server on :${PORT}"
exec node scripts/serve-report.js "${PORT}"
