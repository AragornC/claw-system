import { useLayoutEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { Session } from "../store/chatStore";
import { useChatStore } from "../store/chatStore";
import { useAgentStore } from "../store/agentStore";
import { useFeatureStore } from "../store/featureStore";
import "./SubHeader.css";

/* ── Line-art icons for agent config tabs ── */
const AGENT_ICONS: Record<string, React.ReactNode> = {
  analyst: <svg width={11} height={11} viewBox="0 0 14 14" fill="none"><polyline points="1,11 4,6 7,8 10,3 13,5" stroke="currentColor" strokeWidth={1.2} strokeLinecap="round" strokeLinejoin="round"/></svg>,
  quant:   <svg width={11} height={11} viewBox="0 0 14 14" fill="none"><path d="M5 1h4l1 3H4L5 1z" stroke="currentColor" strokeWidth={1.1} strokeLinejoin="round"/><path d="M4 4h6l1 8H3L4 4z" stroke="currentColor" strokeWidth={1.1} strokeLinejoin="round"/><line x1={5.5} y1={6.5} x2={8.5} y2={6.5} stroke="currentColor" strokeWidth={1} strokeLinecap="round"/></svg>,
  risk:    <svg width={11} height={11} viewBox="0 0 14 14" fill="none"><path d="M7 1L2 3.5v4C2 10.5 4.2 12.8 7 13c2.8-.2 5-2.5 5-5.5v-4L7 1z" stroke="currentColor" strokeWidth={1.2} strokeLinejoin="round"/></svg>,
  sentinel:<svg width={11} height={11} viewBox="0 0 14 14" fill="none"><circle cx={7} cy={7} r={2} stroke="currentColor" strokeWidth={1.2}/><circle cx={7} cy={7} r={4.5} stroke="currentColor" strokeWidth={1} strokeDasharray="2 1.5" fill="none"/></svg>,
  coordinator: <svg width={11} height={11} viewBox="0 0 14 14" fill="none"><circle cx={7} cy={7} r={5.5} stroke="currentColor" strokeWidth={1.2}/><circle cx={7} cy={7} r={1.5} fill="currentColor"/><line x1={7} y1={1.5} x2={7} y2={4} stroke="currentColor" strokeWidth={1.1}/><line x1={7} y1={10} x2={7} y2={12.5} stroke="currentColor" strokeWidth={1.1}/><line x1={1.5} y1={7} x2={4} y2={7} stroke="currentColor" strokeWidth={1.1}/><line x1={10} y1={7} x2={12.5} y2={7} stroke="currentColor" strokeWidth={1.1}/></svg>,
};
const IconAgentGeneric = () => (
  <svg width={11} height={11} viewBox="0 0 16 16" fill="none">
    <rect x={2} y={2} width={12} height={12} rx={3.5} stroke="currentColor" strokeWidth={1.2}/>
    <circle cx={5.8} cy={7} r={1} fill="currentColor"/>
    <circle cx={10.2} cy={7} r={1} fill="currentColor"/>
    <line x1={6} y1={10} x2={10} y2={10} stroke="currentColor" strokeWidth={1.2} strokeLinecap="round"/>
  </svg>
);
const IconSkillTab = () => (
  <svg width={11} height={11} viewBox="0 0 12 12" fill="none">
    <rect x={1} y={1} width={10} height={10} rx={2} stroke="currentColor" strokeWidth={1.1}/>
    <line x1={3.5} y1={6} x2={8.5} y2={6} stroke="currentColor" strokeWidth={1} strokeLinecap="round"/>
    <line x1={3.5} y1={4} x2={7} y2={4} stroke="currentColor" strokeWidth={1} strokeLinecap="round"/>
    <line x1={3.5} y1={8} x2={6.5} y2={8} stroke="currentColor" strokeWidth={1} strokeLinecap="round"/>
  </svg>
);
const IconFnTab = () => (
  <svg width={11} height={11} viewBox="0 0 12 12" fill="none">
    <circle cx={6} cy={6} r={5} stroke="currentColor" strokeWidth={1.1}/>
    <text x={6} y={8.5} textAnchor="middle" fontSize={7} fill="currentColor" fontFamily="var(--font-mono)">f</text>
  </svg>
);
// Feature tab icon — a "factor / formula node" mark: input lines feeding a
// boxed compute step. Monochrome line art, matches the rest of the SubHeader.
const IconFeatureTab = () => (
  <svg width={11} height={11} viewBox="0 0 12 12" fill="none">
    <rect x={3.5} y={3.5} width={5} height={5} rx={1} stroke="currentColor" strokeWidth={1.1}/>
    <line x1={1} y1={5} x2={3.5} y2={5} stroke="currentColor" strokeWidth={1} strokeLinecap="round"/>
    <line x1={1} y1={7} x2={3.5} y2={7} stroke="currentColor" strokeWidth={1} strokeLinecap="round"/>
    <line x1={8.5} y1={6} x2={11} y2={6} stroke="currentColor" strokeWidth={1} strokeLinecap="round"/>
  </svg>
);

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

  const openViews       = useAgentStore(useShallow(s => s.openViews));
  const activeView      = useAgentStore(s => s.activeView);
  const setAgentView    = useAgentStore(s => s.setActiveView);
  const closeAgentView  = useAgentStore(s => s.closeView);

  // Feature tabs — one per feature opened from the sidebar.
  const features        = useFeatureStore(useShallow(s => s.features));
  const featureTabSlugs = useFeatureStore(useShallow(s => s.openTabSlugs));
  const activeTabSlug   = useFeatureStore(s => s.activeTabSlug);
  const setActiveTab    = useFeatureStore(s => s.setActiveTab);
  const closeFeatureTab = useFeatureStore(s => s.closeTab);

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
    .filter(s => (s.items || []).length > 0)
    .filter(s => {
      if (!histSearch) return true;
      const q = histSearch.toLowerCase();
      return s.name.toLowerCase().includes(q) ||
        (s.items || []).some(m => 'text' in m && (m as {text:string}).text.toLowerCase().includes(q));
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);

  const historyGroups = groupByDate(historySessions);

  return (
    <div className="subheader">
      {/* 中：文件 tabs */}
      <div className="subheader-tabs">
        {/* Feature tabs — opened from sidebar 特征库 */}
        {featureTabSlugs.map((slug) => {
          const meta = features.find((f) => f.slug === slug);
          const label = meta?.display_name || slug;
          // Feature tab is "active" iff its slug is the foreground feature.
          // Settings tab presence no longer suppresses this — App routing
          // gives features priority when activeTabSlug is set.
          const isActive = activeTabSlug === slug;
          return (
            <div
              key={slug}
              className={`sh-tab ${isActive ? "active" : ""}`}
              onClick={() => {
                // Activate the feature tab without closing Settings — the
                // App-level routing (activeTabSlug takes priority) decides
                // what's actually rendered. Also clear any active agent
                // sub-view so we don't end up showing AgentDetail content
                // inside what's now meant to be a feature workspace.
                setAgentView(null);
                setActiveTab(slug);
              }}
              title={slug}
            >
              <span className="sh-tab-icon"><IconFeatureTab /></span>
              {label}
              <span
                className="sh-tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  closeFeatureTab(slug);
                }}
              >×</span>
            </div>
          );
        })}
        {showSettings && (
          <div
            className={`sh-tab ${activeTabSlug === null ? "active" : ""}`}
            onClick={() => {
              // Bring Settings to the foreground by clearing whatever
              // feature was active. activeView (agent sub-view) stays as-is.
              setActiveTab(null);
            }}
          >
            <span className="sh-tab-icon">
              <svg width="11" height="11" viewBox="0 0 20 20" fill="none">
                <path d="M10 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
                <path d="M16.2 10c0-.34-.03-.67-.08-1l1.57-1.23a.4.4 0 0 0 .09-.5l-1.49-2.57a.4.4 0 0 0-.48-.17l-1.85.74a7.4 7.4 0 0 0-1.73-1L12 2.42A.4.4 0 0 0 11.6 2H8.4a.4.4 0 0 0-.4.42l-.23 1.85a7.4 7.4 0 0 0-1.73 1l-1.85-.74a.4.4 0 0 0-.48.17L2.22 7.27a.39.39 0 0 0 .09.5L3.88 9c-.05.33-.08.66-.08 1s.03.67.08 1l-1.57 1.23a.4.4 0 0 0-.09.5l1.49 2.57c.1.18.31.25.48.17l1.85-.74c.53.39 1.11.72 1.73 1l.23 1.85c.04.23.24.42.4.42h3.2c.18 0 .36-.19.4-.42l.23-1.85a7.4 7.4 0 0 0 1.73-1l1.85.74c.18.08.38 0 .48-.17l1.49-2.57a.39.39 0 0 0-.09-.5L16.12 11c.05-.33.08-.66.08-1Z" stroke="currentColor" strokeWidth="1.6"/>
              </svg>
            </span>
            设置
            <span
              className="sh-tab-close"
              onClick={(e) => {
                e.stopPropagation();
                onCloseSettings?.();
              }}
            >×</span>
          </div>
        )}
        {!showSettings && openViews.map(view => {
          const isActive = activeView?.type === view.type && activeView?.id === view.id;
          return (
            <div
              key={`${view.type}:${view.id}`}
              className={`sh-tab sh-tab-agentcfg ${isActive ? "active" : ""}`}
              onClick={() => setAgentView(view)}
            >
              <span className="sh-tab-icon sh-tab-agentcfg-icon">
                {view.type === "agent" && (AGENT_ICONS[view.id] ?? <IconAgentGeneric />)}
                {view.type === "skill" && <IconSkillTab />}
                {view.type === "fn" && <IconFnTab />}
              </span>
              {view.id}
              <span
                className="sh-tab-close"
                onMouseDown={e => e.stopPropagation()}
                onClick={e => { e.stopPropagation(); closeAgentView(view); }}
              >×</span>
            </div>
          );
        })}
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
                          <span className="sha-history-count">{(s.items || []).length} 条</span>
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
