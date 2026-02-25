(function(globalObj) {
  function createBacktestPanelRuntime(optionsLike) {
    const options = optionsLike && typeof optionsLike === "object" ? optionsLike : {};
    const OHLCV_BY_TF = options.ohlcvByTf && typeof options.ohlcvByTf === "object"
      ? options.ohlcvByTf
      : {};
    const normalizeBars = typeof options.normalizeBars === "function"
      ? options.normalizeBars
      : function(rowsLike) { return Array.isArray(rowsLike) ? rowsLike : []; };
    const normalizeStrategyDslSpec = typeof options.normalizeStrategyDslSpec === "function"
      ? options.normalizeStrategyDslSpec
      : function(specLike) { return specLike && typeof specLike === "object" ? specLike : null; };
    const reportStrategyArtifactResult = typeof options.reportStrategyArtifactResult === "function"
      ? options.reportStrategyArtifactResult
      : null;
    const setupStrategyLabPanel = typeof options.setupStrategyLabPanel === "function"
      ? options.setupStrategyLabPanel
      : null;
    const escapeHtml = typeof options.escapeHtml === "function"
      ? options.escapeHtml
      : function(valueLike) { return String(valueLike == null ? "" : valueLike); };
    const windowObj = options.windowObj && typeof options.windowObj === "object"
      ? options.windowObj
      : globalObj;

    const backtestMathRuntime = globalObj.backtestMathRuntime && typeof globalObj.backtestMathRuntime === "object"
      ? globalObj.backtestMathRuntime
      : {};
    const btNum = typeof backtestMathRuntime.btNum === "function"
      ? backtestMathRuntime.btNum
      : function(v, digits) {
        const n = Number(v);
        const d = Number.isFinite(Number(digits)) ? Number(digits) : 2;
        return Number.isFinite(n) ? n.toFixed(d) : "-";
      };
    const btEmaSeries = backtestMathRuntime.btEmaSeries;
    const btAtrSeries = backtestMathRuntime.btAtrSeries;
    const btAdxSeries = backtestMathRuntime.btAdxSeries;
    const btBuildDslFeatureMap = backtestMathRuntime.btBuildDslFeatureMap;
    const btCompileDslBoolExpr = backtestMathRuntime.btCompileDslBoolExpr;
    const btMapSeriesByTime = backtestMathRuntime.btMapSeriesByTime;
    const btDonchianPrevHigh = backtestMathRuntime.btDonchianPrevHigh;
    const btDonchianPrevLow = backtestMathRuntime.btDonchianPrevLow;

    function btStrategyLabel(v) {
      if (String(v || "") === "dsl") return "DSL 自定义策略";
      if (String(v || "").startsWith("dsl:")) return "DSL " + String(v || "").slice(4);
      if (v === "custom") return "自定义策略";
      if (v === "v5_retest") return "v5 回踩确认";
      if (v === "v5_reentry") return "v5 趋势再入";
      if (v === "v4_breakout") return "v4 Donchian 突破";
      return "v5 混合（回踩+再入）";
    }

    function btFmtTs(sec) {
      const n = Number(sec);
      if (!Number.isFinite(n)) return "-";
      return new Date(n * 1000).toLocaleString("zh-CN", {
        hour12: false,
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
    }

    function runBacktestByDsl(opts) {
      const tf = String(opts?.tf || "1h");
      const feeRate = Math.max(0, Number(opts?.feeBps || 0) / 10000);
      const limitBars = Math.max(120, Math.floor(Number(opts?.bars || 900)));
      const dsl = normalizeStrategyDslSpec(opts?.dsl || opts?.spec);
      if (!dsl || typeof dsl !== "object" || !Object.keys(dsl).length) {
        return { ok: false, message: "DSL 为空或格式无效。" };
      }
      const allBars = normalizeBars(OHLCV_BY_TF?.[tf]);
      const bars = allBars.slice(-limitBars);
      if (!bars.length) return { ok: false, message: "该周期没有可用 K 线数据。" };
      if (bars.length < 120) return { ok: false, message: "K 线样本不足（至少 120 根）。" };

      const closeSeries = bars.map(function(b) { return Number(b.close); });
      const openSeries = bars.map(function(b) { return Number(b.open); });
      const highSeries = bars.map(function(b) { return Number(b.high); });
      const lowSeries = bars.map(function(b) { return Number(b.low); });
      const volumeSeries = bars.map(function(b) { return Number(b.volume); });
      const atr14 = btAtrSeries(bars, 14);
      const adx14 = btAdxSeries(bars, 14);
      const featureMap = btBuildDslFeatureMap(bars, dsl);
      const sideMode = String(dsl.side || "both").toLowerCase();
      const onlyLong = sideMode === "long";
      const onlyShort = sideMode === "short";
      const risk = dsl.risk && typeof dsl.risk === "object" ? dsl.risk : {};
      const stopAtrMult = Math.max(0.2, Number(opts?.stopAtr || risk.stopAtr || 1.8));
      const tpAtrMult = Math.max(0.2, Number(opts?.tpAtr || risk.tpAtr || 3.0));
      const maxHoldBars = Math.max(4, Math.floor(Number(opts?.maxHold || risk.maxHold || 72)));
      const cooldownBars = Math.max(0, Math.floor(Number(risk.cooldownBars || 2)));
      const varNames = ["open", "high", "low", "close", "volume", "atr", "adx", "bar_index", "prev_close"];
      Object.keys(featureMap).forEach(function(k) { if (!varNames.includes(k)) varNames.push(k); });
      const entryLongExpr = String(dsl.entryLong || "close > open");
      const entryShortExpr = String(dsl.entryShort || "close < open");
      const exitLongExpr = String(dsl.exitLong || "close < open");
      const exitShortExpr = String(dsl.exitShort || "close > open");
      const entryLongFn = btCompileDslBoolExpr(entryLongExpr, varNames);
      const entryShortFn = btCompileDslBoolExpr(entryShortExpr, varNames);
      const exitLongFn = btCompileDslBoolExpr(exitLongExpr, varNames);
      const exitShortFn = btCompileDslBoolExpr(exitShortExpr, varNames);
      if (!entryLongFn && !entryShortFn) {
        return { ok: false, message: "DSL 入场规则无效，无法编译。" };
      }

      let equity = 1;
      let peak = 1;
      let maxDd = 0;
      let pos = null;
      let cooldown = 0;
      const trades = [];
      const curve = [];

      function buildRow(i) {
        const row = {
          open: openSeries[i],
          high: highSeries[i],
          low: lowSeries[i],
          close: closeSeries[i],
          volume: volumeSeries[i],
          atr: atr14[i],
          adx: adx14[i],
          bar_index: i,
          prev_close: i > 0 ? closeSeries[i - 1] : closeSeries[i],
        };
        for (const key in featureMap) {
          row[key] = featureMap[key]?.[i];
        }
        return row;
      }

      function closePosition(i, px, reason) {
        if (!pos) return;
        const exitPx = Number(px);
        if (!Number.isFinite(exitPx) || exitPx <= 0) return;
        const gross = pos.side === "long"
          ? ((exitPx - pos.entryPrice) / pos.entryPrice)
          : ((pos.entryPrice - exitPx) / pos.entryPrice);
        const net = gross - feeRate * 2;
        equity = Math.max(0.0001, equity * (1 + net));
        trades.push({
          side: pos.side,
          signalTag: pos.signalTag,
          entryTime: bars[pos.entryIdx].time,
          exitTime: bars[i].time,
          entryPrice: pos.entryPrice,
          exitPrice: exitPx,
          pnlPct: net * 100,
          holdBars: Math.max(1, i - pos.entryIdx),
          reason: reason,
        });
        pos = null;
        cooldown = cooldownBars;
      }

      for (let i = 1; i < bars.length; i++) {
        const row = buildRow(i);
        const closeNow = Number(row.close);
        const highNow = Number(row.high);
        const lowNow = Number(row.low);
        const atrNow = Number.isFinite(Number(row.atr)) ? Number(row.atr) : (closeNow * 0.0035);
        if (!Number.isFinite(closeNow) || closeNow <= 0) continue;

        if (pos) {
          if (pos.side === "long") {
            if (lowNow <= pos.sl) closePosition(i, pos.sl, "stop_loss");
            else if (highNow >= pos.tp) closePosition(i, pos.tp, "take_profit");
          } else {
            if (highNow >= pos.sl) closePosition(i, pos.sl, "stop_loss");
            else if (lowNow <= pos.tp) closePosition(i, pos.tp, "take_profit");
          }
        }
        if (pos && (i - pos.entryIdx) >= maxHoldBars) closePosition(i, closeNow, "timeout");

        if (pos) {
          const shouldExit = pos.side === "long"
            ? (exitLongFn ? Boolean(exitLongFn(row)) : false)
            : (exitShortFn ? Boolean(exitShortFn(row)) : false);
          if (shouldExit) closePosition(i, closeNow, "dsl_exit");
        }

        if (cooldown > 0) cooldown -= 1;
        let signal = null;
        if (cooldown === 0) {
          const longOk = !onlyShort && (entryLongFn ? Boolean(entryLongFn(row)) : false);
          const shortOk = !onlyLong && (entryShortFn ? Boolean(entryShortFn(row)) : false);
          if (longOk && !shortOk) signal = { side: "long", tag: "dsl_entry_long" };
          else if (shortOk && !longOk) signal = { side: "short", tag: "dsl_entry_short" };
        }

        if (pos && signal && signal.side !== pos.side) closePosition(i, closeNow, "reverse");

        if (!pos && signal) {
          const stopDist = Math.max(atrNow * stopAtrMult, closeNow * 0.0012);
          const takeDist = Math.max(atrNow * tpAtrMult, closeNow * 0.0012);
          pos = {
            side: signal.side,
            signalTag: signal.tag,
            entryIdx: i,
            entryPrice: closeNow,
            sl: signal.side === "long" ? (closeNow - stopDist) : (closeNow + stopDist),
            tp: signal.side === "long" ? (closeNow + takeDist) : (closeNow - takeDist),
          };
        }

        let markEq = equity;
        if (pos) {
          const unreal = pos.side === "long"
            ? ((closeNow - pos.entryPrice) / pos.entryPrice)
            : ((pos.entryPrice - closeNow) / pos.entryPrice);
          markEq = Math.max(0.0001, equity * (1 + unreal - feeRate * 2));
        }
        curve.push({ time: bars[i].time, equity: markEq });
        if (markEq > peak) peak = markEq;
        if (peak > 0) maxDd = Math.max(maxDd, (peak - markEq) / peak);
      }

      if (pos) closePosition(bars.length - 1, Number(bars[bars.length - 1].close), "eod");
      const winCount = trades.filter(function(t) { return Number(t.pnlPct) > 0; }).length;
      const lossCount = trades.filter(function(t) { return Number(t.pnlPct) <= 0; }).length;
      const avgPnl = trades.length
        ? trades.reduce(function(s, t) { return s + Number(t.pnlPct || 0); }, 0) / trades.length
        : 0;
      return {
        ok: true,
        strategy: dsl.name ? ("dsl:" + dsl.name) : "dsl",
        tf: tf,
        bars: bars.length,
        tradeCount: trades.length,
        winRate: trades.length ? (winCount / trades.length) * 100 : 0,
        wins: winCount,
        losses: lossCount,
        avgPnlPct: avgPnl,
        netPnlPct: (equity - 1) * 100,
        maxDrawdownPct: maxDd * 100,
        curve: curve,
        trades: trades.slice().reverse(),
        dslMeta: {
          name: dsl.name || "strategy_dsl",
          side: sideMode,
          featureCount: Array.isArray(dsl.features) ? dsl.features.length : 0,
        },
      };
    }

    function runBacktestByVersion(opts) {
      const tf = String(opts?.tf || "1h");
      const strategy = String(opts?.strategy || "v5_hybrid");
      if (strategy === "dsl" || (opts?.dsl && typeof opts.dsl === "object")) {
        return runBacktestByDsl({ ...opts, tf: tf });
      }
      const custom = opts?.custom && typeof opts.custom === "object" ? opts.custom : {};
      const isCustom = strategy === "custom";
      const feeRate = Math.max(0, Number(opts?.feeBps || 0) / 10000);
      const stopAtrMult = Math.max(0.2, Number(opts?.stopAtr || 1.8));
      const tpAtrMult = Math.max(0.2, Number(opts?.tpAtr || 3.0));
      const maxHoldBars = Math.max(4, Math.floor(Number(opts?.maxHold || 72)));
      const limitBars = Math.max(120, Math.floor(Number(opts?.bars || 900)));

      const allBars = normalizeBars(OHLCV_BY_TF?.[tf]);
      const bars = allBars.slice(-limitBars);
      if (!bars.length) return { ok: false, message: "该周期没有可用 K 线数据。" };
      if (bars.length < 120) return { ok: false, message: "K 线样本不足（至少 120 根）。" };

      const close = bars.map((b) => Number(b.close));
      const atr = btAtrSeries(bars, 14);
      const entryEmaPeriod = Math.max(2, Math.floor(Number(custom.entryEma || 20)));
      const entryEma = btEmaSeries(close, entryEmaPeriod);

      const useV5 = /^v5_/.test(strategy) || isCustom;
      const biasSourceBars = (useV5 && tf === "1h" && Array.isArray(OHLCV_BY_TF?.["4h"]) && OHLCV_BY_TF["4h"].length)
        ? normalizeBars(OHLCV_BY_TF["4h"])
        : bars;
      const biasClose = biasSourceBars.map((b) => Number(b.close));
      const biasEmaFast = Math.max(2, Math.floor(Number(custom.biasEmaFast || 20)));
      const biasEmaSlow = Math.max(2, Math.floor(Number(custom.biasEmaSlow || 50)));
      const biasEmaF = btEmaSeries(biasClose, biasEmaFast);
      const biasEmaS = btEmaSeries(biasClose, biasEmaSlow);
      const biasAdx = btAdxSeries(biasSourceBars, 14);
      const mappedBiasEmaF = biasSourceBars === bars ? biasEmaF : btMapSeriesByTime(bars, biasSourceBars, biasEmaF);
      const mappedBiasEmaS = biasSourceBars === bars ? biasEmaS : btMapSeriesByTime(bars, biasSourceBars, biasEmaS);
      const mappedBiasAdx = biasSourceBars === bars ? biasAdx : btMapSeriesByTime(bars, biasSourceBars, biasAdx);
      const biasAdxMin = Math.max(0, Number(custom.biasAdxMin || 15));
      const sideMode = String(custom.side || "both").toLowerCase();
      const onlyLong = sideMode === "long";
      const onlyShort = sideMode === "short";

      let equity = 1;
      let peak = 1;
      let maxDd = 0;
      let pos = null;
      let cooldown = 0;
      let lastBreakLong = null;
      let lastBreakShort = null;
      const trades = [];
      const curve = [];

      function closePosition(i, px, reason) {
        if (!pos) return;
        const exitPx = Number(px);
        if (!Number.isFinite(exitPx) || exitPx <= 0) return;
        const gross = pos.side === "long"
          ? ((exitPx - pos.entryPrice) / pos.entryPrice)
          : ((pos.entryPrice - exitPx) / pos.entryPrice);
        const net = gross - feeRate * 2;
        equity = Math.max(0.0001, equity * (1 + net));
        const holdBars = Math.max(1, i - pos.entryIdx);
        trades.push({
          side: pos.side,
          signalTag: pos.signalTag,
          entryTime: bars[pos.entryIdx].time,
          exitTime: bars[i].time,
          entryPrice: pos.entryPrice,
          exitPrice: exitPx,
          pnlPct: net * 100,
          holdBars,
          reason,
        });
        pos = null;
        cooldown = 2;
      }

      for (let i = 1; i < bars.length; i++) {
        const b = bars[i];
        const atrNow = Number.isFinite(atr[i]) ? Number(atr[i]) : (Number(b.close) * 0.0035);
        const biasLong = Number.isFinite(mappedBiasEmaF[i]) && Number.isFinite(mappedBiasEmaS[i]) && Number.isFinite(mappedBiasAdx[i])
          ? (mappedBiasEmaF[i] > mappedBiasEmaS[i] && mappedBiasAdx[i] >= biasAdxMin)
          : false;
        const biasShort = Number.isFinite(mappedBiasEmaF[i]) && Number.isFinite(mappedBiasEmaS[i]) && Number.isFinite(mappedBiasAdx[i])
          ? (mappedBiasEmaF[i] < mappedBiasEmaS[i] && mappedBiasAdx[i] >= biasAdxMin)
          : false;

        if (pos) {
          if (pos.side === "long") {
            if (Number(b.low) <= pos.sl) closePosition(i, pos.sl, "stop_loss");
            else if (Number(b.high) >= pos.tp) closePosition(i, pos.tp, "take_profit");
          } else {
            if (Number(b.high) >= pos.sl) closePosition(i, pos.sl, "stop_loss");
            else if (Number(b.low) <= pos.tp) closePosition(i, pos.tp, "take_profit");
          }
        }
        if (pos && (i - pos.entryIdx) >= maxHoldBars) {
          closePosition(i, Number(b.close), "timeout");
        }

        if (cooldown > 0) cooldown -= 1;
        let signal = null;
        const closeNow = Number(b.close);
        const highNow = Number(b.high);
        const lowNow = Number(b.low);
        const lookbackDefault = strategy === "v4_breakout" ? 20 : 15;
        const lookback = Math.max(2, Math.floor(Number(custom.lookback || lookbackDefault)));
        const dHigh = btDonchianPrevHigh(bars, i, lookback);
        const dLow = btDonchianPrevLow(bars, i, lookback);

        if (Number.isFinite(dHigh) && closeNow > dHigh) lastBreakLong = { idx: i, level: dHigh };
        if (Number.isFinite(dLow) && closeNow < dLow) lastBreakShort = { idx: i, level: dLow };

        if (cooldown === 0) {
          const allowBreakout = (custom.allowBreakout === true) || (!isCustom && strategy === "v4_breakout");
          const allowRetest =
            custom.allowRetest === true ||
            (custom.allowRetest !== false && (strategy === "v5_retest" || strategy === "v5_hybrid" || isCustom));
          const allowReentry =
            custom.allowReentry === true ||
            (custom.allowReentry !== false && (strategy === "v5_reentry" || strategy === "v5_hybrid" || isCustom));
          const retestWindow = Math.max(1, Math.floor(Number(custom.retestWindow || 12)));
          const tolRetest = atrNow * Math.max(0.01, Number(custom.retestTolAtr || 0.25));
          const tolReentry = atrNow * Math.max(0.01, Number(custom.reentryTolAtr || 0.35));
          if (allowBreakout) {
            if (!onlyShort && Number.isFinite(dHigh) && closeNow > dHigh) signal = { side: "long", tag: "breakout" };
            else if (!onlyLong && Number.isFinite(dLow) && closeNow < dLow) signal = { side: "short", tag: "breakout" };
          }
          if (!signal) {
            const emaNow = Number(entryEma[i]);
            if (!onlyShort && allowRetest && biasLong && lastBreakLong && (i - lastBreakLong.idx) <= retestWindow) {
              if (lowNow <= lastBreakLong.level + tolRetest && closeNow > lastBreakLong.level) {
                signal = { side: "long", tag: "retest" };
                lastBreakLong = null;
              }
            }
            if (!signal && !onlyLong && allowRetest && biasShort && lastBreakShort && (i - lastBreakShort.idx) <= retestWindow) {
              if (highNow >= lastBreakShort.level - tolRetest && closeNow < lastBreakShort.level) {
                signal = { side: "short", tag: "retest" };
                lastBreakShort = null;
              }
            }
            if (!signal && allowReentry && Number.isFinite(emaNow)) {
              const prevClose = i > 0 ? Number(bars[i - 1]?.close) : closeNow;
              const prevEma = i > 0 ? Number(entryEma[i - 1]) : emaNow;
              const prevLong = Number.isFinite(prevClose) && Number.isFinite(prevEma) ? prevClose > prevEma : true;
              const prevShort = Number.isFinite(prevClose) && Number.isFinite(prevEma) ? prevClose < prevEma : true;
              if (!onlyShort && biasLong && prevLong && lowNow <= emaNow + tolReentry && closeNow > emaNow) {
                signal = { side: "long", tag: "reentry" };
              } else if (!onlyLong && biasShort && prevShort && highNow >= emaNow - tolReentry && closeNow < emaNow) {
                signal = { side: "short", tag: "reentry" };
              }
            }
          }
        }

        if (pos && signal && signal.side !== pos.side) {
          closePosition(i, closeNow, "reverse");
        }

        if (!pos && signal) {
          const stopDist = Math.max(atrNow * stopAtrMult, closeNow * 0.0012);
          const takeDist = Math.max(atrNow * tpAtrMult, closeNow * 0.0012);
          pos = {
            side: signal.side,
            signalTag: signal.tag,
            entryIdx: i,
            entryPrice: closeNow,
            sl: signal.side === "long" ? (closeNow - stopDist) : (closeNow + stopDist),
            tp: signal.side === "long" ? (closeNow + takeDist) : (closeNow - takeDist),
          };
        }

        let markEq = equity;
        if (pos) {
          const unreal = pos.side === "long"
            ? ((closeNow - pos.entryPrice) / pos.entryPrice)
            : ((pos.entryPrice - closeNow) / pos.entryPrice);
          markEq = Math.max(0.0001, equity * (1 + unreal - feeRate * 2));
        }
        curve.push({ time: bars[i].time, equity: markEq });
        if (markEq > peak) peak = markEq;
        if (peak > 0) maxDd = Math.max(maxDd, (peak - markEq) / peak);
      }

      if (pos) closePosition(bars.length - 1, Number(bars[bars.length - 1].close), "eod");
      const winCount = trades.filter((t) => Number(t.pnlPct) > 0).length;
      const lossCount = trades.filter((t) => Number(t.pnlPct) <= 0).length;
      const avgPnl = trades.length ? trades.reduce((s, t) => s + Number(t.pnlPct || 0), 0) / trades.length : 0;
      return {
        ok: true,
        strategy,
        tf,
        bars: bars.length,
        tradeCount: trades.length,
        winRate: trades.length ? (winCount / trades.length) * 100 : 0,
        wins: winCount,
        losses: lossCount,
        avgPnlPct: avgPnl,
        netPnlPct: (equity - 1) * 100,
        maxDrawdownPct: maxDd * 100,
        curve,
        trades: trades.slice().reverse(),
      };
    }

    function drawBacktestEquityCurve(curve) {
      const canvas = document.getElementById("bt-equity-canvas");
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const width = Math.max(240, Math.floor(rect.width || canvas.clientWidth || 320));
      const height = Math.max(120, Math.floor(rect.height || canvas.clientHeight || 160));
      const dpr = Math.max(1, Math.min(2, windowObj.devicePixelRatio || 1));
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      if (!Array.isArray(curve) || curve.length < 2) {
        ctx.strokeStyle = "rgba(139,148,158,0.35)";
        ctx.beginPath();
        ctx.moveTo(8, height * 0.5);
        ctx.lineTo(width - 8, height * 0.5);
        ctx.stroke();
        return;
      }
      const pad = 10;
      const vals = curve.map((p) => Number(p.equity)).filter(Number.isFinite);
      const minV = Math.min.apply(null, vals);
      const maxV = Math.max.apply(null, vals);
      const range = Math.max(1e-6, maxV - minV);
      const toX = (i) => pad + (i / (curve.length - 1)) * (width - pad * 2);
      const toY = (v) => pad + (1 - ((v - minV) / range)) * (height - pad * 2);

      ctx.strokeStyle = "rgba(139,148,158,0.18)";
      ctx.lineWidth = 1;
      [0.2, 0.5, 0.8].forEach(function(r) {
        const y = pad + (height - pad * 2) * r;
        ctx.beginPath();
        ctx.moveTo(pad, y);
        ctx.lineTo(width - pad, y);
        ctx.stroke();
      });

      const up = curve[curve.length - 1].equity >= curve[0].equity;
      const lineColor = up ? "#3fb950" : "#f85149";
      const area = ctx.createLinearGradient(0, 0, 0, height);
      area.addColorStop(0, up ? "rgba(63,185,80,0.18)" : "rgba(248,81,73,0.18)");
      area.addColorStop(1, "rgba(15,20,25,0)");
      ctx.beginPath();
      ctx.moveTo(toX(0), toY(curve[0].equity));
      for (let i = 1; i < curve.length; i++) ctx.lineTo(toX(i), toY(curve[i].equity));
      ctx.lineTo(toX(curve.length - 1), height - pad);
      ctx.lineTo(toX(0), height - pad);
      ctx.closePath();
      ctx.fillStyle = area;
      ctx.fill();

      ctx.beginPath();
      ctx.moveTo(toX(0), toY(curve[0].equity));
      for (let i = 1; i < curve.length; i++) ctx.lineTo(toX(i), toY(curve[i].equity));
      ctx.strokeStyle = lineColor;
      ctx.lineWidth = 2;
      ctx.stroke();

      const lx = toX(curve.length - 1);
      const ly = toY(curve[curve.length - 1].equity);
      ctx.beginPath();
      ctx.arc(lx, ly, 3, 0, Math.PI * 2);
      ctx.fillStyle = lineColor;
      ctx.fill();
    }

    function renderBacktestResult(result, cfg) {
      const noteEl = document.getElementById("bt-note");
      const metricsEl = document.getElementById("bt-metrics");
      const totalEl = document.getElementById("bt-trades-total");
      const tbodyEl = document.getElementById("bt-trades-tbody");
      if (!noteEl || !metricsEl || !totalEl || !tbodyEl) return;

      if (!result?.ok) {
        noteEl.textContent = "回验失败：" + (result?.message || "未知错误");
        metricsEl.innerHTML = "";
        totalEl.textContent = "交易明细：0 条";
        tbodyEl.innerHTML = '<tr><td colspan="10" class="empty">回验失败，请调整参数后重试。</td></tr>';
        drawBacktestEquityCurve([]);
        return;
      }

      noteEl.textContent = "策略：" + btStrategyLabel(result.strategy) + " · 周期：" + result.tf + " · 样本：" + result.bars + " 根 · 手续费：" + btNum(cfg.feeBps, 2) + " bps";
      const pnlCls = result.netPnlPct >= 0 ? "pos" : "neg";
      const avgCls = result.avgPnlPct >= 0 ? "pos" : "neg";
      metricsEl.innerHTML = ""
        + '<div class="bt-metric"><div class="k">净值收益</div><div class="v ' + pnlCls + '">' + (result.netPnlPct >= 0 ? "+" : "") + btNum(result.netPnlPct, 2) + "%</div></div>"
        + '<div class="bt-metric"><div class="k">最大回撤</div><div class="v neg">' + btNum(result.maxDrawdownPct, 2) + "%</div></div>"
        + '<div class="bt-metric"><div class="k">交易次数</div><div class="v">' + result.tradeCount + "</div></div>"
        + '<div class="bt-metric"><div class="k">胜率</div><div class="v">' + btNum(result.winRate, 1) + "%</div></div>"
        + '<div class="bt-metric"><div class="k">平均单笔</div><div class="v ' + avgCls + '">' + (result.avgPnlPct >= 0 ? "+" : "") + btNum(result.avgPnlPct, 2) + "%</div></div>"
        + '<div class="bt-metric"><div class="k">胜/负</div><div class="v">' + result.wins + " / " + result.losses + "</div></div>";

      drawBacktestEquityCurve(result.curve);
      totalEl.textContent = "交易明细：" + result.trades.length + " 条";
      if (!result.trades.length) {
        tbodyEl.innerHTML = '<tr><td colspan="10" class="empty">暂无成交（可调低阈值/扩大回验窗口）。</td></tr>';
        return;
      }
      tbodyEl.innerHTML = result.trades.slice(0, 300).map(function(t, idx) {
        const cls = Number(t.pnlPct) >= 0 ? "pos" : "neg";
        return "<tr>"
          + "<td>" + (idx + 1) + "</td>"
          + "<td>" + (t.side === "short" ? "做空" : "做多") + "</td>"
          + "<td>" + btFmtTs(t.entryTime) + "</td>"
          + "<td>" + btFmtTs(t.exitTime) + "</td>"
          + "<td>" + btNum(t.entryPrice, 2) + "</td>"
          + "<td>" + btNum(t.exitPrice, 2) + "</td>"
          + '<td class="' + cls + '">' + (Number(t.pnlPct) >= 0 ? "+" : "") + btNum(t.pnlPct, 2) + "%</td>"
          + "<td>" + t.holdBars + "</td>"
          + "<td>" + escapeHtml(t.signalTag || "-") + "</td>"
          + "<td>" + escapeHtml(t.reason || "-") + "</td>"
          + "</tr>";
      }).join("");
    }

    function runBacktestFromUi() {
      const strategyEl = document.getElementById("bt-strategy");
      const tfEl = document.getElementById("bt-tf");
      const barsEl = document.getElementById("bt-bars");
      const feeEl = document.getElementById("bt-fee-bps");
      const stopEl = document.getElementById("bt-stop-atr");
      const tpEl = document.getElementById("bt-tp-atr");
      const holdEl = document.getElementById("bt-max-hold");
      if (!strategyEl || !tfEl || !barsEl || !feeEl || !stopEl || !tpEl || !holdEl) return null;
      const cfg = {
        strategy: strategyEl.value || "v5_hybrid",
        tf: tfEl.value || "1h",
        bars: Number(barsEl.value || 900),
        feeBps: Number(feeEl.value || 5),
        stopAtr: Number(stopEl.value || 1.8),
        tpAtr: Number(tpEl.value || 3.0),
        maxHold: Number(holdEl.value || 72),
      };
      const result = runBacktestByVersion(cfg);
      windowObj.__tcLatestBacktestResult = result || null;
      renderBacktestResult(result, cfg);
      if (typeof reportStrategyArtifactResult === "function") {
        void reportStrategyArtifactResult(result, cfg, {
          source: "dashboard_manual",
          query: "",
          label: String(cfg?.dsl?.name || cfg.strategy || result?.strategy || "manual"),
          attachToNote: true,
        });
      }
      return result;
    }

    function setupBacktestPanel() {
      const runBtn = document.getElementById("bt-run");
      const tfEl = document.getElementById("bt-tf");
      if (!runBtn || !tfEl) return;
      if (Array.isArray(OHLCV_BY_TF?.["1h"]) && OHLCV_BY_TF["1h"].length) tfEl.value = "1h";
      else if (Array.isArray(OHLCV_BY_TF?.["15m"]) && OHLCV_BY_TF["15m"].length) tfEl.value = "15m";
      runBtn.addEventListener("click", runBacktestFromUi);
      const autoIds = ["bt-strategy", "bt-tf", "bt-bars", "bt-fee-bps", "bt-stop-atr", "bt-tp-atr", "bt-max-hold"];
      autoIds.forEach(function(id) {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener("change", function() {
          if (id === "bt-strategy" || id === "bt-tf") runBacktestFromUi();
        });
      });
      runBacktestFromUi();
      if (typeof setupStrategyLabPanel === "function") {
        setupStrategyLabPanel(function() { return windowObj.__tcLatestBacktestResult || null; });
      }
    }

    return {
      runBacktestByDsl,
      runBacktestByVersion,
      runBacktestFromUi,
      setupBacktestPanel,
    };
  }

  globalObj.createBacktestPanelRuntime = createBacktestPanelRuntime;
})(typeof window !== "undefined" ? window : this);

