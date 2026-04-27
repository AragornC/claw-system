// End-to-end smoke test for the feature runtime, run outside the Tauri
// webview so we can verify the Python launcher + thunderclaw package +
// _conv() conversion + seed feature logic without manual clicking.
//
// Strategy: load Pyodide in Node, register a JS host module that hits real
// Binance public endpoints (same shapes the Tauri host returns), inject
// the same Python wrapper used in worker.ts, then run the seed feature
// the same way runFeature() does.
//
// Run:  node scripts/test-feature-e2e.mjs

import { loadPyodide } from "../node_modules/pyodide/pyodide.mjs";

const FAPI = "https://fapi.binance.com";

// ─── Host implementations (mirror src/lib/python/host.ts shapes) ──────
async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.json();
}

// Python invokes these positionally — mirror the worker.ts wrapper signature.
async function market_price(symbol) {
  const d = await fetchJson(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`);
  return {
    symbol,
    price: Number(d.lastPrice),
    change_24h: `${d.priceChangePercent}%`,
  };
}

async function market_funding_rate(symbol, limit = 24) {
  const cur = await fetchJson(`${FAPI}/fapi/v1/premiumIndex?symbol=${symbol}`);
  const hist = await fetchJson(`${FAPI}/fapi/v1/fundingRate?symbol=${symbol}&limit=${limit}`);
  return {
    metric: "funding_rate",
    symbol,
    current: {
      rate: Number(cur.lastFundingRate),
      rate_pct: `${(Number(cur.lastFundingRate) * 100).toFixed(4)}%`,
      next_funding_time: cur.nextFundingTime,
    },
    history: hist.map((e) => ({
      time: e.fundingTime,
      rate: Number(e.fundingRate),
      rate_pct: `${(Number(e.fundingRate) * 100).toFixed(4)}%`,
    })),
  };
}

async function market_klines(symbol, interval = "1h", limit = 100) {
  const data = await fetchJson(
    `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`
  );
  return {
    symbol,
    interval,
    count: data.length,
    closes: data.map((c) => Number(c[4])),
  };
}

async function market_open_interest(symbol, period = "1h", limit = 24) {
  const cur = await fetchJson(`${FAPI}/fapi/v1/openInterest?symbol=${symbol}`);
  const hist = await fetchJson(
    `${FAPI}/futures/data/openInterestHist?symbol=${symbol}&period=${period}&limit=${limit}`
  );
  return {
    metric: "open_interest",
    symbol,
    period,
    current: { oi_contracts: Number(cur.openInterest), oi_value_usd: 0 },
    history: hist.map((e) => ({
      time: e.timestamp,
      oi: Number(e.sumOpenInterest),
      oi_value_usd: Number(e.sumOpenInterestValue),
    })),
  };
}

async function market_long_short_ratio(symbol, period = "1h", limit = 24) {
  const url = `${FAPI}/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=${period}&limit=${limit}`;
  const data = await fetchJson(url);
  const latest = data[data.length - 1] ?? {};
  return {
    metric: "long_short_ratio",
    symbol,
    period,
    global_account: {
      time: latest.timestamp,
      ratio: Number(latest.longShortRatio),
      long_pct: Number(latest.longAccount),
      short_pct: Number(latest.shortAccount),
    },
  };
}

// ─── Same Python wrapper shipped in worker.ts ──────────────────────────
const PY_WRAPPER = `
import sys, types
import _thunderclaw_host as _h

def _conv(v):
    if v is None:
        return None
    to_py = getattr(v, "to_py", None)
    if callable(to_py):
        return to_py()
    return v

_pkg = types.ModuleType("thunderclaw")

class _Market:
    async def price(self, symbol):
        return _conv(await _h.market_price(symbol))
    async def klines(self, symbol, interval="1h", limit=100):
        return _conv(await _h.market_klines(symbol, interval, limit))
    async def funding_rate(self, symbol, limit=24):
        return _conv(await _h.market_funding_rate(symbol, limit))
    async def open_interest(self, symbol, period="1h", limit=24):
        return _conv(await _h.market_open_interest(symbol, period, limit))
    async def long_short_ratio(self, symbol, period="1h", limit=24):
        return _conv(await _h.market_long_short_ratio(symbol, period, limit))

_pkg.market = _Market()
sys.modules["thunderclaw"] = _pkg
`;

// ─── Seed feature copied from src/store/featureStore.ts ────────────────
const SEED_CODE = `
import statistics
from thunderclaw import market

async def compute(symbol="BTCUSDT", lookback=24):
    data = await market.funding_rate(symbol, limit=lookback)
    history = data.get("history") or []
    rates = [h.get("rate") or 0.0 for h in history]
    if len(rates) < 3:
        return {"error": "not enough data", "n": len(rates)}
    mean = statistics.mean(rates)
    std = statistics.pstdev(rates)
    cur = rates[-1]
    z = (cur - mean) / std if std > 0 else 0.0
    if z > 2: signal = "long_crowded"
    elif z < -2: signal = "short_crowded"
    else: signal = "neutral"
    return {"symbol": symbol, "current": cur, "z_score": round(z, 2),
            "signal": signal, "mean": round(mean, 6), "std": round(std, 6)}
`;

// ─── runFeature() launcher copied from src/lib/features.ts ─────────────
const LAUNCHER = `
import json as _json, asyncio as _aio, traceback as _tb
_ns = {}
try:
    exec(_USER_CODE, _ns)
    _fn = _ns.get("compute")
    if _fn is None:
        _RESULT = {"__err__": "feature 必须定义 compute(...) 函数"}
    else:
        _ARGS = _json.loads(_ARGS_JSON)
        _coro = _fn(**_ARGS) if _aio.iscoroutinefunction(_fn) else None
        _RESULT = await _coro if _coro is not None else _fn(**_ARGS)
except Exception as e:
    _RESULT = {"__err__": _tb.format_exc()}
_RESULT
`;

// ─── Run ───────────────────────────────────────────────────────────────
console.log("loading pyodide…");
const pyodide = await loadPyodide({ indexURL: "./node_modules/pyodide/" });

pyodide.registerJsModule("_thunderclaw_host", {
  market_price,
  market_klines,
  market_funding_rate,
  market_open_interest,
  market_long_short_ratio,
});

console.log("registering thunderclaw wrapper…");
await pyodide.runPythonAsync(PY_WRAPPER);

console.log("running seed feature…");
pyodide.globals.set("_USER_CODE", SEED_CODE);
pyodide.globals.set("_ARGS_JSON", JSON.stringify({ symbol: "BTCUSDT", lookback: 24 }));
const raw = await pyodide.runPythonAsync(LAUNCHER);
const result = raw && typeof raw.toJs === "function"
  ? raw.toJs({ dict_converter: Object.fromEntries })
  : raw;

console.log("\n─── SEED RESULT ────────────────────────────────");
console.log(JSON.stringify(JSON.parse(JSON.stringify(result)), null, 2));

if (result && result.__err__) {
  console.error("\n❌ FAILED");
  process.exit(1);
}
if (!result || typeof result.z_score !== "number") {
  console.error("\n❌ unexpected shape");
  process.exit(1);
}
console.log("\n✅ seed feature works end-to-end");
