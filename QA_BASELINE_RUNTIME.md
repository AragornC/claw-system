# QA Baseline - OpenClaw Native Runtime

## 目标

验证 ThunderClaw 对话链路在 `openclaw-native` 模式下，runtime 内核（会话/记忆/任务/调度/工具/审批）可正常工作。

## 一键复验

```bash
npm run test:verify:runtime
```

MCP 桥接协议（manifest + invoke envelope）可单独复验：

```bash
npm run test:smoke:mcp-bridge
```

## Smoke 覆盖（`test:smoke:runtime`）

- `GET /api/runtime/sessions`
- `GET /api/runtime/tools/manifest`
- `GET /api/runtime/approvals`
- `POST /api/runtime/tasks`
- `POST /api/runtime/tasks/retry`（非法 ID 校验）
- `POST /api/runtime/schedules`
- `GET /api/runtime/approvals`
- `GET /api/runtime/tools/manifest`

## E2E 覆盖（`test:e2e:runtime`）

- `POST /api/ai/chat`：`memory_get` 分支
- `POST /api/ai/chat`：创建调度分支
- `POST /api/runtime/schedules/patch`
- `POST /api/runtime/sessions/compact`
- `POST /api/runtime/approvals/config`
- `POST /api/ai/chat`：审批拦截分支（`approvalId`）
- `POST /api/runtime/approvals/decide`
- `POST /api/runtime/approvals/allowlist/add`
- `GET /api/runtime/audit`
- `POST /api/runtime/schedules/delete`
- `POST /api/runtime/sessions/reset`
- `POST /api/runtime/sessions/resume`

## 验收标准

1. runtime 模块可被 Node 正常 import（无重复定义/语法错误）
2. `openclaw-native` 模式下 `/api/ai/chat` 能走 runtime 内核
3. 调度 patch/delete 接口路径正确
4. 审批配置与待审批列表可查询，审批决策可落地
5. 审计日志可查询（`/api/runtime/audit`）
6. smoke + e2e 均通过；MCP bridge smoke 通过
