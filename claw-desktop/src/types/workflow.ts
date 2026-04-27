// ── Chat Item types (replaces simple Message) ──────────────
//
// ChatItem is an ADT covering every visual block the agent can emit.
// The Coordinator flow (multi-agent orchestration) adds four new kinds
// on top of the base Thinking + simple_tool flow:
//
//   narration       — prose bridge between action blocks, Claude-Code style
//   coord_thinking  — Coordinator's ReAct block (thinking + inline tool rows)
//   plan            — structured JSON plan (objective/approach/verification)
//   agent_task      — sub-agent work unit (stub now, real dispatch in Phase 2)
//
// Each ChatItem is independently renderable — ChatItemList just branches
// on .kind. Unknown kinds are silently ignored so new variants can land
// without breaking old sessions.

export type ChatItem =
  | UserItem
  | ThinkingItem
  | NarrationItem
  | CoordThinkingItem
  | PlanItem
  | AgentTaskItem
  | ToolGroupItem
  | TextItem;

export interface UserItem {
  kind: "user";
  text: string;
}

export interface ThinkingItem {
  kind: "thinking";
  text: string;
  durationMs: number;
  collapsed: boolean;
}

// ── Narration: prose bridge between action blocks ───────────
//
// Example: "上下文齐了——3 天前给过偏多 60% 的基线……接下来把这件事
//拆成一份 plan，让下游 agent 清楚要产出什么、怎么验收。"
//
// Supports inline `.m` code pills for technical terms via the literal
// markdown backtick syntax (rendered by ReactMarkdown).

export interface NarrationItem {
  kind: "narration";
  text: string;
}

// ── CoordThinking: Coordinator's context-gathering block ────
//
// Visually one unit: a thinking summary ("Coordinator · Thought for Xs
// · 2 read · 1 search") with expandable tool-row body. Unlike the
// plain ThinkingItem + separate ToolGroupItem, these are fused because
// the demo showed them as one bordered card.

export interface CoordThinkingItem {
  kind: "coord_thinking";
  agent: string;                // "Coordinator" (future: other orchestrators)
  text: string;                 // streaming thinking prose
  tools: ToolCallRecord[];      // tool calls executed during this phase
  durationMs: number;
  collapsed: boolean;
}

// ── Plan: structured LLM output (not a tool call) ───────────
//
// Generated via forced tool-call on a single `emit_plan` function.
// Shape mirrors demo: three LLM-authored fields keyed by intent.
//
//   objective:    prose description of what we're deciding & acceptance bar
//   approach:     sequence of steps, each parallel/serial with agent tasks
//   verification: check list the final answer must pass
//
// Phase-tracking (drafting each section) is derived at UI time from
// which fields have landed — we don't persist intermediate states.

export interface PlanItem {
  kind: "plan";
  agent: string;                // "Coordinator"
  plan: Plan;                   // the structured output
  phase: PlanPhase;             // "drafting_objective" | … | "done"
  durationMs: number;
  collapsed: boolean;
}

export type PlanPhase =
  | "drafting_objective"
  | "drafting_approach"
  | "drafting_verification"
  | "done";

export interface Plan {
  objective: {
    kind: string;               // e.g. "trading decision"
    lines: string[];            // prose paragraphs (LLM-authored)
  };
  approach: ApproachStep[];
  verification: string[];
}

export interface ApproachStep {
  mode: "并行" | "串行";
  cond?: string;                // e.g. "等 Step 1 汇总"
  items: AgentTaskSpec[];
}

export interface AgentTaskSpec {
  agent: string;                // "Analyst" | "NewsAgent" | "Risk" | …
  task: string;                 // one-line task description
}

// ── AgentTask: a sub-agent's work unit ──────────────────────
//
// Phase 1.5 stub: each task renders as a collapsible block with
// agent name, status dot, and mock findings. Phase 2 fills with
// real sub-agent thinking + tool calls.

export interface AgentTaskItem {
  kind: "agent_task";
  agent: string;
  task: string;
  status: "pending" | "running" | "done" | "error";
  summary?: string;             // one-line result for collapsed state
  result?: AgentResult;         // full structured output when done
  durationMs: number;
  collapsed: boolean;
}

export interface AgentResult {
  agent: string;
  summary: string;
  findings?: Record<string, unknown>;
  confidence?: number;
  toolTrace?: ToolCallRecord[];
}

// ── Base building blocks ────────────────────────────────────

export interface ToolGroupItem {
  kind: "tool_group";
  title: string;
  tools: ToolCallRecord[];
  collapsed: boolean;
}

export interface TextItem {
  kind: "text";
  text: string;
}

export interface ToolCallRecord {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: unknown;
  brief?: string;
}

// ── Workflow streaming types (from Tauri backend) ───────────

export interface WorkflowChunk {
  thinking_delta?: string;   // DeepSeek R1: reasoning_content, Anthropic: thinking block
  content_delta?: string;    // All providers: response text
  tool_call_delta?: ToolCallDelta;
  done: boolean;
  error?: string;
}

export interface ToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  arguments_fragment: string;
}

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

// ── Workflow message (matches Rust WorkflowMessage) ─────────

export interface WorkflowMessage {
  role: string;
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: WorkflowToolCall[];
}

export interface WorkflowToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

// ── Route decision ──────────────────────────────────────────
//
// Three-way classifier set by the opening Thinking phase:
//   direct_reply      — no tools needed, just answer
//   simple_tool       — one ReAct loop with market/memory tools
//   coordinator_task  — multi-agent orchestration (Plan → dispatch → synth)
//
// The legacy "agent_task" value is aliased to coordinator_task for
// backward compat with old sessions / existing router prompts.

export interface RouteDecision {
  path: "direct_reply" | "simple_tool" | "coordinator_task" | "agent_task";
  tools?: string[];
  agents?: string[];
}
