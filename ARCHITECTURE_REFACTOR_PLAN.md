# Architecture Refactor Plan (Phase 1)

## 目标

在不破坏现有功能的前提下，将项目从单体脚本逐步迁移为模块化结构，覆盖：

- ThunderClaw
- 虾线
- 虾策
- 虾海
- 虾脑
- 后端 API/状态管理

## 第一批（已落地）

- 新增前端共享工具目录：`frontend/src/shared/utils/`
  - `format.js`
  - `storage.js`
  - `provider.js`
- 新增后端路由骨架目录：`backend/src/routes/README.md`

## 第二批（进行中）

- 将 `scripts/perp-report-viewer.js` 的重复工具函数替换为共享实现（保持行为不变）
- 将 `scripts/serve-report.js` 的 xbrain 路由逻辑抽离为独立模块（先拷贝、再切流量）
  - 已完成：`backend/src/routes/xbrain.js` 聚合拆分
  - 已完成：`backend/src/routes/xbrain-auth.js`（`/api/xbrain/auth/*` + `/api/xbrain/provider/remove`）
  - 已完成：`backend/src/routes/xbrain-config.js`（`/api/xbrain/state`、`/api/xbrain/update`、`/api/xbrain/model/switch`、`/api/xbrain/lock`）
- 前端 `app` 视图元数据继续拆分
  - 已完成：`frontend/src/modules/app/view-meta.js`
  - 已完成：`frontend/src/modules/app/view-aliases.js`
  - 已接入：`scripts/perp-report-viewer.js` 使用模块化标题/副标题/别名映射
- 前端 `xsea` 继续去单体
  - 已完成：`frontend/src/modules/xsea/runtime.js`（数据规范化、prompt 组装）
  - 已完成：`frontend/src/modules/xsea/presenter.js`（列表渲染、动作归并）
  - 已接入：`scripts/perp-report-viewer.js`（xsea 逻辑下沉）
- 后端 `xbrain` 服务层继续拆分
  - 已完成：`backend/src/services/xbrain-auth-service.js`
  - 已接入：`scripts/serve-report.js`（OAuth URL 解析、凭证写入、凭证断开逻辑改为 service 委托）
  - 已完成：`backend/src/services/xbrain-state-service.js`
  - 已接入：`scripts/serve-report.js`（provider 删除与状态裁剪逻辑改为 service 委托）
  - 已完成：`backend/src/models/xbrain-providers.js`
  - 已接入：`scripts/serve-report.js`（厂商模型映射常量集中管理）
  - 已优化：`xbrain-auth-service` 增加 `normalizeOAuthProvider`，统一 OAuth 厂商归一
  - 已优化：`xbrain-auth-service` 增加 `resolveXbrainAuthLaunch`、`inferXbrainAuthPhaseFromOutput`
  - 已接入：`scripts/serve-report.js`（登录启动方案与 phase 推断改为 service 委托）
  - 已优化：`xbrain-auth-service` 增加 `resetXbrainAuthState`、`appendOutputTail`、`applyRunnerEvent`、`buildAuthExitError`
  - 已接入：`scripts/serve-report.js`（OAuth runner/expect 状态迁移与错误归因逻辑下沉）
  - 已优化：`xbrain-auth-service` 增加 `buildAuthStatusView`、`validateAuthInput`、`buildExpectScript`
  - 已接入：`scripts/serve-report.js`（状态视图、输入校验、expect 脚本构建改为 service 委托）
  - 已优化：`xbrain-auth-service` 增加 `markAuthProcessError`、`finalizeAuthProcessClose`
  - 已接入：`scripts/serve-report.js`（runner/expect 进程异常与收敛逻辑统一）
  - 已优化：`xbrain-auth-service` 增加 `createAuthProcessHandle`、`applyExpectOutputChunk`
  - 已接入：`scripts/serve-report.js`（spawn proc 包装与 expect 输出解析下沉）
  - 已优化：清理 `serve-report.js` 中 auth 薄封装中转函数，直接委托 `xbrain-auth-service`
  - 已优化：`xbrain-auth-service` 增加 `buildAuthSpawnOptions`
  - 已接入：`scripts/serve-report.js`（runner/expect spawn 配置统一）
  - 已优化：`xbrain-auth-service` 增加 `applyRunnerOutputChunk`、`bindAuthProcessLifecycle`
  - 已接入：`scripts/serve-report.js`（runner/expect 监听挂载模板化，进一步去重复）
  - 已优化：`xbrain-auth-service` 增加 `initializeAuthProcess`、`bindAuthOutputStreams`
  - 已接入：`scripts/serve-report.js`（进程初始化与 stdout/stderr 绑定统一模板）
  - 已优化：`xbrain-auth-service` 增加 `startAuthProcessByMode`
  - 已接入：`scripts/serve-report.js`（runner/expect 启动执行入口统一分发）
  - 已优化：`xbrain-auth-service` 增加 `executeAuthInput`
  - 已接入：`scripts/serve-report.js`（auth input 执行与状态迁移下沉）
  - 已完成：`backend/src/services/xbrain-config-service.js`
  - 已接入：`scripts/serve-report.js`（`handleXbrainModelSwitchApi` 切换校验/同步/状态回填下沉）
  - 已优化：`xbrain-config-service` 增加 `updateSection`
  - 已接入：`scripts/serve-report.js`（`handleXbrainUpdateApi` section 分发与 base 同步策略下沉）
  - 已优化：`xbrain-config-service` 增加 `manageLock`
  - 已接入：`scripts/serve-report.js`（`handleXbrainLockApi` 锁校验/设置/密码逻辑下沉）
- 后端路由依赖注入继续收敛
  - 已完成：`backend/src/routes/api-deps.js`
  - 已接入：`scripts/serve-report.js`（`handleApiRoute` 统一依赖对象，移除每请求散点传参）
- 前端 `xsea` controller 层继续拆分
  - 已完成：`frontend/src/modules/xsea/controller.js`（初始化判断、发帖草稿、AI 目标解析）
  - 已接入：`scripts/perp-report-viewer.js`
  - 已优化：`controller.js` 增加 `prependXseaPost`、`buildXseaActionPersistencePlan`
  - 已接入：`scripts/perp-report-viewer.js`（发帖写入与 feed-action 持久化决策下沉）
  - 已优化：`controller.js` 增加 `parseXseaFeedClickEvent`
  - 已接入：`scripts/perp-report-viewer.js`（xsea 点击 DOM 解析下沉）
  - 已优化：`controller.js` 增加 `readXseaFormFields`
  - 已接入：`scripts/perp-report-viewer.js`（xsea 表单读取下沉）
- 前端 `xbrain` 通信层开始拆分
  - 已完成：`frontend/src/modules/xbrain/api.js`
  - 已接入：`scripts/perp-report-viewer.js`（state/update/auth/switch API 请求封装下沉）
  - 已完成：`frontend/src/modules/xbrain/flows.js`
  - 已接入：`scripts/perp-report-viewer.js`（probe/switch/auth monitor 流程白盒逻辑下沉）
  - 已完成：`frontend/src/modules/xbrain/index.js`
  - 已接入：`scripts/perp-report-viewer.js`（xbrain 模块统一边界入口）
  - 已优化：`xbrain/flows.js` 增加 `buildXbrainFlowDeps`
  - 已接入：`scripts/perp-report-viewer.js`（flow 依赖注入配置统一构建）
  - 已优化：清理 `perp-report-viewer.js` 中 xbrain 流程桥接壳函数（直接调用模块能力）
- 回归脚本（第8步）开始落地
  - 已完成：`scripts/xbrain-smoke-check.mjs`
  - 已接入：`package.json` 脚本 `test:smoke:xbrain`
  - 已验证：`npm run test:smoke:xbrain` PASS（覆盖 state/auth/update/model-switch/lock 关键接口基本健康检查）
- 手测清单脚本化（第9步）开始落地
  - 已完成：`scripts/xbrain-e2e-check.mjs`
  - 已接入：`package.json` 脚本 `test:e2e:xbrain`
  - 已验证：`npm run test:e2e:xbrain` PASS（配置更新/模型切换/锁管理关键链路）
- 验收基线固化（第10步）已落地
  - 已完成：`QA_BASELINE_XBRAIN.md`（验收范围、结果解释、排查优先级）
  - 已接入：`package.json` 脚本 `test:verify:xbrain`（smoke + e2e 一键复验）
  - 已验证：`npm run test:verify:xbrain` PASS

## 验收标准

1. 页面无 JS 报错
2. `/api/xbrain/state`、`/api/xbrain/update`、`/api/xbrain/model/switch` 可用
3. OAuth 连接/断开可用
4. 厂商追加/删除可用
5. ThunderClaw 模型切换可用

## 当前完成度（可签收视角）

- 结构改造完成度（xbrain 主链路）：约 **90%+**
- 风险控制完成度（自动化回归）：约 **80%+**
- 当前状态：`xbrain` 相关的后端路由、服务层、前端通信层与流程层均已模块化并接入
- 可复验命令：`npm run test:verify:xbrain`

## 剩余风险与建议

- **环境依赖风险**：OAuth 与 OpenClaw provider 安装状态受本地环境影响，脚本主要验证接口与链路，不替代真实授权环境
- **跨模块风险**：`thunderclaw/xline/xstrategy/xsea` 其余大块仍在单体脚本中，后续迭代仍可能引入非 xbrain 回归
- **性能风险**：当前尚未做系统级 profile（仅做结构降复杂度），若要进一步提速建议单独做 profiling 轮次

## 签收建议

- 若本轮目标是“xbrain 架构主链路可维护 + 可复验”，建议可先阶段签收
- 若目标是“全项目所有模块都完成同等级拆分”，建议开启下一阶段（`thunderclaw/xline/xstrategy/xsea` 同标准推进）
