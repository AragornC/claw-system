import { useState, useCallback, useRef, type ReactNode } from "react";
import "./Sidebar.css";

/* ═══ Types ═══ */
type SidebarTab = "strategy" | "market" | "community" | "task";

interface FeatureItem {
  name: string;
  cat: string;
  status: "done" | "running" | "idle";
}

interface StrategyItem {
  name: string;
  status: "active" | "paused" | "draft";
}

interface MarketItem {
  sym: string;
  price: string;
  change: string;
  up: boolean;
}

interface CommunityPost {
  avatar: string;
  user: string;
  time: string;
  title: string;
  tags: string[];
  votes: number;
  comments: number;
  stars: number;
}

interface TaskItem {
  name: string;
  sub: string;
  status: "running" | "queued" | "done" | "failed";
  time?: string;
}

/* ═══ Demo data ═══ */
const FEATURES: FeatureItem[] = [
  { name: "volatility_prediction", cat: "波动类", status: "done" },
  { name: "dead_cross_risk", cat: "风控类", status: "done" },
  { name: "macd_momentum", cat: "动量类", status: "running" },
  { name: "volume_breakout", cat: "成交量类", status: "idle" },
  { name: "trend_strength", cat: "趋势类", status: "idle" },
];

const STRATEGIES: StrategyItem[] = [
  { name: "均线交叉策略", status: "active" },
  { name: "波动率套利", status: "paused" },
  { name: "动量跟随", status: "draft" },
];

const MARKET_ITEMS: MarketItem[] = [
  { sym: "BTC", price: "$82,340", change: "+2.4%", up: true },
  { sym: "ETH", price: "$1,923", change: "-1.2%", up: false },
  { sym: "SOL", price: "$138.2", change: "+5.1%", up: true },
  { sym: "BNB", price: "$586.4", change: "-0.3%", up: false },
  { sym: "DOGE", price: "$0.162", change: "+8.7%", up: true },
];

const COMMUNITY_POSTS: CommunityPost[] = [
  { avatar: "T", user: "@trader_mike", time: "2h", title: "基于 LSTM 的 BTC 波动率预测特征，胜率 73%", tags: ["ML", "波动率"], votes: 24, comments: 8, stars: 12 },
  { avatar: "A", user: "@alpha_gen", time: "5h", title: "均值回归策略 v3，支持 ETH/SOL 双标的", tags: ["策略", "回归"], votes: 41, comments: 15, stars: 28 },
  { avatar: "Q", user: "@quant_fox", time: "8h", title: "趋势强度指标，适配 15min K线", tags: ["趋势", "K线"], votes: 16, comments: 4, stars: 9 },
  { avatar: "Z", user: "@zero_hedge", time: "12h", title: "资金费率套利机器人策略模板", tags: ["套利", "模板"], votes: 33, comments: 11, stars: 20 },
];

const TASKS_RUNNING: TaskItem[] = [
  { name: "生成 MACD 动量特征", sub: "Agent 执行中 · 第 3/5 步", status: "running", time: "2m" },
  { name: "均线交叉策略 — 模拟盘", sub: "模拟交易运行中 · 2/10 单", status: "running", time: "15m" },
];
const TASKS_QUEUED: TaskItem[] = [
  { name: "回测 波动率套利策略", sub: "等待中 · 优先级 2", status: "queued" },
];
const TASKS_DONE: TaskItem[] = [
  { name: "生成 dead_cross_risk 特征", sub: "完成 · 12 分钟前", status: "done" },
  { name: "趋势跟随 V2 — 实盘上线", sub: "完成 · 1 小时前", status: "done" },
  { name: "RSI 特征生成", sub: "失败 · 回归测试不通过", status: "failed" },
];

const STRAT_STATUS_LABEL: Record<StrategyItem["status"], string> = {
  active: "运行中", paused: "暂停", draft: "草稿",
};
const STRAT_BADGE_CLS: Record<StrategyItem["status"], string> = {
  active: "green", paused: "muted", draft: "muted",
};

/* ═══ SVG Icons ═══ */
const ChevIcon = () => (
  <svg width={10} height={10} viewBox="0 0 10 10" fill="none">
    <path d="M3 2l4 3-4 3" stroke="currentColor" strokeWidth={1.2} strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const IconStrategy = () => (
  <svg width={16} height={16} viewBox="0 0 16 16" fill="none">
    <rect x={2} y={2} width={5} height={6} rx={1} stroke="currentColor" strokeWidth={1.2} />
    <rect x={9} y={2} width={5} height={6} rx={1} stroke="currentColor" strokeWidth={1.2} />
    <rect x={2} y={10} width={12} height={4} rx={1} stroke="currentColor" strokeWidth={1.2} />
  </svg>
);

const IconMarket = () => (
  <svg width={16} height={16} viewBox="0 0 16 16" fill="none">
    <polyline points="2,12 5,7 8,9 11,4 14,6" stroke="currentColor" strokeWidth={1.2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    <line x1={2} y1={14} x2={14} y2={14} stroke="currentColor" strokeWidth={1.1} strokeLinecap="round" />
  </svg>
);

const IconCommunity = () => (
  <svg width={16} height={16} viewBox="0 0 16 16" fill="none">
    <circle cx={8} cy={5} r={2.5} stroke="currentColor" strokeWidth={1.2} />
    <path d="M3 14c0-2.76 2.24-5 5-5s5 2.24 5 5" stroke="currentColor" strokeWidth={1.2} strokeLinecap="round" fill="none" />
  </svg>
);

const IconTask = () => (
  <svg width={16} height={16} viewBox="0 0 16 16" fill="none">
    <rect x={3} y={2} width={10} height={12} rx={1.5} stroke="currentColor" strokeWidth={1.2} />
    <line x1={6} y1={5.5} x2={11} y2={5.5} stroke="currentColor" strokeWidth={1} strokeLinecap="round" />
    <line x1={6} y1={8} x2={11} y2={8} stroke="currentColor" strokeWidth={1} strokeLinecap="round" />
    <line x1={6} y1={10.5} x2={9} y2={10.5} stroke="currentColor" strokeWidth={1} strokeLinecap="round" />
  </svg>
);

const IconSearch = () => (
  <svg width={14} height={14} viewBox="0 0 14 14" fill="none">
    <circle cx={5.8} cy={5.8} r={4} stroke="currentColor" strokeWidth={1.2} />
    <line x1={8.6} y1={8.6} x2={12} y2={12} stroke="currentColor" strokeWidth={1.2} strokeLinecap="round" />
  </svg>
);

const IconSearchSmall = () => (
  <svg width={12} height={12} viewBox="0 0 12 12" fill="none" style={{ flexShrink: 0 }}>
    <circle cx={5} cy={5} r={3.5} stroke="#4a6580" strokeWidth={1.1} />
    <line x1={7.5} y1={7.5} x2={10.5} y2={10.5} stroke="#4a6580" strokeWidth={1.1} strokeLinecap="round" />
  </svg>
);

const IconClose = () => (
  <svg width={10} height={10} viewBox="0 0 10 10" fill="none">
    <line x1={2} y1={2} x2={8} y2={8} stroke="currentColor" strokeWidth={1.1} strokeLinecap="round" />
    <line x1={8} y1={2} x2={2} y2={8} stroke="currentColor" strokeWidth={1.1} strokeLinecap="round" />
  </svg>
);

/* ═══ CollapsibleSection ═══ */
function CollapsibleSection({ label, hasPlus, collapsed, onToggle, children }: {
  label: string;
  hasPlus?: boolean;
  collapsed: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className={`sb-sec ${collapsed ? "collapsed" : ""}`}>
      <div className="sb-sec-hd" onClick={onToggle}>
        <span className="sb-chev"><ChevIcon /></span>
        <span className="sb-sec-label">{label}</span>
        {hasPlus && <button className="sb-plus" onClick={e => e.stopPropagation()}>+</button>}
      </div>
      <div className="sb-sec-body">{children}</div>
    </div>
  );
}

/* ═══ StrategyPanel ═══ */
function StrategyPanel({ collapsed, onToggle }: { collapsed: Set<string>; onToggle: (k: string) => void }) {
  return (
    <>
      <CollapsibleSection label="特征库" hasPlus collapsed={collapsed.has("特征库")} onToggle={() => onToggle("特征库")}>
        {FEATURES.map(f => (
          <div className={`sb-item ${f.name === "volatility_prediction" ? "active" : ""}`} key={f.name}>
            <span className={`sb-dot ${f.status}`} />
            <div className="sb-item-info">
              <div className="sb-name">{f.name}</div>
              <div className="sb-meta">{f.cat}</div>
            </div>
          </div>
        ))}
      </CollapsibleSection>
      <CollapsibleSection label="策略" hasPlus collapsed={collapsed.has("策略")} onToggle={() => onToggle("策略")}>
        {STRATEGIES.map(s => (
          <div className={`sb-item ${s.status === "active" ? "active" : ""}`} key={s.name}>
            <span className={`sb-dot ${s.status === "active" ? "active" : ""}`} />
            <div className="sb-item-info">
              <div className="sb-name">{s.name}</div>
            </div>
            <span className={`sb-badge ${STRAT_BADGE_CLS[s.status]}`}>{STRAT_STATUS_LABEL[s.status]}</span>
          </div>
        ))}
      </CollapsibleSection>
    </>
  );
}

/* ═══ MarketPanel ═══ */
function MarketPanel({ collapsed, onToggle }: { collapsed: Set<string>; onToggle: (k: string) => void }) {
  return (
    <>
      <CollapsibleSection label="关注列表" hasPlus collapsed={collapsed.has("关注列表")} onToggle={() => onToggle("关注列表")}>
        {MARKET_ITEMS.map(m => (
          <div className="sb-mkt" key={m.sym}>
            <span className="sb-mkt-sym">{m.sym}</span>
            <span className="sb-mkt-price">{m.price}</span>
            <span className={`sb-mkt-chg ${m.up ? "up" : "dn"}`}>{m.change}</span>
          </div>
        ))}
      </CollapsibleSection>
      <CollapsibleSection label="市场概览" collapsed={collapsed.has("市场概览")} onToggle={() => onToggle("市场概览")}>
        <div className="sb-stats">
          <div className="sb-stats-row"><span>24h 涨跌比</span><span style={{ color: "var(--accent)" }}>62% 涨</span></div>
          <div className="sb-stats-row"><span>BTC 主导</span><span style={{ color: "var(--text-primary)" }}>54.2%</span></div>
          <div className="sb-stats-row"><span>恐惧贪婪指数</span><span style={{ color: "var(--accent-gold)" }}>68 贪婪</span></div>
          <div className="sb-stats-row"><span>全网资金费率</span><span style={{ color: "var(--accent)" }}>+0.012%</span></div>
        </div>
      </CollapsibleSection>
    </>
  );
}

/* ═══ CommunityPanel ═══ */
function CommunityPanel({ collapsed, onToggle }: { collapsed: Set<string>; onToggle: (k: string) => void }) {
  const hot = COMMUNITY_POSTS.slice(0, 3);
  const latest = COMMUNITY_POSTS.slice(3);
  return (
    <>
      <CollapsibleSection label="热门推荐" collapsed={collapsed.has("热门推荐")} onToggle={() => onToggle("热门推荐")}>
        {hot.map(p => <CommunityCard key={p.user} post={p} />)}
      </CollapsibleSection>
      <CollapsibleSection label="最新发布" collapsed={collapsed.has("最新发布")} onToggle={() => onToggle("最新发布")}>
        {latest.map(p => <CommunityCard key={p.user} post={p} />)}
      </CollapsibleSection>
    </>
  );
}

function CommunityCard({ post: p }: { post: CommunityPost }) {
  return (
    <div className="sb-comm">
      <div className="sb-comm-top">
        <div className="sb-comm-avatar">{p.avatar}</div>
        <span className="sb-comm-user">{p.user} · {p.time}</span>
      </div>
      <div className="sb-comm-title">{p.title}</div>
      <div className="sb-comm-tags">
        {p.tags.map(t => <span className="sb-comm-tag" key={t}>{t}</span>)}
      </div>
      <div className="sb-comm-stat">
        <span>&#x2B06; {p.votes}</span>
        <span>&#x1F4AC; {p.comments}</span>
        <span>&#x2605; {p.stars}</span>
      </div>
    </div>
  );
}

/* ═══ TaskPanel ═══ */
function TaskPanel({ collapsed, onToggle }: { collapsed: Set<string>; onToggle: (k: string) => void }) {
  return (
    <>
      <CollapsibleSection label="进行中" collapsed={collapsed.has("进行中")} onToggle={() => onToggle("进行中")}>
        {TASKS_RUNNING.map(t => <TaskRow key={t.name} task={t} />)}
      </CollapsibleSection>
      <CollapsibleSection label="队列中" collapsed={collapsed.has("队列中")} onToggle={() => onToggle("队列中")}>
        {TASKS_QUEUED.map(t => <TaskRow key={t.name} task={t} />)}
      </CollapsibleSection>
      <CollapsibleSection label="已完成" collapsed={collapsed.has("已完成")} onToggle={() => onToggle("已完成")}>
        {TASKS_DONE.map(t => <TaskRow key={t.name} task={t} />)}
      </CollapsibleSection>
    </>
  );
}

function TaskRow({ task: t }: { task: TaskItem }) {
  const dotCls = t.status === "running" ? "running" : t.status === "failed" ? "failed" : t.status === "done" ? "done" : "";
  const faded = t.status === "done" || t.status === "failed";
  return (
    <div className={`sb-task ${faded ? "faded" : ""}`}>
      <div className="sb-task-icon">
        <span className={`sb-dot ${dotCls} ${t.status === "running" && t.sub.includes("模拟") ? "blue" : ""}`} style={{ width: 7, height: 7 }} />
      </div>
      <div className="sb-task-info">
        <div className="sb-task-name">{t.name}</div>
        <div className="sb-task-sub">{t.sub}</div>
      </div>
      {t.time && <span className="sb-task-time">{t.time}</span>}
      {t.status === "done" && <span className="sb-badge green">&#x2713;</span>}
      {t.status === "failed" && <span className="sb-badge red">&#x2717;</span>}
    </div>
  );
}

/* ═══ Tab config ═══ */
const TABS: { id: SidebarTab; icon: () => React.ReactNode; title: string }[] = [
  { id: "strategy", icon: IconStrategy, title: "策略管理" },
  { id: "market", icon: IconMarket, title: "大盘" },
  { id: "community", icon: IconCommunity, title: "社区" },
  { id: "task", icon: IconTask, title: "任务" },
];

/* ═══ Main Sidebar ═══ */
interface Props {
  width: number;
  onResize: (w: number) => void;
}

export default function Sidebar({ width, onResize }: Props) {
  const [activeTab, setActiveTab] = useState<SidebarTab>("strategy");
  const [showSearch, setShowSearch] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const dragging = useRef(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const toggleCollapsed = useCallback((key: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  const toggleSearch = useCallback(() => {
    setShowSearch(prev => {
      if (!prev) setTimeout(() => searchRef.current?.focus(), 0);
      return !prev;
    });
  }, []);

  function onMouseDown() {
    dragging.current = true;
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      onResize(Math.max(160, Math.min(400, e.clientX)));
    };
    const onUp = () => {
      dragging.current = false;
      window.removeEventListener("mousemove", onMove);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp, { once: true });
  }

  return (
    <aside className="sidebar" style={{ width }}>
      <div className="sidebar-inner">
        {/* Nav */}
        <div className="sb-nav">
          {TABS.map(t => (
            <button
              key={t.id}
              className={`sb-nav-btn ${activeTab === t.id ? "active" : ""}`}
              onClick={() => setActiveTab(t.id)}
              title={t.title}
            >
              <t.icon />
            </button>
          ))}
          <div style={{ flex: 1 }} />
          <button className="sb-nav-btn" onClick={toggleSearch} title="搜索">
            <IconSearch />
          </button>
        </div>

        {/* Search */}
        {showSearch && (
          <div className="sb-search">
            <IconSearchSmall />
            <input ref={searchRef} placeholder="搜索策略、特征、任务…" />
            <button className="sb-search-close" onClick={toggleSearch}>
              <IconClose />
            </button>
          </div>
        )}

        {/* Body */}
        <div className="sb-body">
          {activeTab === "strategy" && <StrategyPanel collapsed={collapsed} onToggle={toggleCollapsed} />}
          {activeTab === "market" && <MarketPanel collapsed={collapsed} onToggle={toggleCollapsed} />}
          {activeTab === "community" && <CommunityPanel collapsed={collapsed} onToggle={toggleCollapsed} />}
          {activeTab === "task" && <TaskPanel collapsed={collapsed} onToggle={toggleCollapsed} />}
        </div>
      </div>

      <div className="sidebar-resizer" onMouseDown={onMouseDown} />
    </aside>
  );
}
