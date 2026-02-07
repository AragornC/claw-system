# Bitget Perp（简化版）架构说明

目标：底座稳定（交易执行/风控/状态），策略高频可变（JSON）。

## 固定底座（尽量不动）

- 执行引擎：`scripts/bitget-perp-autotrade.js`
  - 读取：`memory/bitget-perp-autotrade-config.json`
  - 负责：下单/止盈止损/本地状态更新/幂等（如有）

- 持仓守护：`scripts/bitget-perp-position-guard.js`
  - 负责：检测持仓是否需要平仓/止盈止损/超时处理

## 可变策略（你/模型随时改）

- 信号生成：`scripts/market-perp-signal.js`
  - 读取：`memory/perp-strategy.json`（可通过环境变量 `PERP_STRATEGY_PATH` 覆盖）
  - 输出：alerts（long/short/强度）+ effective thresholds

- 新闻过滤（稳定）：`scripts/blockbeats-news-signal.js`

## 一轮轮询（cycle）

- `scripts/run-perp-cycle.js`
  - 依次调用：
    1) `market-perp-signal.js` → alerts
    2) `blockbeats-news-signal.js` → allow/block
  - 输出合并 JSON（供执行引擎使用）

> 交易系统调度层（cron）只需要触发一次 cycle，其余逻辑由脚本输出 JSON 决定。

## 策略修改建议

只改 `memory/perp-strategy.json`：
- `thresholds.nearEma20Pct / nearEma50Pct`
- `thresholds.minAtrPct / maxAtrPct`
- `allowSides` 控制只做多/只做空

改完后可先 dry-run：

```bash
node scripts/market-perp-signal.js
node scripts/run-perp-cycle.js
```

确认 alerts 符合预期后，再恢复 cron。
