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

echo "[init] generating report data..."
node scripts/perp-report-data.js 400

echo "[init] generating report viewer..."
node scripts/perp-report-viewer.js

echo "[start] report server on :${PORT:-8765}"
exec node scripts/serve-report.js "${PORT:-8765}"
