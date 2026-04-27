import { useEffect, useState } from "react";
import BacktestChart from "./components/BacktestChart";
import {
  fetchKlines,
  RANGE_PRESETS,
  type Candle,
  type Interval,
} from "./lib/binance";
import { computeFeature, FAST_PERIOD, SLOW_PERIOD, type FeatureSeries } from "./lib/feature";
import "./App.css";

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT"];
const INTERVALS: Interval[] = ["15m", "1h", "4h", "1d"];

export default function App() {
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [interval, setInterval] = useState<Interval>("1h");
  const [rangeIdx, setRangeIdx] = useState(1); // 默认 30 天
  const [candles, setCandles] = useState<Candle[]>([]);
  const [feature, setFeature] = useState<FeatureSeries | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Hover state — when mouse is over the chart we show the value at that
  // bar; otherwise show the latest. (Hookup to chart crosshair could come
  // later; for now we just show the latest.)
  const latestValues = (() => {
    if (!feature || candles.length === 0) return null;
    const last = candles.length - 1;
    return {
      time: candles[last].time,
      close: candles[last].close,
      ma20: feature.ma20[last],
      ma60: feature.ma60[last],
      spread: feature.spread[last],
    };
  })();

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const ms = RANGE_PRESETS[rangeIdx].ms;
      const cs = await fetchKlines(symbol, interval, ms);
      setCandles(cs);
      setFeature(computeFeature(cs));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  // Auto-fetch on first mount and whenever symbol/interval/range changes.
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, interval, rangeIdx]);

  return (
    <div className="app">
      <header className="hd">
        <div className="hd-title">
          MA Cross 回测 <span className="hd-sub">(demo · Lightweight Charts)</span>
        </div>
        <div className="hd-controls">
          <Select label="交易对" value={symbol} onChange={setSymbol} options={SYMBOLS} />
          <Select label="周期" value={interval} onChange={(v) => setInterval(v as Interval)} options={INTERVALS} />
          <Select
            label="区间"
            value={String(rangeIdx)}
            onChange={(v) => {
              const next = Number(v);
              setRangeIdx(next);
              // Bump interval to a sensible default when changing range
              setInterval(RANGE_PRESETS[next].defaultInterval);
            }}
            options={RANGE_PRESETS.map((p, i) => ({ value: String(i), label: p.label }))}
          />
          <button className="hd-btn" onClick={load} disabled={loading}>
            {loading ? "加载中…" : "▶ 重新回测"}
          </button>
        </div>
      </header>

      {error && <div className="banner banner-err">{error}</div>}

      <main className="main">
        <BacktestChart candles={candles} feature={feature} />
      </main>

      <footer className="ft">
        <Stat label="bars" value={candles.length} />
        <Stat label="signals" value={feature?.signals.length ?? 0} />
        {latestValues && (
          <>
            <Stat
              label={`MA${FAST_PERIOD}`}
              value={fmt(latestValues.ma20)}
              color="#6da4ff"
            />
            <Stat
              label={`MA${SLOW_PERIOD}`}
              value={fmt(latestValues.ma60)}
              color="#e8a84a"
            />
            <Stat
              label="spread"
              value={fmt(latestValues.spread, 2)}
              color={
                latestValues.spread != null
                  ? latestValues.spread > 0
                    ? "#3cc87a"
                    : "#e85d4d"
                  : undefined
              }
            />
            <Stat label="close" value={fmt(latestValues.close)} />
          </>
        )}
      </footer>
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value" style={color ? { color } : undefined}>
        {value}
      </span>
    </div>
  );
}

function fmt(v: number | null | undefined, dp = 2): string {
  if (v == null || Number.isNaN(v)) return "—";
  return v.toLocaleString("en-US", {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  });
}

interface SimpleSelectProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[] | { value: string; label: string }[];
}

function Select({ label, value, onChange, options }: SimpleSelectProps) {
  const opts = options.map((o) =>
    typeof o === "string" ? { value: o, label: o } : o,
  );
  return (
    <label className="ctl">
      <span className="ctl-label">{label}</span>
      <select
        className="ctl-select"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {opts.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
