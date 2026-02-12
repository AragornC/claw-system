#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

prompt_default() {
  local label="$1"
  local default="$2"
  local value=""
  read -r -p "${label} [${default}]: " value
  if [[ -z "${value}" ]]; then
    echo "${default}"
  else
    echo "${value}"
  fi
}

OPENCLAW_BIN="${OPENCLAW_CLI_BIN:-openclaw}"
if ! command -v "${OPENCLAW_BIN}" >/dev/null 2>&1; then
  echo "[init] openclaw 未安装，正在安装最新版本..."
  npm install -g openclaw@latest
fi

echo "[init] OpenClaw version:"
"${OPENCLAW_BIN}" --version || true

DEEPSEEK_API_KEY="${DEEPSEEK_API_KEY:-}"
if [[ -z "${DEEPSEEK_API_KEY}" ]]; then
  read -r -s -p "请输入 DEEPSEEK_API_KEY (sk-...): " DEEPSEEK_API_KEY
  echo
fi
if [[ -z "${DEEPSEEK_API_KEY}" ]]; then
  echo "[fatal] DEEPSEEK_API_KEY 不能为空"
  exit 1
fi

PRIMARY_MODEL="$(prompt_default "主模型" "deepseek/deepseek-chat")"
AGENT_ID="$(prompt_default "OpenClaw agent id" "main")"
THINKING="$(prompt_default "thinking 等级(off|minimal|low|medium|high)" "medium")"
VERBOSE="$(prompt_default "verbose(on|off)" "off")"

echo "[init] 写入 OpenClaw 模型配置..."
"${OPENCLAW_BIN}" config set "models.mode" "merge" >/dev/null 2>&1 || true
"${OPENCLAW_BIN}" config set "agents.defaults.model.primary" "${PRIMARY_MODEL}" >/dev/null 2>&1 || true
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
"${OPENCLAW_BIN}" config set --json "models.providers.deepseek" "${DEEPSEEK_PROVIDER_JSON}" >/dev/null 2>&1 || true

OPENCLAW_CHANNEL=""
OPENCLAW_TO=""
OPENCLAW_DELIVER="0"
OPENCLAW_REPLY_CHANNEL=""
OPENCLAW_REPLY_TO=""
OPENCLAW_REPLY_ACCOUNT=""

SETUP_TELEGRAM="$(prompt_default "是否现在配置 Telegram channel? (y/n)" "n")"
if [[ "${SETUP_TELEGRAM,,}" =~ ^(y|yes)$ ]]; then
  TELEGRAM_ACCOUNT="$(prompt_default "Telegram account id" "telegram-main")"
  TELEGRAM_TOKEN=""
  read -r -s -p "Telegram Bot Token: " TELEGRAM_TOKEN
  echo
  if [[ -z "${TELEGRAM_TOKEN}" ]]; then
    echo "[warn] Telegram token 为空，跳过 channel 配置"
  else
    echo "[init] 配置 Telegram channel..."
    "${OPENCLAW_BIN}" channels add \
      --channel telegram \
      --account "${TELEGRAM_ACCOUNT}" \
      --token "${TELEGRAM_TOKEN}" >/dev/null
    OPENCLAW_CHANNEL="telegram"
    read -r -p "默认 Telegram 目标(@username 或 chat_id，可留空): " OPENCLAW_TO
    DELIVER_DEFAULT="$(prompt_default "AI 回复是否默认投递回 Telegram? (y/n)" "n")"
    if [[ "${DELIVER_DEFAULT,,}" =~ ^(y|yes)$ ]]; then
      OPENCLAW_DELIVER="1"
      OPENCLAW_REPLY_CHANNEL="telegram"
      OPENCLAW_REPLY_TO="${OPENCLAW_TO}"
    fi
  fi
fi

cat > "${ROOT_DIR}/.env.local" <<EOF
OPENCLAW_AGENT_LOCAL=1
OPENCLAW_AGENT_ID=${AGENT_ID}
OPENCLAW_CHANNEL=${OPENCLAW_CHANNEL}
OPENCLAW_TO=${OPENCLAW_TO}
OPENCLAW_SESSION_ID=
OPENCLAW_DELIVER=${OPENCLAW_DELIVER}
OPENCLAW_REPLY_CHANNEL=${OPENCLAW_REPLY_CHANNEL}
OPENCLAW_REPLY_TO=${OPENCLAW_REPLY_TO}
OPENCLAW_REPLY_ACCOUNT=${OPENCLAW_REPLY_ACCOUNT}
OPENCLAW_THINKING=${THINKING}
OPENCLAW_VERBOSE=${VERBOSE}
OPENCLAW_TIMEOUT_SEC=90
OPENCLAW_CHAT_TIMEOUT_MS=95000
PORT=8765
EOF

chmod 600 "${ROOT_DIR}/.env.local" || true

echo "[ok] 本地配置完成：${ROOT_DIR}/.env.local"
echo "[next] 启动看板：npm run report:start:local"
echo "[tip] 若你想走 OpenClaw 官方交互引导，也可以执行：openclaw configure"
