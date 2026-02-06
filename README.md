# Bitget Perp Trading Core (Architecture Extract)

This repo contains the **core architecture** for a Bitget **USDT-margined perpetual** (currently BTC) auto-trading system:

- **Signal → Cycle → TradePlan v1 → Executor → Guard**
- **Dry-run**, **idempotency**, and **audit logs**
- Strategy logic is swappable (v2/v3/v5), while execution + risk control stays stable.

> Note: this README intentionally avoids OpenClaw-specific setup. You can run this with any local model / scheduler. OpenClaw can still be used as an optional orchestrator.

---

## 0. What is in here?

### Core scripts (architecture)
- `scripts/run-perp-cycle.js`
  - Runs a market signal script + (optional) news gating
  - Outputs a **TradePlan v1** JSON payload

- `scripts/bitget-perp-autotrade.js` (Executor)
  - Reads TradePlan v1 from stdin
  - Applies risk controls + idempotency
  - Places a real Bitget perp order (or dry-run)
  - Writes state + jsonl logs

- `scripts/bitget-perp-position-guard.js` (Guard)
  - Runs periodically
  - If a position exists, manages exits (TP/SL / trailing / timeout) and reconciles if exchange closed it

- `scripts/perp-engine.js`
  - Convenience wrapper: `run-perp-cycle.js` → feed JSON to `bitget-perp-autotrade.js`

### Strategy / signal scripts (swappable)
- `scripts/market-perp-signal-v2.js`
- `scripts/market-perp-signal-v3.js`
- `scripts/market-perp-signal-v5.js`

### Docs
- `memory/PERP-ARCHITECTURE.md` — architecture overview
- `memory/perp-tradeplan.v1.md` — TradePlan v1 spec
- `memory/perp-strategy-v5.json` — current strategy params (non-secret)

---

## 1. Requirements

- Node.js (>= 18 recommended)
- Bitget API credentials (for live trading)
- `ccxt` (already in `package.json`)

Install:

```bash
npm install
```

---

## 2. Environment variables

Create `.env` (or export env vars in your runtime) with:

- `BITGET_API_KEY`
- `BITGET_API_SECRET`
- `BITGET_API_PASSPHRASE`

Optional:
- `OPENCLAW_WORKDIR` (any working directory; defaults to `process.cwd()`)

---

## 3. Config & state files

Executor/Guard use JSON files under `memory/` by default.

- Config (you edit):
  - `memory/bitget-perp-autotrade-config.json`
- State (system writes):
  - `memory/bitget-perp-autotrade-state.json`
- Logs (system appends):
  - `memory/bitget-perp-autotrade-trades.jsonl`
  - `memory/bitget-perp-autotrade-cycles.jsonl`

**Do not commit** state/log files. `.gitignore` is set up accordingly.

---

## 4. TradePlan v1 (interface)

The system standardizes strategy → execution with TradePlan v1:

```json
{
  "tradePlanVersion": 1,
  "cycleId": "<string>",
  "dryRun": false,
  "plan": {
    "symbol": "BTCUSDT",
    "side": "long",
    "level": "strong",
    "reason": "..."
  },
  "decision": {
    "blockedByNews": false,
    "newsReason": []
  }
}
```

Rules:
- Strategy is only allowed to output: `side`, `level`, `reason` (plus optional context).
- Execution config decides: symbol mapping, leverage, notional sizing, risk model, etc.

Details: see `memory/perp-tradeplan.v1.md`.

---

## 5. How to run (manual)

### 5.1 Run one cycle (signal → TradePlan)

```bash
PERP_SIGNAL=v5 node scripts/run-perp-cycle.js
```

### 5.2 Execute the TradePlan (live) via engine wrapper

```bash
PERP_SIGNAL=v5 node scripts/perp-engine.js
```

### 5.3 Dry-run (no order placed)

```bash
PERP_SIGNAL=v5 DRY_RUN=1 node scripts/perp-engine.js
```

### 5.4 Run position guard (should be scheduled)

```bash
node scripts/bitget-perp-position-guard.js
```

---

## 6. Scheduling (no OpenClaw required)

Use any scheduler:

- macOS/Linux cron:
  - Every 3 minutes: `PERP_SIGNAL=v5 node scripts/perp-engine.js`
  - Every 1 minute: `node scripts/bitget-perp-position-guard.js`

Important:
- The executor is **idempotent** per `cycleId+side+level+symbol`.
- The guard reconciles if the exchange already closed the position.

---

## 7. Safety checklist before enabling live

1) Confirm `memory/bitget-perp-autotrade-config.json`:
   - `enabled=true`
   - correct `symbol`, `marginMode`, `positionMode`, `leverage`
   - correct sizing (`order.notionalUSDT`) and risk controls

2) Start with `DRY_RUN=1` for 1–2 days, then flip to live.

3) Keep `maxDailyLossUSDT` conservative.

4) Always keep the guard running.

---

## 8. Repository hygiene

This repo intentionally ignores `memory/*.jsonl` and runtime state.
If you want to share strategy params, commit only:
- `memory/perp-strategy-*.json`
- `memory/PERP-ARCHITECTURE.md`
- `memory/perp-tradeplan.v1.md`

---

## 9. License / Disclaimer

This is an experimental trading system. Use at your own risk.

