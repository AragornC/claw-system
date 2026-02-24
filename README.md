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

默认首页已恢复为 ThunderClaw 原功能页（虾脑 / 虾线 / 虾海 / 虾策）。  
虾脑现已拆分为 3 个 Tab：

1. 模型与沟通渠道（OpenClaw 登录、模型、channel）
2. ThunderClaw 配置（交易所 API、运行策略）
3. OpenClaw 配置台（cron 管理 + config 路径读写）

如需快速配置 OpenClaw，直接进入「虾脑」第 1 个 Tab 的模型注册中心：

1. 从 OpenClaw 全模型目录中选择模型（DeepSeek / ChatGPT / Anthropic / 其他 provider）  
2. 按 provider 类型执行“连接并注册”或“仅注册”  
3. 注册成功后即可在 ThunderClaw 顶部模型切换器中切换

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

后端（已按功能域拆分）：

- `scripts/thunderclaw-server.js`（主入口：状态编排 + 依赖注入 + 启动）
- `scripts/server/http/router.js`（统一路由分发器）
- `scripts/server/http/route-table.js`（API 路由表）
- `scripts/server/domain/model-provider.js`（模型/provider 领域能力）
- `scripts/server/domain/chat-intent.js`（显式命令与模型引用解析）
- `scripts/server/core/openclaw-xbrain-runtime.js`（OpenClaw/Xbrain 运行时核心）
- `scripts/server/handlers/chat-config.js`（聊天与配置域 handlers）
- `scripts/server/handlers/xbrain-core.js`（虾脑主 handlers）
- `scripts/server/handlers/openclaw-console.js`（OpenClaw 配置台 handlers）
- `scripts/server/handlers/telegram.js`（Telegram handlers）

前端：

- `memory/report/index.html`（主页面入口）
- `memory/report/js/modules/xsea-runtime.js`（虾海辅助运行时）
- `memory/report/js/modules/xbrain-runtime.js`（虾脑辅助运行时）
- `memory/report/js/modules/chat-runtime.js`（聊天运行时辅助模块）

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
- `GET /api/xbrain/models/catalog`：获取 OpenClaw 全模型目录（含 provider 能力）
- `POST /api/xbrain/models/connect`：连接并注册模型（支持 API Key / OAuth / 仅注册）
- `POST /api/xbrain/models/disconnect`：从虾脑模型列表移除已注册模型
- `GET /api/openclaw/status`：OpenClaw 配置台状态摘要
- `GET /api/openclaw/cron/list`：Cron 列表
- `POST /api/openclaw/cron/add|remove|toggle`：Cron 新增/删除/启停
- `POST /api/openclaw/config/get|set|unset`：配置路径读写

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
