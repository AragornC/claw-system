#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

PID_FILE="${ROOT_DIR}/memory/runtime/serve-report.loop.pid"
LOG_FILE="${ROOT_DIR}/memory/report/serve-report.loop.log"

if [[ ! -f "${PID_FILE}" ]]; then
  echo "[keepalive] status=stopped"
  exit 0
fi

PID="$(cat "${PID_FILE}" 2>/dev/null || true)"
if [[ -z "${PID}" ]]; then
  echo "[keepalive] status=invalid_pid_file"
  exit 0
fi

if kill -0 "${PID}" >/dev/null 2>&1; then
  echo "[keepalive] status=running pid=${PID}"
else
  echo "[keepalive] status=dead pid=${PID}"
fi

if [[ -f "${LOG_FILE}" ]]; then
  echo "[keepalive] log=${LOG_FILE}"
  echo "[keepalive] last_lines:"
  rg -n "^" "${LOG_FILE}" | tail -n 20
else
  echo "[keepalive] log file not found"
fi
