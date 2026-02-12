#!/usr/bin/env bash
# 腾讯云 CVM 一键部署脚本
# 在项目根目录或 deploy/tencent-cvm 目录下执行

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# 检查 Docker
if ! command -v docker &>/dev/null; then
  echo "[错误] 未检测到 Docker，请先安装 Docker 和 Docker Compose"
  echo "参考: https://docs.docker.com/engine/install/ubuntu/"
  exit 1
fi

# 检查 .env
if [[ ! -f .env ]]; then
  echo "[提示] 未找到 .env，从 .env.example 创建..."
  cp .env.example .env
  echo "[重要] 请编辑 .env 填入 DEEPSEEK_API_KEY，然后重新运行此脚本"
  exit 1
fi

# 检查必填项
if ! grep -q 'DEEPSEEK_API_KEY=sk-' .env 2>/dev/null; then
  echo "[错误] .env 中必须填写有效的 DEEPSEEK_API_KEY"
  echo "请编辑 .env 后重试"
  exit 1
fi

echo "[部署] 构建并启动服务..."
docker compose up -d --build

echo ""
echo "[完成] 服务已启动"
echo "  - 本机访问: http://127.0.0.1:8765"
echo "  - 公网访问: http://<你的CVM公网IP>:8765"
echo ""
echo "查看日志: docker compose logs -f --tail=100"
echo "健康检查: curl -s http://127.0.0.1:8765/api/ai/health"
