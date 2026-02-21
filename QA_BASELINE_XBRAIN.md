# XBrain QA Baseline

本文档定义当前 `xbrain` 架构改造阶段的最小验收基线与复验命令。

## 一键复验命令

```bash
npm run test:verify:xbrain
```

该命令会顺序执行：

1. `npm run test:smoke:xbrain`（接口健康检查）
2. `npm run test:e2e:xbrain`（关键链路脚本化手测）

## 覆盖范围

### Smoke（接口健康）

- `GET /api/xbrain/state`
- `GET /api/xbrain/auth/status`
- `POST /api/xbrain/update` 非法 `section` 返回 400
- `POST /api/xbrain/model/switch` 空 `modelId` 返回 400
- `POST /api/xbrain/auth/disconnect` 非法 `provider` 返回 400
- `POST /api/xbrain/lock` 非法 `action` 返回 400

### E2E（关键链路）

- `state` 拉取成功
- `base` 配置无副作用更新链路可用（`modelRegistry` noop）
- 模型切换链路可用（切换到当前模型）
- `lock` 参数校验链路可用（非法 action）

## 结果解释

- `PASS`：链路可用且结果符合预期
- `GUARDED`：受保护失败（例如模块被锁/模型未上线），属于预期保护行为
- `FAIL`：非预期失败，需排查回归

## 失败排查优先级

1. 先看 `scripts/serve-report.js` 是否可启动
2. 再看 `backend/src/services/xbrain-*.js` 最近改动
3. 最后看 `frontend/src/modules/xbrain/*` 与 `scripts/perp-report-viewer.js` 接口调用参数
