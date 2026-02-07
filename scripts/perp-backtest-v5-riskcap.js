#!/usr/bin/env node
/**
 * perp-backtest-v5-riskcap.js
 * Wraps perp-backtest-v5 logic by re-running and then applying daily loss cap logic on the trades list.
 *
 * We reuse the JSON output file tmp/perp-backtest-v5-<DAYS>d.json created by perp-backtest-v5.js.
 */

import fs from 'node:fs';
import path from 'node:path';

const DAYS = Number(process.env.DAYS || 180);
const DAILY_LOSS_CAP = Number(process.env.DAILY_LOSS_CAP || 4);
const TZ = 'Asia/Shanghai';

function dateCN(tsMs) {
  return new Date(tsMs).toLocaleDateString('sv-SE', { timeZone: TZ });
}

function main() {
  const p = path.join(process.cwd(), 'tmp', `perp-backtest-v5-${DAYS}d.json`);
  if (!fs.existsSync(p)) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'missing_tmp_backtest_json', path: p }, null, 2));
    return;
  }
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  const trades = Array.isArray(j.trades) ? j.trades : [];

  let equity = Number(process.env.START_EQUITY || 20);
  let peak = equity;
  let maxDD = 0;

  let totalPnl = 0;
  let taken = 0;
  let skipped = 0;

  let day = null;
  let dayPnl = 0;
  let halted = false;

  for (const t of trades) {
    const exitTs = Number(t.exitTs);
    if (!Number.isFinite(exitTs)) continue;
    const d = dateCN(exitTs);
    if (day !== d) {
      day = d;
      dayPnl = 0;
      halted = false;
    }

    if (halted) {
      skipped += 1;
      continue;
    }

    const pnl = Number(t.pnl);
    if (!Number.isFinite(pnl)) continue;

    // apply trade
    totalPnl += pnl;
    equity += pnl;
    taken += 1;

    dayPnl += pnl;
    if (dayPnl <= -Math.abs(DAILY_LOSS_CAP)) {
      halted = true;
    }

    peak = Math.max(peak, equity);
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    days: DAYS,
    dailyLossCapUSDT: DAILY_LOSS_CAP,
    takenTrades: taken,
    skippedTrades: skipped,
    totalPnlUsdt: totalPnl,
    endEquityUSDT: equity,
    maxDrawdownUSDT: maxDD,
  }, null, 2));
}

main();
