#!/usr/bin/env bash
set -euo pipefail

export OPENCLAW_WORKDIR="${OPENCLAW_WORKDIR:-/app}"
export OPENCLAW_CLI_BIN="${OPENCLAW_CLI_BIN:-openclaw}"
export OPENCLAW_AGENT_LOCAL="${OPENCLAW_AGENT_LOCAL:-1}"
export OPENCLAW_AGENT_ID="${OPENCLAW_AGENT_ID:-main}"
export OPENCLAW_TIMEOUT_SEC="${OPENCLAW_TIMEOUT_SEC:-90}"
export OPENCLAW_CHAT_TIMEOUT_MS="${OPENCLAW_CHAT_TIMEOUT_MS:-95000}"
export OPENCLAW_PRIMARY_MODEL="${OPENCLAW_PRIMARY_MODEL:-deepseek/deepseek-chat}"
export OPENCLAW_BOOTSTRAP_DEEPSEEK="${OPENCLAW_BOOTSTRAP_DEEPSEEK:-1}"
export PORT="${PORT:-8765}"

cd /app

echo "[init] configuring OpenClaw model defaults..."
openclaw config set "models.mode" "merge" >/dev/null 2>&1 || true
if [[ -n "${OPENCLAW_PRIMARY_MODEL:-}" ]]; then
  openclaw config set "agents.defaults.model.primary" "${OPENCLAW_PRIMARY_MODEL}" >/dev/null 2>&1 || true
fi
if [[ "${OPENCLAW_BOOTSTRAP_DEEPSEEK,,}" =~ ^(1|true|yes|on)$ ]]; then
  if [[ -n "${DEEPSEEK_API_KEY:-}" ]]; then
    echo "[init] wiring DeepSeek provider into OpenClaw config..."
    DEEPSEEK_PROVIDER_JSON="$(
      DEEPSEEK_API_KEY="${DEEPSEEK_API_KEY}" node -e "console.log(JSON.stringify({
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: process.env.DEEPSEEK_API_KEY,
        api: 'openai-completions',
        models: [
          { id: 'deepseek-chat', name: 'DeepSeek Chat' },
          { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
        ],
      }))"
    )"
    openclaw config set --json "models.providers.deepseek" \
      "${DEEPSEEK_PROVIDER_JSON}" >/dev/null 2>&1 || true
  else
    echo "[warn] DEEPSEEK_API_KEY is empty; skip DeepSeek provider bootstrap."
  fi
else
  echo "[init] OPENCLAW_BOOTSTRAP_DEEPSEEK=off; skip provider bootstrap."
fi

if [[ "${REFRESH_REPORT_DATA:-0}" == "1" ]]; then
  echo "[init] refreshing report data..."
  node scripts/perp-report-data.js "${REPORT_MAX_DECISIONS:-400}" || true
fi

echo "[init] generating report viewer..."
node scripts/perp-report-viewer.js

echo "[start] report server on :${PORT}"
exec node scripts/serve-report.js "${PORT}"
