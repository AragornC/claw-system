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

is_yes() {
  local v
  v="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  case "${v}" in
    y|yes) return 0 ;;
    *) return 1 ;;
  esac
}

OPENCLAW_BIN="${OPENCLAW_CLI_BIN:-openclaw}"
if ! command -v "${OPENCLAW_BIN}" >/dev/null 2>&1; then
  echo "[init] openclaw 未安装，正在安装最新版本..."
  npm install -g openclaw@latest
fi

echo "[init] OpenClaw version:"
"${OPENCLAW_BIN}" --version || true

echo
echo "====== ThunderClaw 极速初始化 ======"
echo "仅做两件事：1) 连接模型 2) 连接 Telegram Bot"
echo

MODEL_SETUP_MODE="$(prompt_default "模型连接方式：1) DeepSeek(API Key) 2) ChatGPT/Codex(登录链接) 3) 跳过" "1")"
case "${MODEL_SETUP_MODE}" in
  1)
    DEEPSEEK_API_KEY="${DEEPSEEK_API_KEY:-}"
    if [[ -z "${DEEPSEEK_API_KEY}" ]]; then
      read -r -s -p "请输入 DeepSeek API Key (sk-...): " DEEPSEEK_API_KEY
      echo
    fi
    if [[ -n "${DEEPSEEK_API_KEY}" ]]; then
      DEEPSEEK_MODEL_ID="$(prompt_default "DeepSeek 主模型ID" "deepseek-chat")"
    if [[ "${DEEPSEEK_MODEL_ID}" != */* ]]; then
      DEEPSEEK_MODEL_ID="deepseek/${DEEPSEEK_MODEL_ID}"
    fi
      echo "[init] 写入 DeepSeek 模型配置..."
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
      "${OPENCLAW_BIN}" config set "agents.defaults.model.primary" "${DEEPSEEK_MODEL_ID}" >/dev/null 2>&1 || true
    echo "[ok] DeepSeek 默认模型已设置为: ${DEEPSEEK_MODEL_ID}"
    else
      echo "[warn] 未提供 DeepSeek key，跳过模型写入。"
    fi
    ;;
  2)
    echo "[init] 启动 ChatGPT/Codex 登录流程（会出现登录/授权链接）..."
    "${OPENCLAW_BIN}" models auth login --set-default || {
      echo "[warn] 自动登录流程失败，可稍后手动执行："
      echo "       ${OPENCLAW_BIN} models auth login --set-default"
    }
    ;;
  *)
    echo "[info] 跳过模型连接，后续可随时执行：${OPENCLAW_BIN} models auth login"
    ;;
esac

echo "[info] 当前模型状态："
"${OPENCLAW_BIN}" models status || true

THUNDERCLAW_TELEGRAM_BOT_TOKEN=""
read -r -p "Telegram Bot Token（留空=暂不连接）: " THUNDERCLAW_TELEGRAM_BOT_TOKEN

cat > "${ROOT_DIR}/.env.local" <<EOF
OPENCLAW_AGENT_LOCAL=1
OPENCLAW_AGENT_ID=main
OPENCLAW_THINKING=medium
OPENCLAW_VERBOSE=off
OPENCLAW_TIMEOUT_SEC=90
OPENCLAW_CHAT_TIMEOUT_MS=95000
THUNDERCLAW_TELEGRAM_BOT_TOKEN=${THUNDERCLAW_TELEGRAM_BOT_TOKEN}
THUNDERCLAW_TELEGRAM_AUTO_REPLY=1
THUNDERCLAW_TELEGRAM_PUSH_TRADES=1
THUNDERCLAW_TELEGRAM_PUSH_EVENTS=open,close,risk
THUNDERCLAW_TELEGRAM_PUSH_INTERVAL_MS=4000
PORT=8765
EOF

chmod 600 "${ROOT_DIR}/.env.local" || true

echo
echo "[ok] 配置完成：${ROOT_DIR}/.env.local"
echo "[next] 启动看板：npm run report:start:local"
echo "[tip] 需要高级配置时再用：openclaw configure 或 openclaw models auth login"
