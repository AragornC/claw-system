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
export OPENCLAW_THINKING="${OPENCLAW_THINKING:-medium}"
export OPENCLAW_VERBOSE="${OPENCLAW_VERBOSE:-off}"
export OPENCLAW_SESSION_LOCK_RETRY="${OPENCLAW_SESSION_LOCK_RETRY:-4}"
export OPENCLAW_SESSION_LOCK_BACKOFF_MS="${OPENCLAW_SESSION_LOCK_BACKOFF_MS:-650}"
export THUNDERCLAW_CHAT_RUNTIME_MODE="${THUNDERCLAW_CHAT_RUNTIME_MODE:-openclaw-native}"
export THUNDERCLAW_TOOL_ADAPTER="${THUNDERCLAW_TOOL_ADAPTER:-mcp}"
export THUNDERCLAW_MCP_BRIDGE_ENABLED="${THUNDERCLAW_MCP_BRIDGE_ENABLED:-1}"
export THUNDERCLAW_MCP_BRIDGE_AUTOSTART="${THUNDERCLAW_MCP_BRIDGE_AUTOSTART:-1}"
export THUNDERCLAW_MCP_BRIDGE_PORT="${THUNDERCLAW_MCP_BRIDGE_PORT:-9001}"
export THUNDERCLAW_MCP_BRIDGE_URL="${THUNDERCLAW_MCP_BRIDGE_URL:-http://127.0.0.1:${THUNDERCLAW_MCP_BRIDGE_PORT}/tool/invoke}"
export THUNDERCLAW_MCP_BRIDGE_TIMEOUT_MS="${THUNDERCLAW_MCP_BRIDGE_TIMEOUT_MS:-6500}"
export THUNDERCLAW_MCP_BRIDGE_RETRY="${THUNDERCLAW_MCP_BRIDGE_RETRY:-1}"
export THUNDERCLAW_MCP_BRIDGE_FALLBACK="${THUNDERCLAW_MCP_BRIDGE_FALLBACK:-internal}"

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

if [[ "${THUNDERCLAW_MCP_BRIDGE_AUTOSTART}" == "1" ]]; then
  if command -v pgrep >/dev/null 2>&1; then
    _bridge_pids="$(pgrep -f "node .*scripts/mcp-bridge-local.js" 2>/dev/null || true)"
    if [[ -n "${_bridge_pids}" ]]; then
      echo "[init] stopping old mcp-bridge-local processes: ${_bridge_pids}"
      while IFS= read -r _pid; do
        [[ -n "${_pid}" ]] || continue
        kill "${_pid}" >/dev/null 2>&1 || true
      done <<< "${_bridge_pids}"
      sleep 1
    fi
  fi
  mkdir -p "${ROOT_DIR}/memory/report"
  echo "[init] starting mcp-bridge-local on :${THUNDERCLAW_MCP_BRIDGE_PORT}"
  node scripts/mcp-bridge-local.js "${THUNDERCLAW_MCP_BRIDGE_PORT}" \
    > "${ROOT_DIR}/memory/report/mcp-bridge.log" 2>&1 &
  echo "[init] mcp-bridge-local pid=$!"
fi

echo "[init] generating report data..."
node scripts/perp-report-data.js 400

echo "[init] generating report viewer..."
node scripts/perp-report-viewer.js

echo "[start] report server on :${PORT:-8765}"
exec node scripts/serve-report.js "${PORT:-8765}"
