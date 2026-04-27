// Demo feature: MA(20) / MA(60) cross.
//
// Two simple moving averages over closing price. Output:
//   - ma20[t] / ma60[t] — overlay lines on the main chart
//   - spread[t] = ma20[t] - ma60[t] — sub-pane line, the "feature value"
//   - signals: 金叉 (spread crosses 0 upward) → buy marker
//              死叉 (spread crosses 0 downward) → sell marker
//
// Time-series semantics: feature is evaluated at every candle close, looking
// only backward — no future leakage. This is the model real features will
// follow when we plug them into the Pyodide pipeline.

import type { Candle } from "./binance";

export const FAST_PERIOD = 20;
export const SLOW_PERIOD = 60;

export interface Signal {
  /** Unix seconds matching the candle time. */
  time: number;
  /** "buy" = golden cross (ma20 crosses above ma60); "sell" = death cross. */
  kind: "buy" | "sell";
  /** Close price at the bar where the cross was detected (for marker label). */
  price: number;
}

export interface FeatureSeries {
  /** Aligned 1-1 with `candles`; first (period-1) entries are null. */
  ma20: (number | null)[];
  ma60: (number | null)[];
  /** ma20 - ma60. Null until both MAs have warmed up. */
  spread: (number | null)[];
  /** Cross events. */
  signals: Signal[];
}

export function computeFeature(candles: Candle[]): FeatureSeries {
  const closes = candles.map((c) => c.close);
  const ma20 = sma(closes, FAST_PERIOD);
  const ma60 = sma(closes, SLOW_PERIOD);
  const spread: (number | null)[] = ma20.map((v, i) => {
    const w = ma60[i];
    if (v == null || w == null) return null;
    return v - w;
  });

  const signals: Signal[] = [];
  for (let i = 1; i < spread.length; i++) {
    const prev = spread[i - 1];
    const curr = spread[i];
    if (prev == null || curr == null) continue;
    if (prev <= 0 && curr > 0) {
      signals.push({ time: candles[i].time, kind: "buy", price: candles[i].close });
    } else if (prev >= 0 && curr < 0) {
      signals.push({ time: candles[i].time, kind: "sell", price: candles[i].close });
    }
  }

  return { ma20, ma60, spread, signals };
}

/** Simple Moving Average — null for indices < period-1 so series stays
 *  aligned with the input length (chart libs prefer parallel arrays). */
function sma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  out[period - 1] = sum / period;
  for (let i = period; i < values.length; i++) {
    sum += values[i] - values[i - period];
    out[i] = sum / period;
  }
  return out;
}
