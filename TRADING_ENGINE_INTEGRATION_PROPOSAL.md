# ThunderClaw 交易引擎接入建议（开源方案）

## 1. 结论（先说人话）

可以，而且很适合你们当前阶段：

- 你们的 AI 交流层已经基本完成；
- 当前后端已经具备“意图提取 + 候选确认 + API 路由”的基础骨架；
- 最缺的是一个稳定、可观测、可风控的“执行内核”。

建议采用 **“双层单引擎（先钉死）”**：

1. **策略/回测/研究引擎（唯一）**：`Freqtrade`；
2. **实盘执行引擎（唯一）**：`CCXT Pro`（若预算/许可受限则先 `CCXT`）。

这样能避免“大而全重构”，先把链路打通，并且避免“选型摇摆”导致迟迟不落地。

---

## 2. 你们现有系统与交易引擎的契合点

从当前仓库看，已经有这些可复用点：

- 已有 API 网关与领域分层，便于新增 `trade.*` 路由。 
- 已有 `strategy-intent` 候选生成/确认流，适合作为“AI -> 策略参数 -> 执行计划”的上游。
- 已有策略版本与工件上报接口，适合接回测结果和仿真报告。
- 产品定位强调“能力外接”，和接入开源交易引擎高度一致。

因此不建议在 ThunderClaw 内自研完整撮合与执行栈，而是做 **编排层 + 适配层**。

---

## 3. 备选引擎对比（仅作备忘，不作为当前实施范围）

## A) Freqtrade（Python）

- 优势：
  - 现成的数字货币策略框架、回测、超参优化、实盘框架；
  - 社区大，文档全，适合快速验证策略。
- 短板：
  - 框架范式较重，若你们要深度自定义执行状态机会受限。
- 适合：
  - **先跑通从 AI 意图到策略回测/纸交易** 的 MVP。

## B) Lean / QuantConnect Lean（C#，支持 Python）

- 优势：
  - 资产类别丰富、研究/回测能力强、工程化成熟；
  - 更接近“机构级研究与执行框架”。
- 短板：
  - 上手和部署复杂度较高，接入成本大于 Freqtrade。
- 适合：
  - 中长期要做多资产、多市场统一研究平台。

## C) Hummingbot（Python）

- 优势：
  - 在做市、套利、CEX/DEX 连接方面成熟；
  - 执行与订单生命周期管理经验足。
- 短板：
  - 若主要是方向性 CTA/择时策略，不一定最顺手。
- 适合：
  - 偏高频执行、做市、跨交易所策略。

## D) CCXT / CCXT Pro（库，不是完整引擎）

- 优势：
  - 交易所接入广，REST + WS；
  - 便于你们在 Node.js 里快速实现统一下单网关。
- 短板：
  - 需要自建风控、状态机、持仓对账、重试机制。
- 适合：
  - 你们已具备编排层，想自己掌控执行逻辑时。

---


## 3.5 最终拍板（V1，不再多选）

为确保工程落地，V1 直接钉死：

- 研究/回测层：`Freqtrade`
- 执行层：`CCXT Pro`（若短期先用 `CCXT`，接口保持一致）

边界约束：

- V1 不引入 Lean/Hummingbot 到主链路；
- 备选引擎只保留在文档，不进入代码依赖；
- 至少跑完一个测试网闭环后，再评估替换。

## 4. 固定实施路线（按“快上线 + 可演进”）

## Phase 1（2~4 周）：先打通可用链路

- 固定选型：**Freqtrade（研究/回测） + CCXT Pro（执行适配）**
- 目标：
  - AI 对话 -> 结构化意图 -> 策略参数 -> 回测报告 -> 模拟下单 -> 执行回执。
- 产出：
  - 端到端“可演示、可回放”的交易闭环。

## Phase 2（4~8 周）：实盘前工程化

- 新增：
  - 风控网关（仓位、杠杆、最大回撤、单日亏损阈值）；
  - 订单状态机（新单/部分成交/撤单/重试/超时）；
  - 账本与对账（本地账本 vs 交易所账本）。

## Phase 3（8 周+）：按策略类型分叉执行器

- 若偏 CTA：加强回测一致性与组合管理；
- 若出现明确瓶颈，再以 RFC 形式评估是否替换执行层或研究层。

---

## 5. 建议的系统架构（嵌入 ThunderClaw）

```text
[UI/Chat]
   -> /api/strategy/intent-candidates
   -> /api/strategy/intent-candidates/apply
   -> /api/trade/plans/create
   -> /api/trade/orders/submit

[ThunderClaw Orchestrator]
   - Intent Normalizer
   - Risk Gateway (pre-trade check)
   - Execution Router
   - Audit/Event Store

[Engine Adapter Layer]
   - Freqtrade Adapter (backtest/paper)
   - CCXT Pro Adapter (live execution)

[Exchange/Broker]
   - Binance/OKX/Bybit/... via API
```

核心原则：

- **AI 只给“建议/计划”**，不直接下单；
- 下单前必须经过 **风控网关 + 人工确认（可配置）**；
- 所有指令与回执都写入事件日志，支持审计和复盘。

---

## 6. 交易领域模型（建议先定）

建议先冻结这些统一对象，降低引擎替换成本：

- `TradeIntent`：AI 提取的交易意图（symbol、side、entry、tp/sl、timeframe）
- `TradePlan`：经过规则化后的可执行计划（风险预算、有效期、执行方式）
- `OrderRequest`：标准下单请求（type, qty, price, tif, reduceOnly）
- `OrderState`：订单状态机（created/submitted/accepted/partial/filled/canceled/rejected）
- `PositionState`：持仓快照（size, avgPrice, pnl, liquidationPrice）
- `RiskDecision`：风控决策（allow/deny + reasons）

---

## 7. 最小可行 API（你们可以直接加）

- `POST /api/trade/intents/normalize`
- `POST /api/trade/plans/create`
- `POST /api/trade/risk/check`
- `POST /api/trade/orders/preview`
- `POST /api/trade/orders/submit`
- `POST /api/trade/orders/cancel`
- `GET  /api/trade/orders/:id`
- `GET  /api/trade/positions`
- `GET  /api/trade/events`

这组 API 能和你们现有聊天/策略模块无缝拼接。

> 实施要求：V1 仅实现 Freqtrade + CCXT Pro 两类适配器，避免过早抽象。

---

## 8. 风控与合规底线（务必先做）

- 交易所 API Key 分级：只读、交易、提现权限严格隔离；
- 默认不开提现权限；
- 每个策略设置：
  - 单笔风险上限
  - 日损上限
  - 最大连续亏损熔断
  - 黑名单交易对
- 对 AI 输出做“结构校验 + 白名单约束 + 数值边界检查”；
- 敏感操作必须可追溯（谁在何时批准了什么订单）。

---

## 9. 你们下一步最值得做的 5 件事

1. 先定义统一交易对象（第 6 节）并固化 JSON Schema；
2. 实现 `risk/check` 与 `orders/preview`（先不实盘）；
3. 接一个测试网交易所（如 Binance Testnet）跑通提交与回执；
4. 将回测报告写入你们现有策略工件接口；
5. 增加“人工确认开关”：默认 AI 建议不自动下单。

---

## 10. 一句话建议

**你们完全可以嵌入开源交易引擎，而且 V1 应钉死为“编排层（ThunderClaw）+ 适配层（Freqtrade + CCXT Pro）”，先跑通测试网闭环，再决定是否扩展。**

---

## 11. 实现状态（V1）

当前代码已按“聊天域 -> 虾策域 -> 回测层”闭环落地最小实现：

- 聊天域通过 `intent-candidates` + `intent-candidates/apply` 已可生成并确认特征/策略；
- 虾策域在 `replay/publish/detail` 三个接口中消费回测结果；
- 回测层新增 `FreqtradeBacktestAdapter`，并在服务启动时支持按环境变量切换引擎：
  - `THUNDERCLAW_BACKTEST_ENGINE=freqtrade`：优先使用 Freqtrade 适配器；
  - 默认 `local`：继续使用内置本地引擎。

### V1 边界

- 为保证可运行性，Freqtrade 适配器当前先做“命令可用性探测 + 结果标准化映射”；
- 若 Freqtrade 不可用，策略回测路径会自动回退本地引擎，保证 API 稳定；
- 后续再补真实 `freqtrade backtesting` 命令编排与参数细化映射。

### V1.1 工程强化（已补）

- 补充聊天与意图提取的本地降级策略：当外部模型链路不可用时，仍可产出可执行的特征/策略候选；
- 增加端到端验收脚本 `scripts/e2e-intent-backtest.js`，覆盖：
  - 服务状态与配置初始化；
  - 对话入口（`/api/ai/chat`）；
  - 意图候选提取与确认写入；
  - 回放、发布、详情查询；
- 在 `THUNDERCLAW_BACKTEST_ENGINE=freqtrade` 模式下完成全链路验证（并保留 local fallback 兜底）。

- “强断言卡死”仅用于 `scripts/e2e-intent-backtest.js` 验收脚本，不会拦截线上用户对话；
- 线上流程仍通过 skill 意图识别决定是否进入虾策链路，普通闲聊不会被强制落库回测。

