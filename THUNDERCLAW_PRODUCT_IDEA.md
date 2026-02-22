# ThunderClaw 产品思路（保留版）

## 1. 产品定位

ThunderClaw 只保留为一个轻量产品壳子：

- 品牌与入口：ThunderClaw
- 展示层：产品页面与视觉资产
- 交易相关能力：作为后续外接能力域（不在本仓库继续维护实现）
- 智能底座：后续直接基于 OpenClaw 原生体系构建

## 2. 核心原则

1. **壳子优先**：本仓库只承载品牌壳、页面、思路，不承载复杂后端逻辑。
2. **能力外接**：所有智能与执行能力通过外部系统接入，避免再次耦合。
3. **清晰边界**：页面展示与能力实现分离，降低维护复杂度。
4. **可替换性**：后端与模型能力可替换，不锁定单一技术栈。

## 3. 未来重建方向

- 以 OpenClaw 为唯一核心执行引擎
- ThunderClaw 仅负责：
  - 品牌层与交互入口
  - 业务能力编排配置（而非实现）
  - 交易能力域接入（虾线 / 虾策 / 虾海 / 虾脑）

## 4. 当前保留资产

- `scripts/thunderclaw-cli.js`（壳子入口）
- `memory/report/index.html`（产品页面）
- `memory/report/app-icon.svg`
- `memory/report/app-icon-maskable.svg`
- `memory/report/manifest.json`
- `memory/report/decisions.json`
- `memory/report/orders.json`
- `memory/report/ohlcv.json`
