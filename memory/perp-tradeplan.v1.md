# TradePlan v1（Bitget Perp）

执行引擎：`scripts/bitget-perp-autotrade.js`

## 输入格式（stdin JSON）

推荐使用 TradePlan v1：

```json
{
  "tradePlanVersion": 1,
  "cycleId": "1770308277199",
  "dryRun": true,
  "plan": {
    "symbol": "BTCUSDT",
    "side": "long",
    "level": "strong",
    "reason": "manual_dry_run"
  },
  "decision": {
    "blockedByNews": false,
    "newsReason": []
  },
  "news": { "ok": false }
}
```

### 字段说明
- `tradePlanVersion`: 固定为 1
- `cycleId`: 本轮唯一ID（用于幂等，建议用 nowMs 或 ISO 时间串）
- `dryRun`: true 时不下单，仅返回 wouldOpenPosition
- `plan`: 若为 null，表示本轮**明确无可执行信号**（执行器返回 reason=no_plan）
- `plan.symbol`: 仅用于标记；执行时仍以 `memory/bitget-perp-autotrade-config.json` 的 `symbol` 为准
- `plan.side`: long/short
- `plan.level`: strong/very-strong（用于记录）
- `plan.reason`: 可选，记录在 meta
- `decision.blockedByNews`: 若 true，执行器直接跳过（reason=blocked_by_news）

## 幂等规则
- 若 `cycleId` 相同且 plan 的 (symbol, side, level) 计算出的 `idemKey` 相同，则本轮跳过：`reason=idempotent_skip`。

## 兼容旧输入
仍兼容旧版 `{alerts, news}`，但后续建议逐步迁移到 TradePlan v1。
