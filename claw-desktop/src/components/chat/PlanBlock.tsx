import { useState, useEffect, useRef } from "react";
import type { PlanItem, Plan, ApproachStep } from "../../types/workflow";

interface Props {
  item: PlanItem;
  isActive: boolean;
}

// Plan block — matches docs/demos/ui-anim-coordinator.html exactly.
//
// Uses the same outer shell as CoordThinkingBlock (agent-card border,
// coord-header styling). Inside: three collapsible .plan-section blocks,
// each containing a .tool-preview card with a `plan.*` path strip header
// and .ln numbered lines for the content.
//
//   > Coordinator · Planned for 4.4 seconds · 3 subAgents · 2 steps · 3 checks
//   ┌─────────────────────────────────────────┐
//   │ Objective · 3 deliverables           ›  │
//   │  ┌─────────────────────────────────┐    │
//   │  │ plan.objective                  │    │
//   │  │   判断当前是否应该对 BTC 加仓…   │    │
//   │  │   结论须可直接交给执行层…        │    │
//   │  └─────────────────────────────────┘    │
//   │ Approach · 3 subAgents · 2 steps     ›  │
//   │  ┌─────────────────────────────────┐    │
//   │  │ plan.approach                   │    │
//   │  │ 1  [Step 1 · 并行]              │    │
//   │  │ 2    Analyst  判断趋势…          │    │
//   │  │ 3    NewsAgent 复盘情绪…         │    │
//   │  │ 4  [Step 2 · 串行] · 等 Step1…  │    │
//   │  │ 5    Risk  给出加仓建议…         │    │
//   │  └─────────────────────────────────┘    │
//   │ Verification · 3 checks              ›  │
//   │  ┌─────────────────────────────────┐    │
//   │  │ plan.verification               │    │
//   │  │ 1  Analyst 结论须标注置信度…     │    │
//   │  │ 2  Risk 建议必须包含止损位…      │    │
//   │  │ 3  NewsAgent 若超时…            │    │
//   │  └─────────────────────────────────┘    │
//   └─────────────────────────────────────────┘
export default function PlanBlock({ item, isActive }: Props) {
  const [open, setOpen] = useState(!item.collapsed);
  const startRef = useRef(Date.now());
  const [elapsed, setElapsed] = useState(item.durationMs || 0);

  useEffect(() => {
    if (!isActive) {
      if (item.durationMs > 0) setElapsed(item.durationMs);
      return;
    }
    const t = setInterval(() => setElapsed(Date.now() - startRef.current), 200);
    return () => clearInterval(t);
  }, [isActive, item.durationMs]);

  useEffect(() => {
    if (item.collapsed) setOpen(false);
  }, [item.collapsed]);

  const secs = (elapsed / 1000).toFixed(1).replace(/\.0$/, "");
  const done = item.phase === "done";

  // Accumulator tags mirror demo's planAccumulated: add them as each section lands.
  const tags: string[] = [];
  if (hasApproach(item.plan)) {
    const agentCount = countAgents(item.plan.approach);
    if (agentCount > 0) {
      tags.push(`${agentCount} subAgents`);
      tags.push(`${item.plan.approach.length} steps`);
    }
  }
  if (hasVerification(item.plan)) {
    tags.push(`${item.plan.verification.length} checks`);
  }

  const statusLabel = done ? `Planned for ${secs} seconds` : "Planning";

  return (
    <div className="coord-block plan-block">
      <div className="coord-header" onClick={() => setOpen((o) => !o)}>
        <span className={`coord-arrow ${open ? "open" : ""}`}>›</span>
        <span className="coord-title">
          <span className="agent">{item.agent}</span>
          <span className="sep">·</span>
          <span>{statusLabel}</span>
          {!done && <span className="cursor-dots" />}
          {tags.length > 0 && (
            <>
              <span className="brief-sep">·</span>
              <span className="brief-tag">{tags.join(" · ")}</span>
            </>
          )}
        </span>
      </div>

      {open && (
        <div className="coord-body">
          {hasObjective(item.plan) && (
            <PlanSection
              title="Objective"
              brief={item.plan.objective.kind || `${item.plan.objective.lines.length} deliverables`}
              defaultOpen
            >
              <div className="tool-preview open prose">
                <span className="path">plan.objective</span>
                <div className="code">
                  {item.plan.objective.lines.map((p, i) => (
                    <div key={i} className="ln">{p}</div>
                  ))}
                </div>
              </div>
            </PlanSection>
          )}

          {hasApproach(item.plan) && (
            <PlanSection
              title="Approach"
              brief={`${countAgents(item.plan.approach)} subAgents · ${item.plan.approach.length} steps`}
              defaultOpen
            >
              <div className="tool-preview open">
                <span className="path">plan.approach</span>
                <div className="code">
                  {flattenApproach(item.plan.approach).map((ln, i) => (
                    <div key={i} className={`ln ${ln.cls}`}>
                      {ln.kind === "step" ? (
                        <>
                          <span className="step-marker">[Step {ln.index} · {ln.mode}]</span>
                          {ln.cond && <span className="dim"> · {ln.cond}</span>}
                        </>
                      ) : (
                        <>
                          <span className="agent-cell">{ln.agent}</span>
                          <span className="dim">{ln.task}</span>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </PlanSection>
          )}

          {hasVerification(item.plan) && (
            <PlanSection
              title="Verification"
              brief={`${item.plan.verification.length} checks`}
              defaultOpen
            >
              <div className="tool-preview open">
                <span className="path">plan.verification</span>
                <div className="code">
                  {item.plan.verification.map((c, i) => (
                    <div key={i} className="ln dim">{c}</div>
                  ))}
                </div>
              </div>
            </PlanSection>
          )}
        </div>
      )}
    </div>
  );
}

// Collapsible section inside plan body. Arrow on the RIGHT (matches demo).
function PlanSection({
  title,
  brief,
  defaultOpen,
  children,
}: {
  title: string;
  brief: string;
  defaultOpen: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`plan-section ${open ? "open" : ""}`}>
      <div className="plan-section-head" onClick={() => setOpen((o) => !o)}>
        <span className="sec-title">{title}</span>
        <span className="sec-sep">·</span>
        <span className="sec-brief">{brief}</span>
        <span className={`sec-arrow ${open ? "open" : ""}`}>›</span>
      </div>
      {open && <div className="plan-section-body">{children}</div>}
    </div>
  );
}

// ── helpers ─────────────────────────────────────────────

type ApproachLine =
  | { kind: "step"; index: number; mode: string; cond?: string; cls: string }
  | { kind: "agent"; agent: string; task: string; cls: string };

function flattenApproach(steps: ApproachStep[]): ApproachLine[] {
  const out: ApproachLine[] = [];
  steps.forEach((s, i) => {
    out.push({ kind: "step", index: i + 1, mode: s.mode, cond: s.cond, cls: "step-line" });
    for (const it of s.items) {
      out.push({ kind: "agent", agent: it.agent, task: it.task, cls: "agent-line" });
    }
  });
  return out;
}

function hasObjective(p: Plan): boolean {
  return !!p.objective?.lines?.length;
}
function hasApproach(p: Plan): boolean {
  return !!p.approach?.length;
}
function hasVerification(p: Plan): boolean {
  return !!p.verification?.length;
}
function countAgents(steps: ApproachStep[]): number {
  const set = new Set<string>();
  for (const s of steps) for (const a of s.items) set.add(a.agent);
  return set.size;
}
