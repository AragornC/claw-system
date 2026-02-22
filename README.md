# ThunderClaw（OpenClaw 启动版）

本仓库现在进入“从零重建”第一步：

- 深度对照 OpenClaw 控制面架构（Gateway + config/chat/models methods）
- 在 ThunderClaw 内提供最小可用“虾脑”：
  - 页面内完成 OpenClaw 基础登录配置
  - 页面内启动/停止 Gateway
  - 页面内直接发起对话

---

## 1. 快速启动

```bash
npm install
npm run thunderclaw:start
```

默认访问：

- `http://127.0.0.1:3456`
- `http://127.0.0.1:3456/onboarding.html`（简化 OpenClaw 配置向导）

默认首页已恢复为 ThunderClaw 原功能页（虾脑 / 虾线 / 虾海 / 虾策）。  
如需快速配置 OpenClaw，再打开向导页：

1. 粘贴 DeepSeek API Key  
2. 点击“一键完成基础配置”  
3. 回到主页面直接聊天

---

## 2. CLI 命令

```bash
npm run thunderclaw:help
npm run thunderclaw:status
npm run thunderclaw:start
```

等价地，也可以直接：

```bash
node scripts/thunderclaw-cli.js start --port 3456
```

---

## 3. 当前功能（第一步）

后端：`scripts/thunderclaw-server.js`  
前端：

- `memory/report/index.html`（主页面）
- `web/index.html`（配置向导）

提供 API：

- `GET /api/status`：OpenClaw 可用性、配置存在性、Gateway 健康状态
- `POST /api/setup`：non-interactive onboarding（provider + apiKey）
- `POST /api/setup/quick`：简化向导的一键基础配置（默认 DeepSeek）
- `POST /api/models/set`：设置默认模型
- `POST /api/oauth/start`：触发 OpenAI OAuth 登录（interactive）
- `POST /api/gateway/start`：启动 Gateway
- `POST /api/gateway/stop`：停止 Gateway
- `POST /api/chat`：通过 `openclaw agent --json` 发起对话
- `POST /api/ai/chat`：旧主页面聊天入口兼容
- `GET /api/chat/history`：旧主页面聊天历史轮询
- `GET /api/ai/health`：旧主页面 AI 链路健康检查
- `GET/POST /api/xbrain/*`：旧主页面虾脑配置接口兼容

已支持认证路径：

- OpenAI / Anthropic / OpenRouter / Gemini / ZAI / **DeepSeek**（API Key）
- OpenAI Codex（OAuth 跳转登录，需在启动 thunderclaw 的终端内完成交互）

---

## 4. OpenClaw 源码理解文档

见：

- `OPENCLAW_CORE_UNDERSTANDING.md`

该文档记录了本次对 OpenClaw 核心代码（CLI、Gateway methods、config/onboard、UI 控制器）的结构化理解和 ThunderClaw 对齐策略。

---

## 5. 保留资产

- `THUNDERCLAW_PRODUCT_IDEA.md`
- `memory/report/*`（原产品页与图片/数据资产）
- `scripts/thunderclaw-cli.js`
