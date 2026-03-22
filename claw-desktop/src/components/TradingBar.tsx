import "./TradingBar.css";

const POSITIONS = [
  { symbol: "BTC/USDT", side: "long",  size: "0.12 BTC", entry: "82,340", pnl: "+2.3%", pnlVal: "+$228" },
  { symbol: "ETH/USDT", side: "short", size: "1.5 ETH",  entry: "1,923",  pnl: "-0.8%", pnlVal: "-$23" },
];

const METRICS = [
  { label: "今日收益",   value: "+$205",  positive: true  },
  { label: "总持仓价值", value: "$12,450", positive: null  },
  { label: "可用余额",   value: "$8,320",  positive: null  },
  { label: "胜率(7d)",  value: "63.2%",   positive: true  },
  { label: "最大回撤",   value: "4.1%",   positive: false },
];

const SIGNALS = [
  { symbol: "BTC/USDT", signal: "死叉信号", feature: "dead_cross_risk", strength: 0.82, time: "2分钟前" },
  { symbol: "ETH/USDT", signal: "波动放大", feature: "volatility_pred", strength: 0.67, time: "8分钟前" },
];

export default function TradingBar() {
  return (
    <div className="trading-bar">
      {/* 实盘状态 */}
      <div className="tb-status-badge">
        <span className="tb-live-dot" />
        实盘运行中
      </div>

      {/* 核心指标 */}
      <div className="tb-metrics">
        {METRICS.map((m) => (
          <div key={m.label} className="tb-metric">
            <span className="tb-metric-label">{m.label}</span>
            <span className={`tb-metric-value ${m.positive === true ? "positive" : m.positive === false ? "negative" : ""}`}>
              {m.value}
            </span>
          </div>
        ))}
      </div>

      <div className="tb-divider" />

      {/* 持仓 */}
      <div className="tb-section">
        <div className="tb-section-label">持仓</div>
        <div className="tb-positions">
          {POSITIONS.map((p) => (
            <div key={p.symbol} className="tb-position">
              <span className="tb-pos-symbol">{p.symbol}</span>
              <span className={`tb-pos-side ${p.side}`}>{p.side === "long" ? "多" : "空"}</span>
              <span className="tb-pos-size">{p.size}</span>
              <span className="tb-pos-entry">@{p.entry}</span>
              <span className={`tb-pos-pnl ${p.pnl.startsWith("+") ? "positive" : "negative"}`}>
                {p.pnl} {p.pnlVal}
              </span>
              <button className="tb-pos-close">平仓</button>
            </div>
          ))}
        </div>
      </div>

      <div className="tb-divider" />

      {/* 近期信号 */}
      <div className="tb-section">
        <div className="tb-section-label">特征信号</div>
        <div className="tb-signals">
          {SIGNALS.map((s) => (
            <div key={s.symbol + s.signal} className="tb-signal">
              <span className="tb-sig-symbol">{s.symbol}</span>
              <span className="tb-sig-name">{s.signal}</span>
              <div className="tb-sig-bar-wrap">
                <div className="tb-sig-bar" style={{ width: `${s.strength * 100}%` }} />
              </div>
              <span className="tb-sig-strength">{Math.round(s.strength * 100)}%</span>
              <span className="tb-sig-time">{s.time}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
