# OpenClaw 核心代码理解（ThunderClaw 第一步）

> 目标：先彻底看懂 OpenClaw 的控制面，再把 ThunderClaw 做成可落地的“配置 + 启动 + 对话”最小闭环。

## 1) OpenClaw 的核心架构（我这次实际对照的源码）

### A. 三层主线

1. **CLI 层（`src/cli/**`）**
   - 命令入口：`openclaw <subcommand>`
   - 关键命令：
     - `onboard`（交互/非交互初始化）
     - `configure` / `config get|set|apply|patch`（配置管理）
     - `gateway run`（启动 WS 控制面）
     - `agent`（发起对话/任务）
     - `models ...`（模型、认证、fallback）

2. **Gateway 控制面（`src/gateway/**`）**
   - 核心是 WebSocket + JSON-RPC 风格方法面。
   - methods 列表在 `src/gateway/server-methods-list.ts`，包含：
     - `chat.send` / `chat.history` / `chat.abort`
     - `config.get` / `config.set` / `config.apply` / `config.patch` / `config.schema`
     - `models.list`, `agents.*`, `sessions.*`, `skills.*`, `cron.*` 等
   - 这层是 OpenClaw 的“控制平面内核”。

3. **Agent Runtime 层（`src/commands/agent*.ts`, `src/agents/**`）**
   - `agent` 命令优先走 gateway 调用（`agent-via-gateway.ts`），失败可 fallback。
   - 会话由 `session-id` / `session-key` / `agent` 绑定。
   - 模型选择、auth profile、fallback 在运行时统一处理。

### B. 配置系统要点

- 配置快照/写回核心：`src/config/config.ts`
- 类型定义：`src/config/types.openclaw.ts`
- 配置 RPC：`src/gateway/server-methods/config.ts`
- 配置 schema + uiHints：`config.schema`（供 UI 生成表单）

这解释了为什么 OpenClaw 的 UI 可以在页面里改大量配置，而不是只靠命令行。

### C. 认证与 onboarding 要点

- 非交互 onboarding 命令路径：
  - `src/commands/onboard.ts`
  - `src/commands/onboard-non-interactive.ts`
  - `src/commands/onboard-non-interactive/local.ts`
- provider API Key flags 统一定义在：
  - `src/commands/onboard-provider-auth-flags.ts`
- 例如：
  - `--openai-api-key` -> `--auth-choice openai-api-key`
  - `--anthropic-api-key` -> `--auth-choice apiKey`
- 这套机制非常适合“虾脑表单 -> 后端拼装 onboard 参数”的模式。

### D. Web 控制台交互模型

- OpenClaw UI 的浏览器网关客户端在 `ui/src/ui/gateway.ts`
- 对话控制器在 `ui/src/ui/controllers/chat.ts`
- 配置控制器在 `ui/src/ui/controllers/config.ts`

关键思想是：**UI 不直接做业务，UI 只调用 Gateway methods**。

---

## 2) 本次 ThunderClaw 对齐策略（第一步）

为了快速落地“打开 ThunderClaw 后就能配 OpenClaw 并对话”：

1. 新增 `scripts/thunderclaw-server.js`
   - 作为 ThunderClaw 与 OpenClaw CLI 的桥接层。
   - 暴露 API：
     - `GET /api/status`：检查 openclaw 可用性、配置状态、gateway 健康
     - `POST /api/setup`：一键执行 non-interactive onboarding
     - `POST /api/models/set`：设置默认模型
     - `POST /api/gateway/start|stop`：控制 gateway 进程
     - `POST /api/chat`：发送对话到 `openclaw agent --json`

2. 新增 `web/index.html`
   - 虾脑最小原型：
     - provider + api key + gateway 参数表单
     - 一键初始化按钮
     - gateway 启停和日志
     - 直接对话窗口（session-id 可控）

3. 更新 `scripts/thunderclaw-cli.js`
   - 新命令：
     - `thunderclaw start`
     - `thunderclaw status`

---

## 3) 为什么这是“正确第一步”

- 用户不再被迫先手写复杂 CLI 配置。
- ThunderClaw 已经开始扮演“OpenClaw 配置管理壳子（虾脑）”角色。
- 对话能力最短路径可验证（初始化 -> 启动 -> 发消息）。
- 为下一步“把更多 openclaw 配置项完整映射到页面”打通了后端和交互骨架。

---

## 4) 下一轮建议（第二步）

1. 把 `config.get + config.schema + config.apply` 接到页面，做“完整配置表单化”。
2. 增加 `models.list / fallbacks / auth order` 可视化配置。
3. 把 gateway WS 事件流（`chat delta/final`）接入前端，实现真流式对话。
4. 把 ThunderClaw 的“虾线/虾策/虾海/虾脑”作为 OpenClaw skill/tool 插件域接入。

