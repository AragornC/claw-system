import { useRef } from "react";
import "./Sidebar.css";

const FEATURES = [
  { name: "volatility_prediction", cat: "波动类", status: "done" },
  { name: "dead_cross_risk", cat: "风控类", status: "done" },
  { name: "macd_momentum", cat: "动量类", status: "running" },
  { name: "volume_breakout", cat: "成交量类", status: "idle" },
  { name: "trend_strength", cat: "趋势类", status: "idle" },
];

const STRATEGIES = [
  { name: "均线交叉策略", active: true },
  { name: "波动率套利", active: false },
  { name: "动量跟随", active: false },
];

interface Props {
  width: number;
  onResize: (w: number) => void;
}

export default function Sidebar({ width, onResize }: Props) {
  const dragging = useRef(false);

  function onMouseDown() {
    dragging.current = true;
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      onResize(Math.max(160, Math.min(400, e.clientX)));
    };
    const onUp = () => { dragging.current = false; window.removeEventListener("mousemove", onMove); };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp, { once: true });
  }

  return (
    <aside className="sidebar" style={{ width }}>
      <div className="sidebar-inner">
        {/* 特征列表 */}
        <div className="sidebar-section">
          <div className="sidebar-section-head">
            <span>特征库</span>
            <button className="section-add">+</button>
          </div>
          {FEATURES.map((f) => (
            <div key={f.name} className="sidebar-item">
              <span className={`item-status ${f.status}`} />
              <div className="item-info">
                <div className="item-name">{f.name}</div>
                <div className="item-meta">{f.cat}</div>
              </div>
            </div>
          ))}
        </div>

        {/* 策略列表 */}
        <div className="sidebar-section">
          <div className="sidebar-section-head">
            <span>策略</span>
            <button className="section-add">+</button>
          </div>
          {STRATEGIES.map((s) => (
            <div key={s.name} className={`sidebar-item ${s.active ? "active" : ""}`}>
              <span className="item-status" style={{ background: s.active ? "#3cc87a" : undefined }} />
              <div className="item-info">
                <div className="item-name">{s.name}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 拖拽调宽手柄 */}
      <div className="sidebar-resizer" onMouseDown={onMouseDown} />
    </aside>
  );
}
