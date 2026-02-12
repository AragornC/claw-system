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
- OpenClaw 按约定返回结构化动作（`switch_view / focus_trade / run_backtest`）
- 前端自动执行动作：切页、定位交易开平区间、触发回验
- 提供调试接口：
  - `GET /api/ai/health`
  - `GET /api/ai/context`
  - `GET /api/ai/context?full=1`

手机/静态部署（无本地后端）可用方案：

- 页面会自动尝试 `OpenClaw` 后端；不可达时可切到 **DeepSeek 直连模式**。
- 在聊天框发送：`/deepseek sk-xxxx`（仅保存到当前浏览器 localStorage，不入库）。
- 之后聊天将直接调用 DeepSeek API（支持动作：切页/定位/回验）。
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

`openclaw:setup:local` 会引导你填写：

- 是否运行 OpenClaw 官方 `configure` 向导
- 默认模型 ID（留空则沿用 OpenClaw 当前配置）
- 可选 DeepSeek provider 快速写入（仅当你选择时）
- OpenClaw 路由参数（写入 `.env.local`，不含 API key）

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
- 然后用 `thunderclaw start` 启动看板；
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

可选环境变量：

- `OPENCLAW_CLI_BIN`：指定 OpenClaw 命令入口（可设 `openclaw` 或 `thunderclaw`；未设置时优先用 `openclaw`，若检测到 `./openclaw/` 且依赖已安装则会自动使用仓库版本）
- `OPENCLAW_AGENT_ID`：默认 `main`
- `OPENCLAW_CHANNEL`：会话路由频道（如 `telegram` / `whatsapp`），透传到 `openclaw agent --channel`
- `OPENCLAW_TO`：会话目标（如手机号、`@username`、chat_id），透传到 `openclaw agent --to`
- `OPENCLAW_SESSION_ID`：指定会话 ID，透传到 `openclaw agent --session-id`
- `OPENCLAW_AGENT_LOCAL`：`1/true` 时强制 `openclaw agent --local`（无需先跑 Gateway，推荐本地直连模型时开启）
- `OPENCLAW_DELIVER`：`1/true` 时在执行 agent 后投递回复到频道（`--deliver`）
- `OPENCLAW_REPLY_CHANNEL` / `OPENCLAW_REPLY_TO` / `OPENCLAW_REPLY_ACCOUNT`：投递覆盖参数（`--reply-channel` / `--reply-to` / `--reply-account`）
- `OPENCLAW_THINKING`：如 `low | medium | high`
- `OPENCLAW_VERBOSE`：如 `on | off`
- `OPENCLAW_TIMEOUT_SEC`：OpenClaw `agent` 超时秒数（默认 `90`）
- `OPENCLAW_CHAT_TIMEOUT_MS`：服务端桥接超时毫秒（默认 `95000`）
- `OPENCLAW_CONTEXT_MAX_DECISIONS`：上下文中最近决策条数（默认 `36`）
- `OPENCLAW_CONTEXT_TIMELINE_EVENTS`：上下文时间线条数（默认 `18`）
- `OPENCLAW_CONTEXT_MAX_ORDERS`：上下文中最近订单条数（默认 `12`）

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
