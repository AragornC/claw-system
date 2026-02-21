# Backend Routes Skeleton

第一批架构拆分骨架（已开始承接真实流量）：

- `xbrain/`：虾脑状态、鉴权、模型、锁管理路由
  - `xbrain.js`：聚合入口
  - `xbrain-auth.js`：鉴权与厂商管理路由
  - `xbrain-config.js`：状态/配置/模型切换/锁路由
- `chat/`：聊天与上下文路由
- `strategy/`：策略工件与回测相关路由
- `telegram/`：Telegram 健康与事件路由

当前仍由 `scripts/serve-report.js` 作为服务器入口，API 路由已通过 `backend/src/routes/index.js` 分发并保持兼容。
