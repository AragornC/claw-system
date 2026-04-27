import { useState, useEffect, useRef } from "react";
import type { ThinkingItem } from "../../types/workflow";

interface Props {
  item: ThinkingItem;
  isActive: boolean;
}

export default function ThinkingBlock({ item, isActive }: Props) {
  const [open, setOpen] = useState(!item.collapsed);
  const startRef = useRef(Date.now());
  const [elapsed, setElapsed] = useState(item.durationMs || 0);

  // Live timer while active
  useEffect(() => {
    if (!isActive) {
      if (item.durationMs > 0) setElapsed(item.durationMs);
      return;
    }
    const timer = setInterval(() => {
      setElapsed(Date.now() - startRef.current);
    }, 200);
    return () => clearInterval(timer);
  }, [isActive, item.durationMs]);

  // Auto-collapse when store says collapsed
  useEffect(() => {
    if (item.collapsed) setOpen(false);
  }, [item.collapsed]);

  const secs = Math.round(elapsed / 1000);
  const title = isActive
    ? "Thinking"
    : secs < 3
      ? "Thought briefly"
      : `Thought for ${secs} seconds`;

  return (
    <div className="thinking-block">
      <div className="thinking-header" onClick={() => setOpen((o) => !o)}>
        <span className={`thinking-arrow ${open ? "open" : ""}`}>›</span>
        <span className="thinking-title">{title}</span>
        {isActive && <span className="thinking-dot" />}
        {isActive && <span className="thinking-time">{secs}s</span>}
      </div>
      {open && (
        <div className="thinking-body">
          <div className="thinking-content">
            {item.text || (isActive ? "..." : "(empty)")}
          </div>
        </div>
      )}
    </div>
  );
}
