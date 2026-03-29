import { useLayoutEffect, useRef, useState } from "react";
import type { Session } from "../App";
import "./SubHeader.css";

const FILE_TABS = ["特征生成任务", "均线死叉特征"];

interface Props {
  agentWidth: number;
  sessions: Session[];
  activeId: string;
  onSwitch: (id: string) => void;
  onNew: () => void;
  onClose: (id: string) => void;
  onReorder: (sessions: Session[]) => void;
  onRename: (id: string, name: string) => void;
}

export default function SubHeader({ agentWidth, sessions, activeId, onSwitch, onNew, onClose, onReorder, onRename }: Props) {
  const [showHistory, setShowHistory] = useState(false);
  const [draggingId, setDraggingId]   = useState<string | null>(null);
  const [liveOrder,  setLiveOrder]    = useState<Session[] | null>(null);
  // 右键菜单
  const [ctxMenu, setCtxMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  // 内联重命名
  const [renamingId, setRenamingId]     = useState<string | null>(null);
  const [renameValue, setRenameValue]   = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);

  const containerRef    = useRef<HTMLDivElement>(null);
  const liveRef         = useRef<Session[]>(sessions);
  const draggingIdRef   = useRef<string | null>(null);
  const mouseDownX      = useRef(0);
  const didDrag         = useRef(false);
  // FLIP: tabEl refs & previous rects
  const tabEls          = useRef<Map<string, HTMLElement>>(new Map());
  const prevRects       = useRef<Map<string, number>>(new Map());

  const displayed = liveOrder ?? sessions;

  // FLIP: after React re-renders new order, animate non-dragged tabs from old to new pos
  useLayoutEffect(() => {
    if (!liveOrder) return;
    tabEls.current.forEach((el, id) => {
      if (id === draggingIdRef.current) return;
      const prev = prevRects.current.get(id);
      if (prev === undefined) return;
      const curr = el.getBoundingClientRect().left;
      const dx = prev - curr;
      if (Math.abs(dx) < 1) return;
      el.style.transition = "none";
      el.style.transform  = `translateX(${dx}px)`;
      el.getBoundingClientRect(); // force reflow
      el.style.transition = "transform 0.15s ease";
      el.style.transform  = "";
    });
  }, [liveOrder]);

  function snapshotRects() {
    tabEls.current.forEach((el, id) => {
      prevRects.current.set(id, el.getBoundingClientRect().left);
    });
  }

  function onTabMouseDown(e: React.MouseEvent, id: string) {
    if ((e.target as HTMLElement).classList.contains("sha-agent-close")) return;
    e.preventDefault();
    mouseDownX.current = e.clientX;
    didDrag.current    = false;
    draggingIdRef.current = id;
    liveRef.current    = [...sessions];

    const onMove = (ev: MouseEvent) => {
      if (!didDrag.current && Math.abs(ev.clientX - mouseDownX.current) > 5) {
        didDrag.current = true;
        setDraggingId(id);
      }
      if (!didDrag.current || !containerRef.current) return;

      const tabs   = Array.from(containerRef.current.querySelectorAll<HTMLElement>("[data-sid]"));
      const mouseX = ev.clientX;
      const cur    = liveRef.current;
      const fromIdx = cur.findIndex(s => s.id === draggingIdRef.current);

      let toIdx = cur.length - 1;
      for (let i = 0; i < tabs.length; i++) {
        const rect = tabs[i].getBoundingClientRect();
        if (mouseX < rect.left + rect.width / 2) { toIdx = i; break; }
      }

      if (toIdx !== fromIdx) {
        snapshotRects();
        const next = [...cur];
        const [moved] = next.splice(fromIdx, 1);
        next.splice(toIdx, 0, moved);
        liveRef.current = next;
        setLiveOrder([...next]);
      }
    };

    const onUp = () => {
      document.body.style.userSelect = "";
      if (!didDrag.current) {
        onSwitch(id);
      } else {
        onReorder(liveRef.current);
      }
      setDraggingId(null);
      setLiveOrder(null);
      draggingIdRef.current = null;
      didDrag.current = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };

    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function onTabContextMenu(e: React.MouseEvent, id: string) {
    e.preventDefault();
    setCtxMenu({ id, x: e.clientX, y: e.clientY });
  }

  function startRename(id: string) {
    const s = sessions.find(s => s.id === id);
    if (!s) return;
    setRenamingId(id);
    setRenameValue(s.name);
    setCtxMenu(null);
    setTimeout(() => { renameInputRef.current?.select(); }, 0);
  }

  function commitRename() {
    if (renamingId && renameValue.trim()) {
      onRename(renamingId, renameValue.trim());
    }
    setRenamingId(null);
  }

  return (
    <div className="subheader">
      {/* 中：文件 tabs */}
      <div className="subheader-tabs">
        {FILE_TABS.map((t, i) => (
          <div key={i} className={`sh-tab ${i === 1 ? "active" : ""}`}>
            <span className="sh-tab-icon">⚡</span>
            {t}
            <span className="sh-tab-close">×</span>
          </div>
        ))}
        <button className="sh-tab-add">+</button>
      </div>

      {/* 右：agent session 操作区 */}
      <div className="subheader-agent" style={{ width: agentWidth }}>
        <div className="sha-resizer-placeholder" />
        <div className="sha-actions" ref={containerRef}>
          {displayed.map(s => (
            <div
              key={s.id}
              data-sid={s.id}
              ref={el => { if (el) tabEls.current.set(s.id, el); else tabEls.current.delete(s.id); }}
              className={`sha-agent-tab
                ${s.id === activeId ? "sha-agent-tab-active" : ""}
                ${s.id === draggingId ? "sha-agent-tab-dragging" : ""}`}
              onMouseDown={(e) => onTabMouseDown(e, s.id)}
              onContextMenu={(e) => onTabContextMenu(e, s.id)}
            >
              {renamingId === s.id ? (
                <input
                  ref={renameInputRef}
                  className="sha-rename-input"
                  value={renameValue}
                  onChange={e => setRenameValue(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={e => {
                    if (e.key === "Enter") commitRename();
                    if (e.key === "Escape") setRenamingId(null);
                  }}
                  onMouseDown={e => e.stopPropagation()}
                  autoFocus
                />
              ) : (
                <span className="sha-agent-label">{s.name}</span>
              )}
              <span className="sha-agent-close" title="关闭"
                onMouseDown={e => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); onClose(s.id); }}>×</span>
            </div>
          ))}
        </div>
        <div className="sha-right-icons">
          <span className="sha-icon" title="新建 Agent" onClick={onNew}>＋</span>
          <div className="sha-history-wrap">
            <span className="sha-icon" title="历史对话" onClick={() => setShowHistory(v => !v)}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
                <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.2"/>
                <path d="M7 4.5V7L8.8 8.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </span>
            {showHistory && (
              <div className="sha-history-dropdown" onMouseLeave={() => setShowHistory(false)}>
                <div className="sha-history-title">历史对话</div>
                {sessions.map(s => (
                  <div
                    key={s.id}
                    className={`sha-history-item ${s.id === activeId ? "sha-history-item-active" : ""}`}
                    onClick={() => { onSwitch(s.id); setShowHistory(false); }}
                  >
                    <span className="sha-history-dot">●</span>
                    {s.name}
                    <span className="sha-history-count">{s.messages.length} 条</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
      {/* 自定义右键菜单 */}
      {ctxMenu && (
        <div
          className="sha-ctx-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onMouseLeave={() => setCtxMenu(null)}
        >
          <div className="sha-ctx-item" onClick={() => startRename(ctxMenu.id)}>
            ✎ 重命名
          </div>
          <div className="sha-ctx-divider" />
          <div className="sha-ctx-item sha-ctx-danger" onClick={() => { onClose(ctxMenu.id); setCtxMenu(null); }}>
            ✕ 关闭
          </div>
        </div>
      )}
    </div>
  );
}
