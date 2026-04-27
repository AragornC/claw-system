import { useState, useEffect } from "react";
import type { AgentTaskItem } from "../../types/workflow";

interface Props {
  item: AgentTaskItem;
}

// Sub-agent work unit. Phase 1.5 stub: just shows agent + task + summary.
// Phase 2 will expand with nested thinking + tool trace.
export default function AgentTaskBlock({ item }: Props) {
  const [open, setOpen] = useState(!item.collapsed);

  useEffect(() => {
    if (item.collapsed) setOpen(false);
  }, [item.collapsed]);

  const secs = Math.round(item.durationMs / 1000);
  const statusLabel =
    item.status === "pending" ? "Queued" :
    item.status === "running" ? "Running…" :
    item.status === "error"   ? "Failed" :
    secs < 3                  ? "Done" :
                                `Done in ${secs}s`;

  return (
    <div className="agenttask-block">
      <div className="agenttask-header" onClick={() => setOpen((o) => !o)}>
        <span className={`agenttask-arrow ${open ? "open" : ""}`}>›</span>
        <span className="agenttask-title">
          <span className={`status-dot ${item.status}`} />
          <span className="agent">{item.agent}</span>
          <span className="sep">·</span>
          <span>{statusLabel}</span>
          {item.summary && item.status === "done" && (
            <>
              <span className="sep" style={{ margin: "0 8px" }}>·</span>
              <span style={{ color: "#8b949e", fontSize: 12 }}>
                {truncate(item.summary, 60)}
              </span>
            </>
          )}
        </span>
      </div>
      {open && (
        <div className="agenttask-body">
          <div className="task-line">{item.task}</div>
          {item.summary && (
            <div className="summary-line">{item.summary}</div>
          )}
          {item.result?.confidence != null && (
            <div style={{ marginTop: 4, color: "#484f58", fontSize: 11 }}>
              confidence: {(item.result.confidence * 100).toFixed(0)}%
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
