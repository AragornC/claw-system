# ThunderClaw 四层特征 × Freqtrade 单引擎架构（落地版）

## 目标

- 只保留 `Freqtrade` 作为唯一回测执行后端，避免双引擎语义漂移。
- 将“信号 / 仓位 / 风控 / 执行”四层特征统一为标准化策略框架（Layer Framework / IR）。
- 对话生成、推荐回显、策略详情编辑、回测执行、K线点位解释全部使用同一套框架。

## 总体架构

```text
AI 对话 / 推荐 / 手工编辑
        ↓
Strategy Layer Framework (IR)
  - normalize
  - validate
  - capability matrix
        ↓
Freqtrade Adapter (唯一执行器)
  - strategy code generation
  - config generation
  - backtesting
        ↓
Execution Report + K线事件决策快照
```

## 四层能力矩阵

| 层 | 业务目标 | 关键字段 | Freqtrade落地方式 | 当前状态 |
|---|---|---|---|---|
| 信号层 | 入场/出场方向和阈值 | signalLogic, signalType, featureRefs, long/shortThreshold | populate_indicators + entry/exit 规则注入 | Supported |
| 仓位层 | 资金分配与暴露约束 | mode, maxPositions, maxExposurePct, notional, leverageLimit | 先纳入运行元数据与约束；后续扩展 custom_stake_amount | Partial |
| 风控层 | 止损止盈与保护 | stopLossPct, takeProfitPct, maxDrawdownPct, maxConsecutiveLoss, frequencyLimitPerDay | stoploss/minimal_roi + 保护规则 | Supported |
| 执行层 | 成交模型质量 | orderMode, slippageBps, feeModel, retry* | order_types/pricing + 执行元数据回传 | Partial |

## 对话策略并入框架

1. `intent-candidates` 产出策略候选时，同时给出 `layers` + `frameworkSummary`。
2. `intent-candidates/apply` 时必须先做层框架标准化，再写入策略草稿。
3. 推荐卡片展示基于 `frameworkSummary`（而不是纯自然语言片段）。

## K线点位解释规范

每个交易事件点位返回 `decisionSnapshot`：

- `signal`: 当根K线的信号逻辑/阈值/观测值
- `position`: 仓位上限与杠杆限制
- `risk`: SL/TP/DD/连亏阈值
- `execution`: 下单模式/手续费/滑点假设

前端在 marker hover/click 的 popover 里展示这四层，支持“为什么在这里执行”的可解释复盘。

## 设计约束

- 不允许 UI 展示可编辑字段但执行层未消费（必须有 capability 标记）。
- 不允许不同来源策略（对话/推荐/手工）绕过 Layer Framework。
- 不允许双引擎并行导致结果语义不一致。

## 迁移策略

1. 启动阶段强制 Freqtrade 可用，否则直接报错。
2. 本地历史策略读取后自动规范化到 Layer Framework。
3. 逐步补齐仓位层与执行层在 Freqtrade 中的深度映射。


## 外部信号特征扩展（新闻 / 社媒 / 预测市场）

- 信号层允许 `signal_external` 分组的特征（如 `news_sentiment`、`social_sentiment`、`prediction_market`）。
- 对话解析阶段先将用户意图映射为标准特征定义，再进入 Layer Framework，不直接跳过到代码拼接。
- Freqtrade 回测事件在 `decisionSnapshot.signal` 中回传：
  - `externalSignalScore`
  - `externalSignals[]`（featureRef/sourceType/score/bias/confidence）
- 这样可以在 K 线上逐点解释“当时外部信号是如何参与决策”的问题。

> 注意：当前版本先实现统一结构与回测可解释闭环；新闻/Twitter/Polymarket 的实时抓取可通过后续 skill + MCP 数据适配器补齐。
