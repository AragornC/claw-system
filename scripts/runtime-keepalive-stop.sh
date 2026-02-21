#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

PID_FILE="${ROOT_DIR}/memory/runtime/serve-report.loop.pid"

if [[ ! -f "${PID_FILE}" ]]; then
  echo "[keepalive] no pid file"
  exit 0
fi

PID="$(cat "${PID_FILE}" 2>/dev/null || true)"
if [[ -z "${PID}" ]]; then
  echo "[keepalive] invalid pid file"
  rm -f "${PID_FILE}"
  exit 0
fi

if kill -0 "${PID}" >/dev/null 2>&1; then
  kill "${PID}" >/dev/null 2>&1 || true
  sleep 1
  if kill -0 "${PID}" >/dev/null 2>&1; then
    kill -9 "${PID}" >/dev/null 2>&1 || true
  fi
  echo "[keepalive] stopped pid=${PID}"
else
  echo "[keepalive] process not running pid=${PID}"
fi

rm -f "${PID_FILE}"
