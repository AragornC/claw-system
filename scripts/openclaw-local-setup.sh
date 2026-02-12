#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

prompt_default() {
  local label="$1"
  local default="$2"
  local value=""
  local prompt=""
  if [[ -n "${default}" ]]; then
    prompt="${label} [${default}]: "
  else
    prompt="${label}: "
  fi
  read -r -p "${prompt}" value
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

RUN_OPENCLAW_CONFIGURE="$(prompt_default "是否先运行 OpenClaw 官方引导(openclaw configure)? (y/n)" "y")"
if [[ "${RUN_OPENCLAW_CONFIGURE,,}" =~ ^(y|yes)$ ]]; then
  echo "[init] 启动 openclaw configure..."
  "${OPENCLAW_BIN}" configure || echo "[warn] openclaw configure 未完成，可稍后手动执行。"
fi

AGENT_ID="$(prompt_default "OpenClaw agent id" "main")"
THINKING="$(prompt_default "thinking 等级(off|minimal|low|medium|high)" "medium")"
VERBOSE="$(prompt_default "verbose(on|off)" "off")"

BOOTSTRAP_DEEPSEEK="$(prompt_default "是否快速写入 DeepSeek provider? (y/n)" "n")"
if [[ "${BOOTSTRAP_DEEPSEEK,,}" =~ ^(y|yes)$ ]]; then
  DEEPSEEK_API_KEY="${DEEPSEEK_API_KEY:-}"
  if [[ -z "${DEEPSEEK_API_KEY}" ]]; then
    read -r -s -p "请输入 DEEPSEEK_API_KEY (sk-...): " DEEPSEEK_API_KEY
    echo
  fi
  if [[ -n "${DEEPSEEK_API_KEY}" ]]; then
    echo "[init] 写入 DeepSeek provider..."
    "${OPENCLAW_BIN}" config set "models.mode" "merge" >/dev/null 2>&1 || true
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
  else
    echo "[warn] 未提供 DEEPSEEK_API_KEY，跳过 DeepSeek provider 写入。"
  fi
fi

PRIMARY_MODEL="$(prompt_default "默认主模型ID（留空保持 OpenClaw 现有配置）" "")"
if [[ -n "${PRIMARY_MODEL}" ]]; then
  echo "[init] 设置默认主模型: ${PRIMARY_MODEL}"
  "${OPENCLAW_BIN}" config set "agents.defaults.model.primary" "${PRIMARY_MODEL}" >/dev/null 2>&1 || true
fi

echo "[info] 当前 OpenClaw 模型状态："
"${OPENCLAW_BIN}" models status || true

OPENCLAW_CHANNEL=""
OPENCLAW_TO=""
OPENCLAW_SESSION_ID=""
OPENCLAW_DELIVER="0"
OPENCLAW_REPLY_CHANNEL=""
OPENCLAW_REPLY_TO=""
OPENCLAW_REPLY_ACCOUNT=""

echo "[info] 当前 OpenClaw channels："
"${OPENCLAW_BIN}" channels list || true

CONFIGURE_CHANNELS="$(prompt_default "是否现在通过 OpenClaw 配置 channel(openclaw channels ...)? (y/n)" "n")"
if [[ "${CONFIGURE_CHANNELS,,}" =~ ^(y|yes)$ ]]; then
  echo "[tip] 你可以在此终端执行："
  echo "      openclaw channels add --channel telegram --account telegram-main --token <bot_token>"
  echo "      openclaw channels login --channel whatsapp"
  echo "      openclaw channels list"
  read -r -p "完成后按回车继续..." _
fi

OPENCLAW_CHANNEL="$(prompt_default "看板默认路由 channel（留空=不固定）" "")"
OPENCLAW_TO="$(prompt_default "看板默认路由目标 to（留空=由 OpenClaw 自行路由）" "")"
OPENCLAW_SESSION_ID="$(prompt_default "固定 session id（留空=按 to/channel 生成）" "")"
DELIVER_DEFAULT="$(prompt_default "AI 回复是否默认投递到频道? (y/n)" "n")"
if [[ "${DELIVER_DEFAULT,,}" =~ ^(y|yes)$ ]]; then
  OPENCLAW_DELIVER="1"
  OPENCLAW_REPLY_CHANNEL="$(prompt_default "reply-channel（留空=沿用 channel）" "${OPENCLAW_CHANNEL}")"
  OPENCLAW_REPLY_TO="$(prompt_default "reply-to（留空=沿用 to）" "${OPENCLAW_TO}")"
  OPENCLAW_REPLY_ACCOUNT="$(prompt_default "reply-account（可留空）" "")"
fi

cat > "${ROOT_DIR}/.env.local" <<EOF
OPENCLAW_AGENT_LOCAL=1
OPENCLAW_AGENT_ID=${AGENT_ID}
OPENCLAW_CHANNEL=${OPENCLAW_CHANNEL}
OPENCLAW_TO=${OPENCLAW_TO}
OPENCLAW_SESSION_ID=${OPENCLAW_SESSION_ID}
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
