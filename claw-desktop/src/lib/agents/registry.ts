// Sub-agent registry — the seam between Coordinator's dispatch and
// individual specialist agents (Analyst / NewsAgent / Risk / …).
//
// Phase 1.5 ships stub implementations that return mock AgentResult
// after a short delay so the UI timeline feels real. Phase 2 will
// replace each .run() body with a real ReAct loop (or subgraph) —
// the signatures and AgentResult shape are frozen here so downstream
// consumers (Coordinator synth, UI blocks) don't have to change.

import type { AgentResult, AgentTaskSpec } from "../../types/workflow";

export interface AgentContext {
  userText: string;
  providerId: string;
  model: string;
  sessionId: string;
  /** Outputs from previously-completed sub-agents in the same dispatch. */
  priorResults: AgentResult[];
  /** System context (exchange status, memory index, etc). */
  systemContext: string;
}

export interface SubAgent {
  readonly name: string;        // identifier used in Plan approach rows
  readonly description: string; // one-line role, shown in agent config UI
  run(spec: AgentTaskSpec, ctx: AgentContext): Promise<AgentResult>;
}

// ── Stub factory: simulate work + emit mock findings ────────
//
// All stubs share the same shape so Phase 2 can focus on substance,
// not plumbing. mockFindings/summary are intentionally generic — the
// point is to exercise the UI pipeline end-to-end.

function stubAgent(name: string, description: string, runMs: number): SubAgent {
  return {
    name,
    description,
    async run(spec, _ctx): Promise<AgentResult> {
      await sleep(runMs);
      return {
        agent: name,
        summary: mockSummary(name, spec.task),
        findings: mockFindings(name),
        confidence: 0.55 + Math.random() * 0.35,
        toolTrace: [],
      };
    },
  };
}

function mockSummary(agent: string, task: string): string {
  const preview = task.length > 40 ? task.slice(0, 40) + "…" : task;
  switch (agent) {
    case "Analyst":
      return `趋势面偏多：RSI 68、MACD 金叉成立、4h EMA20>EMA50。(stub: ${preview})`;
    case "NewsAgent":
      return `近 24h 无重大利空；ETF 资金面持续流入。(stub: ${preview})`;
    case "Risk":
      return `当前账户敞口 30%，距风控阈值 60% 还有空间。建议加仓 ≤ 0.1 BTC。(stub: ${preview})`;
    default:
      return `stub result for ${agent}: ${preview}`;
  }
}

function mockFindings(agent: string): Record<string, unknown> {
  switch (agent) {
    case "Analyst":
      return { trend: "bullish", rsi: 68, macd: "golden_cross", conviction: 0.62 };
    case "NewsAgent":
      return { sentiment: "neutral_positive", flow_7d_usd: 1.8e9 };
    case "Risk":
      return { exposure_pct: 0.30, suggested_add_btc: 0.1, veto: false };
    default:
      return {};
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Registry ────────────────────────────────────────────────

const REGISTRY: Record<string, SubAgent> = {
  Analyst:   stubAgent("Analyst",   "技术面分析（K 线、指标、趋势）", 1400),
  NewsAgent: stubAgent("NewsAgent", "消息面与资金流聚合", 1800),
  Risk:      stubAgent("Risk",      "仓位、敞口与风控阈值校验", 1100),
};

/** Case-insensitive lookup. Returns undefined if agent unknown. */
export function getAgent(name: string): SubAgent | undefined {
  if (REGISTRY[name]) return REGISTRY[name];
  const lc = name.toLowerCase();
  return Object.values(REGISTRY).find((a) => a.name.toLowerCase() === lc);
}

export function listAgents(): SubAgent[] {
  return Object.values(REGISTRY);
}
