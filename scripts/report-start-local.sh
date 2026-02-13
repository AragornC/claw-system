#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

if [[ -f "${ROOT_DIR}/.env.local" ]]; then
  echo "[init] loading .env.local"
  set -a
  # shellcheck disable=SC1091
  source "${ROOT_DIR}/.env.local"
  set +a
fi

export OPENCLAW_AGENT_LOCAL="${OPENCLAW_AGENT_LOCAL:-1}"
export OPENCLAW_AGENT_ID="${OPENCLAW_AGENT_ID:-main}"
export OPENCLAW_TIMEOUT_SEC="${OPENCLAW_TIMEOUT_SEC:-90}"
export OPENCLAW_CHAT_TIMEOUT_MS="${OPENCLAW_CHAT_TIMEOUT_MS:-95000}"

if command -v pgrep >/dev/null 2>&1; then
  _tc_pids="$(pgrep -f "node .*scripts/serve-report.js" 2>/dev/null || true)"
  if [[ -n "${_tc_pids}" ]]; then
    echo "[init] stopping old serve-report processes: ${_tc_pids}"
    while IFS= read -r _pid; do
      [[ -n "${_pid}" ]] || continue
      kill "${_pid}" >/dev/null 2>&1 || true
    done <<< "${_tc_pids}"
    sleep 1
  fi
fi

echo "[init] generating report data..."
node scripts/perp-report-data.js 400

echo "[init] generating report viewer..."
node scripts/perp-report-viewer.js

echo "[start] report server on :${PORT:-8765}"
exec node scripts/serve-report.js "${PORT:-8765}"
