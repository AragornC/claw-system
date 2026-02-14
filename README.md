# Bitget Perp Trading Core (Architecture Extract)

This repo contains the **core architecture** for a Bitget **USDT-margined perpetual** (currently BTC) auto-trading system:

- **Signal → Cycle → TradePlan v1 → Executor → Guard**
- **Dry-run**, **idempotency**, and **audit logs**
- Strategy logic is swappable (v2/v3/v5), while execution + risk control stays stable.

> Note: this README intentionally avoids OpenClaw-specific setup. You can run this with any local model / scheduler. OpenClaw can still be used as an optional orchestrator.

---

## 0. What is in here?

### Core scripts (architecture)
- `scripts/run-perp-cycle.js`
  - Runs a market signal script + (optional) news gating
  - Outputs a **TradePlan v1** JSON payload

- `scripts/bitget-perp-autotrade.js` (Executor)
  - Reads TradePlan v1 from stdin
  - Applies risk controls + idempotency
  - Places a real Bitget perp order (or dry-run)
  - Writes state + jsonl logs

- `scripts/bitget-perp-position-guard.js` (Guard)
  - Runs periodically
  - If a position exists, manages exits (TP/SL / trailing / timeout) and reconciles if exchange closed it

- `scripts/perp-engine.js`
  - Convenience wrapper: `run-perp-cycle.js` → feed JSON to `bitget-perp-autotrade.js`
  - Appends each run to `memory/bitget-perp-cycle-decisions.jsonl` for decision visualization

### Strategy / signal scripts (swappable)
- `scripts/market-perp-signal-v2.js`
- `scripts/market-perp-signal-v3.js`
- `scripts/market-perp-signal-v5.js`

### Docs
- `memory/PERP-ARCHITECTURE.md` — architecture overview
- `memory/perp-tradeplan.v1.md` — TradePlan v1 spec
- `memory/perp-strategy-v5.json` — current strategy params (non-secret)

---

## 1. Requirements

- Node.js (>= 18 recommended)
- Bitget API credentials (for live trading)
- `ccxt` (already in `package.json`)

Install:

```bash
npm install
```

---

## 2. Environment variables

Create `.env` (or export env vars in your runtime) with:

- `BITGET_API_KEY`
- `BITGET_API_SECRET`
- `BITGET_API_PASSPHRASE`

Optional:
- `OPENCLAW_WORKDIR` (any working directory; defaults to `process.cwd()`)

---

## 3. Config & state files

Executor/Guard use JSON files under `memory/` by default.

- Config (you edit):
  - `memory/bitget-perp-autotrade-config.json`
- State (system writes):
  - `memory/bitget-perp-autotrade-state.json`
- Logs (system appends):
  - `memory/bitget-perp-autotrade-trades.jsonl`
  - `memory/bitget-perp-autotrade-cycles.jsonl`

**Do not commit** state/log files. `.gitignore` is set up accordingly.

---

## 4. TradePlan v1 (interface)

The system standardizes strategy → execution with TradePlan v1:

```json
{
  "tradePlanVersion": 1,
  "cycleId": "<string>",
  "dryRun": false,
  "plan": {
    "symbol": "BTCUSDT",
    "side": "long",
    "level": "strong",
    "reason": "..."
  },
  "decision": {
    "blockedByNews": false,
    "newsReason": []
  }
}
```

Rules:
- Strategy is only allowed to output: `side`, `level`, `reason` (plus optional context).
- Execution config decides: symbol mapping, leverage, notional sizing, risk model, etc.

Details: see `memory/perp-tradeplan.v1.md`.

---

## 5. How to run (manual)

### 5.1 Run one cycle (signal → TradePlan)

```bash
PERP_SIGNAL=v5 node scripts/run-perp-cycle.js
```

### 5.2 Execute the TradePlan (live) via engine wrapper

```bash
PERP_SIGNAL=v5 node scripts/perp-engine.js
```

### 5.3 Dry-run (no order placed)

```bash
PERP_SIGNAL=v5 DRY_RUN=1 node scripts/perp-engine.js
```

### 5.3.1 一键打通引擎 dry-run → 看板数据（真实行情/新闻）

```bash
node scripts/perp-dryrun-live-bridge.js 3 15 400
```

- 参数含义：`cycles=3`（跑 3 轮引擎）`intervalSec=15`（每轮间隔 15 秒）`maxDecisions=400`（刷新报告数据条数）
- 脚本会自动以 `DRY_RUN=1` + `DRY_RUN_FORCE=1` 跑引擎，然后执行 `perp-report.js data/viewer`。
- 完成后可直接：

```bash
node scripts/perp-report.js serve
```

### 5.4 Run position guard (should be scheduled)

```bash
node scripts/bitget-perp-position-guard.js
```

### 5.5 决策可视化（K 线 + 决策点）

每次运行 `perp-engine.js` 会往 `memory/bitget-perp-cycle-decisions.jsonl` 追加一条决策记录。数据与展示分离：数据写入 `memory/report/decisions.json` 与 `memory/report/ohlcv.json`，展示页通过 fetch 加载，需本地服务打开。

```bash
node scripts/perp-report.js                    # 更新数据 + 生成展示页 + 启动服务，浏览器打开 http://localhost:8765
node scripts/perp-report.js data [maxDecisions] # 仅更新数据
node scripts/perp-report.js viewer              # 仅生成 report/index.html
node scripts/perp-report.js serve [port]        # 仅启动服务
```

页面可切换 K 线周期，悬停决策点显示详情，点击放大该段。

### 5.6 OpenClaw 深度绑定（AI 交易助理）

交易看板 UI 保持不变，但 AI 对话改成 **OpenClaw + 交易域上下文**：

- 前端：`/api/ai/chat`
- 报告服务：`scripts/serve-report.js`
- 后端执行：`openclaw agent --agent <id> --json`

本次深度绑定要点：

- 服务端每次请求会实时读取 `decisions.json / orders.json / ohlcv.json` 生成权威上下文（不依赖前端传参）
- OpenClaw 按约定返回结构化动作（`switch_view / focus_trade / run_backtest / run_backtest_compare / run_custom_backtest / run_strategy_dsl`）
- 前端自动执行动作：切页、定位交易开平区间、触发回验；支持自然语言约束执行自定义策略，也支持 **特征驱动 DSL**（AI 给“特征 + 规则表达式”，系统直接运行）
- 提供调试接口：
  - `GET /api/ai/health`
  - `GET /api/ai/context`
  - `GET /api/ai/context?full=1`
  - `GET /api/telegram/health`
  - `GET /api/telegram/events?afterId=<id>`
  - `GET /api/chat/history?afterId=<id>`
  - `GET /api/memory/health?q=<query>`

新增（本地直连 Telegram）：

- 配置 `THUNDERCLAW_TELEGRAM_BOT_TOKEN` 后，服务端会轮询 Telegram Bot API。
- 轮询带本机单实例锁（`memory/.telegram-poll.<tokenHash>.lock`），可避免同机多进程并发 `getUpdates` 触发 `409 Conflict`。
- 若出现外部冲突（例如另一台机器也在轮询同一 bot），系统会自动指数退避重试并在健康接口显示冲突计数。
- 入站消息带去重（`memory/.telegram-inbound-dedupe.<tokenHash>/`），重复 update/message 不会重复触发回复。
- 默认忽略 `from.is_bot=true` 的入站消息，避免机器人互相触发造成回声/重复回复。
- 聊天历史持久化到 `memory/chat-history.jsonl`：页面刷新或服务重启后可继续读取历史对话。
- Telegram 来信会进入 ThunderClaw 聊天面板，并可由本地 AI 自动回复回 Telegram。
- **本地看板里用户输入的消息不会反向同步到 Telegram**（按单向同步设计）。
- 可选开启交易事件主动推送：开仓/平仓/风控拦截会自动发到 Telegram。
- 新增聊天内配置通道：`POST /api/config/chat`
  - 例如在聊天框直接发送：
    - `设置 Telegram token 123456:ABC...`
    - `设置 DeepSeek key sk-...`
    - `连接 ChatGPT/Codex`

新增（长期记忆检索 / RAG-lite）：

- 服务端把对话摘要与交易结果持续写入 `memory/trader-memory.jsonl`（自动脱敏关键 secret）。
- 每次 AI 请求前会执行“相关记忆检索”（token overlap + sparse vector cosine），并注入 `context.longTermMemory`。
- 支持手工记忆：在聊天框发送 `记住: ...`（或 `remember: ...`）。
- 已扩展为分层记忆：
  - `shortTermMemory`：近期会话窗口（短期）
  - `midTermMemory`：交易者画像 + 策略权重（中期）
  - `longTermMemory`：长期检索结果（长期）
- 新增策略反馈学习（自动 + 人工）：
  - 自动：读取真实成交结果（`bitget-perp-autotrade-trades.jsonl`）更新策略权重
  - 人工：聊天发送 `反馈 v5_retest +0.6` / `策略反馈 v5_reentry 太激进`
- 新增策略工件化（artifactization）：
  - 每次回验会自动沉淀策略工件到：
    - `memory/strategy-artifacts.jsonl`（事件流）
    - `memory/strategy-artifacts-state.json`（最新状态）
  - 工件包含：策略配置、特征定义（DSL）、版本号、回验指标、学习权重、来源上下文
  - 可在聊天中查看：`工件状态` / `策略工件`
  - 可在聊天中复用：`使用工件 art-xxxxxx`
- 新增工件闭环学习（closed-loop）：
  - 自动：回验结果会转化为 reward 并更新工件权重（learningWeight）
  - 人工：聊天发送 `反馈工件 art-xxxxxx +0.6` / `工件反馈 art-xxxxxx -0.4`
  - 工件权重会回注到 `midTermMemory.strategyArtifacts`，供 AI 优先复用高质量工件
- 查看记忆状态：聊天发送 `记忆状态` / `查看记忆` / `memory status`

手机/静态部署（无本地后端）可用方案：

- 页面会自动尝试 `OpenClaw` 后端；不可达时可切到 **DeepSeek 直连模式**。
- 在聊天框发送：`/deepseek sk-xxxx`（仅保存到当前浏览器 localStorage，不入库）。
- 之后聊天将直接调用 DeepSeek API（支持动作：切页/定位/回验/多策略对比/自定义策略回验）。
- 现在也支持 `run_strategy_dsl`：例如 AI 可给出 `5日EMA + ADX过滤` 这类新特征组合，ThunderClaw 直接回验并返回结果。

新增 API：

- `GET /api/strategy/artifacts?limit=8&q=...`：查询策略工件列表
- `POST /api/strategy/artifacts/report`：上报回验结果并更新工件学习权重
- 清除本地 key：`/deepseek clear`

#### 5.6.1 最简启动（纯 npm，不用 Docker）

如果你只想快速跑通（包括云服务器），这几步就够了：

```bash
# 1) 拉对分支（默认 main 不包含最新对接改造）
git fetch origin cursor/-bc-f94ec5fe-5b54-4b20-84e9-3f37528f33d0-f9ff
git checkout cursor/-bc-f94ec5fe-5b54-4b20-84e9-3f37528f33d0-f9ff
git pull origin cursor/-bc-f94ec5fe-5b54-4b20-84e9-3f37528f33d0-f9ff

# 2) 安装依赖 + OpenClaw CLI
npm install
npm install -g openclaw@latest

# 3) 配置 OpenClaw 模型（二选一）
# 3A: 走 OpenClaw 官方向导（推荐，支持任意 provider / channel）
openclaw configure
#
# 3B: 仅快速写入 DeepSeek provider（可选）
export DEEPSEEK_API_KEY="sk-xxxx"
npm run openclaw:deepseek:init

# 4) 启动看板（OpenClaw local 模式）
# 若要一键刷新数据 + 生成页面 + 启动服务，直接用：
npm run report:deploy:console
#
# 若只想基于已有数据快速起服务（不刷新 decisions/ohlcv）：
OPENCLAW_AGENT_LOCAL=1 npm run report:start:cloud
```

云服务器公网访问：`http://<服务器IP>:8765`（记得放行安全组端口 8765）。

#### 5.6.2 本地交互引导（terminal wizard，最省事）

如果你在本机部署，想要类似 OpenClaw onboarding 的交互流程，直接用：

```bash
npm install
npm run openclaw:setup:local
npm run report:start:local
```

`report:start:local` 启动前会尝试结束旧的 `serve-report.js` 进程，避免同机多实例导致 Telegram 重复回复。

`openclaw:setup:local` 会引导你填写：

- 模型连接方式（DeepSeek API Key / ChatGPT-Codex 登录链接）
- Telegram Bot Token（其余参数走默认）

补充说明：

- DeepSeek 模型 ID 输入 `deepseek-chat` / `deepseek-reasoner` 即可，脚本会自动规范为 `deepseek/deepseek-chat` 这类 provider 前缀形式，避免 OpenClaw fallback 报错。
- `openclaw models auth login --set-default` 是终端发起的登录授权流程：会给出登录链接，完成授权后自动把该 provider 推荐模型设为默认。

之后你也可以手工编辑 `.env.local`（可参考 `.env.local.example`），再执行：

```bash
npm run report:start:local
```

#### 5.6.3 无需先手工 clone：ThunderClaw 两步启动

如果你希望像 OpenClaw 一样先装 CLI 再引导，可以直接：

```bash
npm i -g github:AragornC/claw-system
thunderclaw onboard
```

说明：

- `thunderclaw onboard` 会自动在 `~/.thunderclaw/workspace` 拉取/更新代码并执行本地配置引导；
- 首次运行会自动执行项目依赖安装（`npm install`）；
- 引导完成后会直接启动看板（若只想配置不启动可用 `thunderclaw onboard --no-start`）；
- 也可以后续手动执行 `thunderclaw start`；
- CLI 里除 `onboard/start/workspace/update` 外的命令，会透传给 OpenClaw（例如 `thunderclaw channels list`）。

### 5.7 腾讯云部署（CVM + Docker）

如果你要在手机公网访问并测试 OpenClaw 打通，直接用：

- `deploy/tencent-cvm/docker-compose.yml`
- `deploy/tencent-cvm/docker-compose.https.yml`
- `deploy/tencent-cvm/.env.example`
- `deploy/tencent-cvm/.env.https.example`
- `deploy/tencent-cvm/README.md`

最短路径：

```bash
cd deploy/tencent-cvm
cp .env.example .env
# 编辑 .env（至少填 PUBLIC_PORT；模型/provider 按你的 OpenClaw 配置选择）
docker compose up -d --build
```

随后手机访问：`http://<CVM公网IP>:8765`

建议流程：

```bash
# 1) 先确保 OpenClaw 可用（已完成 onboarding / gateway 正常）
openclaw status

# 2) 生成页面
node scripts/perp-report.js viewer

# 3) 启动看板（默认绑定 OpenClaw 的 main agent）
OPENCLAW_AGENT_ID=main node scripts/perp-report.js serve
```

最小环境变量（推荐只看这几个）：

- `THUNDERCLAW_TELEGRAM_BOT_TOKEN`：Telegram 机器人 token（最核心）
- `THUNDERCLAW_TELEGRAM_AUTO_REPLY`：来信是否自动回复（默认 `1`）
- `THUNDERCLAW_TELEGRAM_PUSH_TRADES`：是否主动推送交易事件（默认 `1`）
- `THUNDERCLAW_TELEGRAM_PUSH_EVENTS`：推送事件类型（默认 `open,close,risk`）
- `OPENCLAW_AGENT_ID`：默认 `main`

其余高级参数（白名单、轮询周期、轮询锁 stale 时间、记忆检索参数、路由覆盖等）都有默认值，只有特殊场景才需要改，见 `.env.local.example`。

当 OpenClaw 不可用时，聊天区会自动回退到本地兜底回复，并在界面上标记为离线状态。

---

## 6. Scheduling (no OpenClaw required)

Use any scheduler:

- macOS/Linux cron:
  - Every 3 minutes: `PERP_SIGNAL=v5 node scripts/perp-engine.js`
  - Every 1 minute: `node scripts/bitget-perp-position-guard.js`

Important:
- The executor is **idempotent** per `cycleId+side+level+symbol`.
- The guard reconciles if the exchange already closed the position.

---

## 7. Safety checklist before enabling live

1) Confirm `memory/bitget-perp-autotrade-config.json`:
   - `enabled=true`
   - correct `symbol`, `marginMode`, `positionMode`, `leverage`
   - correct sizing (`order.notionalUSDT`) and risk controls

2) Start with `DRY_RUN=1` for 1–2 days, then flip to live.

3) Keep `maxDailyLossUSDT` conservative.

4) Always keep the guard running.

---

## 8. Repository hygiene

This repo intentionally ignores `memory/*.jsonl` and runtime state.
If you want to share strategy params, commit only:
- `memory/perp-strategy-*.json`
- `memory/PERP-ARCHITECTURE.md`
- `memory/perp-tradeplan.v1.md`

---

## 9. License / Disclaimer

This is an experimental trading system. Use at your own risk.
