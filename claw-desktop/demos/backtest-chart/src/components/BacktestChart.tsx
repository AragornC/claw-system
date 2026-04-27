// Two stacked Lightweight Charts:
//   - main pane: candles + MA20 + MA60 + buy/sell markers
//   - sub  pane: ma20-ma60 spread (the "feature value" over time)
//
// We use two separate chart instances and sync their time scales so they
// pan/zoom together. v4 doesn't have first-class panes; this is the
// idiomatic workaround and is what most exchanges ship.

import { useEffect, useRef } from "react";
import {
  createChart,
  CrosshairMode,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type LogicalRange,
  type SeriesMarker,
  type Time,
} from "lightweight-charts";
import type { Candle } from "../lib/binance";
import type { FeatureSeries } from "../lib/feature";

interface Props {
  candles: Candle[];
  feature: FeatureSeries | null;
}

export default function BacktestChart({ candles, feature }: Props) {
  const mainRef = useRef<HTMLDivElement>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const mainChart = useRef<IChartApi | null>(null);
  const subChart = useRef<IChartApi | null>(null);
  const candleSeries = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const ma20Series = useRef<ISeriesApi<"Line"> | null>(null);
  const ma60Series = useRef<ISeriesApi<"Line"> | null>(null);
  const spreadSeries = useRef<ISeriesApi<"Line"> | null>(null);

  // ── Mount: create both charts + wire time-scale sync ──────────────
  useEffect(() => {
    if (!mainRef.current || !subRef.current) return;

    const baseOpts = {
      layout: {
        background: { color: "#0d1117" },
        textColor: "#8b949e",
        fontFamily: "SF Mono, Menlo, monospace",
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.04)" },
        horzLines: { color: "rgba(255,255,255,0.04)" },
      },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        borderColor: "rgba(255,255,255,0.08)",
      },
      rightPriceScale: { borderColor: "rgba(255,255,255,0.08)" },
      crosshair: { mode: CrosshairMode.Normal },
    };

    const main = createChart(mainRef.current, {
      ...baseOpts,
      height: mainRef.current.clientHeight,
      width: mainRef.current.clientWidth,
    });
    const sub = createChart(subRef.current, {
      ...baseOpts,
      height: subRef.current.clientHeight,
      width: subRef.current.clientWidth,
      timeScale: { ...baseOpts.timeScale, visible: false },
    });

    mainChart.current = main;
    subChart.current = sub;

    candleSeries.current = main.addCandlestickSeries({
      upColor: "#3cc87a",
      downColor: "#e85d4d",
      wickUpColor: "#3cc87a",
      wickDownColor: "#e85d4d",
      borderVisible: false,
    });
    ma20Series.current = main.addLineSeries({
      color: "#6da4ff",
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      title: "MA20",
    });
    ma60Series.current = main.addLineSeries({
      color: "#e8a84a",
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      title: "MA60",
    });
    spreadSeries.current = sub.addLineSeries({
      color: "#9c8cff",
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: true,
      title: "MA20−MA60",
    });
    // Zero baseline on the sub pane — visual anchor for cross detection.
    spreadSeries.current.createPriceLine({
      price: 0,
      color: "rgba(255,255,255,0.18)",
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: false,
      title: "",
    });

    // ── Sync time scales bidirectionally without recursion ──────────
    let syncing = false;
    const sync = (from: IChartApi, to: IChartApi) =>
      (range: LogicalRange | null) => {
        if (syncing || !range) return;
        syncing = true;
        to.timeScale().setVisibleLogicalRange(range);
        // Defer reset so the inverse handler from `to` doesn't re-enter.
        queueMicrotask(() => { syncing = false; });
        // Reference `from` so TS doesn't drop it as unused.
        void from;
      };
    main.timeScale().subscribeVisibleLogicalRangeChange(sync(main, sub));
    sub.timeScale().subscribeVisibleLogicalRangeChange(sync(sub, main));

    // ── Resize observer — keep both charts filling their containers ──
    const ro = new ResizeObserver(() => {
      if (mainRef.current) {
        main.applyOptions({
          width: mainRef.current.clientWidth,
          height: mainRef.current.clientHeight,
        });
      }
      if (subRef.current) {
        sub.applyOptions({
          width: subRef.current.clientWidth,
          height: subRef.current.clientHeight,
        });
      }
    });
    ro.observe(mainRef.current);
    ro.observe(subRef.current);

    return () => {
      ro.disconnect();
      main.remove();
      sub.remove();
      mainChart.current = null;
      subChart.current = null;
    };
  }, []);

  // ── Update data when candles / feature change ─────────────────────
  useEffect(() => {
    if (!candleSeries.current || !ma20Series.current || !ma60Series.current || !spreadSeries.current) return;
    if (candles.length === 0) return;

    candleSeries.current.setData(
      candles.map((c) => ({
        time: c.time as Time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
    );

    if (feature) {
      const ma20Data = feature.ma20
        .map((v, i) => (v == null ? null : { time: candles[i].time as Time, value: v }))
        .filter((p): p is { time: Time; value: number } => p != null);
      const ma60Data = feature.ma60
        .map((v, i) => (v == null ? null : { time: candles[i].time as Time, value: v }))
        .filter((p): p is { time: Time; value: number } => p != null);
      const spreadData = feature.spread
        .map((v, i) => (v == null ? null : { time: candles[i].time as Time, value: v }))
        .filter((p): p is { time: Time; value: number } => p != null);

      ma20Series.current.setData(ma20Data);
      ma60Series.current.setData(ma60Data);
      spreadSeries.current.setData(spreadData);

      const markers: SeriesMarker<Time>[] = feature.signals.map((s) => ({
        time: s.time as Time,
        position: s.kind === "buy" ? "belowBar" : "aboveBar",
        shape: s.kind === "buy" ? "arrowUp" : "arrowDown",
        color: s.kind === "buy" ? "#3cc87a" : "#e85d4d",
        text: s.kind === "buy" ? "金叉" : "死叉",
      }));
      candleSeries.current.setMarkers(markers);
    } else {
      ma20Series.current.setData([]);
      ma60Series.current.setData([]);
      spreadSeries.current.setData([]);
      candleSeries.current.setMarkers([]);
    }

    mainChart.current?.timeScale().fitContent();
  }, [candles, feature]);

  return (
    <div className="bc-stack">
      <div ref={mainRef} className="bc-main" />
      <div ref={subRef} className="bc-sub" />
    </div>
  );
}
