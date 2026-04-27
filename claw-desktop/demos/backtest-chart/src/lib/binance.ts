// Binance klines fetcher. Public spot endpoint, no auth, no proxy.
//
// Returns Lightweight-Charts-shaped candles (time = unix seconds), so the
// chart can `setData(...)` directly. We also keep a parallel `closes[]`
// since most feature math operates on closes only.

export interface Candle {
  /** Unix seconds — Lightweight Charts UTC convention. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type Interval = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";

const SPOT = "https://api.binance.com/api/v3";

/**
 * Fetch up to N candles, paginating Binance's 1500-per-call cap automatically.
 * `lookbackMs` controls how far back we go; we walk backward from now.
 */
export async function fetchKlines(
  symbol: string,
  interval: Interval,
  lookbackMs: number,
): Promise<Candle[]> {
  const endTime = Date.now();
  const startTime = endTime - lookbackMs;
  const out: Candle[] = [];
  let cursor = startTime;

  // Binance returns at most 1500 rows per call. Loop until we cover the range.
  // Each iteration advances `cursor` to the last bar's close + 1ms.
  for (let i = 0; i < 20 && cursor < endTime; i++) {
    const url = `${SPOT}/klines?symbol=${symbol}&interval=${interval}&startTime=${cursor}&endTime=${endTime}&limit=1500`;
    const r = await fetch(url);
    if (!r.ok) {
      const body = await r.text();
      throw new Error(`Binance HTTP ${r.status}: ${body.slice(0, 200)}`);
    }
    const rows = (await r.json()) as unknown[][];
    if (rows.length === 0) break;
    for (const row of rows) {
      out.push({
        time: Math.floor((row[0] as number) / 1000),
        open: Number(row[1]),
        high: Number(row[2]),
        low: Number(row[3]),
        close: Number(row[4]),
        volume: Number(row[5]),
      });
    }
    const lastOpenMs = rows[rows.length - 1][0] as number;
    cursor = lastOpenMs + intervalMs(interval);
    if (rows.length < 1500) break;
  }

  // Dedup by time (defensive — pagination boundaries should already be clean).
  const seen = new Set<number>();
  return out.filter((c) => {
    if (seen.has(c.time)) return false;
    seen.add(c.time);
    return true;
  });
}

function intervalMs(iv: Interval): number {
  switch (iv) {
    case "1m": return 60_000;
    case "5m": return 5 * 60_000;
    case "15m": return 15 * 60_000;
    case "1h": return 60 * 60_000;
    case "4h": return 4 * 60 * 60_000;
    case "1d": return 24 * 60 * 60_000;
  }
}

export const RANGE_PRESETS: { label: string; ms: number; defaultInterval: Interval }[] = [
  { label: "最近 7 天", ms: 7 * 24 * 60 * 60_000, defaultInterval: "1h" },
  { label: "最近 30 天", ms: 30 * 24 * 60 * 60_000, defaultInterval: "1h" },
  { label: "最近 90 天", ms: 90 * 24 * 60 * 60_000, defaultInterval: "4h" },
  { label: "最近 1 年", ms: 365 * 24 * 60 * 60_000, defaultInterval: "1d" },
];
