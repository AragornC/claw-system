# OpenClaw 完全兼容推进计划（ThunderClaw）

> 版本：v1.0  
> 日期：2026-02-22  
> 目标：在保留 ThunderClaw 交易能力的前提下，实现对 OpenClaw 协议与行为的高兼容（最终达到“可替换接入”级别）。

---

## 1. 目标定义（先统一“什么叫完全兼容”）

为避免“看起来像兼容但实际不可替换”，本计划把兼容分为 3 层：

1. **协议兼容（Protocol-Compatible）**  
   OpenClaw 客户端可直接调用 ThunderClaw 网关（HTTP + WS + req/res + event）。

2. **方法兼容（Method-Compatible）**  
   OpenClaw 核心网关方法集在 ThunderClaw 均可调用，参数/返回/错误语义一致。

3. **行为兼容（Behavior-Compatible）**  
   同一输入在关键场景（chat/sessions/cron/approval/tools）下，状态迁移和结果与 OpenClaw 一致（允许交易域扩展差异）。

---

## 2. 当前基线（2026-02-22）

### 2.1 已完成（本轮前置结果）

- 默认聊天内核：`openclaw-native`（已切默认）
- 已有 RPC 入口：`/api/runtime/rpc`、`/api/openclaw/rpc`、`/api/gateway/rpc`
- 已实现方法：26 个（含 `chat.send`、`sessions.*`、`cron.*`、`approvals.*`、`tools.*`）
- Runtime smoke/e2e 已覆盖 RPC 场景并 PASS

### 2.2 与 OpenClaw 差距（量化）

- OpenClaw 基础网关方法数：**87**  
- ThunderClaw 当前 RPC 方法数：**26**  
- 方法覆盖率（按数量粗算）：**29.9%**

### 2.3 核心缺口（按影响排序）

1. **WS 传输层不兼容**（当前以 HTTP/轮询为主，缺 OpenClaw WS 握手 + req/res + event 推送）
2. **方法覆盖不足**（`config.* / models.* / skills.* / send / node.* / device.* / wizard.* / talk.* / channels.*` 等未齐）
3. **chat 行为差异**（attachments、runId、abort、history 裁剪策略、idempotency 仍有差异）
4. **权限/作用域模型缺失**（OpenClaw 的 role + scope + control-plane 限流未完整落地）
5. **审批体系差异**（当前为简化版；OpenClaw 有 exec approval 文件/socket/节点通道等）
6. **插件与通道生态差异**（channels/plugins、skills 生态未达到同等扩展模型）

---

## 3. 推进策略（分两条线并行）

### A 线：OpenClaw 兼容能力线（协议/方法/行为）
目标：达到“OpenClaw 客户端最小改动可替换接入”。

### B 线：ThunderClaw 交易能力融合线
目标：兼容不削弱交易机器人能力，并让交易工具成为 OpenClaw 兼容层的一等能力。

---

## 4. 分阶段里程碑

## Phase 0 - 兼容基准冻结（2-3 天）

- [ ] 输出“兼容契约”文档（method、params、error、event、状态机）
- [ ] 建立 OpenClaw 对照测试清单（按方法与场景）
- [ ] 固化当前基线快照（回滚点）

**验收**：兼容目标可量化；后续每个 PR 都能标记兼容增量。

---

## Phase 1 - 传输层对齐（7-10 天）

- [ ] 新增 WS 网关（`connect.challenge` + req/res frame）
- [ ] 加入事件推送通道（至少 `chat` / `tick` / `cron` / `health`）
- [ ] 同步心跳与会话保活协议
- [ ] 兼容 `chat.history` 的实时与补拉模式

**验收**：OpenClaw WS 客户端可直连并稳定收发。

---

## Phase 2 - 核心方法面补齐（10-14 天）

优先补 P0/P1 方法：

- [ ] `health / status / logs.tail / usage.*`
- [ ] `config.get/set/apply/patch/schema`
- [ ] `models.list`
- [ ] `sessions.preview/delete`（当前缺）
- [ ] `chat.abort / chat.history`（当前缺）
- [ ] `send`（统一外发入口）

**验收**：核心运维与对话管理能力可通过同一 method contract 调用。

---

## Phase 3 - 安全与控制面一致性（7-10 天）

- [ ] role/scope 权限校验（operator/node/admin）
- [ ] control-plane 写操作限流策略
- [ ] exec approvals 文件持久化模型兼容
- [ ] approval request/wait/resolve 语义对齐

**验收**：高风险操作与 OpenClaw 同等级可控，策略可复现。

---

## Phase 4 - 会话与聊天行为深度对齐（10-14 天）

- [ ] `chat.send` runId/idempotency/abort 生命周期对齐
- [ ] 附件输入（图片/结构化内容）兼容
- [ ] transcript 与 session store 结构对齐（便于迁移工具复用）
- [ ] history 裁剪与大消息预算策略对齐

**验收**：多轮、并发、中断恢复场景与 OpenClaw 行为一致。

---

## Phase 5 - 生态能力补齐（14-20 天）

- [ ] `skills.*`（status/install/update/bins）
- [ ] `agents.*`（list/create/update/delete/files.*）
- [ ] `channels.status/logout`
- [ ] `wizard.* / talk.* / voicewake.*`
- [ ] `node.* / device.*`（按 ThunderClaw 需要分级实现）

**验收**：生态能力达到 OpenClaw 常用运维与扩展需求。

---

## Phase 6 - 交易能力原生融合（并行进行，2-3 周）

- [ ] ThunderClaw 交易工具注册为标准 ToolManifest 能力域
- [ ] 策略工件、反馈学习、风险控制接入统一 method/event 面
- [ ] 交易域状态通过 `chat/context + method` 双通道可观测
- [ ] 交易任务调度与 cron 行为对齐（含失败重试、审计）

**验收**：兼容 OpenClaw 的同时，交易域能力不降级且更可编排。

---

## 5. 建议的执行顺序（现实可落地）

为尽快给你可验证结果，建议按如下优先级推进：

1. **先做 Phase 1 + Phase 2（P0 方法）**  
   让 OpenClaw 客户端可直接接入，先解决“能不能用”。

2. **再做 Phase 3 + Phase 4**  
   解决“稳不稳、准不准、可控不可控”。

3. **最后做 Phase 5 + Phase 6**  
   解决“像不像 OpenClaw 完整生态 + ThunderClaw 专长融合”。

---

## 6. 工作量预估（单人全职）

- Phase 0-2：约 **3-4 周**
- Phase 3-4：约 **3-4 周**
- Phase 5-6：约 **4-6 周**

**合计**：约 **10-14 周** 达到“高兼容 + 交易融合”的完整目标。  
若只做到“你的核心目标（沟通/执行能力强 + 交易不降级）”，可压缩到 **5-7 周**。

---

## 7. 风险与前置条件

- OpenClaw 某些能力依赖其完整生态（node/device/移动端桥接），需明确是否全量照搬
- 兼容层扩展会抬高 `serve-report.js` 复杂度，需同步拆分模块避免技术债反弹
- 要求建立“兼容回归集”（方法级 + 行为级），否则后续容易回退

---

## 8. 本周建议落地清单（下一步）

- [ ] 建立 `WS gateway skeleton`（握手 + req/res + chat/send demo）
- [ ] 补 `chat.abort / chat.history / sessions.preview / sessions.delete`
- [ ] 引入 role/scope 基础校验骨架
- [ ] 新增 `compat:e2e` 套件（按 OpenClaw method contract 断言）

---

## 9. 结果口径（给业务看的）

到 Phase 2 结束时，可对外口径：

- “ThunderClaw 已支持 OpenClaw 风格方法网关，核心对话/会话/调度可直接接入”  
- “交易能力已作为一等工具域接入，具备任务执行与持续学习闭环”  
- “后续阶段聚焦安全一致性与生态能力全量对齐”

