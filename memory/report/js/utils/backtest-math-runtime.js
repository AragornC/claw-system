(function(globalObj) {
function btNum(v, digits) {
  const n = Number(v);
  const d = Number.isFinite(Number(digits)) ? Number(digits) : 2;
  return Number.isFinite(n) ? n.toFixed(d) : '-';
}

function btEmaSeries(values, period) {
  const p = Math.max(2, Math.floor(Number(period) || 2));
  const out = new Array(values.length).fill(null);
  const k = 2 / (p + 1);
  let ema = null;
  for (let i = 0; i < values.length; i++) {
    const v = Number(values[i]);
    if (!Number.isFinite(v)) continue;
    ema = (ema == null) ? v : (v * k + ema * (1 - k));
    out[i] = ema;
  }
  return out;
}

function btAtrSeries(bars, period) {
  const p = Math.max(2, Math.floor(Number(period) || 14));
  const tr = new Array(bars.length).fill(null);
  for (let i = 0; i < bars.length; i++) {
    const h = Number(bars[i]?.high), l = Number(bars[i]?.low);
    if (!Number.isFinite(h) || !Number.isFinite(l)) continue;
    if (i === 0) {
      tr[i] = h - l;
      continue;
    }
    const pc = Number(bars[i - 1]?.close);
    tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  const out = new Array(bars.length).fill(null);
  let atr = 0;
  for (let i = 0; i < bars.length; i++) {
    if (!Number.isFinite(tr[i])) continue;
    if (i < p) {
      atr += tr[i];
      if (i === p - 1) {
        atr = atr / p;
        out[i] = atr;
      }
    } else {
      atr = ((atr * (p - 1)) + tr[i]) / p;
      out[i] = atr;
    }
  }
  return out;
}

function btAdxSeries(bars, period) {
  const p = Math.max(2, Math.floor(Number(period) || 14));
  const len = bars.length;
  const out = new Array(len).fill(null);
  if (len < p * 2 + 1) return out;
  const tr = new Array(len).fill(0);
  const pdm = new Array(len).fill(0);
  const mdm = new Array(len).fill(0);
  for (let i = 1; i < len; i++) {
    const upMove = Number(bars[i].high) - Number(bars[i - 1].high);
    const downMove = Number(bars[i - 1].low) - Number(bars[i].low);
    pdm[i] = (upMove > downMove && upMove > 0) ? upMove : 0;
    mdm[i] = (downMove > upMove && downMove > 0) ? downMove : 0;
    const h = Number(bars[i].high), l = Number(bars[i].low), pc = Number(bars[i - 1].close);
    tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }

  let trSm = 0, pdmSm = 0, mdmSm = 0;
  for (let i = 1; i <= p; i++) {
    trSm += tr[i];
    pdmSm += pdm[i];
    mdmSm += mdm[i];
  }
  const dx = new Array(len).fill(null);
  for (let i = p + 1; i < len; i++) {
    trSm = trSm - (trSm / p) + tr[i];
    pdmSm = pdmSm - (pdmSm / p) + pdm[i];
    mdmSm = mdmSm - (mdmSm / p) + mdm[i];
    if (trSm <= 0) continue;
    const pdi = 100 * (pdmSm / trSm);
    const mdi = 100 * (mdmSm / trSm);
    const den = pdi + mdi;
    if (den <= 0) continue;
    dx[i] = 100 * Math.abs(pdi - mdi) / den;
  }
  let adxSum = 0;
  let adxStart = p * 2;
  let count = 0;
  for (let i = p + 1; i <= adxStart && i < len; i++) {
    if (Number.isFinite(dx[i])) {
      adxSum += dx[i];
      count += 1;
    }
  }
  if (!count) return out;
  let adx = adxSum / count;
  out[adxStart] = adx;
  for (let i = adxStart + 1; i < len; i++) {
    if (!Number.isFinite(dx[i])) {
      out[i] = adx;
      continue;
    }
    adx = ((adx * (p - 1)) + dx[i]) / p;
    out[i] = adx;
  }
  return out;
}

function btSmaSeries(values, period) {
  const p = Math.max(2, Math.floor(Number(period) || 2));
  const out = new Array(values.length).fill(null);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < values.length; i++) {
    const v = Number(values[i]);
    if (Number.isFinite(v)) {
      sum += v;
      count += 1;
    }
    if (i >= p) {
      const prev = Number(values[i - p]);
      if (Number.isFinite(prev)) {
        sum -= prev;
        count -= 1;
      }
    }
    if (i >= p - 1 && count > 0) out[i] = sum / count;
  }
  return out;
}

function btRsiSeries(values, period) {
  const p = Math.max(2, Math.floor(Number(period) || 14));
  const out = new Array(values.length).fill(null);
  if (!Array.isArray(values) || values.length < p + 1) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= p; i++) {
    const diff = Number(values[i]) - Number(values[i - 1]);
    if (!Number.isFinite(diff)) continue;
    if (diff >= 0) gain += diff;
    else loss += Math.abs(diff);
  }
  let avgGain = gain / p;
  let avgLoss = loss / p;
  out[p] = avgLoss <= 1e-12 ? 100 : (100 - (100 / (1 + avgGain / avgLoss)));
  for (let i = p + 1; i < values.length; i++) {
    const diff = Number(values[i]) - Number(values[i - 1]);
    const g = Number.isFinite(diff) && diff > 0 ? diff : 0;
    const l = Number.isFinite(diff) && diff < 0 ? Math.abs(diff) : 0;
    avgGain = ((avgGain * (p - 1)) + g) / p;
    avgLoss = ((avgLoss * (p - 1)) + l) / p;
    out[i] = avgLoss <= 1e-12 ? 100 : (100 - (100 / (1 + avgGain / avgLoss)));
  }
  return out;
}

function btPctChangeSeries(values, period) {
  const p = Math.max(1, Math.floor(Number(period) || 1));
  const out = new Array(values.length).fill(null);
  for (let i = p; i < values.length; i++) {
    const now = Number(values[i]);
    const prev = Number(values[i - p]);
    if (!Number.isFinite(now) || !Number.isFinite(prev) || prev === 0) continue;
    out[i] = ((now - prev) / prev) * 100;
  }
  return out;
}

function btShiftSeries(values, shift) {
  const s = Math.trunc(Number(shift) || 0);
  if (!s) return values.slice();
  const out = new Array(values.length).fill(null);
  for (let i = 0; i < values.length; i++) {
    const src = i - s;
    if (src < 0 || src >= values.length) continue;
    out[i] = values[src];
  }
  return out;
}

function btSourceSeries(bars, source) {
  const src = String(source || 'close').toLowerCase();
  if (src === 'open') return bars.map(function(b) { return Number(b.open); });
  if (src === 'high') return bars.map(function(b) { return Number(b.high); });
  if (src === 'low') return bars.map(function(b) { return Number(b.low); });
  if (src === 'volume') return bars.map(function(b) { return Number(b.volume); });
  if (src === 'hl2') return bars.map(function(b) { return (Number(b.high) + Number(b.low)) / 2; });
  if (src === 'ohlc4') {
    return bars.map(function(b) {
      return (Number(b.open) + Number(b.high) + Number(b.low) + Number(b.close)) / 4;
    });
  }
  return bars.map(function(b) { return Number(b.close); });
}

function btBuildDslFeatureMap(bars, dsl) {
  const featureDefs = Array.isArray(dsl?.features) ? dsl.features : [];
  const out = {};
  featureDefs.slice(0, 24).forEach(function(def, idx) {
    if (!def || typeof def !== 'object') return;
    const nameRaw = String(def.name || '').trim();
    const name = /^[a-z][a-z0-9_]{0,31}$/i.test(nameRaw) ? nameRaw : ('f_' + (idx + 1));
    const kind = String(def.kind || '').toLowerCase();
    const sourceValues = btSourceSeries(bars, def.source || 'close');
    let series = null;
    if (kind === 'price') {
      series = sourceValues.slice();
    } else if (kind === 'ema') {
      series = btEmaSeries(sourceValues, Number(def.period || 14));
    } else if (kind === 'sma') {
      series = btSmaSeries(sourceValues, Number(def.period || 14));
    } else if (kind === 'rsi') {
      series = btRsiSeries(sourceValues, Number(def.period || 14));
    } else if (kind === 'atr') {
      series = btAtrSeries(bars, Number(def.period || 14));
    } else if (kind === 'adx') {
      series = btAdxSeries(bars, Number(def.period || 14));
    } else if (kind === 'donchian_high') {
      const lb = Math.max(2, Math.floor(Number(def.lookback || 20)));
      series = bars.map(function(_, i) { return btDonchianPrevHigh(bars, i, lb); });
    } else if (kind === 'donchian_low') {
      const lb = Math.max(2, Math.floor(Number(def.lookback || 20)));
      series = bars.map(function(_, i) { return btDonchianPrevLow(bars, i, lb); });
    } else if (kind === 'pct_change') {
      series = btPctChangeSeries(sourceValues, Number(def.period || 1));
    } else if (kind === 'constant') {
      const v = Number.isFinite(Number(def.value)) ? Number(def.value) : 0;
      series = new Array(bars.length).fill(v);
    }
    if (!Array.isArray(series) || !series.length) return;
    const shift = Number(def.shift || 0);
    out[name] = shift ? btShiftSeries(series, shift) : series;
  });
  return out;
}

function btCompileDslBoolExpr(expr, varNames) {
  const sourceRaw = String(expr || '').trim();
  if (!sourceRaw) return null;
  const source = sourceRaw
    .replace(/并且|且/g, '&&')
    .replace(/或者|或/g, '||')
    .replace(/\band\b/gi, '&&')
    .replace(/\bor\b/gi, '||')
    .trim();
  if (!source || source.length > 280) return null;
  if (!/^[a-zA-Z0-9_\s().,+\-*/%<>=!&|?:]+$/.test(source)) return null;
  const ids = source.match(/\b[a-zA-Z_][a-zA-Z0-9_]*\b/g) || [];
  const fnNames = ['abs', 'min', 'max', 'pow', 'sqrt', 'floor', 'ceil', 'round', 'log', 'exp'];
  const allowed = new Set([].concat(varNames, fnNames, ['true', 'false', 'null']));
  for (let i = 0; i < ids.length; i++) {
    if (!allowed.has(ids[i])) return null;
  }
  let fn = null;
  try {
    fn = Function.apply(null, [].concat(varNames, fnNames, ['return (' + source + ');']));
  } catch (_) {
    fn = null;
  }
  if (!fn) return null;
  return function(row) {
    try {
      const args = varNames.map(function(k) { return row[k]; });
      const out = fn.apply(
        null,
        args.concat([Math.abs, Math.min, Math.max, Math.pow, Math.sqrt, Math.floor, Math.ceil, Math.round, Math.log, Math.exp]),
      );
      if (typeof out === 'boolean') return out;
      const n = Number(out);
      return Number.isFinite(n) ? n > 0 : false;
    } catch (_) {
      return false;
    }
  };
}


function btMapSeriesByTime(lowerBars, higherBars, values) {
  const out = new Array(lowerBars.length).fill(null);
  let j = 0;
  let last = null;
  for (let i = 0; i < lowerBars.length; i++) {
    const t = Number(lowerBars[i]?.time);
    while (j < higherBars.length && Number(higherBars[j]?.time) <= t) {
      last = values[j];
      j += 1;
    }
    out[i] = last;
  }
  return out;
}

function btDonchianPrevHigh(bars, i, lookback) {
  const lb = Math.max(2, lookback);
  if (i - lb < 0) return null;
  let h = -Infinity;
  for (let k = i - lb; k < i; k++) {
    const v = Number(bars[k]?.high);
    if (Number.isFinite(v) && v > h) h = v;
  }
  return Number.isFinite(h) ? h : null;
}

function btDonchianPrevLow(bars, i, lookback) {
  const lb = Math.max(2, lookback);
  if (i - lb < 0) return null;
  let l = Infinity;
  for (let k = i - lb; k < i; k++) {
    const v = Number(bars[k]?.low);
    if (Number.isFinite(v) && v < l) l = v;
  }
  return Number.isFinite(l) ? l : null;
}

  globalObj.backtestMathRuntime = {
    btNum: btNum,
    btEmaSeries: btEmaSeries,
    btAtrSeries: btAtrSeries,
    btAdxSeries: btAdxSeries,
    btSmaSeries: btSmaSeries,
    btRsiSeries: btRsiSeries,
    btPctChangeSeries: btPctChangeSeries,
    btShiftSeries: btShiftSeries,
    btSourceSeries: btSourceSeries,
    btBuildDslFeatureMap: btBuildDslFeatureMap,
    btCompileDslBoolExpr: btCompileDslBoolExpr,
    btMapSeriesByTime: btMapSeriesByTime,
    btDonchianPrevHigh: btDonchianPrevHigh,
    btDonchianPrevLow: btDonchianPrevLow,
  };
})(typeof window !== 'undefined' ? window : this);
