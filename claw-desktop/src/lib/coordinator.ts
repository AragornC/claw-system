// Coordinator orchestrator — the multi-agent branch of runWorkflow.
//
// Flow (mirrors docs/demos/ui-anim-coordinator.html):
//
//   1. Opening narration           "这件事是 X 加 Y 的组合判断……"
//   2. CoordThinking (ReAct loop)  reads memory + fetches market snapshot
//   3. Bridge narration            "上下文齐了——……接下来拆成一份 plan"
//   4. Plan                        objective → approach → verification
//   5. Handoff narration           "Plan 就绪。派 Analyst / News 并行推进……"
//   6. AgentTask blocks            fan-out per approach step (serial/parallel)
//   7. Synthesis                   Coordinator merges findings → final text
//
// Phase 1.5 status:
//   ✓ Steps 1–5 real (LLM-driven, tool-calling, structured plan)
//   ◑ Step 6 stubbed — uses registry stubs so UI flows end-to-end
//   ✓ Step 7 real (LLM synthesizes from stub findings)
//
// Swapping stubs for real agents is a one-file change in lib/agents/registry.

import { chatStreamWithTools } from "./workflow-llm";
import { tryParsePartialJSON } from "./stream-json";
import { execTool, toolBrief } from "./tools";
import {
  MEM_TOOLS_FULL,
  isMemoryTool,
  execMemoryTool,
  memoryToolBrief,
} from "./memory-tools";
import { useChatStore } from "../store/chatStore";
import { getAgent, type AgentContext } from "./agents/registry";
import type {
  ChatItem,
  CoordThinkingItem,
  NarrationItem,
  PlanItem,
  AgentTaskItem,
  TextItem,
  WorkflowMessage,
  ToolDef,
  Plan,
  AgentResult,
  ApproachStep,
} from "../types/workflow";

// ── Tool sets ───────────────────────────────────────────────
//
// Coordinator's ctx-gathering phase can use market data + memory.
// Plan emission uses a *forced* single-tool — tool_choice would pin it
// exactly, but we achieve the same effect by offering only one tool
// and instructing the LLM to emit plan via that tool.

const COORD_CTX_TOOLS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "get_price",
      description: "获取加密货币实时价格和成交量",
      parameters: {
        type: "object",
        properties: { symbol: { type: "string" } },
        required: ["symbol"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_positions",
      description: "查询当前持仓",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "check_balance",
      description: "查询账户余额",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "通用网络搜索（Tavily）。用来拉最新新闻、政策、ETF 流入、链上动态——memory 里查不到的外部信息走这里。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "搜索关键词" },
          max_results: { type: "number", description: "结果数，默认 5" },
        },
        required: ["query"],
      },
    },
  },
  ...MEM_TOOLS_FULL,
];

const EMIT_PLAN_TOOL: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "emit_plan",
      description:
        "产出这次任务的 Plan。你必须调用这个函数并且只调用这一次。不要在 content 里写 plan，只通过参数传递。",
      parameters: {
        type: "object",
        properties: {
          objective: {
            type: "object",
            description: "任务目标——描述性，不是具体数值",
            properties: {
              kind: {
                type: "string",
                description: '任务类型标签，例如 "trading decision" / "analysis" / "strategy review"',
              },
              lines: {
                type: "array",
                items: { type: "string" },
                description: "1-3 段描述性文字说明要交付什么、验收标准",
              },
            },
            required: ["kind", "lines"],
          },
          approach: {
            type: "array",
            description: "执行路径——按步骤拆分，每步可并行或串行",
            items: {
              type: "object",
              properties: {
                mode: {
                  type: "string",
                  enum: ["并行", "串行"],
                  description: "这一步内部是并行还是串行",
                },
                cond: {
                  type: "string",
                  description: "触发条件（可选），如 '等 Step 1 汇总'",
                },
                items: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      agent: {
                        type: "string",
                        enum: ["Analyst", "NewsAgent", "Risk"],
                      },
                      task: {
                        type: "string",
                        description: "给该 agent 的一句话任务（≤50字）",
                      },
                    },
                    required: ["agent", "task"],
                  },
                },
              },
              required: ["mode", "items"],
            },
          },
          verification: {
            type: "array",
            description: "验收 checklist——最终回答必须满足的 2-4 条",
            items: { type: "string" },
          },
        },
        required: ["objective", "approach", "verification"],
      },
    },
  },
];

// ── Entry point ─────────────────────────────────────────────

export interface CoordinatorOptions {
  sessionId: string;
  providerId: string;
  model: string;
  userText: string;
  systemContext: string;       // built by caller (workflow.ts buildContext)
  history: WorkflowMessage[];  // prior conversation turns
}

export async function runCoordinator(opts: CoordinatorOptions): Promise<void> {
  // 1. Opening narration — LLM authors 1-2 sentences framing what it's
  //    about to do based on the actual user query.
  await narrateOpening(opts);

  // 2. Coordinator context-gathering (ReAct loop on market + memory tools).
  const ctxResult = await runCoordContext(opts);
  if (ctxResult.failed) return;

  // 3. Bridge narration — LLM summarizes what was found + signals transition.
  await narrateBridge(opts, ctxResult);

  // 4. Plan — force structured emit_plan call.
  const plan = await runPlanPhase(opts, ctxResult.thinking);
  if (!plan) return;

  // 5. Handoff narration — LLM explains dispatch pattern for THIS plan.
  await narrateHandoff(opts, plan);

  // 6. Dispatch sub-agents per approach step (parallel or serial).
  const agentResults = await runDispatch(opts, plan);

  // 7. Synthesis — Coordinator writes the final user-facing answer.
  await runSynthesis(opts, plan, agentResults);
}

// ── 2. Context gathering (ReAct loop) ───────────────────────

interface CtxResult {
  failed: boolean;
  thinking: string;
  toolSummary: string;  // "2 read · 1 search · 1 fetch"
}

async function runCoordContext(opts: CoordinatorOptions): Promise<CtxResult> {
  const idx = pushAndGetIndex(opts.sessionId, {
    kind: "coord_thinking",
    agent: "Coordinator",
    text: "",
    tools: [],
    durationMs: 0,
    collapsed: false,
  });
  const start = Date.now();

  const systemPrompt = `你是 Coordinator——ThunderClaw 的多 agent 编排器。**当前只做上下文收集这一件事**。

**严格规则（违反即任务失败）**：
1. **必须调用工具**。第一轮至少调用 1 个工具（search_memory 或 get_positions 或 get_price）。
2. **绝对禁止**输出 markdown 报告、章节标题（## / ###）、表格、用户友好的分析结论。
3. **绝对禁止**直接回答用户。用户会在后面阶段才看到结果。
4. 每轮 content 只能写 1 句话，说明下一步要查什么（例如"现在查一下账户持仓"）——或者完全为空，让工具调用说话。
5. 最后一轮（确认上下文已齐）：停止调用工具，用 2-3 句**事实陈述**总结关键数据（例：「BTC $77k +3%，持仓 0.3 @ 60.8k 均价，memory 有一份 04-15 偏多 60% 的分析」）。不要下结论，不要给建议。

**工作流程**：
- 先用 search_memory({query, scope:["analyst/","coordinator/","shared/"]}) 找历史分析
- 根据 search 结果用 read_memory 读有价值的文件
- 用 get_price / get_positions / check_balance 拉实时状态
- 全部查完后停止调用工具，写简洁的事实总结

${opts.systemContext}`;

  const msgs: WorkflowMessage[] = [
    { role: "system", content: systemPrompt },
    ...opts.history,
    { role: "user", content: opts.userText },
  ];

  try {
    for (let round = 0; round < 6; round++) {
      // Round 0 is forced — the model MUST call at least one tool or the
      // whole ctx phase degenerates into direct prose. Later rounds use
      // "auto" so the loop can actually terminate (model emits a final
      // short summary with no tool calls → we break out).
      const choice =
        round === 0
          ? ("required" as const)
          : ("auto" as const);

      const result = await chatStreamWithTools(
        opts.providerId,
        opts.model,
        msgs,
        COORD_CTX_TOOLS,
        {
          onThinkingDelta: (d) => appendThinking(opts.sessionId, idx, d),
          onContentDelta: (d) => appendThinking(opts.sessionId, idx, d),
        },
        choice
      );

      // No more tools → context gathering done
      if (result.toolCalls.length === 0) break;

      // Persist assistant tool-call turn
      msgs.push({
        role: "assistant",
        content: result.content || null,
        tool_calls: result.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: tc.arguments },
        })),
      });

      // Execute each tool, append to the coord block's tool list
      for (const tc of result.toolCalls) {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(tc.arguments || "{}"); } catch { /* noop */ }

        // Push placeholder row (running state)
        useChatStore.getState().updateItem(opts.sessionId, idx, (it) => {
          const c = it as CoordThinkingItem;
          return {
            ...c,
            tools: [
              ...c.tools,
              { id: tc.id, name: tc.name, args, brief: "running…" },
            ],
            durationMs: Date.now() - start,
          };
        });

        let out: unknown;
        let brief: string;
        try {
          if (isMemoryTool(tc.name)) {
            out = execMemoryTool(tc.name, args, null);
            brief = memoryToolBrief(tc.name, args, out);
          } else {
            out = await execTool(tc.name, args);
            brief = toolBrief(tc.name, out);
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          out = { error: msg };
          brief = `error: ${msg}`;
        }

        // Update placeholder with real result
        useChatStore.getState().updateItem(opts.sessionId, idx, (it) => {
          const c = it as CoordThinkingItem;
          return {
            ...c,
            tools: c.tools.map((t) =>
              t.id === tc.id ? { ...t, result: out, brief } : t
            ),
          };
        });

        msgs.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify(out),
        });
      }
    }

    // Finalize: collapse + duration.
    //
    // If the LLM ignored instructions and dumped a markdown report into
    // content (headers, long paragraphs), strip that from the UI text so
    // the coord block stays tight — but keep the full text in the returned
    // `thinking` summary so the plan phase still has context to work with.
    const durationMs = Date.now() - start;
    let fullText = "";
    let toolSummary = "";
    useChatStore.getState().updateItem(opts.sessionId, idx, (it) => {
      const c = it as CoordThinkingItem;
      fullText = c.text;
      toolSummary = summarizeTools(c.tools.map((t) => t.name));
      return {
        ...c,
        text: cleanCoordDisplay(c.text),
        durationMs,
        collapsed: true,
      };
    });

    return { failed: false, thinking: fullText, toolSummary };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    useChatStore.getState().updateItem(opts.sessionId, idx, (it) => ({
      ...(it as CoordThinkingItem),
      text: (it as CoordThinkingItem).text + `\n\n[Coordinator 出错: ${msg}]`,
      collapsed: false,
      durationMs: Date.now() - start,
    }));
    return { failed: true, thinking: "", toolSummary: "" };
  }
}

// ── 4. Plan emission (forced structured output) ─────────────

async function runPlanPhase(
  opts: CoordinatorOptions,
  ctxThinking: string
): Promise<Plan | null> {
  const idx = pushAndGetIndex(opts.sessionId, {
    kind: "plan",
    agent: "Coordinator",
    plan: emptyPlan(),
    phase: "drafting_objective",
    durationMs: 0,
    collapsed: false,
  });
  const start = Date.now();

  const systemPrompt = `你是 Coordinator——ThunderClaw 的多 agent 编排器。

你的当前任务：**产出 Plan**。基于已收集的上下文，调用 emit_plan 函数。

## Sub-agents 能力边界（按需选用，不要凑数）
- **Analyst**   — 技术面分析：K线、指标、趋势、支撑阻力、成交量
- **NewsAgent** — 消息面：新闻、ETF 流入、链上数据、市场情绪、宏观催化
- **Risk**      — 风控：仓位管理、止损、风险敞口、加减仓建议

## Approach 结构 —— 关键：按任务实际需要决定，不要套模板！

**核心原则**：approach 是你独立判断出来的执行图，不是固定剧本。简单任务 1 步 1 agent，复杂任务才拆多步。

不同任务 → 不同形状的例子：
- "BTC 技术面怎么样" → 1 步并行 { Analyst }
- "要不要加仓 BTC"   → 2 步：并行 { Analyst, NewsAgent } → 串行 { Risk } 等前面汇总
- "最近有什么利空"    → 1 步并行 { NewsAgent }
- "我止损设哪合适"    → 1 步串行 { Risk }（甚至不需要其他 agent）
- "BTC vs ETH 该买哪个" → 2 步：并行 { Analyst[BTC], Analyst[ETH], NewsAgent } → 串行 { Risk }
- "帮我做一份完整决策" → 2 步：并行 { Analyst, NewsAgent, Risk } → 串行 { Analyst } 做综合（Risk 也可能需要等前两个）

**判断要点**：
1. 真的需要这个 agent 吗？如果用户只问技术面就别拉 NewsAgent 来凑数。
2. 真的需要串行吗？如果后一步不依赖前一步的输出，就放同一个并行步里。
3. **可以只 1 步**。1 步 1 个 agent 完全合法，别为了"看起来像 plan"硬拆两步。
4. cond 字段只在串行步需要等待时写，独立任务不用写。

## 三段字段要求

1. **objective**
   - kind: 一个短标签，贴合任务，如 "price check" / "trend analysis" / "trading decision" / "risk review" / "news brief"
   - lines: 1-3 句，说明要交付什么、验收标准
2. **approach**
   - 1-3 步，每步 mode 为 "并行" 或 "串行"
   - items 里的 agent 只能是 "Analyst" / "NewsAgent" / "Risk"
   - 串行步可用 cond 字段写依赖条件
3. **verification**
   - **必须** 2-4 条 checklist，最终答案必须满足的约束
   - 贴合任务本身，不要抄例子。
   - 例（按任务类型）：
     - 技术分析："必须给出关键支撑位和阻力位数字"
     - 加仓决策："建议必须包含止损位和建议仓位比例"
     - 新闻汇总："若 24h 内无重大新闻需明确标注 '无新增催化'"
     - 风控评估："必须给出最大可承受回撤百分比"
   - **verification 不能为空数组**。

## 已收集的上下文
${ctxThinking || "(无明确摘要，请基于工具调用结果推断)"}

## 输出协议
- 只调用 emit_plan 一次，一次性传入 objective + approach + verification。
- content 保持空字符串。
- approach 请根据上下文独立判断形状，不要套 "2 步 · 3 agent" 的模板。`;

  const msgs: WorkflowMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: opts.userText },
  ];

  // Progressive plan reveal — parse partial tool-args JSON on every fragment
  // and mirror what has landed into the PlanItem's state. The user watches
  // the plan fill in top-down (objective → approach → verification) instead
  // of waiting for the tool call to close before seeing anything.
  const applyPartial = (argsSoFar: string): void => {
    const parsed = tryParsePartialJSON(argsSoFar);
    if (!parsed || typeof parsed !== "object") return;
    const partial = normalizePlan(parsed);
    // Derive which section is currently drafting. The last key present in
    // the stream determines the phase; we infer from what's non-empty.
    const phase: PlanItem["phase"] =
      partial.verification.length > 0
        ? "drafting_verification"
        : partial.approach.length > 0
          ? "drafting_approach"
          : "drafting_objective";
    useChatStore.getState().updateItem(opts.sessionId, idx, (it) => ({
      ...(it as PlanItem),
      plan: partial,
      phase,
      durationMs: Date.now() - start,
    }));
  };

  try {
    const result = await chatStreamWithTools(
      opts.providerId,
      opts.model,
      msgs,
      EMIT_PLAN_TOOL,
      {
        onToolArgsDelta: ({ toolIndex, argsSoFar }) => {
          if (toolIndex !== 0) return;
          applyPartial(argsSoFar);
        },
      },
      // Force emit_plan — the plan is required output, not optional.
      { type: "function", function: { name: "emit_plan" } }
    );

    if (result.toolCalls.length === 0) {
      useChatStore.getState().updateItem(opts.sessionId, idx, (it) => ({
        ...(it as PlanItem),
        phase: "done",
        durationMs: Date.now() - start,
        collapsed: false,
      }));
      pushItem(opts.sessionId, {
        kind: "text",
        text: "（Coordinator 没有产出结构化 plan，流程中断）",
      });
      return null;
    }

    let plan: Plan;
    try {
      const raw = result.toolCalls[0].arguments ?? "";
      const parsed = parsePlanArgs(raw);
      plan = normalizePlan(parsed);
      // Sanity: at least objective + one approach step, else bail to fallback.
      if (!plan.objective.kind && plan.approach.length === 0) {
        throw new Error("empty plan after normalize");
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Log raw for diagnosis — this is the only window we get into
      // DeepSeek's structured-output weirdness.
      // eslint-disable-next-line no-console
      console.error("[coordinator] plan parse failed", {
        error: msg,
        raw: result.toolCalls[0].arguments,
        content: result.content,
      });
      pushItem(opts.sessionId, {
        kind: "text",
        text: `（Plan 解析失败: ${msg}；已降级跳过 sub-agent 分派。raw 已写入 console）`,
      });
      return null;
    }

    // Single-shot reveal (we don't have mid-argument streaming of structured
    // fields from the LLM here; phase just jumps to done). UI still shows
    // the "Planning… (drafting objective)" flash before this replaces it
    // because we push the empty-phase item first, then update.
    const durationMs = Date.now() - start;
    useChatStore.getState().updateItem(opts.sessionId, idx, (it) => ({
      ...(it as PlanItem),
      plan,
      phase: "done",
      durationMs,
      collapsed: true,
    }));
    return plan;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    pushItem(opts.sessionId, {
      kind: "text",
      text: `（Plan 生成失败: ${msg}）`,
    });
    return null;
  }
}

// ── 6. Dispatch sub-agents ──────────────────────────────────

async function runDispatch(
  opts: CoordinatorOptions,
  plan: Plan
): Promise<AgentResult[]> {
  const all: AgentResult[] = [];

  for (const step of plan.approach) {
    // Create AgentTaskItems for each agent in this step first (UI shows the queue)
    const taskIdxs: number[] = [];
    for (const item of step.items) {
      const tIdx = pushAndGetIndex(opts.sessionId, {
        kind: "agent_task",
        agent: item.agent,
        task: item.task,
        status: "pending",
        durationMs: 0,
        collapsed: false,
      });
      taskIdxs.push(tIdx);
    }

    const runOne = async (item: typeof step.items[0], idx: number): Promise<AgentResult | null> => {
      const start = Date.now();
      const agent = getAgent(item.agent);
      if (!agent) {
        useChatStore.getState().updateItem(opts.sessionId, idx, (it) => ({
          ...(it as AgentTaskItem),
          status: "error",
          summary: `Unknown agent: ${item.agent}`,
          durationMs: Date.now() - start,
        }));
        return null;
      }

      useChatStore.getState().updateItem(opts.sessionId, idx, (it) => ({
        ...(it as AgentTaskItem),
        status: "running",
      }));

      try {
        const ctx: AgentContext = {
          userText: opts.userText,
          providerId: opts.providerId,
          model: opts.model,
          sessionId: opts.sessionId,
          priorResults: all,
          systemContext: opts.systemContext,
        };
        const result = await agent.run(item, ctx);
        useChatStore.getState().updateItem(opts.sessionId, idx, (it) => ({
          ...(it as AgentTaskItem),
          status: "done",
          summary: result.summary,
          result,
          durationMs: Date.now() - start,
          collapsed: true,
        }));
        return result;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        useChatStore.getState().updateItem(opts.sessionId, idx, (it) => ({
          ...(it as AgentTaskItem),
          status: "error",
          summary: msg,
          durationMs: Date.now() - start,
        }));
        return null;
      }
    };

    if (step.mode === "并行") {
      const results = await Promise.all(
        step.items.map((item, i) => runOne(item, taskIdxs[i]))
      );
      for (const r of results) if (r) all.push(r);
    } else {
      // 串行
      for (let i = 0; i < step.items.length; i++) {
        const r = await runOne(step.items[i], taskIdxs[i]);
        if (r) all.push(r);
      }
    }
  }

  return all;
}

// ── 7. Synthesis ────────────────────────────────────────────

async function runSynthesis(
  opts: CoordinatorOptions,
  plan: Plan,
  results: AgentResult[]
): Promise<void> {
  const textIdx = pushAndGetIndex(opts.sessionId, { kind: "text", text: "" });

  const findingsBlock = results
    .map((r) => `### ${r.agent}\n${r.summary}\nfindings: ${JSON.stringify(r.findings ?? {})}\nconfidence: ${r.confidence?.toFixed(2) ?? "-"}`)
    .join("\n\n");

  const verificationBlock = plan.verification
    .map((v, i) => `${i + 1}. ${v}`)
    .join("\n");

  const systemPrompt = `你是 Coordinator。下面是各 sub-agent 的产出。请**面向用户**写一段最终回答。

要求：
- 直接给结论（该不该做 / 怎么做 / 风险在哪），不要复述 plan。
- 必须回应每条 verification（简洁引用即可）。
- 2-4 段，总长 ≤ 180 字。
- 语气专业但不要 robotic，像一位资深交易员的判断。

## Plan Objective
${plan.objective.kind} — ${plan.objective.lines.join(" ")}

## Agent Findings
${findingsBlock || "(无 agent 结果)"}

## Verification Checklist
${verificationBlock}`;

  const msgs: WorkflowMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: opts.userText },
  ];

  try {
    await chatStreamWithTools(
      opts.providerId,
      opts.model,
      msgs,
      null,
      {
        onContentDelta: (d) => {
          useChatStore.getState().updateItem(opts.sessionId, textIdx, (it) => {
            const t = it as TextItem;
            return { ...t, text: t.text + d };
          });
        },
      }
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    useChatStore.getState().updateItem(opts.sessionId, textIdx, (it) => ({
      ...(it as TextItem),
      text: `（合成最终回答失败: ${msg}）`,
    }));
  }
}

// ── Narration copy (LLM-authored, streamed) ─────────────────
//
// Three short bridges that the user sees between action blocks.
// Hardcoded templates read as "system echo" — identical prose regardless
// of query — so each narration is written by the LLM against the actual
// query / ctx / plan. We stream into a placeholder NarrationItem so the
// user sees it type in real time, same feel as direct_reply.
//
// Cost: ~50-120 tokens each × 3 = trivial compared to the ctx ReAct loop
// and synthesis calls that already run.

async function streamNarration(
  opts: CoordinatorOptions,
  systemPrompt: string,
  userPrompt: string
): Promise<void> {
  const idx = pushAndGetIndex(opts.sessionId, { kind: "narration", text: "" });
  try {
    await chatStreamWithTools(
      opts.providerId,
      opts.model,
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      null,
      {
        onContentDelta: (d) => {
          useChatStore.getState().updateItem(opts.sessionId, idx, (it) => {
            const n = it as NarrationItem;
            return { ...n, text: n.text + d };
          });
        },
      }
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    useChatStore.getState().updateItem(opts.sessionId, idx, (it) => ({
      ...(it as NarrationItem),
      text: `（narration 生成失败: ${msg}）`,
    }));
  }
}

async function narrateOpening(opts: CoordinatorOptions): Promise<void> {
  const system = `你是 ThunderClaw 的 Coordinator，正要开始处理一个需要多 agent 协作的交易相关问题。

**你的任务**：在真正开工前，写 1-2 句短话对用户说——
- 第一人称，像刚坐到工位上自言自语地整理思路
- 明确说出**你看了这个问题之后打算先查什么 / 整理什么上下文**（别泛泛说"我来协调一下"）
- 贴合问题本身：如果问 BTC 技术面，你就说先调 K 线和历史分析；如果问消息面，就说先过一遍新闻和持仓；如果问加减仓，就说先拉账户状态 + 历史判断
- 不要喊口号，不要罗列 step，不要"我将会…"这种生硬腔
- **严禁**用模板句式如"这件事需要多个 agent 协作"

**输出要求**：直接出中文正文，不加引号、不加 markdown、不加前缀。1-2 句，最多 80 字。`;
  await streamNarration(opts, system, opts.userText);
}

async function narrateBridge(
  opts: CoordinatorOptions,
  ctx: CtxResult
): Promise<void> {
  const factSummary = (ctx.thinking || "").slice(0, 800) || "(无明确摘要)";
  const system = `你是 ThunderClaw 的 Coordinator。上下文已经收集完了，下一步要拆 plan 派 sub-agent。

**你的任务**：写 1-2 句短话，承上启下——
- 第一人称
- **先简短陈述你查到的关键事实**（最该被用户注意的 1-2 点，比如"BTC 现在 \`77.4k\` 上 3%，持仓 0.3 还在手"），贴合下面的上下文
- 然后自然过渡到"我来拆一下接下来谁做什么"这个意思（别用原话）
- 不要复述工具调用计数，不要说"（2 read · 3 fetch）"这种系统 log
- **严禁**用"上下文齐了"这种模板开头

## 已收集的事实
${factSummary}

## 工具使用概览（仅供参考，不要直接引用）
${ctx.toolSummary || "(无)"}

**输出要求**：直接出中文正文，不加引号、不加 markdown、不加前缀。1-2 句，最多 100 字。可用反引号包数字/代码。`;
  await streamNarration(opts, system, opts.userText);
}

async function narrateHandoff(
  opts: CoordinatorOptions,
  plan: Plan
): Promise<void> {
  const planBrief = describePlanShape(plan);
  const system = `你是 ThunderClaw 的 Coordinator。Plan 刚刚出炉，马上要派 sub-agent 干活。

**你的任务**：写 1 句话，说明**这份 plan 实际上怎么跑**——
- 只提 plan 里真实出现的 agent（见下面的结构），**不要虚构 agent**
- 如果 plan 只有 1 个 agent，就直说让谁出手，别装作有很多 agent 协作
- 如果有并行/串行结构，要讲清楚谁先谁后、谁等谁
- 用反引号包 agent 名，如 \`Analyst\`
- **严禁**说"派 Analyst / NewsAgent / Risk 并行推进"这种和实际 plan 不符的模板

## 当前 plan 结构
${planBrief}

**输出要求**：直接出中文正文，不加引号、不加 markdown、不加前缀。1 句话，最多 70 字。`;
  await streamNarration(opts, system, opts.userText);
}

function describePlanShape(plan: Plan): string {
  const steps = plan.approach.map((s, i) => {
    const items = s.items.map((a) => `${a.agent}（${a.task}）`).join(" + ");
    const cond = s.cond ? ` ※条件：${s.cond}` : "";
    return `Step ${i + 1} [${s.mode}] ${items}${cond}`;
  });
  return steps.length ? steps.join("\n") : "(无 step)";
}

// ── Helpers ─────────────────────────────────────────────────

function pushItem(sessionId: string, item: ChatItem): void {
  useChatStore.getState().pushItem(sessionId, item);
}

function pushAndGetIndex(sessionId: string, item: ChatItem): number {
  useChatStore.getState().pushItem(sessionId, item);
  const session = useChatStore.getState().sessions.find((s) => s.id === sessionId);
  return (session?.items.length ?? 1) - 1;
}

function appendThinking(sessionId: string, idx: number, delta: string): void {
  useChatStore.getState().updateItem(sessionId, idx, (it) => {
    const c = it as CoordThinkingItem;
    return { ...c, text: c.text + delta };
  });
}

// Strip markdown reports the LLM may have emitted against instructions.
// We keep only short narrative lines (what the model said *between* tool
// calls) and drop any stretch that starts looking like a user-facing
// report (## headings, bullet walls, long paragraphs).
function cleanCoordDisplay(text: string): string {
  if (!text) return "";
  const lines = text.split("\n");
  const kept: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      if (kept.length && kept[kept.length - 1] !== "") kept.push("");
      continue;
    }
    // Drop markdown headings — a sure sign of report mode.
    if (/^#{1,6}\s/.test(line)) break;
    // Drop bullet / numbered lists and bold-heavy lines — same pattern.
    if (/^[-*]\s\*\*/.test(line) || /^\d+\.\s\*\*/.test(line)) break;
    // Keep short prose (reasoning between tool calls).
    kept.push(line);
    if (kept.join(" ").length > 280) break;
  }
  return kept.join("\n").trim();
}

function summarizeTools(names: string[]): string {
  const counts: Record<string, number> = {};
  for (const n of names) {
    const k =
      n.startsWith("read_") || n.startsWith("list_") ? "read" :
      n.startsWith("search_") || n === "web_search" ? "search" :
      n.startsWith("write_") || n.startsWith("update_") ? "write" :
      n.startsWith("get_") || n.startsWith("fetch_") ? "fetch" :
      n.startsWith("calculate_") ? "calc" :
      "call";
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(" · ");
}

function emptyPlan(): Plan {
  return {
    objective: { kind: "", lines: [] },
    approach: [],
    verification: [],
  };
}

// Defensive parser for emit_plan's `arguments` string.
//
// DeepSeek (and other OpenAI-compat models) occasionally:
//   1. return empty / whitespace arguments when content got most of the payload
//   2. wrap the JSON in ```json ... ``` fences
//   3. concatenate fragments across a single tool call with junk between them
//      (we saw e.g. "{...}\n\n{...}" when a retry got merged)
//   4. emit trailing commas or single quotes
//
// We try strict parse first, then progressively strip.
function parsePlanArgs(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("emit_plan arguments 为空");
  }

  // 1. Strict
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through */
  }

  // 2. Strip code fence wrapper ```json ... ```
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      /* fall through */
    }
  }

  // 3. Extract the first balanced { ... } object.
  const firstBrace = trimmed.indexOf("{");
  if (firstBrace !== -1) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = firstBrace; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (esc) { esc = false; continue; }
      if (ch === "\\") { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          const candidate = trimmed.slice(firstBrace, i + 1);
          try {
            return JSON.parse(candidate);
          } catch {
            // 4. Last resort: strip trailing commas
            try {
              return JSON.parse(candidate.replace(/,(\s*[}\]])/g, "$1"));
            } catch {
              break;
            }
          }
        }
      }
    }
  }

  throw new Error(
    `无法解析 emit_plan.arguments（len=${raw.length}, head="${trimmed.slice(0, 60)}"）`
  );
}

function normalizePlan(raw: unknown): Plan {
  const r = raw as Record<string, unknown>;
  const obj = (r?.objective ?? {}) as Record<string, unknown>;
  const lines = Array.isArray(obj.lines) ? (obj.lines as string[]) : [];
  const approach = Array.isArray(r?.approach) ? (r.approach as ApproachStep[]) : [];
  const verification = Array.isArray(r?.verification) ? (r.verification as string[]) : [];
  return {
    objective: {
      kind: String(obj.kind ?? "task"),
      lines: lines.filter((l) => typeof l === "string"),
    },
    approach: approach.map((s) => ({
      mode: s.mode === "串行" ? "串行" : "并行",
      cond: s.cond,
      items: Array.isArray(s.items) ? s.items : [],
    })),
    verification,
  };
}
