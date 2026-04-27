import { useState, useEffect } from "react";
import type { ToolGroupItem } from "../../types/workflow";
import ToolRow from "./ToolRow";

// Tool group — used by the simple_tool flow for the "Fetched data" /
// "Memory updated" expandable containers.
//
// Each row is a <ToolRow> (shared with CoordThinkingBlock): click the
// row to see the full call signature + args + result body.
export default function ToolGroupBlock({ item }: Props) {
  const [collapsed, setCollapsed] = useState(item.collapsed);

  useEffect(() => {
    if (item.collapsed && !collapsed) {
      setCollapsed(true);
    }
  }, [item.collapsed]);

  return (
    <div className="coord-block toolgroup-block">
      <div
        className="coord-header"
        onClick={() => setCollapsed((c) => !c)}
      >
        <span className={`coord-arrow ${collapsed ? "" : "open"}`}>›</span>
        <span className="coord-title">
          <span>{item.title}</span>
          {item.tools.length > 0 && (
            <>
              <span className="brief-sep">·</span>
              <span className="brief-tag">{item.tools.length} call{item.tools.length > 1 ? "s" : ""}</span>
            </>
          )}
        </span>
      </div>
      {!collapsed && (
        <div className="coord-body">
          {item.tools.length === 0 ? (
            <div className="coord-empty">… 执行中</div>
          ) : (
            item.tools.map((tc) => <ToolRow key={tc.id} tc={tc} />)
          )}
        </div>
      )}
    </div>
  );
}

interface Props {
  item: ToolGroupItem;
}
