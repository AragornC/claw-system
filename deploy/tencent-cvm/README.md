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
  - `8765`（看板服务）

> 如果你后面要挂 HTTPS 域名，可再放行 `80/443`。

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

方式 A：从 Git 仓库拉取（替换为你的仓库地址）

```bash
git clone <你的仓库URL> .
cd deploy/tencent-cvm
cp .env.example .env
```

方式 B：已有本地项目，直接进入部署目录

```bash
cd /path/to/your/project/deploy/tencent-cvm
cp .env.example .env
```

编辑 `.env`，至少填入：

```dotenv
DEEPSEEK_API_KEY=sk-你的真实key
PUBLIC_PORT=8765
```

## 4) 启动服务

方式 A：使用一键部署脚本（推荐）

```bash
chmod +x deploy.sh
./deploy.sh
```

方式 B：手动启动

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

## 5) 手机访问

用手机浏览器打开：

```text
http://<你的CVM公网IP>:8765
```

---

## 常用运维命令

重启：

```bash
docker compose restart
```

更新代码后重建：

```bash
git pull
docker compose up -d --build
```

停止：

```bash
docker compose down
```

## 安全建议

- 不要把 `.env` 提交到 git。
- API key 若曾在聊天中暴露，务必立即轮换。
- 生产建议加 Nginx/Caddy + HTTPS + 基础认证（至少限制 `/api/ai/*`）。
