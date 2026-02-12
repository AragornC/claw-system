# 腾讯云 CVM 部署（OpenClaw + 交易看板）

这个目录用于把当前项目部署到腾讯云 CVM，并支持：

- 手机公网访问看板 UI
- 看板 AI 聊天通过 OpenClaw 打通
- OpenClaw 走 DeepSeek API（`OPENCLAW_AGENT_LOCAL=1`）

## 1) 准备一台腾讯云 CVM

推荐：

- Ubuntu 22.04+
- 2C4G 或更高
- 安全组放行：
  - `22`（SSH）
  - HTTP 方案：`8765`
  - HTTPS 方案：`80`、`443`

> 推荐直接用 HTTPS 方案（域名 + `80/443`）。

## 2) 安装 Docker + Compose

在 CVM 执行：

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo \"$VERSION_CODENAME\") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin git
sudo usermod -aG docker $USER
newgrp docker
```

## 3) 拉代码并配置环境变量

```bash
git clone https://github.com/AragornC/claw-system.git
cd claw-system/deploy/tencent-cvm
cp .env.example .env
```

编辑 `.env`，最低可用配置：

```dotenv
DEEPSEEK_API_KEY=sk-你的真实key
PUBLIC_PORT=8765
```

常用增强配置（按需）：

```dotenv
# OpenClaw 基础
OPENCLAW_AGENT_LOCAL=1
OPENCLAW_AGENT_ID=main
OPENCLAW_PRIMARY_MODEL=deepseek/deepseek-chat
OPENCLAW_BOOTSTRAP_DEEPSEEK=1

# 会话/路由（可留空）
OPENCLAW_CHANNEL=
OPENCLAW_TO=
OPENCLAW_SESSION_ID=
OPENCLAW_DELIVER=0
OPENCLAW_REPLY_CHANNEL=
OPENCLAW_REPLY_TO=
OPENCLAW_REPLY_ACCOUNT=
```

## 4A) 启动 HTTP 版本（快速验证）

```bash
docker compose up -d --build
```

查看状态：

```bash
docker compose ps
docker compose logs -f --tail=100
```

健康检查：

```bash
curl -s http://127.0.0.1:8765/api/ai/health
```

## 5A) 手机访问（HTTP）

用手机浏览器打开：

```text
http://<你的CVM公网IP>:8765
```

---

## 4B) 启动 HTTPS 版本（推荐生产）

### 前置：域名解析

在 DNS 控制台新增：

- 记录类型：`A`
- 主机记录：例如 `trade`
- 记录值：`<你的CVM公网IP>`

等待解析生效后继续。

### 配置 HTTPS 环境变量

```bash
cp .env.https.example .env.https
```

编辑 `.env.https`：

```dotenv
DOMAIN=trade.yourdomain.com
ACME_EMAIL=you@yourdomain.com
```

### 启动 HTTPS 栈（OpenClaw + Caddy）

```bash
docker compose -f docker-compose.https.yml up -d --build
```

### 访问

```text
https://trade.yourdomain.com
```

### HTTPS 诊断

```bash
docker compose -f docker-compose.https.yml ps
docker compose -f docker-compose.https.yml logs -f --tail=120 caddy
curl -I https://trade.yourdomain.com
```

---

## OpenClaw 深度联通（模型 + Telegram）

### 1) 检查容器内 OpenClaw 状态

```bash
docker exec -it claw-report openclaw status
docker exec -it claw-report openclaw models status
docker exec -it claw-report openclaw channels list
```

> `claw-report` 容器挂载了 `claw_openclaw_state`，模型与 channel 配置会持久化。

### 2) 模型配置（可切换，不绑死 DeepSeek）

改 `.env` 后重启容器即可：

```dotenv
OPENCLAW_PRIMARY_MODEL=deepseek/deepseek-reasoner
OPENCLAW_BOOTSTRAP_DEEPSEEK=1
```

也可以进入容器临时切换：

```bash
docker exec -it claw-report openclaw models set deepseek/deepseek-chat
```

若你要改用非 DeepSeek provider，可设：

```dotenv
OPENCLAW_BOOTSTRAP_DEEPSEEK=0
```

然后在容器内用 `openclaw models auth ...` / `openclaw config set ...` 完成 provider 鉴权与模型绑定。

### 3) Telegram channel 联通（示例）

```bash
docker exec -it claw-report openclaw channels add \
  --channel telegram \
  --account telegram-main \
  --token "<你的TelegramBotToken>"

docker exec -it claw-report openclaw channels list

docker exec -it claw-report openclaw message send \
  --channel telegram \
  --account telegram-main \
  --target @你的用户名或chat_id \
  --message "OpenClaw Telegram通道已联通" \
  --json
```

### 4) 让交易看板桥接使用指定会话/频道（可选）

在 `.env` 里加：

```dotenv
OPENCLAW_CHANNEL=telegram
OPENCLAW_TO=@你的用户名或chat_id
OPENCLAW_SESSION_ID=
OPENCLAW_DELIVER=0
```

说明：

- `OPENCLAW_DELIVER=0`：只把 OpenClaw 回复返回给看板前端（推荐）。
- `OPENCLAW_DELIVER=1`：同时把回复投递回频道（可配 `OPENCLAW_REPLY_CHANNEL/OPENCLAW_REPLY_TO`）。

## 常用运维命令

重启（HTTP）：

```bash
docker compose restart
```

重启（HTTPS）：

```bash
docker compose -f docker-compose.https.yml restart
```

更新代码后重建（HTTP）：

```bash
git pull
docker compose up -d --build
```

更新代码后重建（HTTPS）：

```bash
git pull
docker compose -f docker-compose.https.yml up -d --build
```

停止（HTTP）：

```bash
docker compose down
```

停止（HTTPS）：

```bash
docker compose -f docker-compose.https.yml down
```

## 安全建议

- 不要把 `.env` 提交到 git。
- 不要把 `.env.https` 提交到 git。
- API key 若曾在聊天中暴露，务必立即轮换。
- HTTPS 已内置 Caddy 自动签发证书；如需更严格，可在 Caddyfile 增加 `/api/ai/*` 认证或 IP 白名单。
