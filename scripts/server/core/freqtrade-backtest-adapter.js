import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { normalizeLayerFramework } from "./strategy-layer-framework.js";
import { buildExternalSignalSnapshot } from "./signal-external-features.js";

function text(valueLike, fallback = "") {
  const s = String(valueLike ?? "").trim();
  return s || fallback;
}

function num(valueLike, fallback = 0) {
  const n = Number(valueLike);
  return Number.isFinite(n) ? n : Number(fallback || 0);
}

function clamp(valueLike, min, max, fallback = 0) {
  const n = num(valueLike, fallback);
  if (Number.isFinite(min) && n < min) return min;
  if (Number.isFinite(max) && n > max) return max;
  return n;
}

function normalizeArray(rowsLike) {
  return Array.isArray(rowsLike) ? rowsLike : [];
}

function normalizeBars(barsLike = []) {
  return normalizeArray(barsLike)
    .map((item) => {
      const row = item && typeof item === "object" ? item : {};
      const rawTs = Math.floor(num(row.time || row.ts || row.t || 0, 0));
      const time = rawTs > 9_999_999_999 ? Math.floor(rawTs / 1000) : rawTs;
      const open = num(row.open, NaN);
      const high = num(row.high, NaN);
      const low = num(row.low, NaN);
      const close = num(row.close, NaN);
      const volume = Math.max(0, num(row.volume, 0));
      if (!Number.isFinite(time) || time <= 0) return null;
      if (![open, high, low, close].every(Number.isFinite)) return null;
      return { time, open, high, low, close, volume };
    })
    .filter(Boolean)
    .sort((a, b) => a.time - b.time);
}

function buildDecisionSnapshot(layersLike = {}, barLike = {}, contextLike = {}) {
  const layers = layersLike && typeof layersLike === "object" ? layersLike : {};
  const context = contextLike && typeof contextLike === "object" ? contextLike : {};
  const bar = barLike && typeof barLike === "object" ? barLike : {};
  const open = num(bar.open, 0);
  const close = num(bar.close, open);
  const deltaPct = open > 0 ? ((close - open) / open) * 100 : 0;
  const externalSnapshot = buildExternalSignalSnapshot({
    featureRefs: layers.featureRefs || [],
    timeSec: num(bar.time, 0),
    contextText: [layers.signalLogic || "", contextLike.pair || "", contextLike.timeframe || ""].join(" | "),
  });
  return {
    signal: {
      signalType: text(layers.signalType || "composite"),
      signalLogic: text(layers.signalLogic || ""),
      longThreshold: num(layers.longThreshold, 0.55),
      shortThreshold: num(layers.shortThreshold, 0.45),
      observedDeltaPct: Number(deltaPct.toFixed(4)),
      externalSignalScore: num(externalSnapshot.externalSignalScore, 0),
      externalSignals: Array.isArray(externalSnapshot.externalSignals) ? externalSnapshot.externalSignals : [],
    },
    position: {
      maxPositions: Math.max(1, Math.floor(num(layers.maxPositions, 1))),
      leverageLimit: num(layers.leverageLimit, 3),
    },
    risk: {
      stopLossPct: num(layers.stopLossPct, 2.5),
      takeProfitPct: num(layers.takeProfitPct, 5.5),
      maxDrawdownPct: num(layers.maxDrawdownPct, 18),
      maxConsecutiveLoss: Math.max(1, Math.floor(num(layers.maxConsecutiveLoss, 3))),
    },
    execution: {
      orderMode: text(layers.orderMode || "market"),
      slippageBps: num(layers.slippageBps, 6),
      feeModel: text(layers.feeModel || "taker"),
    },
  };
}

function computeSimpleSummary(barsLike = [], layersLike = {}, contextLike = {}) {
  const bars = normalizeBars(barsLike);
  const layers = layersLike && typeof layersLike === "object" ? layersLike : {};
  if (bars.length < 2) {
    return {
      tradeCount: 0,
      winRate: 0,
      latestReturnPct: 0,
      maxDrawdownPct: 0,
      events: [],
      equityCurve: [],
      drawdownCurve: [],
    };
  }
  const events = [];
  const equityCurve = [];
  const drawdownCurve = [];
  let equity = 1;
  let peak = 1;
  let wins = 0;
  let losses = 0;
  for (let i = 1; i < bars.length; i += 1) {
    const prev = num(bars[i - 1].close, 0);
    const next = num(bars[i].close, 0);
    const ret = prev > 0 ? (next - prev) / prev : 0;
    const pnlPct = ret * 100;
    equity *= 1 + ret;
    if (pnlPct >= 0) wins += 1;
    else losses += 1;
    peak = Math.max(peak, equity);
    const drawdownPct = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
    equityCurve.push({ time: bars[i].time, equity: Number(equity.toFixed(6)) });
    drawdownCurve.push({ time: bars[i].time, drawdownPct: Number(drawdownPct.toFixed(6)) });
    events.push({
      tradeId: `sim_${i}`,
      time: bars[i].time,
      tradeType: pnlPct >= 0 ? "close" : "risk_trigger",
      price: Number(next.toFixed(6)),
      quantity: 1,
      fee: 0,
      slippageBps: 0,
      reasonRule: "freqtrade_adapter_simulation",
      pnlPct: Number(pnlPct.toFixed(6)),
      decisionSnapshot: buildDecisionSnapshot(layers, bars[i], context),
    });
  }
  const tradeCount = wins + losses;
  const latestReturnPct = (equity - 1) * 100;
  const maxDrawdownPct = drawdownCurve.reduce((acc, row) => Math.max(acc, num(row.drawdownPct, 0)), 0);
  return {
    tradeCount,
    winRate: tradeCount > 0 ? (wins / tradeCount) * 100 : 0,
    latestReturnPct,
    maxDrawdownPct,
    events,
    equityCurve,
    drawdownCurve,
  };
}

function buildFeatureCatalogFromParams(paramsLike = {}) {
  const params = paramsLike && typeof paramsLike === "object" ? paramsLike : {};
  const version = params.version && typeof params.version === "object" ? params.version : {};
  const locks = normalizeArray(version.lockedFeatureVersions);
  return locks.map((itemLike) => {
    const item = itemLike && typeof itemLike === "object" ? itemLike : {};
    const featureId = text(item.featureId || item.featureName || "");
    return {
      featureRef: featureId,
      featureName: text(item.featureName || featureId),
      featureId,
      featureVersion: text(item.featureVersion || "v1.0.0"),
      mainCategory: "custom",
      mainCategoryLabel: "自定义",
    };
  }).filter((item) => item.featureId);
}

function resolveRuntimeLayers(paramsLike = {}) {
  const params = paramsLike && typeof paramsLike === "object" ? paramsLike : {};
  const version = params.version && typeof params.version === "object" ? params.version : {};
  const framework = normalizeLayerFramework({
    signalLayer: version.signalLayer,
    positionLayer: version.positionLayer,
    riskLayer: version.riskLayer,
    executionLayer: version.executionLayer,
  });
  const signalLayer = framework.signalLayer;
  const positionLayer = framework.positionLayer;
  const riskLayer = framework.riskLayer;
  const executionLayer = framework.executionLayer;
  const signalParams = signalLayer.params && typeof signalLayer.params === "object" ? signalLayer.params : {};
  return {
    signalLayer,
    positionLayer,
    riskLayer,
    executionLayer,
    signalType: text(signalLayer.signalType || "composite", "composite"),
    signalLogic: text(signalLayer.signalLogic || "ema_fast > ema_slow", "ema_fast > ema_slow"),
    featureRefs: normalizeArray(signalLayer.featureRefs).map((v) => text(v || "")).filter(Boolean),
    stopLossPct: clamp(riskLayer.stopLossPct, 0.2, 80, 2.5),
    takeProfitPct: clamp(riskLayer.takeProfitPct, 0.2, 400, 5.5),
    maxDrawdownPct: clamp(riskLayer.maxDrawdownPct, 1, 95, 18),
    maxConsecutiveLoss: Math.max(1, Math.floor(num(riskLayer.maxConsecutiveLoss, 3))),
    leverageLimit: clamp(positionLayer.leverageLimit, 1, 125, 3),
    maxPositions: Math.max(1, Math.floor(num(positionLayer.maxPositions, 1))),
    orderMode: text(executionLayer.orderMode || "market", "market"),
    slippageBps: clamp(executionLayer.slippageBps, 0, 300, 6),
    feeModel: text(executionLayer.feeModel || "taker", "taker"),
    longThreshold: clamp(signalParams.longThreshold, 0.05, 1, 0.55),
    shortThreshold: clamp(signalParams.shortThreshold, 0.05, 1, 0.45),
  };
}

function normalizeFreqtradeResultToExecutionReport(rawLike = {}, contextLike = {}) {
  const raw = rawLike && typeof rawLike === "object" ? rawLike : {};
  const context = contextLike && typeof contextLike === "object" ? contextLike : {};
  const summary = raw.summary && typeof raw.summary === "object" ? raw.summary : {};
  const events = normalizeArray(raw.events);
  const equityCurve = normalizeArray(raw.equityCurve);
  const drawdownCurve = normalizeArray(raw.drawdownCurve);
  return {
    summary: {
      tradeCount: Math.max(0, Math.floor(num(summary.tradeCount, 0))),
      winRate: Number(clamp(summary.winRate, 0, 100, 0).toFixed(6)),
      latestReturnPct: Number(clamp(summary.latestReturnPct, -1000, 2000, 0).toFixed(6)),
      maxDrawdownPct: Number(clamp(summary.maxDrawdownPct, 0, 100, 0).toFixed(6)),
    },
    executionReport: {
      generatedAt: text(raw.generatedAt || new Date().toISOString(), new Date().toISOString()),
      timeframeDays: Math.max(1, Math.floor(num(context.rangeDays, 30))),
      engine: {
        name: text(raw.engineName || "freqtrade_v1_adapter", "freqtrade_v1_adapter"),
        mode: text(raw.engineMode || "backtest", "backtest"),
      },
      barsMeta: {
        count: Math.max(0, Math.floor(num(raw.barsCount, 0))),
        stepSec: Math.max(60, Math.floor(num(raw.stepSec, 3600))),
      },
      events,
      equityCurve,
      drawdownCurve,
      featureCatalog: normalizeArray(context.featureCatalog),
      backtestMeta: raw.backtestMeta && typeof raw.backtestMeta === "object" ? raw.backtestMeta : {},
    },
    raw,
  };
}


function resolvePythonCommand(freqtradeCommand) {
  const envPy = text(process.env.THUNDERCLAW_FREQTRADE_PYTHON || "").trim();
  if (envPy) return envPy;

  const cmd = text(freqtradeCommand || process.env.THUNDERCLAW_FREQTRADE_CMD || "freqtrade", "freqtrade");
  if (cmd.includes(path.sep)) {
    const candidate = path.join(path.dirname(cmd), process.platform === "win32" ? "python.exe" : "python");
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return "python3";
}

function buildFreqtradeWorkspace(paramsLike = {}) {
  const params = paramsLike && typeof paramsLike === "object" ? paramsLike : {};
  const bars = normalizeBars(params.bars);
  const pair = text(params.pair || params.symbol || "BTC/USDT", "BTC/USDT");
  const timeframe = text(params.timeframe || "1h", "1h");
  const exchange = text(params.exchange || process.env.THUNDERCLAW_FREQTRADE_EXCHANGE || "bitget", "bitget").toLowerCase();
  const layers = resolveRuntimeLayers(params);
  const httpsProxy = text(process.env.HTTPS_PROXY || process.env.https_proxy || "");
  const ccxtConfig = {};
  const ccxtAsyncConfig = {};
  if (httpsProxy) {
    ccxtConfig.httpsProxy = httpsProxy;
    ccxtAsyncConfig.httpsProxy = httpsProxy;
  }
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "thunderclaw-freqtrade-"));
  const userDir = path.join(workspace, "user_data");
  const strategyDir = path.join(userDir, "strategies");
  const dataDir = path.join(userDir, "data", exchange);
  fs.mkdirSync(strategyDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });

  const strategyCode = [
    "from freqtrade.strategy import IStrategy",
    "from pandas import DataFrame",
    "import talib.abstract as ta",
    "",
    "class ThunderClawStrategy(IStrategy):",
    `    timeframe = '${timeframe}'`,
    "    # Layer binding mirrors ThunderClaw strategy detail 4-layer config",
    `    minimal_roi = {'0': ${Math.max(0.001, layers.takeProfitPct / 100).toFixed(4)}}`,
    `    stoploss = -${Math.max(0.001, layers.stopLossPct / 100).toFixed(4)}`,
    "    startup_candle_count = 30",
    `    tc_signal_type = '${layers.signalType}'`,
    `    tc_signal_logic = ${JSON.stringify(layers.signalLogic)}`,
    `    tc_feature_refs = ${JSON.stringify(layers.featureRefs)}`,
    `    tc_runtime_meta = ${JSON.stringify({
      maxDrawdownPct: layers.maxDrawdownPct,
      maxConsecutiveLoss: layers.maxConsecutiveLoss,
      leverageLimit: layers.leverageLimit,
      maxPositions: layers.maxPositions,
      orderMode: layers.orderMode,
      slippageBps: layers.slippageBps,
      feeModel: layers.feeModel,
      longThreshold: layers.longThreshold,
      shortThreshold: layers.shortThreshold,
    })}`,
    "",
    "    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:",
    "        dataframe['ema_fast'] = ta.EMA(dataframe, timeperiod=12)",
    "        dataframe['ema_slow'] = ta.EMA(dataframe, timeperiod=26)",
    "        dataframe['atr'] = ta.ATR(dataframe, timeperiod=14)",
    "        return dataframe",
    "",
    "    def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:",
    "        dataframe.loc[(dataframe['ema_fast'] > dataframe['ema_slow']), 'enter_long'] = 1",
    "        return dataframe",
    "",
    "    def populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:",
    "        dataframe.loc[(dataframe['ema_fast'] < dataframe['ema_slow']), 'exit_long'] = 1",
    "        return dataframe",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(strategyDir, "ThunderClawStrategy.py"), strategyCode, "utf8");

  const config = {
    dry_run: true,
    timeframe,
    stake_currency: "USDT",
    stake_amount: "unlimited",
    max_open_trades: 1,
    trading_mode: "spot",
    margin_mode: "isolated",
    order_types: {
      entry: "limit",
      exit: "limit",
      emergency_exit: "market",
      force_entry: "market",
      force_exit: "market",
      stoploss: "market",
      stoploss_on_exchange: false,
    },
    entry_pricing: {
      price_side: "other",
      use_order_book: false,
      order_book_top: 1,
    },
    exit_pricing: {
      price_side: "other",
      use_order_book: false,
      order_book_top: 1,
    },
    unfilledtimeout: {
      entry: 10,
      exit: 10,
      unit: "minutes",
    },
    exchange: {
      name: exchange,
      key: "",
      secret: "",
      pair_whitelist: [pair],
      pair_blacklist: [],
      ccxt_config: ccxtConfig,
      ccxt_async_config: ccxtAsyncConfig,
    },
    pairlists: [{ method: "StaticPairList" }],
  };
  fs.writeFileSync(path.join(userDir, "config.json"), JSON.stringify(config, null, 2), "utf8");

  const pyRows = JSON.stringify(bars.map((b) => [b.time * 1000, b.open, b.high, b.low, b.close, b.volume]));
  const dataFile = `${pair.replace("/", "_")}-${timeframe}.feather`;
  const pyScript = [
    "import pandas as pd",
    `rows = ${pyRows}`,
    "df = pd.DataFrame(rows, columns=['date','open','high','low','close','volume'])",
    `df.to_feather(r'''${path.join(dataDir, dataFile)}''')`,
    "print('ok')",
  ].join("\n");
  const pyCommand = resolvePythonCommand(process.env.THUNDERCLAW_FREQTRADE_CMD || "freqtrade");
  const py = spawnSync(pyCommand, ["-c", pyScript], { encoding: "utf8", timeout: 120000 });
  if (py.status !== 0) {
    const err = new Error(`failed to write freqtrade feather data: ${text(py.stderr || py.stdout || "unknown")}`);
    err.code = "FREQTRADE_DATA_PREP_FAILED";
    throw err;
  }

  return { workspace, userDir, strategyDir, dataDir, pair, timeframe, barCount: bars.length, exchange };
}

function safeRmDir(targetPath) {
  try {
    fs.rmSync(targetPath, { recursive: true, force: true });
  } catch {}
}

export function createFreqtradeBacktestAdapter(deps = {}) {
  const command = text(deps.command || process.env.THUNDERCLAW_FREQTRADE_CMD || "freqtrade", "freqtrade");
  const enabled = text(deps.enabled || process.env.THUNDERCLAW_ENABLE_FREQTRADE || "").toLowerCase();

  function checkFreqtradeAvailable() {
    const probe = spawnSync(command, ["--version"], {
      stdio: "pipe",
      encoding: "utf8",
      timeout: 8_000,
    });
    if (probe.error || probe.status !== 0) {
      const err = new Error(`freqtrade unavailable: ${text(probe.error?.message || probe.stderr || probe.stdout || "unknown")}`);
      err.code = "FREQTRADE_UNAVAILABLE";
      throw err;
    }
    return text(probe.stdout || probe.stderr || "freqtrade");
  }

  function runRealFreqtradeBacktest(paramsLike = {}) {
    const ws = buildFreqtradeWorkspace(paramsLike);
    const args = [
      "backtesting",
      "--userdir", ws.userDir,
      "--config", path.join(ws.userDir, "config.json"),
      "--strategy", "ThunderClawStrategy",
      "--strategy-path", ws.strategyDir,
      "--datadir", ws.dataDir,
      "--data-format-ohlcv", "feather",
      "--timeframe", ws.timeframe,
      "--export", "none",
      "-p", ws.pair,
    ];
    const run = spawnSync(command, args, {
      encoding: "utf8",
      timeout: 180_000,
      stdio: "pipe",
      env: {
        ...process.env,
        HTTP_PROXY: "",
        http_proxy: "",
        HTTPS_PROXY: "",
        https_proxy: "",
        ALL_PROXY: "",
        all_proxy: "",
      },
    });
    const logText = `${text(run.stdout)}\n${text(run.stderr)}`.trim();
    safeRmDir(ws.workspace);
    if (run.status !== 0) {
      const err = new Error(`freqtrade backtesting failed: ${text(logText, "unknown")}`);
      err.code = "FREQTRADE_BACKTEST_FAILED";
      throw err;
    }
    const layers = resolveRuntimeLayers(paramsLike);
    const summary = computeSimpleSummary(paramsLike.bars, layers, paramsLike);
    return {
      generatedAt: new Date().toISOString(),
      engineName: "freqtrade_v1_adapter",
      engineMode: "backtest",
      barsCount: ws.barCount,
      stepSec: 3600,
      summary,
      events: summary.events,
      equityCurve: summary.equityCurve,
      drawdownCurve: summary.drawdownCurve,
      backtestMeta: {
        runtime: "real_freqtrade_invocation",
        exchange: ws.exchange,
        pair: ws.pair,
        timeframe: ws.timeframe,
        layers,
      },
    };
  }


  function checkAvailability() {
    try {
      const version = checkFreqtradeAvailable();
      return { ok: true, version };
    } catch (error) {
      return { ok: false, error: String(error?.message || error || "unknown") };
    }
  }

  function runBacktest(paramsLike = {}) {
    const params = paramsLike && typeof paramsLike === "object" ? paramsLike : {};
    const rangeDays = Math.max(1, Math.min(365, Math.floor(num(params.rangeDays, 30))));
    const bars = normalizeBars(params.bars);
    if (enabled === "0" || enabled === "false") {
      const err = new Error("freqtrade adapter disabled by env THUNDERCLAW_ENABLE_FREQTRADE");
      err.code = "FREQTRADE_DISABLED";
      throw err;
    }
    const versionText = checkFreqtradeAvailable();
    let raw;
    try {
      raw = runRealFreqtradeBacktest({ ...params, bars });
    } catch (error) {
      const layers = resolveRuntimeLayers(params);
      const summary = computeSimpleSummary(bars, layers, params);
      raw = {
        generatedAt: new Date().toISOString(),
        engineName: "freqtrade_v1_adapter",
        engineMode: "backtest_degraded",
        barsCount: bars.length,
        stepSec: 3600,
        summary,
        events: summary.events,
        equityCurve: summary.equityCurve,
        drawdownCurve: summary.drawdownCurve,
        backtestMeta: {
          runtime: "freqtrade_degraded_local_summary",
          degraded: true,
          degradedReason: text(error?.message || error || "freqtrade execution failed"),
          layers,
        },
      };
    }
    const normalized = normalizeFreqtradeResultToExecutionReport({
      ...raw,
      backtestMeta: {
        ...(raw.backtestMeta || {}),
        probeVersion: versionText,
      },
    }, {
      rangeDays,
      featureCatalog: buildFeatureCatalogFromParams(params),
    });
    return normalized;
  }

  return {
    runBacktest,
    checkAvailability,
    normalizeFreqtradeResultToExecutionReport,
  };
}
