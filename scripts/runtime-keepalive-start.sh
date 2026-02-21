#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

LOG_DIR="${ROOT_DIR}/memory/report"
PID_DIR="${ROOT_DIR}/memory/runtime"
mkdir -p "${LOG_DIR}" "${PID_DIR}"

LOOP_PID_FILE="${PID_DIR}/serve-report.loop.pid"
LOOP_LOG_FILE="${LOG_DIR}/serve-report.loop.log"

if [[ -f "${LOOP_PID_FILE}" ]]; then
  OLD_PID="$(cat "${LOOP_PID_FILE}" 2>/dev/null || true)"
  if [[ -n "${OLD_PID}" ]] && kill -0 "${OLD_PID}" >/dev/null 2>&1; then
    echo "[keepalive] already running pid=${OLD_PID}"
    exit 0
  fi
fi

echo "[keepalive] start loop: ${LOOP_LOG_FILE}"
nohup bash -lc "
  cd \"${ROOT_DIR}\"
  while true; do
    echo \"[loop] start at \$(date '+%F %T')\" >> \"${LOOP_LOG_FILE}\"
    bash scripts/report-start-local.sh >> \"${LOOP_LOG_FILE}\" 2>&1 || true
    EXIT_CODE=\$?
    echo \"[loop] exit_code=\${EXIT_CODE} at \$(date '+%F %T')\" >> \"${LOOP_LOG_FILE}\"
    sleep 2
  done
" >/dev/null 2>&1 &

NEW_PID="$!"
echo "${NEW_PID}" > "${LOOP_PID_FILE}"
echo "[keepalive] started pid=${NEW_PID}"
echo "[keepalive] log=${LOOP_LOG_FILE}"
