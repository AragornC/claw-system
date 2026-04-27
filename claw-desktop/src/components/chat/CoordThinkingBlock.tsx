import { useState, useEffect, useRef } from "react";
import type { CoordThinkingItem } from "../../types/workflow";
import { toolDisplay, coordCounter } from "../../lib/tool-display";
import ToolRow from "./ToolRow";

interface Props {
  item: CoordThinkingItem;
  isActive: boolean;
}

// Coordinator's agent-card. Mirrors docs/demos/ui-anim-coordinator.html.
// Header + body; each body row is a shared <ToolRow> (same component the
// simple_tool flow uses so the detail UX stays consistent).
export default function CoordThinkingBlock({ item, isActive }: Props) {
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

  const counter = coordCounter(item.tools.map((tc) => toolDisplay(tc)));
  const secs = Math.round(elapsed / 1000);

  const statusLabel = isActive
    ? `Thinking`
    : secs < 3
      ? `Thought briefly`
      : `Thought for ${secs} seconds`;

  return (
    <div className="coord-block">
      <div className="coord-header" onClick={() => setOpen((o) => !o)}>
        <span className={`coord-arrow ${open ? "open" : ""}`}>›</span>
        <span className="coord-title">
          <span className="agent">{item.agent}</span>
          <span className="sep">·</span>
          <span>{statusLabel}</span>
          {isActive && <span className="cursor-dots" />}
          {counter && (
            <>
              <span className="brief-sep">·</span>
              <span className="brief-tag">{counter}</span>
            </>
          )}
        </span>
      </div>
      {open && (
        <div className="coord-body">
          {item.tools.length === 0 ? (
            <div className="coord-empty">… 准备调用工具</div>
          ) : (
            item.tools.map((tc) => <ToolRow key={tc.id} tc={tc} />)
          )}
        </div>
      )}
    </div>
  );
}
