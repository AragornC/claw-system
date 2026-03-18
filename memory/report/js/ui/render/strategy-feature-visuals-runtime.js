(function attachStrategyFeatureVisualRuntime(globalLike) {
  const globalObj = globalLike || (typeof window !== "undefined" ? window : {});

  function createStrategyFeatureVisualRuntime(depsLike) {
    const deps = depsLike && typeof depsLike === "object" ? depsLike : {};
    const sfText = typeof deps.sfText === "function"
      ? deps.sfText
      : function sfTextFallback(valueLike, fallback) {
          const s = String(valueLike == null ? "" : valueLike).trim();
          return s || String(fallback || "");
        };
    const sfNum = typeof deps.sfNum === "function"
      ? deps.sfNum
      : function sfNumFallback(valueLike, fallback) {
          const n = Number(valueLike);
          return Number.isFinite(n) ? n : Number(fallback || 0);
        };
    const sfEscapeHtml = typeof deps.sfEscapeHtml === "function"
      ? deps.sfEscapeHtml
      : function sfEscapeHtmlFallback(valueLike) {
          return String(valueLike == null ? "" : valueLike)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
        };
    const sfFormatBarTs = typeof deps.sfFormatBarTs === "function"
      ? deps.sfFormatBarTs
      : function sfFormatBarTsFallback(secLike) {
          const sec = sfNum(secLike, 0);
          if (!Number.isFinite(sec) || sec <= 0) return "-";
          const d = new Date(sec * 1000);
          const m = String(d.getMonth() + 1).padStart(2, "0");
          const day = String(d.getDate()).padStart(2, "0");
          const hh = String(d.getHours()).padStart(2, "0");
          const mm = String(d.getMinutes()).padStart(2, "0");
          return m + "-" + day + " " + hh + ":" + mm;
        };
    const normalizeStrategyFeatureRuntime = typeof deps.normalizeStrategyFeatureRuntime === "function"
      ? deps.normalizeStrategyFeatureRuntime
      : function normalizeFeatureFallback(rawLike) {
          const raw = rawLike && typeof rawLike === "object" ? rawLike : {};
          return raw;
        };
    const FEATURE_MAIN_CATEGORY_CONFIG = deps.mainCategoryConfig && typeof deps.mainCategoryConfig === "object"
      ? deps.mainCategoryConfig
      : {};

function calcSmaSeries(values, periodLike) {
  const period = Math.max(2, Math.floor(sfNum(periodLike, 14)));
  const out = Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    const val = sfNum(values[i], Number.NaN);
    if (!Number.isFinite(val)) continue;
    sum += val;
    if (i >= period) {
      const prev = sfNum(values[i - period], Number.NaN);
      if (Number.isFinite(prev)) sum -= prev;
    }
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function calcEmaSeries(values, periodLike) {
  const period = Math.max(2, Math.floor(sfNum(periodLike, 14)));
  const alpha = 2 / (period + 1);
  const out = Array(values.length).fill(null);
  let ema = null;
  for (let i = 0; i < values.length; i += 1) {
    const v = sfNum(values[i], Number.NaN);
    if (!Number.isFinite(v)) continue;
    if (ema == null) ema = v;
    else ema = (v - ema) * alpha + ema;
    out[i] = ema;
  }
  return out;
}

function calcRsiSeries(values, periodLike) {
  const period = Math.max(2, Math.floor(sfNum(periodLike, 14)));
  const out = Array(values.length).fill(null);
  let gain = 0;
  let loss = 0;
  for (let i = 1; i < values.length; i += 1) {
    const prev = sfNum(values[i - 1], Number.NaN);
    const curr = sfNum(values[i], Number.NaN);
    if (!Number.isFinite(prev) || !Number.isFinite(curr)) continue;
    const diff = curr - prev;
    if (i <= period) {
      gain += Math.max(diff, 0);
      loss += Math.max(-diff, 0);
      if (i === period) {
        const avgGain = gain / period;
        const avgLoss = loss / period;
        const rs = avgLoss <= 0 ? 100 : (avgGain / avgLoss);
        out[i] = 100 - (100 / (1 + rs));
      }
      continue;
    }
    gain = ((gain * (period - 1)) + Math.max(diff, 0)) / period;
    loss = ((loss * (period - 1)) + Math.max(-diff, 0)) / period;
    const rs = loss <= 0 ? 100 : (gain / loss);
    out[i] = 100 - (100 / (1 + rs));
  }
  return out;
}

function calcAtrSeries(highs, lows, closes, periodLike) {
  const period = Math.max(2, Math.floor(sfNum(periodLike, 14)));
  const tr = Array(highs.length).fill(null);
  for (let i = 0; i < highs.length; i += 1) {
    const h = sfNum(highs[i], Number.NaN);
    const l = sfNum(lows[i], Number.NaN);
    const cPrev = i > 0 ? sfNum(closes[i - 1], Number.NaN) : sfNum(closes[i], Number.NaN);
    if (!Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(cPrev)) continue;
    tr[i] = Math.max(h - l, Math.abs(h - cPrev), Math.abs(l - cPrev));
  }
  const out = Array(highs.length).fill(null);
  let atr = null;
  for (let i = 0; i < tr.length; i += 1) {
    const v = sfNum(tr[i], Number.NaN);
    if (!Number.isFinite(v)) continue;
    if (atr == null) atr = v;
    else atr = ((atr * (period - 1)) + v) / period;
    out[i] = atr;
  }
  return out;
}

function calcAdxSeries(highs, lows, closes, periodLike) {
  const period = Math.max(2, Math.floor(sfNum(periodLike, 14)));
  const len = highs.length;
  const plusDm = Array(len).fill(0);
  const minusDm = Array(len).fill(0);
  const tr = Array(len).fill(0);
  for (let i = 1; i < len; i += 1) {
    const up = sfNum(highs[i], 0) - sfNum(highs[i - 1], 0);
    const down = sfNum(lows[i - 1], 0) - sfNum(lows[i], 0);
    plusDm[i] = up > down && up > 0 ? up : 0;
    minusDm[i] = down > up && down > 0 ? down : 0;
    const h = sfNum(highs[i], 0);
    const l = sfNum(lows[i], 0);
    const cPrev = sfNum(closes[i - 1], 0);
    tr[i] = Math.max(h - l, Math.abs(h - cPrev), Math.abs(l - cPrev));
  }
  const adx = Array(len).fill(null);
  let trSm = 0;
  let plusSm = 0;
  let minusSm = 0;
  for (let i = 1; i < len; i += 1) {
    trSm = trSm - (trSm / period) + tr[i];
    plusSm = plusSm - (plusSm / period) + plusDm[i];
    minusSm = minusSm - (minusSm / period) + minusDm[i];
    if (i < period) continue;
    const pdi = trSm <= 0 ? 0 : (100 * plusSm / trSm);
    const mdi = trSm <= 0 ? 0 : (100 * minusSm / trSm);
    const dx = (pdi + mdi) <= 0 ? 0 : (100 * Math.abs(pdi - mdi) / (pdi + mdi));
    if (adx[i - 1] == null) adx[i] = dx;
    else adx[i] = ((adx[i - 1] * (period - 1)) + dx) / period;
  }
  return adx;
}

function resolvePreviewBarsRuntime(contextLike) {
  const context = contextLike && typeof contextLike === "object" ? contextLike : {};
  const ohlcvByTf = context.ohlcvByTf && typeof context.ohlcvByTf === "object" ? context.ohlcvByTf : {};
  const tfPrefer = sfText(context.previewTf || "auto", "auto");
  const windowSize = Math.max(60, Math.min(360, Math.floor(sfNum(context.previewWindow, 120))));
  if (tfPrefer !== "auto") {
    const rows = Array.isArray(ohlcvByTf[tfPrefer]) ? ohlcvByTf[tfPrefer] : [];
    if (rows.length >= 16) return { bars: rows.slice(-windowSize), tf: tfPrefer, windowSize: windowSize };
  }
  const priority = ["1h", "15m", "5m", "1m", "4h", "1d"];
  for (let i = 0; i < priority.length; i += 1) {
    const tf = priority[i];
    const rows = Array.isArray(ohlcvByTf[tf]) ? ohlcvByTf[tf] : [];
    if (rows.length >= 24) return { bars: rows.slice(-windowSize), tf: tf, windowSize: windowSize };
  }
  const keys = Object.keys(ohlcvByTf || {});
  for (let i = 0; i < keys.length; i += 1) {
    const rows = Array.isArray(ohlcvByTf[keys[i]]) ? ohlcvByTf[keys[i]] : [];
    if (rows.length >= 16) return { bars: rows.slice(-windowSize), tf: keys[i], windowSize: windowSize };
  }
  return { bars: [], tf: tfPrefer === "auto" ? "-" : tfPrefer, windowSize: windowSize };
}

function downsampleRowsRuntime(rowsLike, maxPointsLike) {
  const rows = Array.isArray(rowsLike) ? rowsLike : [];
  const maxPoints = Math.max(12, Math.min(72, Math.floor(sfNum(maxPointsLike, 36))));
  if (rows.length <= maxPoints) return rows.slice();
  const step = Math.max(1, Math.floor(rows.length / maxPoints));
  const out = [];
  for (let i = Math.max(0, rows.length - maxPoints * step); i < rows.length; i += step) {
    out.push(rows[i]);
  }
  if (out.length && out[out.length - 1] !== rows[rows.length - 1]) out.push(rows[rows.length - 1]);
  return out.slice(-maxPoints);
}

function seriesPathRuntime(valuesLike, minValLike, maxValLike, left, right, top, bottom) {
  const values = Array.isArray(valuesLike) ? valuesLike : [];
  const minVal = sfNum(minValLike, 0);
  const maxVal = sfNum(maxValLike, 1);
  const span = Math.max(1e-9, maxVal - minVal);
  const innerW = Math.max(1, right - left);
  const innerH = Math.max(1, bottom - top);
  const pts = [];
  for (let i = 0; i < values.length; i += 1) {
    const v = sfNum(values[i], Number.NaN);
    if (!Number.isFinite(v)) continue;
    const x = left + (i / Math.max(1, values.length - 1)) * innerW;
    const y = top + (1 - ((v - minVal) / span)) * innerH;
    pts.push([x, y]);
  }
  if (pts.length < 2) return "";
  return pts.map(function build(item, idx) {
    return (idx ? "L" : "M") + item[0].toFixed(2) + " " + item[1].toFixed(2);
  }).join(" ");
}

function buildCandleLayerRuntime(barsLike, left, right, top, bottom) {
  const bars = Array.isArray(barsLike) ? barsLike : [];
  const highs = bars.map(function mapHigh(item) { return sfNum(item && item.high, Number.NaN); }).filter(Number.isFinite);
  const lows = bars.map(function mapLow(item) { return sfNum(item && item.low, Number.NaN); }).filter(Number.isFinite);
  if (!highs.length || !lows.length) return { wickPath: "", bodyHtml: "", min: 0, max: 1 };
  const maxPrice = Math.max.apply(null, highs);
  const minPrice = Math.min.apply(null, lows);
  const span = Math.max(1e-9, maxPrice - minPrice);
  const innerW = Math.max(1, right - left);
  const innerH = Math.max(1, bottom - top);
  const slot = bars.length > 1 ? innerW / (bars.length - 1) : innerW;
  const wick = [];
  const bodies = [];
  function scalePrice(vLike) {
    const v = sfNum(vLike, minPrice);
    return top + (1 - ((v - minPrice) / span)) * innerH;
  }
  bars.forEach(function eachBar(barLike, idx) {
    const bar = barLike && typeof barLike === "object" ? barLike : {};
    const x = left + idx * slot;
    const yH = scalePrice(bar.high);
    const yL = scalePrice(bar.low);
    wick.push("M" + x.toFixed(2) + " " + yH.toFixed(2) + "L" + x.toFixed(2) + " " + yL.toFixed(2));
    const yO = scalePrice(bar.open);
    const yC = scalePrice(bar.close);
    const bodyTop = Math.min(yO, yC);
    const bodyH = Math.max(1, Math.abs(yO - yC));
    const bodyW = Math.max(1.6, Math.min(6, slot * 0.42));
    const color = sfNum(bar.close, 0) >= sfNum(bar.open, 0)
      ? "rgba(63,185,80,0.78)"
      : "rgba(248,81,73,0.78)";
    bodies.push(
      '<rect x="' + (x - bodyW / 2).toFixed(2) + '" y="' + bodyTop.toFixed(2)
      + '" width="' + bodyW.toFixed(2) + '" height="' + bodyH.toFixed(2)
      + '" fill="' + color + '"></rect>',
    );
  });
  return { wickPath: wick.join(""), bodyHtml: bodies.join(""), min: minPrice, max: maxPrice };
}

function getIndicatorSeriesRuntime(feature, barsLike) {
  const bars = Array.isArray(barsLike) ? barsLike : [];
  const period = Math.max(2, Math.floor(sfNum(feature.params && feature.params.period, 14)));
  const closes = bars.map(function mapClose(item) { return sfNum(item && item.close, Number.NaN); });
  const highs = bars.map(function mapHigh(item) { return sfNum(item && item.high, Number.NaN); });
  const lows = bars.map(function mapLow(item) { return sfNum(item && item.low, Number.NaN); });
  const volumes = bars.map(function mapVolume(item) { return sfNum(item && item.volume, Number.NaN); });
  const kind = sfText(feature.kind, "custom").toLowerCase();
  const builders = {
    ema: function buildEma() { return calcEmaSeries(closes, period); },
    sma: function buildSma() { return calcSmaSeries(closes, period); },
    rsi: function buildRsi() { return calcRsiSeries(closes, period); },
    adx: function buildAdx() { return calcAdxSeries(highs, lows, closes, period); },
    atr: function buildAtr() { return calcAtrSeries(highs, lows, closes, period); },
    volume: function buildVolume() { return calcSmaSeries(volumes, period); },
    price_action: function buildPa() { return calcSmaSeries(closes, Math.max(3, Math.floor(period / 2))); },
    risk_rule: function buildRisk() { return calcAtrSeries(highs, lows, closes, Math.max(4, period)); },
    custom: function buildCustom() { return calcSmaSeries(closes, period); },
  };
  const fn = builders[kind] || builders.custom;
  return fn();
}

function describeValueRuntime(feature, barLike, valueLike) {
  const featureKind = sfText(feature.kind, "custom").toLowerCase();
  const bar = barLike && typeof barLike === "object" ? barLike : {};
  const value = sfNum(valueLike, Number.NaN);
  if (!Number.isFinite(value)) return "-";
  const explainers = {
    ema: function emaExp() {
      const close = sfNum(bar.close, Number.NaN);
      if (!Number.isFinite(close)) return "-";
      return close >= value ? "Close>=EMA（趋势通过）" : "Close<EMA（趋势过滤）";
    },
    sma: function smaExp() {
      const close = sfNum(bar.close, Number.NaN);
      if (!Number.isFinite(close)) return "-";
      return close >= value ? "Close>=SMA（顺势）" : "Close<SMA（偏弱）";
    },
    rsi: function rsiExp() {
      if (value <= 30) return "RSI<=30（超卖）";
      if (value >= 70) return "RSI>=70（超买）";
      return "30<RSI<70（中性）";
    },
    adx: function adxExp() {
      const min = sfNum(feature.params && feature.params.min, 20);
      return value >= min ? ("ADX>=" + min + "（趋势有效）") : ("ADX<" + min + "（趋势偏弱）");
    },
    atr: function atrExp() {
      const stopAtr = sfNum(feature.params && feature.params.stopAtr, 1.2);
      return "ATR=" + value.toFixed(2) + "，止损距离≈" + (value * stopAtr).toFixed(2);
    },
    volume: function volExp() {
      const vol = sfNum(bar.volume, Number.NaN);
      if (!Number.isFinite(vol) || value <= 0) return "-";
      const ratio = vol / value;
      if (ratio >= 1.3) return "放量确认（ratio=" + ratio.toFixed(2) + "）";
      if (ratio <= 0.8) return "缩量状态（ratio=" + ratio.toFixed(2) + "）";
      return "量能中性（ratio=" + ratio.toFixed(2) + "）";
    },
    price_action: function paExp() {
      const close = sfNum(bar.close, Number.NaN);
      const high = sfNum(bar.high, Number.NaN);
      const low = sfNum(bar.low, Number.NaN);
      if (!Number.isFinite(close) || !Number.isFinite(high) || !Number.isFinite(low)) return "-";
      if (close >= high * 0.998) return "接近上沿（潜在突破）";
      if (close <= low * 1.002) return "接近下沿（潜在反转）";
      return "结构中性";
    },
    risk_rule: function riskExp() {
      return value >= 1 ? "风险偏高（限制开仓）" : "风险可控（允许执行）";
    },
    custom: function defaultExp() {
      return "特征值=" + value.toFixed(4);
    },
  };
  const fn = explainers[featureKind] || explainers.custom;
  return fn();
}

function buildSampleRowsRuntime(feature, barsLike, valuesLike, maxRowsLike) {
  const bars = Array.isArray(barsLike) ? barsLike : [];
  const values = Array.isArray(valuesLike) ? valuesLike : [];
  const maxRows = Math.max(3, Math.min(10, Math.floor(sfNum(maxRowsLike, 6))));
  const out = [];
  for (let i = bars.length - 1; i >= 0 && out.length < maxRows; i -= 1) {
    const bar = bars[i] && typeof bars[i] === "object" ? bars[i] : null;
    if (!bar) continue;
    const val = sfNum(values[i], Number.NaN);
    if (!Number.isFinite(val)) continue;
    out.push({
      idx: i,
      timeSec: Math.floor(sfNum(bar.time, 0)),
      ts: sfFormatBarTs(bar.time),
      close: Number.isFinite(sfNum(bar.close, Number.NaN)) ? sfNum(bar.close, Number.NaN) : null,
      value: val,
      explain: describeValueRuntime(feature, bar, val),
    });
  }
  return out;
}

function buildSampleTableRuntime(rowsLike, tfLike, optionsLike) {
  const options = optionsLike && typeof optionsLike === "object" ? optionsLike : {};
  const detailMode = Boolean(options.detailMode);
  const rows = Array.isArray(rowsLike) ? rowsLike : [];
  const tf = sfText(tfLike, "1h");
  if (!rows.length) return "";
  const body = rows.map(function mapRow(rowLike) {
    const row = rowLike && typeof rowLike === "object" ? rowLike : {};
    const timeSec = Math.floor(sfNum(row.timeSec, 0));
    const hasTime = Number.isFinite(timeSec) && timeSec > 0;
    const rowAttrs = hasTime
      ? (' data-feature-bar-time="' + sfEscapeHtml(String(timeSec)) + '"'
        + ' data-feature-tf="' + sfEscapeHtml(tf) + '"'
        + ' data-feature-value="' + sfEscapeHtml(sfNum(row.value, 0).toFixed(6)) + '"'
        + ' data-feature-label="' + sfEscapeHtml(sfText(row.explain, "")) + '"'
        + ' title="点击定位主K线"')
      : "";
    const jumpBtn = hasTime
      ? ('<button class="feature-jump-btn" type="button"'
        + ' data-feature-bar-time="' + sfEscapeHtml(String(timeSec)) + '"'
        + ' data-feature-tf="' + sfEscapeHtml(tf) + '"'
        + ' data-feature-value="' + sfEscapeHtml(sfNum(row.value, 0).toFixed(6)) + '"'
        + ' data-feature-label="' + sfEscapeHtml(sfText(row.explain, "")) + '">定位K线</button>')
      : "-";
    return "<tr" + rowAttrs + ">"
      + "<td>" + sfEscapeHtml(sfText(row.ts, "-")) + "</td>"
      + "<td>" + sfEscapeHtml("#" + String(Math.floor(sfNum(row.idx, 0)) + 1)) + "</td>"
      + "<td>" + sfEscapeHtml(row.close == null ? "-" : sfNum(row.close, 0).toFixed(2)) + "</td>"
      + "<td>" + sfEscapeHtml(sfNum(row.value, 0).toFixed(4)) + "</td>"
      + "<td>" + sfEscapeHtml(sfText(row.explain, "-")) + "</td>"
      + "<td>" + jumpBtn + "</td>"
      + "</tr>";
  }).join("");
  const tableClassName = detailMode ? "feature-sample-table detail" : "feature-sample-table";
  return '<table class="' + tableClassName + '"><thead><tr>'
    + "<th>时间</th><th>位置</th><th>Close</th><th>特征值</th><th>解释</th><th>联动</th>"
    + "</tr></thead><tbody>" + body + "</tbody></table>";
}

function seriesPathWithGapsRuntime(rowsLike, valueKeyLike, minValLike, maxValLike, left, right, top, bottom) {
  const rows = Array.isArray(rowsLike) ? rowsLike : [];
  const valueKey = sfText(valueKeyLike, "");
  const minVal = sfNum(minValLike, 0);
  const maxVal = sfNum(maxValLike, 1);
  const span = Math.max(1e-9, maxVal - minVal);
  const innerW = Math.max(1, right - left);
  const innerH = Math.max(1, bottom - top);
  let path = "";
  let drawing = false;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i] && typeof rows[i] === "object" ? rows[i] : {};
    const v = Number(row[valueKey]);
    if (!Number.isFinite(v)) {
      drawing = false;
      continue;
    }
    const x = left + (i / Math.max(1, rows.length - 1)) * innerW;
    const y = top + (1 - ((v - minVal) / span)) * innerH;
    path += (drawing ? "L" : "M") + x.toFixed(2) + " " + y.toFixed(2);
    drawing = true;
  }
  return path;
}

function normalizeFeatureEvalRowsRuntime(timeSeriesLike, featureColLike) {
  const timeSeries = Array.isArray(timeSeriesLike) ? timeSeriesLike : [];
  const featureCol = sfText(featureColLike, "");
  return timeSeries.map(function mapRow(itemLike) {
    const row = itemLike && typeof itemLike === "object" ? itemLike : {};
    const timeSec = Math.floor(sfNum(row.time, 0));
    if (!Number.isFinite(timeSec) || timeSec <= 0) return null;
    const open = Number(row.open);
    const high = Number(row.high);
    const low = Number(row.low);
    const close = Number(row.close);
    const volume = Number(row.volume);
    const featureValue = Number(row[featureCol]);
    return {
      time: timeSec,
      open: Number.isFinite(open) ? open : null,
      high: Number.isFinite(high) ? high : null,
      low: Number.isFinite(low) ? low : null,
      close: Number.isFinite(close) ? close : null,
      volume: Number.isFinite(volume) ? volume : null,
      value: Number.isFinite(featureValue) ? featureValue : null,
    };
  }).filter(Boolean).sort(function sortByTime(a, b) {
    return sfNum(a.time, 0) - sfNum(b.time, 0);
  });
}

function buildFeatureEvalSampleRowsRuntime(rowsLike, featureColLike, maxRowsLike) {
  const rows = Array.isArray(rowsLike) ? rowsLike : [];
  const featureCol = sfText(featureColLike, "").replace(/^tc_feat_/, "");
  const maxRows = Math.max(4, Math.min(20, Math.floor(sfNum(maxRowsLike, 12))));
  const out = [];
  for (let i = rows.length - 1; i >= 0 && out.length < maxRows; i -= 1) {
    const row = rows[i] && typeof rows[i] === "object" ? rows[i] : null;
    if (!row || !Number.isFinite(Number(row.value))) continue;
    out.push({
      idx: i,
      timeSec: Math.floor(sfNum(row.time, 0)),
      ts: sfFormatBarTs(row.time),
      close: Number.isFinite(Number(row.close)) ? Number(row.close) : null,
      value: Number(row.value),
      explain: featureCol ? (featureCol + "=" + Number(row.value).toFixed(4)) : ("特征值=" + Number(row.value).toFixed(4)),
    });
  }
  return out;
}

function renderFeatureEvaluationRuntime(timeSeriesLike, columnsLike, optionsLike) {
  const options = optionsLike && typeof optionsLike === "object" ? optionsLike : {};
  const detailMode = options.detailMode !== false;
  const tf = sfText(options.timeframe || "-", "-");
  const columns = Array.isArray(columnsLike)
    ? columnsLike.filter(function onlyFeatureCols(colLike) { return sfText(colLike, "").indexOf("tc_feat_") === 0; })
    : [];
  const featureCol = columns[0] || "";
  if (!featureCol) {
    return {
      ok: false,
      error: "未找到可展示的特征列",
      sampleRows: [],
      featureLabel: "",
      timeframe: tf,
    };
  }
  const normalizedRows = normalizeFeatureEvalRowsRuntime(timeSeriesLike, featureCol);
  const validBars = normalizedRows.filter(function onlyValidBars(rowLike) {
    const row = rowLike && typeof rowLike === "object" ? rowLike : {};
    return [row.open, row.high, row.low, row.close].every(function each(vLike) {
      return Number.isFinite(Number(vLike));
    });
  });
  if (validBars.length < 8) {
    return {
      ok: false,
      error: "有效 K 线数量不足，无法绘制特征图",
      sampleRows: [],
      featureLabel: featureCol.replace(/^tc_feat_/, ""),
      timeframe: tf,
    };
  }
  const chartWindow = Math.max(24, Math.min(96, Math.floor(sfNum(options.chartWindow, detailMode ? 72 : 48))));
  const chartRows = validBars.slice(-chartWindow).map(function mapRow(row) {
    return {
      time: row.time,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: row.volume,
      featureValue: Number.isFinite(Number(row.value)) ? Number(row.value) : null,
    };
  });
  const validFeatureValues = chartRows
    .map(function mapValue(row) { return Number(row.featureValue); })
    .filter(Number.isFinite);
  if (validFeatureValues.length < 3) {
    return {
      ok: false,
      error: "有效特征点数量不足，无法绘制特征图",
      sampleRows: [],
      featureLabel: featureCol.replace(/^tc_feat_/, ""),
      timeframe: tf,
    };
  }
  const width = detailMode ? 980 : 560;
  const height = detailMode ? 340 : 240;
  const left = detailMode ? 18 : 12;
  const right = width - (detailMode ? 18 : 12);
  const topA = detailMode ? 18 : 12;
  const bottomA = detailMode ? 208 : 144;
  const topB = detailMode ? 236 : 168;
  const bottomB = height - (detailMode ? 22 : 16);
  const candleLayer = buildCandleLayerRuntime(chartRows, left, right, topA, bottomA);
  const featureLabel = featureCol.replace(/^tc_feat_/, "");
  let minFeature = Math.min.apply(null, validFeatureValues);
  let maxFeature = Math.max.apply(null, validFeatureValues);
  if (Math.abs(maxFeature - minFeature) < 1e-9) {
    const center = minFeature;
    minFeature = center - 1;
    maxFeature = center + 1;
  }
  const featurePath = seriesPathWithGapsRuntime(chartRows, "featureValue", minFeature, maxFeature, left, right, topB, bottomB);
  const hasZeroLine = minFeature < 0 && maxFeature > 0;
  const zeroPath = hasZeroLine
    ? seriesPathRuntime([0, 0], minFeature, maxFeature, left, right, topB, bottomB)
    : "";
  const firstLabel = chartRows.length ? sfFormatBarTs(chartRows[0].time) : "-";
  const lastLabel = chartRows.length ? sfFormatBarTs(chartRows[chartRows.length - 1].time) : "-";
  const skippedBarCount = Math.max(0, normalizedRows.length - validBars.length);
  const skippedValueCount = chartRows.filter(function missingValue(row) {
    return !Number.isFinite(Number(row.featureValue));
  }).length;
  const statusParts = [
    "TF=" + sfEscapeHtml(tf),
    "窗口=" + String(chartRows.length) + "根",
  ];
  if (skippedBarCount > 0) statusParts.push("已跳过" + String(skippedBarCount) + "根坏K线");
  if (skippedValueCount > 0) statusParts.push("已忽略" + String(skippedValueCount) + "个坏点");
  const svg = '<svg class="feature-eval-svg' + (detailMode ? " large" : "") + '" viewBox="0 0 ' + width + " " + height + '" preserveAspectRatio="none">'
    + '<path d="' + candleLayer.wickPath + '" fill="none" stroke="rgba(139,148,158,0.55)" stroke-width="1"></path>'
    + candleLayer.bodyHtml
    + '<line x1="' + left + '" y1="' + topB + '" x2="' + right + '" y2="' + topB + '" stroke="rgba(139,148,158,0.18)" stroke-width="1"></line>'
    + '<line x1="' + left + '" y1="' + bottomB + '" x2="' + right + '" y2="' + bottomB + '" stroke="rgba(139,148,158,0.18)" stroke-width="1"></line>'
    + (zeroPath ? ('<path d="' + zeroPath + '" fill="none" stroke="rgba(210,153,34,0.45)" stroke-width="1" stroke-dasharray="4 3"></path>') : "")
    + '<path d="' + featurePath + '" fill="none" stroke="rgba(88,166,255,0.96)" stroke-width="1.7"></path>'
    + '<text x="' + left + '" y="' + (height - 6) + '" fill="rgba(139,148,158,0.86)" font-size="' + (detailMode ? "12" : "10") + '">' + sfEscapeHtml(firstLabel) + "</text>"
    + '<text x="' + right + '" y="' + (height - 6) + '" text-anchor="end" fill="rgba(139,148,158,0.86)" font-size="' + (detailMode ? "12" : "10") + '">' + sfEscapeHtml(lastLabel) + "</text>"
    + '<text x="' + left + '" y="' + (topB - 8) + '" fill="rgba(121,192,255,0.95)" font-size="' + (detailMode ? "12" : "10") + '">' + sfEscapeHtml(featureLabel || "feature") + "</text>"
    + "</svg>";
  return {
    ok: true,
    html: '<div class="feature-eval-chart-card">'
      + '<div class="feature-eval-chart-head">'
      + '<div class="feature-eval-chart-title">K线 + 特征图</div>'
      + '<div class="feature-eval-chart-meta">' + statusParts.join(" · ") + "</div>"
      + "</div>"
      + svg
      + "</div>",
    sampleRows: buildFeatureEvalSampleRowsRuntime(chartRows, featureCol, options.sampleRows || 12),
    featureLabel: featureLabel,
    timeframe: tf,
  };
}

function renderTrendOverlayComponent(paramsLike) {
  const params = paramsLike && typeof paramsLike === "object" ? paramsLike : {};
  const detailMode = Boolean(params.context && params.context.detailMode);
  const feature = params.feature;
  const bars = downsampleRowsRuntime(params.bars || [], detailMode ? 76 : 38);
  if (!bars.length) return { visualHtml: "", sampleRows: [], tf: params.tf || "-", windowSize: params.windowSize || 0 };
  const indicator = downsampleRowsRuntime(getIndicatorSeriesRuntime(feature, params.bars || []).map(function mapSeries(v, idx) {
    return { idx: idx, v: v };
  }), detailMode ? 76 : 38).map(function pick(item) { return item.v; });
  const width = detailMode ? 980 : 460;
  const height = detailMode ? 280 : 96;
  const left = detailMode ? 16 : 8;
  const right = width - (detailMode ? 16 : 8);
  const top = detailMode ? 16 : 8;
  const bottom = detailMode ? 218 : 70;
  const candleLayer = buildCandleLayerRuntime(bars, left, right, top, bottom);
  const validIndicator = indicator.filter(function onlyFinite(v) { return Number.isFinite(sfNum(v, Number.NaN)); });
  const minVal = validIndicator.length ? Math.min.apply(null, validIndicator.concat([candleLayer.min])) : candleLayer.min;
  const maxVal = validIndicator.length ? Math.max.apply(null, validIndicator.concat([candleLayer.max])) : candleLayer.max;
  const linePath = seriesPathRuntime(indicator, minVal, maxVal, left, right, top, bottom);
  const firstLabel = bars.length ? sfFormatBarTs(bars[0].time) : "-";
  const lastLabel = bars.length ? sfFormatBarTs(bars[bars.length - 1].time) : "-";
  const svg = '<svg class="feature-preview-svg' + (detailMode ? " large" : "") + '" viewBox="0 0 ' + width + " " + height + '" preserveAspectRatio="none">'
    + '<path d="' + candleLayer.wickPath + '" fill="none" stroke="rgba(139,148,158,0.55)" stroke-width="1"></path>'
    + candleLayer.bodyHtml
    + '<path d="' + linePath + '" fill="none" stroke="rgba(88,166,255,0.95)" stroke-width="1.6"></path>'
    + '<text x="' + left + '" y="' + (height - (detailMode ? 10 : 2)) + '" fill="rgba(139,148,158,0.86)" font-size="' + (detailMode ? "12" : "8") + '">' + sfEscapeHtml(firstLabel) + "</text>"
    + '<text x="' + right + '" y="' + (height - (detailMode ? 10 : 2)) + '" text-anchor="end" fill="rgba(139,148,158,0.86)" font-size="' + (detailMode ? "12" : "8") + '">' + sfEscapeHtml(lastLabel) + "</text>"
    + "</svg>";
  const fullSeries = getIndicatorSeriesRuntime(feature, params.bars || []);
  return {
    visualHtml: '<div class="meta">模板：K线 + 指标线叠加（趋势） · TF=' + sfEscapeHtml(sfText(params.tf, "-")) + "</div>" + svg,
    sampleRows: buildSampleRowsRuntime(feature, params.bars || [], fullSeries, detailMode ? 10 : 6),
    tf: params.tf || "-",
    windowSize: params.windowSize || 0,
  };
}

function renderMomentumOscillatorComponent(paramsLike) {
  const params = paramsLike && typeof paramsLike === "object" ? paramsLike : {};
  const detailMode = Boolean(params.context && params.context.detailMode);
  const feature = params.feature;
  const bars = downsampleRowsRuntime(params.bars || [], detailMode ? 72 : 36);
  if (!bars.length) return { visualHtml: "", sampleRows: [], tf: params.tf || "-", windowSize: params.windowSize || 0 };
  const width = detailMode ? 980 : 460;
  const height = detailMode ? 320 : 108;
  const left = detailMode ? 16 : 8;
  const right = width - (detailMode ? 16 : 8);
  const topA = detailMode ? 16 : 8;
  const bottomA = detailMode ? 150 : 52;
  const topB = detailMode ? 180 : 64;
  const bottomB = detailMode ? 292 : 98;
  const candleLayer = buildCandleLayerRuntime(bars, left, right, topA, bottomA);
  const fullSeries = getIndicatorSeriesRuntime(feature, params.bars || []);
  const sampledSeries = downsampleRowsRuntime(fullSeries, detailMode ? 72 : 36);
  const valid = sampledSeries.filter(function finite(v) { return Number.isFinite(sfNum(v, Number.NaN)); });
  const minVal = valid.length ? Math.min.apply(null, valid.concat([0])) : 0;
  const maxVal = valid.length ? Math.max.apply(null, valid.concat([100])) : 100;
  const linePath = seriesPathRuntime(sampledSeries, minVal, maxVal, left, right, topB, bottomB);
  const lowLine = seriesPathRuntime([30, 30], 0, 100, left, right, topB, bottomB);
  const highLine = seriesPathRuntime([70, 70], 0, 100, left, right, topB, bottomB);
  const svg = '<svg class="feature-preview-svg' + (detailMode ? " large" : "") + '" viewBox="0 0 ' + width + " " + height + '" preserveAspectRatio="none">'
    + '<path d="' + candleLayer.wickPath + '" fill="none" stroke="rgba(139,148,158,0.55)" stroke-width="1"></path>'
    + candleLayer.bodyHtml
    + '<line x1="' + left + '" y1="' + topB + '" x2="' + right + '" y2="' + topB + '" stroke="rgba(139,148,158,0.20)" stroke-width="1"></line>'
    + '<line x1="' + left + '" y1="' + bottomB + '" x2="' + right + '" y2="' + bottomB + '" stroke="rgba(139,148,158,0.20)" stroke-width="1"></line>'
    + '<path d="' + lowLine + '" fill="none" stroke="rgba(210,153,34,0.45)" stroke-width="1" stroke-dasharray="3 3"></path>'
    + '<path d="' + highLine + '" fill="none" stroke="rgba(248,81,73,0.45)" stroke-width="1" stroke-dasharray="3 3"></path>'
    + '<path d="' + linePath + '" fill="none" stroke="rgba(121,192,255,0.95)" stroke-width="1.5"></path>'
    + "</svg>";
  return {
    visualHtml: '<div class="meta">模板：K线 + 副图震荡指标（动量） · TF=' + sfEscapeHtml(sfText(params.tf, "-")) + "</div>" + svg,
    sampleRows: buildSampleRowsRuntime(feature, params.bars || [], fullSeries, detailMode ? 10 : 6),
    tf: params.tf || "-",
    windowSize: params.windowSize || 0,
  };
}

function renderVolatilityRiskComponent(paramsLike) {
  const params = paramsLike && typeof paramsLike === "object" ? paramsLike : {};
  const detailMode = Boolean(params.context && params.context.detailMode);
  const feature = params.feature;
  const bars = Array.isArray(params.bars) ? params.bars : [];
  if (!bars.length) return { visualHtml: "", sampleRows: [], tf: params.tf || "-", windowSize: params.windowSize || 0 };
  const highs = bars.map(function h(item) { return sfNum(item && item.high, Number.NaN); });
  const lows = bars.map(function l(item) { return sfNum(item && item.low, Number.NaN); });
  const closes = bars.map(function c(item) { return sfNum(item && item.close, Number.NaN); });
  const period = Math.max(2, Math.floor(sfNum(feature.params && feature.params.period, 14)));
  const series = calcAtrSeries(highs, lows, closes, period);
  const sampledSeries = downsampleRowsRuntime(series, detailMode ? 88 : 42);
  const valid = sampledSeries.filter(function finite(v) { return Number.isFinite(sfNum(v, Number.NaN)); });
  const latest = valid.length ? valid[valid.length - 1] : 0;
  const max = valid.length ? Math.max.apply(null, valid) : 1;
  const level = latest >= max * 0.72 ? "高风险" : (latest >= max * 0.42 ? "中风险" : "低风险");
  const levelClass = level === "高风险" ? "warn" : (level === "中风险" ? "ok" : "");
  const width = detailMode ? 980 : 460;
  const height = detailMode ? 240 : 86;
  const left = detailMode ? 16 : 8;
  const right = width - (detailMode ? 16 : 8);
  const top = detailMode ? 30 : 10;
  const bottom = detailMode ? 170 : 62;
  const path = seriesPathRuntime(sampledSeries, Math.min.apply(null, valid.concat([0])), Math.max.apply(null, valid.concat([1])), left, right, top, bottom);
  const svg = '<svg class="feature-preview-svg' + (detailMode ? " large" : "") + '" viewBox="0 0 ' + width + " " + height + '" preserveAspectRatio="none">'
    + '<path d="' + path + '" fill="none" stroke="rgba(210,153,34,0.92)" stroke-width="1.8"></path>'
    + "</svg>";
  const panel = '<div class="meta" style="display:flex;gap:6px;flex-wrap:wrap;">'
    + '<span class="tag ' + levelClass + '">风险等级：' + sfEscapeHtml(level) + "</span>"
    + '<span class="tag">ATR=' + sfEscapeHtml(sfNum(latest, 0).toFixed(4)) + "</span>"
    + '<span class="tag">period=' + sfEscapeHtml(String(period)) + "</span>"
    + "</div>";
  return {
    visualHtml: '<div class="meta">模板：风险等级卡片 + 波动趋势图（波动） · TF=' + sfEscapeHtml(sfText(params.tf, "-")) + "</div>" + panel + svg,
    sampleRows: buildSampleRowsRuntime(feature, bars, series, detailMode ? 10 : 6),
    tf: params.tf || "-",
    windowSize: params.windowSize || 0,
  };
}

function renderVolumeHighlightComponent(paramsLike) {
  const params = paramsLike && typeof paramsLike === "object" ? paramsLike : {};
  const detailMode = Boolean(params.context && params.context.detailMode);
  const feature = params.feature;
  const bars = downsampleRowsRuntime(params.bars || [], detailMode ? 68 : 34);
  if (!bars.length) return { visualHtml: "", sampleRows: [], tf: params.tf || "-", windowSize: params.windowSize || 0 };
  const width = detailMode ? 980 : 460;
  const height = detailMode ? 300 : 106;
  const left = detailMode ? 16 : 8;
  const right = width - (detailMode ? 16 : 8);
  const topA = detailMode ? 18 : 8;
  const bottomA = detailMode ? 152 : 56;
  const topB = detailMode ? 182 : 66;
  const bottomB = detailMode ? 288 : 98;
  const candleLayer = buildCandleLayerRuntime(bars, left, right, topA, bottomA);
  const vols = bars.map(function v(item) { return sfNum(item && item.volume, Number.NaN); });
  const volMa = calcSmaSeries(vols, Math.max(2, Math.floor(sfNum(feature.params && feature.params.period, 14))));
  const vMax = Math.max.apply(null, vols.filter(Number.isFinite).concat([1]));
  const innerW = Math.max(1, right - left);
  const slot = bars.length > 1 ? innerW / (bars.length - 1) : innerW;
  const volRects = [];
  bars.forEach(function eachBar(barLike, idx) {
    const bar = barLike && typeof barLike === "object" ? barLike : {};
    const x = left + idx * slot;
    const volume = sfNum(bar.volume, 0);
    const ratio = volume / Math.max(1e-9, sfNum(volMa[idx], volume || 1));
    const h = ((volume / Math.max(1e-9, vMax)) * (bottomB - topB));
    const y = bottomB - h;
    const color = ratio >= 1.3 ? "rgba(210,153,34,0.85)" : "rgba(88,166,255,0.52)";
    const w = Math.max(1.4, Math.min(6.6, slot * 0.52));
    volRects.push('<rect x="' + (x - w / 2).toFixed(2) + '" y="' + y.toFixed(2) + '" width="' + w.toFixed(2) + '" height="' + h.toFixed(2) + '" fill="' + color + '"></rect>');
  });
  const svg = '<svg class="feature-preview-svg' + (detailMode ? " large" : "") + '" viewBox="0 0 ' + width + " " + height + '" preserveAspectRatio="none">'
    + '<path d="' + candleLayer.wickPath + '" fill="none" stroke="rgba(139,148,158,0.55)" stroke-width="1"></path>'
    + candleLayer.bodyHtml
    + volRects.join("")
    + "</svg>";
  const fullSeries = calcSmaSeries((params.bars || []).map(function m(item) { return sfNum(item && item.volume, Number.NaN); }), Math.max(2, Math.floor(sfNum(feature.params && feature.params.period, 14))));
  return {
    visualHtml: '<div class="meta">模板：K线 + 成交量高亮（成交量） · TF=' + sfEscapeHtml(sfText(params.tf, "-")) + "</div>" + svg,
    sampleRows: buildSampleRowsRuntime(feature, params.bars || [], fullSeries, detailMode ? 10 : 6),
    tf: params.tf || "-",
    windowSize: params.windowSize || 0,
  };
}

function renderStructureLevelsComponent(paramsLike) {
  const params = paramsLike && typeof paramsLike === "object" ? paramsLike : {};
  const detailMode = Boolean(params.context && params.context.detailMode);
  const feature = params.feature;
  const bars = downsampleRowsRuntime(params.bars || [], detailMode ? 80 : 40);
  if (!bars.length) return { visualHtml: "", sampleRows: [], tf: params.tf || "-", windowSize: params.windowSize || 0 };
  const width = detailMode ? 980 : 460;
  const height = detailMode ? 270 : 92;
  const left = detailMode ? 16 : 8;
  const right = width - (detailMode ? 16 : 8);
  const top = detailMode ? 16 : 8;
  const bottom = detailMode ? 226 : 72;
  const candleLayer = buildCandleLayerRuntime(bars, left, right, top, bottom);
  const lookback = Math.max(8, Math.min(48, Math.floor(sfNum(feature.params && feature.params.lookback, 20))));
  const focus = bars.slice(-lookback);
  const high = Math.max.apply(null, focus.map(function m(item) { return sfNum(item && item.high, Number.NaN); }).filter(Number.isFinite).concat([candleLayer.max]));
  const low = Math.min.apply(null, focus.map(function m(item) { return sfNum(item && item.low, Number.NaN); }).filter(Number.isFinite).concat([candleLayer.min]));
  const levelTopY = top + (1 - ((high - candleLayer.min) / Math.max(1e-9, candleLayer.max - candleLayer.min))) * (bottom - top);
  const levelBottomY = top + (1 - ((low - candleLayer.min) / Math.max(1e-9, candleLayer.max - candleLayer.min))) * (bottom - top);
  const lastClose = sfNum(bars[bars.length - 1] && bars[bars.length - 1].close, 0);
  const trigger = lastClose >= high ? "突破上沿" : (lastClose <= low ? "跌破下沿" : "区间内");
  const triggerColor = trigger === "区间内" ? "rgba(139,148,158,0.86)" : "rgba(210,153,34,0.9)";
  const svg = '<svg class="feature-preview-svg' + (detailMode ? " large" : "") + '" viewBox="0 0 ' + width + " " + height + '" preserveAspectRatio="none">'
    + '<path d="' + candleLayer.wickPath + '" fill="none" stroke="rgba(139,148,158,0.55)" stroke-width="1"></path>'
    + candleLayer.bodyHtml
    + '<line x1="' + left + '" y1="' + levelTopY.toFixed(2) + '" x2="' + right + '" y2="' + levelTopY.toFixed(2) + '" stroke="rgba(210,153,34,0.75)" stroke-width="1.2" stroke-dasharray="4 3"></line>'
    + '<line x1="' + left + '" y1="' + levelBottomY.toFixed(2) + '" x2="' + right + '" y2="' + levelBottomY.toFixed(2) + '" stroke="rgba(88,166,255,0.75)" stroke-width="1.2" stroke-dasharray="4 3"></line>'
    + '<text x="' + right + '" y="' + (top + 10) + '" text-anchor="end" fill="' + triggerColor + '" font-size="9">' + sfEscapeHtml(trigger) + "</text>"
    + "</svg>";
  const fullSeries = getIndicatorSeriesRuntime(feature, params.bars || []);
  return {
    visualHtml: '<div class="meta">模板：K线 + 关键位/箱体/触发标记（结构） · TF=' + sfEscapeHtml(sfText(params.tf, "-")) + "</div>" + svg,
    sampleRows: buildSampleRowsRuntime(feature, params.bars || [], fullSeries, detailMode ? 10 : 6),
    tf: params.tf || "-",
    windowSize: params.windowSize || 0,
  };
}

function renderRiskPanelComponent(paramsLike) {
  const params = paramsLike && typeof paramsLike === "object" ? paramsLike : {};
  const detailMode = Boolean(params.context && params.context.detailMode);
  const feature = params.feature;
  const bars = Array.isArray(params.bars) ? params.bars : [];
  const rows = bars.slice(-8);
  const riskScores = rows.map(function each(item) {
    const high = sfNum(item && item.high, 0);
    const low = sfNum(item && item.low, 0);
    const close = Math.max(1e-9, sfNum(item && item.close, 0));
    return ((high - low) / close) * 100;
  });
  const last = riskScores.length ? riskScores[riskScores.length - 1] : 0;
  const max = riskScores.length ? Math.max.apply(null, riskScores) : 0;
  const riskState = last >= max * 0.75 ? "限制开仓" : (last >= max * 0.45 ? "谨慎执行" : "正常执行");
  const panel = '<div class="detail-block">'
    + '<div class="detail-title">风控状态面板</div>'
    + '<div class="meta">当前状态：<span class="tag ' + (riskState === "限制开仓" ? "warn" : "ok") + '">' + sfEscapeHtml(riskState) + "</span></div>"
    + '<div class="meta">输出类型：' + sfEscapeHtml(feature.outputTypeLabel) + "</div>"
    + '<div class="meta">波动代理值：' + sfEscapeHtml(last.toFixed(3)) + "%</div>"
    + "</div>";
  const derivedRows = rows.map(function mapRow(item, idx) {
    return {
      idx: idx,
      timeSec: Math.floor(sfNum(item && item.time, 0)),
      ts: sfFormatBarTs(item && item.time),
      close: sfNum(item && item.close, Number.NaN),
      value: sfNum(riskScores[idx], 0),
      explain: sfNum(riskScores[idx], 0) >= max * 0.75 ? "触发风险约束" : "风险可控",
    };
  }).reverse().slice(0, detailMode ? 10 : 6);
  return {
    visualHtml: '<div class="meta">模板：状态面板展示（风控，无需K线）</div>' + panel,
    sampleRows: derivedRows,
    tf: params.tf || "-",
    windowSize: params.windowSize || 0,
  };
}

const FEATURE_DISPLAY_COMPONENTS = {
  trend_overlay: renderTrendOverlayComponent,
  momentum_oscillator: renderMomentumOscillatorComponent,
  volatility_risk: renderVolatilityRiskComponent,
  volume_highlight: renderVolumeHighlightComponent,
  structure_levels: renderStructureLevelsComponent,
  risk_panel: renderRiskPanelComponent,
};

function renderFeatureVisualizationRuntime(featureLike, contextLike) {
  const feature = normalizeStrategyFeatureRuntime(featureLike);
  const context = contextLike && typeof contextLike === "object" ? contextLike : {};
  const detailMode = Boolean(context.detailMode);
  const barsPayload = resolvePreviewBarsRuntime(context);
  const component = FEATURE_DISPLAY_COMPONENTS[feature.displayMode]
    || FEATURE_DISPLAY_COMPONENTS[(FEATURE_MAIN_CATEGORY_CONFIG[feature.mainCategory] || {}).displayMode]
    || FEATURE_DISPLAY_COMPONENTS.trend_overlay;
  const result = component({
    feature: feature,
    bars: barsPayload.bars,
    tf: barsPayload.tf,
    windowSize: barsPayload.windowSize,
    context: context,
  }) || { visualHtml: "", sampleRows: [], tf: barsPayload.tf, windowSize: barsPayload.windowSize };
  const sampleTable = buildSampleTableRuntime(result.sampleRows, result.tf || barsPayload.tf, { detailMode: detailMode });
  return {
    html: result.visualHtml + (sampleTable || ""),
    tf: sfText(result.tf || barsPayload.tf || "-"),
    windowSize: Math.floor(sfNum(result.windowSize || barsPayload.windowSize || 0)),
  };
}

    return {
      renderFeatureVisualizationRuntime,
      renderFeatureEvaluationRuntime,
      resolvePreviewBarsRuntime,
    };
  }

  globalObj.createStrategyFeatureVisualRuntime = createStrategyFeatureVisualRuntime;
})(typeof window !== "undefined" ? window : this);
