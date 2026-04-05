import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import "./TradingBar.css";
import { useExchangeStore, EXCHANGE_IDS } from "../store/exchangeStore";

/* ═══ Types ═══ */
interface PositionItem {
  id: number;
  strat: string;
  sym: string;
  dir: "多" | "空";
  mode: "auto" | "semi" | "sug";
  entry: number;
  qty: number;
  signal: "BUY" | "SELL" | "HOLD";
  conf: number;
  pnl: number;
  reason: string;
}

type SortKey = "pnl" | "entry" | "sig";
type ViewMode = "card" | "list";
type TabId = "pnl" | "strat";

/* ═══ Seed data ═══ */
const INIT_ITEMS: PositionItem[] = [
  { id: 0, strat: "趋势跟随 V2", sym: "BTC", dir: "多", mode: "auto", entry: 82340, qty: 0.12, signal: "BUY",  conf: 82, pnl: 218,  reason: "突破 20 日高点，动量持续向上，仓位继续持有" },
  { id: 1, strat: "均值回归 α",  sym: "ETH", dir: "空", mode: "semi", entry: 1923,  qty: 1.5,  signal: "SELL", conf: 71, pnl: -38,  reason: "价格偏离均值 2.3σ，历史回归概率 71%" },
  { id: 2, strat: "突破追单 B",  sym: "SOL", dir: "多", mode: "sug",  entry: 138,   qty: 12.0, signal: "HOLD", conf: 58, pnl: 73,   reason: "震荡整理中，等待突破方向确认后入场" },
];

const DAILY_PNL = [40, 80, 120, 60, 100, 180, 130, 200, 160, 220, 190, 260, 220, 300, 280, 312];
const SORT_LABELS: Record<SortKey, string> = { pnl: "盈亏", entry: "入场价", sig: "信号" };

/* ═══ Helpers ═══ */
const sigColor = (s: string) => s === "BUY" ? "g" : s === "SELL" ? "r" : "y";
const dirColor = (d: string) => d === "多" ? "g" : "r";
const modeCls  = (m: string) => m === "auto" ? "auto" : m === "semi" ? "semi" : "sug";
const modeLbl  = (m: string) => m === "auto" ? "全自动" : m === "semi" ? "半自动" : "建议";
const fmtPnl   = (v: number) => (v >= 0 ? "+$" : "−$") + Math.abs(v).toFixed(0);
const sigCls   = (s: string) => s === "BUY" ? "buy" : s === "SELL" ? "sell" : "hold";

/* ═══ ConfRing ═══ */
function ConfRing({ conf }: { conf: number }) {
  const r = 10, cx = 14, cy = 14, circ = 2 * Math.PI * r;
  const arc = circ * conf / 100;
  const col = conf >= 70 ? "var(--g)" : conf >= 50 ? "var(--y)" : "var(--r)";
  return (
    <div className="tb-cring">
      <svg viewBox="0 0 28 28">
        <circle className="tb-ring-bg" cx={cx} cy={cy} r={r} strokeWidth={2.5} />
        <circle className="tb-ring-fg" cx={cx} cy={cy} r={r} stroke={col} strokeWidth={2.5}
          strokeDasharray={`${arc} ${circ}`} transform={`rotate(-90 ${cx} ${cy})`} opacity={0.9} />
        <text x={cx} y={cy + 1} textAnchor="middle" dominantBaseline="middle"
          style={{ fill: col, fontSize: 7, fontFamily: "var(--mono)", fontWeight: 700 }}>
          {conf}
        </text>
      </svg>
    </div>
  );
}

/* ═══ Sparkline (SVG path + gradient fill) ═══ */
function Sparkline({ data }: { data: number[] }) {
  const n = data.length;
  if (n < 2) return null;
  const W = 170, H = 32;
  const mn = Math.min(...data), mx = Math.max(...data), rng = mx - mn || 1;
  const pts = data.map((v, i) => [i / (n - 1) * W, H - (v - mn) / rng * (H - 4) - 2] as const);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  const fillD = `${d} L${W},${H} L0,${H} Z`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <defs>
        <linearGradient id="sparkGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#2ec97c" stopOpacity={0.2} />
          <stop offset="100%" stopColor="#2ec97c" stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={fillD} fill="url(#sparkGrad)" />
      <path d={d} stroke="#2ec97c" strokeWidth={1.5} fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* ═══ PnlPanel ═══ */
function PnlPanel({ pnl, pct, equity, winRate, maxDD, free, pnlHist, dailyPnl, hasExchange, refreshing, onRefresh }:
  { pnl: number; pct: number; equity: number; winRate: number; maxDD: number; free: number; pnlHist: number[]; dailyPnl: number[]; hasExchange: boolean; refreshing: boolean; onRefresh: () => void }) {
  const col = pnl >= 0 ? "var(--g)" : "var(--r)";
  const sign = pnl >= 0 ? "+" : "";
  const barMax = Math.max(...dailyPnl);

  if (!hasExchange) {
    return (
      <div className="tb-pnl-panel tb-no-exchange">
        <div className="tb-no-ex-icon">📊</div>
        <div className="tb-no-ex-title">未连接交易所</div>
        <div className="tb-no-ex-desc">在设置 → 交易 中配置 API Key，即可查看实时账户余额</div>
      </div>
    );
  }

  return (
    <div className="tb-pnl-panel">
      <div className="tb-pnl-main">
        <div>
          <div className="tb-pnl-big" style={{ color: col }}>{sign}${Math.abs(Math.round(pnl)).toLocaleString()}</div>
          <div className="tb-pnl-pct" style={{ color: col }}>{sign}{pct.toFixed(2)}%</div>
          <div className="tb-pnl-since">今日收益 (模拟)</div>
        </div>
        <div className="tb-spark-wrap" style={{ height: 38 }}>
          <Sparkline data={pnlHist} />
        </div>
      </div>

      <div className="tb-pnl-mid">
        <div className="tb-pnl-grid">
          <div className="k">稳定币余额</div>
          <div className="v" style={{ color: "var(--accent)" }}>
            ${equity.toLocaleString("en-US", { maximumFractionDigits: 2 })}
          </div>
          <div className="k">可用资金</div>
          <div className="v">${free.toLocaleString("en-US", { maximumFractionDigits: 2 })}</div>
          <div className="k">最大回撤</div><div className="v" style={{ color: "var(--r)" }}>{maxDD.toFixed(1)}%</div>
          <div className="k">胜率</div><div className="v">{Math.round(winRate)}%</div>
        </div>
        <button
          className="tb-refresh-btn"
          onClick={onRefresh}
          disabled={refreshing}
          title="刷新余额"
        >
          <svg width={12} height={12} viewBox="0 0 14 14" fill="none" style={{ transform: refreshing ? "rotate(360deg)" : undefined, transition: "transform 0.6s" }}>
            <path d="M12.5 7A5.5 5.5 0 1 1 7 1.5a5.5 5.5 0 0 1 4.24 2" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" />
            <path d="M11.5 1.5h3v3" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {refreshing ? "刷新中" : "刷新"}
        </button>
      </div>

      <div className="tb-pnl-right">
        <div className="caption">每日盈亏分布</div>
        <div className="tb-bar-chart">
          {dailyPnl.map((v, i) => (
            <span key={i} style={{
              height: Math.round(v / barMax * 34),
              background: i === dailyPnl.length - 1 ? "var(--g)" : "rgba(46,201,124,.35)",
            }} />
          ))}
        </div>
      </div>
    </div>
  );
}

/* ═══ CardPanel ═══ */
function CardPanel({ items }: { items: PositionItem[] }) {
  return (
    <div className="tb-cards-wrap">
      {items.map(d => (
        <div className={`tb-kcard ${sigCls(d.signal)}`} key={d.id}>
          <div className="tb-kc-top">
            <span className="tb-kc-strat" title={d.strat}>{d.strat}</span>
            <span className={`tb-mode ${modeCls(d.mode)}`}>{modeLbl(d.mode)}</span>
          </div>
          <div>
            <div className={`tb-kc-sym tb-${dirColor(d.dir)}`}>{d.sym}</div>
            <div className={`tb-kc-dir tb-${dirColor(d.dir)}`}>{d.dir} {d.qty}</div>
          </div>
          <div className="tb-kc-bot">
            <div><div className="k">入场</div><div className="v">{d.entry.toLocaleString()}</div></div>
            <div style={{ textAlign: "right" }}>
              <div className={`tb-kc-pnl tb-${d.pnl >= 0 ? "up" : "dn"}`}>{fmtPnl(d.pnl)}</div>
              <div className={`tb-kc-sig tb-${sigColor(d.signal)}`}>{d.signal}</div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ═══ ListPanel ═══ */
function ListPanel({ items, openId, onToggle, sortBy, onSort }:
  { items: PositionItem[]; openId: number; onToggle: (id: number) => void; sortBy: SortKey; onSort: (s: SortKey) => void }) {

  const sorted = useMemo(() => {
    const cpy = [...items];
    if (sortBy === "pnl") cpy.sort((a, b) => b.pnl - a.pnl);
    else if (sortBy === "entry") cpy.sort((a, b) => b.entry - a.entry);
    return cpy;
  }, [items, sortBy]);

  return (
    <div className="tb-strat-panel">
      <div className="tb-col-hd">
        <span />
        <span>策略</span>
        <span>标的</span>
        <span>方向</span>
        <span className={`sortable ${sortBy === "entry" ? "active" : ""}`} onClick={() => onSort("entry")}>
          {SORT_LABELS.entry}{sortBy === "entry" ? " ↓" : ""}
        </span>
        <span className={`sortable ${sortBy === "pnl" ? "active" : ""}`} onClick={() => onSort("pnl")} style={{ textAlign: "right" }}>
          {SORT_LABELS.pnl}{sortBy === "pnl" ? " ↓" : ""}
        </span>
        <span style={{ textAlign: "right" }}>持仓量</span>
        <span className={`sortable ${sortBy === "sig" ? "active" : ""}`} onClick={() => onSort("sig")} style={{ textAlign: "right" }}>
          {SORT_LABELS.sig}{sortBy === "sig" ? " ↓" : ""}
        </span>
        <span />
      </div>
      <div className="tb-rows-wrap">
        {sorted.map(d => {
          const isOpen = openId === d.id;
          return (
            <div key={d.id}>
              <div className={`tb-s-row ${sigCls(d.signal)} ${isOpen ? "open" : ""}`} onClick={() => onToggle(d.id)}>
                <div className={`tb-d-dot ${dirColor(d.dir)}`} />
                <div className="tb-c-name">{d.strat}</div>
                <div className={`tb-c-sym tb-${dirColor(d.dir)}`}>{d.sym}</div>
                <div className={`tb-c-dir tb-${dirColor(d.dir)}`}>{d.dir}</div>
                <div className="tb-c-entry">{d.entry.toLocaleString()}</div>
                <div className={`tb-c-pnl tb-${d.pnl >= 0 ? "up" : "dn"}`}>{fmtPnl(d.pnl)}</div>
                <div className="tb-c-entry" style={{ textAlign: "right" }}>{d.qty}</div>
                <div className={`tb-c-sig tb-${sigColor(d.signal)}`}>{d.signal}</div>
                <div className={`tb-chev ${isOpen ? "open" : ""}`}>›</div>
              </div>
              <div className={`tb-s-detail ${isOpen ? "open" : ""}`}>
                <ConfRing conf={d.conf} />
                <div className="tb-dg"><div className="k">模式</div><div className="v"><span className={`tb-mode ${modeCls(d.mode)}`}>{modeLbl(d.mode)}</span></div></div>
                <div className="tb-dg"><div className="k">持仓量</div><div className="v">{d.qty} {d.sym}</div></div>
                <div className="tb-dg"><div className="k">入场价</div><div className="v">{d.entry.toLocaleString()}</div></div>
                <div className="tb-dg"><div className="k">浮动盈亏</div><div className={`v tb-${d.pnl >= 0 ? "up" : "dn"}`}>{fmtPnl(d.pnl)}</div></div>
                <div className="tb-dg"><div className="k">信号依据</div><div className="tb-d-reason">{d.reason}</div></div>
                <div className="tb-d-actions">
                  <button className="tb-d-btn tb-btn-detail">详情</button>
                  <button className="tb-d-btn tb-btn-close">平仓</button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ═══ SVG icons for view toggle ═══ */
const IconList = () => (
  <svg width={13} height={13} viewBox="0 0 12 12" fill="none">
    <line x1={1} y1={3} x2={11} y2={3} stroke="currentColor" strokeWidth={1.1} strokeLinecap="round" />
    <line x1={1} y1={6} x2={11} y2={6} stroke="currentColor" strokeWidth={1.1} strokeLinecap="round" />
    <line x1={1} y1={9} x2={11} y2={9} stroke="currentColor" strokeWidth={1.1} strokeLinecap="round" />
  </svg>
);
const IconCard = () => (
  <svg width={13} height={13} viewBox="0 0 12 12" fill="none">
    <rect x={0.5} y={0.5} width={4.5} height={5} rx={1} stroke="currentColor" strokeWidth={1.1} />
    <rect x={7} y={0.5} width={4.5} height={5} rx={1} stroke="currentColor" strokeWidth={1.1} />
    <rect x={0.5} y={6.5} width={4.5} height={5} rx={1} stroke="currentColor" strokeWidth={1.1} />
    <rect x={7} y={6.5} width={4.5} height={5} rx={1} stroke="currentColor" strokeWidth={1.1} />
  </svg>
);

/* ═══ TradingBar (main export) ═══ */
export default function TradingBar({ onClose }: { onClose: () => void }) {
  const [activeTab, setActiveTab] = useState<TabId>("pnl");
  const [curView, setCurView] = useState<ViewMode>("card");
  const [openId, setOpenId] = useState(-1);
  const [sortBy, setSortBy] = useState<SortKey>("pnl");
  const [items, setItems] = useState<PositionItem[]>(INIT_ITEMS);
  const [pnl, setPnl] = useState(312);
  const [winRate, setWinRate] = useState(63);
  const [maxDD, setMaxDD] = useState(-4.2);
  const [pnlHist, setPnlHist] = useState<number[]>(() =>
    Array.from({ length: 24 }, (_, i) => 250 - 80 + i * 7 + (Math.random() - 0.5) * 18)
  );

  // Real exchange data
  const exAuth = useExchangeStore(s => s.auth);
  const exBalances = useExchangeStore(s => s.balances);
  const exLoading = useExchangeStore(s => s.loadingBalance);
  const refreshBalance = useExchangeStore(s => s.refreshBalance);

  const hasExchange = EXCHANGE_IDS.some(id => exAuth[id]?.connected);
  const equity = EXCHANGE_IDS.reduce((sum, id) => {
    if (exAuth[id]?.connected && exBalances[id]) return sum + (exBalances[id]?.total_usd ?? 0);
    return sum;
  }, 0);
  const free = EXCHANGE_IDS.reduce((sum, id) => {
    if (exAuth[id]?.connected && exBalances[id]) return sum + (exBalances[id]?.available_usd ?? 0);
    return sum;
  }, 0);
  const refreshing = EXCHANGE_IDS.some(id => exAuth[id]?.connected && exLoading[id]);

  const handleRefreshBalance = useCallback(() => {
    EXCHANGE_IDS.forEach(id => {
      if (exAuth[id]?.connected) refreshBalance(id);
    });
  }, [exAuth, refreshBalance]);

  const pnlRef = useRef(pnl);
  pnlRef.current = pnl;

  const tick = useCallback(() => {
    setItems(prev => prev.map(d => ({
      ...d,
      pnl: Math.round((d.pnl + (Math.random() - 0.44) * 5) * 10) / 10,
    })));
    setPnl(prev => prev + (Math.random() - 0.5) * 9);
    setWinRate(w => Math.max(50, Math.min(78, w + (Math.random() - 0.5) * 0.3)));
    setMaxDD(d => Math.max(-12, Math.min(-1, d + (Math.random() - 0.5) * 0.1)));
    setPnlHist(prev => {
      const next = [...prev, pnlRef.current];
      if (next.length > 32) next.shift();
      return next;
    });
  }, []);

  useEffect(() => {
    const id = setInterval(tick, 1100);
    return () => clearInterval(id);
  }, [tick]);

  const toggleDetail = useCallback((id: number) => {
    setOpenId(prev => prev === id ? -1 : id);
  }, []);

  const pct = equity > 0 ? (pnl / equity) * 100 : 0;

  return (
    <div className="trading-bar">
      {/* ═══ Header ═══ */}
      <div className="tb-hd">
        <div className={`tb-tab ${activeTab === "pnl" ? "active" : ""}`} onClick={() => setActiveTab("pnl")}>
          <span className="tb-tab-dot pnl" />收益
        </div>
        <div className={`tb-tab ${activeTab === "strat" ? "active" : ""}`} onClick={() => setActiveTab("strat")}>
          <span className="tb-tab-dot strat" />持仓策略
        </div>
        <div className="tb-spacer" />
        <div className="tb-hd-actions" style={{
          opacity: activeTab === "strat" ? 1 : 0,
          pointerEvents: activeTab === "strat" ? "auto" : "none",
        }}>
          <div className="tb-view-toggle">
            <div className="tb-vt-slider" style={{ left: curView === "card" ? 2 : 30 }} />
            <div
              className={`tb-vt-opt ${curView === "card" ? "active" : ""}`}
              onClick={() => setCurView("card")}
            >
              <IconCard />
            </div>
            <div
              className={`tb-vt-opt ${curView === "list" ? "active" : ""}`}
              onClick={() => setCurView("list")}
            >
              <IconList />
            </div>
          </div>
        </div>
        <button className="tb-icon-btn tb-close-btn" onClick={onClose} title="关闭工作台">
          <svg width={13} height={13} viewBox="0 0 12 12" fill="none">
            <line x1={2} y1={2} x2={10} y2={10} stroke="currentColor" strokeWidth={1.2} strokeLinecap="round" />
            <line x1={10} y1={2} x2={2} y2={10} stroke="currentColor" strokeWidth={1.2} strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {/* ═══ Body ═══ */}
      <div className="tb-body">
        <div className={`tb-panel ${activeTab === "pnl" ? "active" : ""}`}>
          <PnlPanel pnl={pnl} pct={pct} equity={equity} winRate={winRate} maxDD={maxDD}
            free={free} pnlHist={pnlHist} dailyPnl={DAILY_PNL}
            hasExchange={hasExchange} refreshing={refreshing} onRefresh={handleRefreshBalance} />
        </div>
        <div className={`tb-panel ${activeTab === "strat" ? "active" : ""}`}>
          {curView === "card"
            ? <CardPanel items={items} />
            : <ListPanel items={items} openId={openId} onToggle={toggleDetail} sortBy={sortBy} onSort={setSortBy} />}
        </div>
      </div>
    </div>
  );
}
