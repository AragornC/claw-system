/**
 * runAgent — the single primitive that drives every Agent in the system.
 *
 * Responsibilities:
 *   1. Build the agent's system prompt from its config (systemPrompt +
 *      memory strategy + relevant memory summaries from MEMORY.md).
 *   2. Resolve its tool set = agent.fns (via toolCatalog) + memory tools
 *      scoped to the agent's namespace.
 *   3. Run a ReAct loop: stream LLM → dispatch tool calls → feed results
 *      back → repeat until LLM produces a final answer or maxRounds hit.
 *   4. Render UI items (text, tool_group) into the given session so the
 *      user can watch the agent's progress.
 *
 * This is deliberately *not* responsible for:
 *   - Routing (that's workflow.ts's job)
 *   - Coordinator logic (Coordinator is just another caller of runAgent,
 *     but it also has access to a dispatch_agent tool — to be added)
 */

import { chatStreamWithTools } from "./workflow-llm";
import { execTool, toolBrief } from "./tools";
import {
  MEM_TOOLS_AGENT,
  isMemoryTool,
  execMemoryTool,
  memoryToolBrief,
  getMemorySummariesFor,
} from "./memory-tools";
import { resolveTools } from "./toolCatalog";
import { useChatStore } from "../store/chatStore";
import type { MemoryNamespace } from "../store/memoryStore";
import type { Agent } from "../types/agent";
import type {
  WorkflowMessage,
  ChatItem,
  TextItem,
  ToolGroupItem,
  ToolCallRecord,
} from "../types/workflow";

// ── Public types ────────────────────────────────────────────

export interface AgentRunOptions {
  /** The agent config (from useAgentStore) */
  agent: Agent;
  /** The task to hand this agent — typically the user's question, or a
   *  sub-task synthesized by the Coordinator */
  task: string;
  providerId: string;
  model: string;
  /** Session id — used for rendering streaming UI (text + tool_group) */
  sessionId: string;
  /** Optional: caller-provided system context (time, exchange, balance…)
   *  Appended verbatim to the system prompt. */
  extraContext?: string;
  /** Optional: prior conversation turns this agent should see */
  history?: WorkflowMessage[];
  /** Safety bound on ReAct loop iterations. Default 8. */
  maxRounds?: number;
}

export interface AgentRunResult {
  /** The LLM's final answer (last round's content with no tool calls) */
  finalText: string;
  /** How many LLM rounds were consumed */
  rounds: number;
  /** Flat log of every tool call this agent made */
  toolCalls: Array<{
    name: string;
    args: Record<string, unknown>;
    result: unknown;
  }>;
}

// ── Implementation ──────────────────────────────────────────

const KNOWN_NAMESPACES: MemoryNamespace[] = [
  "shared",
  "analyst",
  "risk",
  "coordinator",
];

function asNamespace(id: string): MemoryNamespace | null {
  return (KNOWN_NAMESPACES as string[]).includes(id)
    ? (id as MemoryNamespace)
    : null;
}

export async function runAgent(opts: AgentRunOptions): Promise<AgentRunResult> {
  const {
    agent,
    task,
    providerId,
    model,
    sessionId,
    extraContext = "",
    history = [],
    maxRounds = 8,
  } = opts;

  // Agent's own memory namespace — drives scoped read/write
  const scope = asNamespace(agent.id);

  // Resolve tool set: declared fns + agent-scoped memory tools
  const fnTools = resolveTools(agent.fns);
  const allTools = [...fnTools, ...MEM_TOOLS_AGENT];

  // Inject relevant memory summaries so the agent knows what's available
  const memHints = scope ? getMemorySummariesFor(scope) : "";
  const memSection = memHints
    ? `\n\n## 相关记忆索引\n${memHints}`
    : "";

  const writeScopeHint = scope
    ? `${scope}/ 或 shared/`
    : "shared/";

  const systemPrompt = `${agent.systemPrompt}

## 角色元数据
- 角色名: ${agent.name}
- 职责: ${agent.role}
- 记忆策略: ${agent.memory}

## 记忆工具使用
- 你的 namespace: ${scope ?? "(无专属 namespace — 只能写 shared/)"}
- write_memory 只能写入 ${writeScopeHint}
- 先用 read_memory / search_memory 查既有知识，避免重复研究
- 只在有值得沉淀的新发现时 write_memory，不要每轮都写${memSection}

## 工作方式
- 需要数据时直接调用工具，不要只说"我将会调用"
- 工具可多轮调用。拿到足够数据后，输出结构化的最终结论（不再调用工具）
- 最终结论必须能独立被 Coordinator / 用户读懂

${extraContext}`.trimEnd();

  const msgs: WorkflowMessage[] = [
    { role: "system", content: systemPrompt },
    ...history,
    { role: "user", content: task },
  ];

  const toolCallLog: AgentRunResult["toolCalls"] = [];
  const dataGroupTitle = `${agent.name} · 调用工具`;
  const memGroupTitle = `${agent.name} · 更新记忆`;

  let dataGroupIdx: number | null = null;
  let memGroupIdx: number | null = null;
  let finalText = "";
  let rounds = 0;

  for (let round = 0; round < maxRounds; round++) {
    rounds = round + 1;

    // Live-streaming text block for this round's assistant narration
    const textIdx = pushAndGetIndex(sessionId, { kind: "text", text: "" });

    const result = await chatStreamWithTools(
      providerId,
      model,
      msgs,
      allTools,
      {
        onContentDelta: (delta) => {
          useChatStore.getState().updateItem(sessionId, textIdx, (item) => {
            const t = item as TextItem;
            return { ...t, text: t.text + delta };
          });
        },
      }
    );

    // Terminal condition: LLM produced content with no tool calls
    if (result.toolCalls.length === 0) {
      finalText = result.content;
      break;
    }

    // Feed the assistant's turn (with tool_calls) back into history so the
    // next round's context is coherent
    msgs.push({
      role: "assistant",
      content: result.content || null,
      tool_calls: result.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.name, arguments: tc.arguments },
      })),
    });

    // Dispatch each tool call — memory vs data groups rendered separately
    for (const tc of result.toolCalls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.arguments || "{}");
      } catch {
        /* ignore malformed args — we'll surface the error via exec path */
      }

      const isMem = isMemoryTool(tc.name);

      if (isMem) {
        if (memGroupIdx === null) {
          memGroupIdx = pushAndGetIndex(sessionId, {
            kind: "tool_group",
            title: memGroupTitle,
            tools: [],
            collapsed: false,
          });
        }
        const out = execMemoryTool(tc.name, args, scope);
        const brief = memoryToolBrief(tc.name, args, out);
        appendToolToGroup(sessionId, memGroupIdx, {
          id: tc.id,
          name: tc.name,
          args,
          result: out,
          brief,
        });
        toolCallLog.push({ name: tc.name, args, result: out });
        msgs.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify(out),
        });
      } else {
        if (dataGroupIdx === null) {
          dataGroupIdx = pushAndGetIndex(sessionId, {
            kind: "tool_group",
            title: dataGroupTitle,
            tools: [],
            collapsed: false,
          });
        }
        try {
          const out = await execTool(tc.name, args);
          const brief = toolBrief(tc.name, out);
          appendToolToGroup(sessionId, dataGroupIdx, {
            id: tc.id,
            name: tc.name,
            args,
            result: out,
            brief,
          });
          toolCallLog.push({ name: tc.name, args, result: out });
          msgs.push({
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify(out),
          });
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e);
          const errResult = { error: errMsg };
          appendToolToGroup(sessionId, dataGroupIdx, {
            id: tc.id,
            name: tc.name,
            args,
            result: errResult,
            brief: `error: ${errMsg}`,
          });
          toolCallLog.push({ name: tc.name, args, result: errResult });
          msgs.push({
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify(errResult),
          });
        }
      }
    }
  }

  // Collapse groups once the loop finishes so the transcript stays compact
  if (dataGroupIdx !== null) {
    useChatStore.getState().updateItem(sessionId, dataGroupIdx, (item) => ({
      ...(item as ToolGroupItem),
      title: `${agent.name} · 工具已调用`,
      collapsed: true,
    }));
  }
  if (memGroupIdx !== null) {
    useChatStore.getState().updateItem(sessionId, memGroupIdx, (item) => ({
      ...(item as ToolGroupItem),
      title: `${agent.name} · 记忆已更新`,
      collapsed: true,
    }));
  }

  return { finalText, rounds, toolCalls: toolCallLog };
}

// ── Local helpers ───────────────────────────────────────────

function pushAndGetIndex(sessionId: string, item: ChatItem): number {
  const store = useChatStore.getState();
  store.pushItem(sessionId, item);
  const session = useChatStore
    .getState()
    .sessions.find((s) => s.id === sessionId);
  return (session?.items.length ?? 1) - 1;
}

function appendToolToGroup(
  sessionId: string,
  idx: number,
  record: ToolCallRecord
): void {
  useChatStore.getState().updateItem(sessionId, idx, (item) => {
    const g = item as ToolGroupItem;
    return { ...g, tools: [...g.tools, record] };
  });
}
