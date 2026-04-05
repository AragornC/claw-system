import { useLayoutEffect, useRef, useState } from "react";
import type { Session } from "../store/chatStore";
import { useChatStore } from "../store/chatStore";
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
  showSettings?: boolean;
  onCloseSettings?: () => void;
}

function groupByDate(sessions: Session[]): { label: string; items: Session[] }[] {
  const now = Date.now();
  const DAY = 86400000;
  const today: Session[] = [];
  const yesterday: Session[] = [];
  const week: Session[] = [];
  const older: Session[] = [];

  for (const s of sessions) {
    const diff = now - s.updatedAt;
    if (diff < DAY) today.push(s);
    else if (diff < 2 * DAY) yesterday.push(s);
    else if (diff < 7 * DAY) week.push(s);
    else older.push(s);
  }

  const groups: { label: string; items: Session[] }[] = [];
  if (today.length > 0) groups.push({ label: "今天", items: today });
  if (yesterday.length > 0) groups.push({ label: "昨天", items: yesterday });
  if (week.length > 0) groups.push({ label: "本周", items: week });
  if (older.length > 0) groups.push({ label: "更早", items: older });
  return groups;
}

export default function SubHeader({ agentWidth, sessions, activeId, onSwitch, onNew, onClose, onReorder, onRename, showSettings, onCloseSettings }: Props) {
  const [showHistory, setShowHistory] = useState(false);
  const [draggingId, setDraggingId]   = useState<string | null>(null);
  const [liveOrder,  setLiveOrder]    = useState<Session[] | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [renamingId, setRenamingId]     = useState<string | null>(null);
  const [renameValue, setRenameValue]   = useState("");
  const [histSearch, setHistSearch]     = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);
  const histRef = useRef<HTMLDivElement>(null);

  const containerRef    = useRef<HTMLDivElement>(null);
  const liveRef         = useRef<Session[]>(sessions);
  const draggingIdRef   = useRef<string | null>(null);
  const mouseDownX      = useRef(0);
  const didDrag         = useRef(false);
  const tabEls          = useRef<Map<string, HTMLElement>>(new Map());
  const prevRects       = useRef<Map<string, number>>(new Map());

  const allSessions = useChatStore(s => s.sessions);

  const displayed = liveOrder ?? sessions;

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
      el.getBoundingClientRect();
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
    const s = sessions.find(s => s.id === id) ?? allSessions.find(s => s.id === id);
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

  function handleHistoryOpen(id: string) {
    useChatStore.getState().openTab(id);
    setShowHistory(false);
    setHistSearch("");
  }

  function handleHistoryDelete(id: string) {
    useChatStore.getState().deleteSession(id);
  }

  const historySessions = allSessions
    .filter(s => s.messages.length > 0)
    .filter(s => {
      if (!histSearch) return true;
      const q = histSearch.toLowerCase();
      return s.name.toLowerCase().includes(q) ||
        s.messages.some(m => m.text.toLowerCase().includes(q));
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);

  const historyGroups = groupByDate(historySessions);

  return (
    <div className="subheader">
      {/* 中：文件 tabs */}
      <div className="subheader-tabs">
        {FILE_TABS.map((t, i) => (
          <div key={i} className={`sh-tab ${!showSettings && i === 1 ? "active" : ""}`}>
            <span className="sh-tab-icon">⚡</span>
            {t}
            <span className="sh-tab-close">×</span>
          </div>
        ))}
        {showSettings && (
          <div className="sh-tab active">
            <span className="sh-tab-icon">
              <svg width="11" height="11" viewBox="0 0 20 20" fill="none">
                <path d="M10 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
                <path d="M16.2 10c0-.34-.03-.67-.08-1l1.57-1.23a.4.4 0 0 0 .09-.5l-1.49-2.57a.4.4 0 0 0-.48-.17l-1.85.74a7.4 7.4 0 0 0-1.73-1L12 2.42A.4.4 0 0 0 11.6 2H8.4a.4.4 0 0 0-.4.42l-.23 1.85a7.4 7.4 0 0 0-1.73 1l-1.85-.74a.4.4 0 0 0-.48.17L2.22 7.27a.39.39 0 0 0 .09.5L3.88 9c-.05.33-.08.66-.08 1s.03.67.08 1l-1.57 1.23a.4.4 0 0 0-.09.5l1.49 2.57c.1.18.31.25.48.17l1.85-.74c.53.39 1.11.72 1.73 1l.23 1.85c.04.23.24.42.4.42h3.2c.18 0 .36-.19.4-.42l.23-1.85a7.4 7.4 0 0 0 1.73-1l1.85.74c.18.08.38 0 .48-.17l1.49-2.57a.39.39 0 0 0-.09-.5L16.12 11c.05-.33.08-.66.08-1Z" stroke="currentColor" strokeWidth="1.6"/>
              </svg>
            </span>
            设置
            <span className="sh-tab-close" onClick={onCloseSettings}>×</span>
          </div>
        )}
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
          <div className="sha-history-wrap" ref={histRef}>
            <span className="sha-icon" title="历史对话" onClick={() => setShowHistory(v => !v)}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
                <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.2"/>
                <path d="M7 4.5V7L8.8 8.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </span>
            {showHistory && (
              <div className="sha-history-dropdown" onMouseLeave={() => { setShowHistory(false); setHistSearch(""); }}>
                <div className="sha-history-title">历史对话</div>
                <div className="sha-history-search-wrap">
                  <input
                    className="sha-history-search"
                    placeholder="搜索对话…"
                    value={histSearch}
                    onChange={e => setHistSearch(e.target.value)}
                    onMouseDown={e => e.stopPropagation()}
                    autoFocus
                  />
                </div>
                <div className="sha-history-list">
                  {historyGroups.length === 0 && (
                    <div className="sha-history-empty">
                      {histSearch ? "无匹配结果" : "暂无历史对话"}
                    </div>
                  )}
                  {historyGroups.map(g => (
                    <div key={g.label}>
                      <div className="sha-history-group">{g.label}</div>
                      {g.items.map(s => (
                        <div
                          key={s.id}
                          className={`sha-history-item ${s.id === activeId ? "sha-history-item-active" : ""}`}
                          onClick={() => handleHistoryOpen(s.id)}
                        >
                          <span className="sha-history-dot">●</span>
                          <span className="sha-history-name">{s.name}</span>
                          <span className="sha-history-count">{s.messages.length} 条</span>
                          <span
                            className="sha-history-delete"
                            title="删除"
                            onClick={(e) => { e.stopPropagation(); handleHistoryDelete(s.id); }}
                          >✕</span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
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
