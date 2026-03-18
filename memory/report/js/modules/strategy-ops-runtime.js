(function(globalObj) {
  function soText(valueLike, fallback = "") {
    const s = String(valueLike == null ? "" : valueLike).trim();
    return s || String(fallback || "");
  }

  function soNum(valueLike, fallback = 0) {
    const n = Number(valueLike);
    return Number.isFinite(n) ? n : Number(fallback || 0);
  }

  function soEsc(valueLike) {
    return String(valueLike == null ? "" : valueLike)
      .split("&").join("&amp;")
      .split("<").join("&lt;")
      .split(">").join("&gt;")
      .split('"').join("&quot;")
      .split("'").join("&#39;");
  }

  function soFmtPct(valueLike, digits = 2) {
    const n = soNum(valueLike, 0);
    const sign = n > 0 ? "+" : "";
    return sign + n.toFixed(Math.max(0, Math.min(4, Number(digits) || 2))) + "%";
  }

  function soFmtTs(valueLike) {
    const raw = String(valueLike == null ? "" : valueLike).trim();
    if (!raw) return "-";
    const dt = new Date(raw);
    if (!Number.isFinite(dt.getTime())) return raw;
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, "0");
    const d = String(dt.getDate()).padStart(2, "0");
    const hh = String(dt.getHours()).padStart(2, "0");
    const mm = String(dt.getMinutes()).padStart(2, "0");
    return y + "-" + m + "-" + d + " " + hh + ":" + mm;
  }

  function soStatusLabel(statusLike) {
    const status = soText(statusLike).toLowerCase();
    if (status === "draft") return "草稿";
    if (status === "backtested") return "已回测";
    if (status === "paper_live") return "模拟中";
    if (status === "live") return "实盘中";
    if (status === "paused") return "已暂停";
    if (status === "risk_paused") return "风控暂停";
    return status || "-";
  }

  function soEnvLabel(envLike) {
    const env = soText(envLike).toLowerCase();
    if (env === "backtest") return "回测";
    if (env === "paper") return "模拟";
    if (env === "live") return "实盘";
    return env || "-";
  }

  function soTradeTypeLabel(typeLike) {
    const type = soText(typeLike).toLowerCase();
    if (type === "buy") return "买入";
    if (type === "sell") return "卖出";
    if (type === "add") return "加仓";
    if (type === "reduce") return "减仓";
    if (type === "close") return "平仓";
    if (type === "risk_trigger") return "风控触发";
    return type || "-";
  }

  function soTradeColor(typeLike) {
    const type = soText(typeLike).toLowerCase();
    if (type === "buy") return "#3fb950";
    if (type === "sell") return "#f85149";
    if (type === "add") return "#79c0ff";
    if (type === "reduce") return "#f2cc60";
    if (type === "close") return "#a5d6ff";
    if (type === "risk_trigger") return "#ff7b72";
    return "#8b949e";
  }

  function soTradingModeLabel(modeLike) {
    const mode = soText(modeLike).toLowerCase();
    if (mode === "live") return "实盘交易";
    if (mode === "paper") return "模拟交易";
    return "回测交易";
  }

  function normalizeBarsRuntime(barsLike) {
    const rows = Array.isArray(barsLike) ? barsLike : [];
    return rows
      .map(function(item) {
        const row = item && typeof item === "object" ? item : {};
        const timeRaw = soNum(row.time || row.ts || row.t || 0, 0);
        const time = timeRaw > 9_999_999_999 ? Math.floor(timeRaw / 1000) : Math.floor(timeRaw);
        const open = soNum(row.open, NaN);
        const high = soNum(row.high, NaN);
        const low = soNum(row.low, NaN);
        const close = soNum(row.close, NaN);
        if (!Number.isFinite(time) || time <= 0 || !Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) {
          return null;
        }
        return { time: time, open: open, high: high, low: low, close: close };
      })
      .filter(Boolean)
      .sort(function(a, b) { return a.time - b.time; });
  }

  function buildSyntheticBarsFromEventsRuntime(eventsLike, rangeDaysLike) {
    const rows = Array.isArray(eventsLike) ? eventsLike : [];
    const rangeDays = Math.max(1, Math.min(365, Math.floor(soNum(rangeDaysLike, 30))));
    const pointCount = Math.max(120, Math.min(1800, rangeDays * 24));
    let baseTime = 0;
    if (rows.length) {
      const first = rows[0] && typeof rows[0] === "object" ? rows[0] : {};
      baseTime = Math.floor(soNum(first.time, 0));
    }
    if (!baseTime) baseTime = Math.floor(Date.now() / 1000);
    const stepSec = 3600;
    const start = baseTime - pointCount * stepSec;
    const bars = [];
    let price = 50000;
    for (let i = 0; i < pointCount; i += 1) {
      const t = start + i * stepSec;
      const drift = Math.sin(i / 11) * 42 + Math.cos(i / 17) * 30 + (i % 41 === 0 ? 120 : -8);
      const open = price;
      const close = Math.max(1000, open + drift);
      const high = Math.max(open, close) + Math.abs(Math.sin(i / 7) * 22) + 8;
      const low = Math.min(open, close) - Math.abs(Math.cos(i / 9) * 20) - 8;
      bars.push({ time: t, open: open, high: high, low: low, close: close });
      price = close;
    }
    if (rows.length) {
      rows.forEach(function(ev, idx) {
        const event = ev && typeof ev === "object" ? ev : {};
        const t = Math.floor(soNum(event.time, 0));
        if (!t) return;
        let nearestIdx = 0;
        let nearestGap = Math.abs(bars[0].time - t);
        for (let i = 1; i < bars.length; i += 1) {
          const gap = Math.abs(bars[i].time - t);
          if (gap < nearestGap) {
            nearestGap = gap;
            nearestIdx = i;
          }
        }
        const bar = bars[nearestIdx];
        const force = soNum(event.price, bar.close || price);
        bar.high = Math.max(bar.high, force + 12 + idx % 5);
        bar.low = Math.min(bar.low, force - 12 - idx % 5);
        bar.close = force;
      });
    }
    return bars;
  }

  function pickBarsForRangeRuntime(ohlcvByTfLike, rangeDaysLike) {
    const map = ohlcvByTfLike && typeof ohlcvByTfLike === "object" ? ohlcvByTfLike : {};
    let tf = "1h";
    let rows = normalizeBarsRuntime(map["1h"]);
    if (!rows.length) {
      const keys = Object.keys(map);
      for (let i = 0; i < keys.length; i += 1) {
        const k = keys[i];
        const normalized = normalizeBarsRuntime(map[k]);
        if (normalized.length) {
          tf = k;
          rows = normalized;
          break;
        }
      }
    }
    const rangeDays = Math.max(1, Math.min(365, Math.floor(soNum(rangeDaysLike, 30))));
    const fromSec = Math.floor(Date.now() / 1000) - rangeDays * 86400;
    const filtered = rows.filter(function(item) { return item.time >= fromSec; });
    return {
      tf: tf,
      bars: filtered.length ? filtered : rows.slice(-Math.max(80, rangeDays * 10)),
    };
  }

  function buildLinePathRuntime(valuesLike, minY, maxY, width, height, padX, padY) {
    const rows = Array.isArray(valuesLike) ? valuesLike : [];
    if (!rows.length) return "";
    const innerW = Math.max(1, width - padX * 2);
    const innerH = Math.max(1, height - padY * 2);
    const span = Math.max(1e-9, maxY - minY);
    let d = "";
    for (let i = 0; i < rows.length; i += 1) {
      const x = padX + (i / Math.max(1, rows.length - 1)) * innerW;
      const y = padY + ((maxY - rows[i]) / span) * innerH;
      d += (i === 0 ? "M" : "L") + x.toFixed(2) + " " + y.toFixed(2) + " ";
    }
    return d.trim();
  }

  function resolveMarkerIndexByTimeRuntime(timeSec, bars) {
    if (!Array.isArray(bars) || !bars.length) return -1;
    let bestIdx = 0;
    let bestGap = Math.abs(bars[0].time - timeSec);
    for (let i = 1; i < bars.length; i += 1) {
      const gap = Math.abs(bars[i].time - timeSec);
      if (gap < bestGap) {
        bestGap = gap;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  function renderKlineChartRuntime(paramsLike) {
    const params = paramsLike && typeof paramsLike === "object" ? paramsLike : {};
    const bars = Array.isArray(params.bars) ? params.bars : [];
    const events = Array.isArray(params.events) ? params.events : [];
    const width = 1100;
    const height = 340;
    const padX = 42;
    const padY = 18;
    const innerW = width - padX * 2;
    const innerH = height - padY * 2;
    if (!bars.length) {
      return {
        svg: '<svg viewBox="0 0 1100 340"><text x="30" y="48" fill="#8b949e" font-size="13">暂无K线数据</text></svg>',
        markerEvents: [],
      };
    }
    const minPrice = Math.min.apply(null, bars.map(function(item) { return soNum(item.low, item.close); }));
    const maxPrice = Math.max.apply(null, bars.map(function(item) { return soNum(item.high, item.close); }));
    const span = Math.max(1e-9, maxPrice - minPrice);
    const candleW = Math.max(2, Math.min(11, Math.floor(innerW / Math.max(1, bars.length) * 0.66)));
    function xOf(idx) {
      return padX + (idx / Math.max(1, bars.length - 1)) * innerW;
    }
    function yOf(price) {
      return padY + ((maxPrice - price) / span) * innerH;
    }
    const candleHtml = [];
    for (let i = 0; i < bars.length; i += 1) {
      const bar = bars[i];
      const x = xOf(i);
      const openY = yOf(bar.open);
      const closeY = yOf(bar.close);
      const highY = yOf(bar.high);
      const lowY = yOf(bar.low);
      const isUp = bar.close >= bar.open;
      const color = isUp ? "#3fb950" : "#f85149";
      const bodyY = Math.min(openY, closeY);
      const bodyH = Math.max(1.2, Math.abs(closeY - openY));
      candleHtml.push('<line x1="' + x.toFixed(2) + '" y1="' + highY.toFixed(2) + '" x2="' + x.toFixed(2) + '" y2="' + lowY.toFixed(2) + '" stroke="' + color + '" stroke-width="1" opacity="0.85"></line>');
      candleHtml.push('<rect x="' + (x - candleW / 2).toFixed(2) + '" y="' + bodyY.toFixed(2) + '" width="' + candleW + '" height="' + bodyH.toFixed(2) + '" rx="1.2" fill="' + color + '" opacity="0.82"></rect>');
    }
    const markerEvents = [];
    const markerHtml = [];
    events.forEach(function(ev, idx) {
      const event = ev && typeof ev === "object" ? ev : {};
      const eventTime = Math.floor(soNum(event.time, 0));
      if (eventTime <= 0) return;
      const barIdx = resolveMarkerIndexByTimeRuntime(eventTime, bars);
      if (barIdx < 0 || barIdx >= bars.length) return;
      const bar = bars[barIdx];
      const tradeType = soText(event.tradeType || "");
      const color = soTradeColor(tradeType);
      const x = xOf(barIdx);
      const yBase = tradeType === "buy" || tradeType === "add"
        ? yOf(Math.max(bar.low - span * 0.01, minPrice))
        : yOf(Math.min(bar.high + span * 0.01, maxPrice));
      const y = Math.max(8, Math.min(height - 8, yBase));
      markerEvents.push({
        ...event,
        markerX: x,
        markerY: y,
        barIndex: barIdx,
      });
      markerHtml.push(
        '<circle class="strategy-trade-marker" data-trade-index="' + idx + '" cx="' + x.toFixed(2) + '" cy="' + y.toFixed(2) + '" r="4.2" fill="' + color + '" stroke="#0d1117" stroke-width="1.2" style="cursor:pointer;"></circle>',
      );
    });
    const tickCount = 5;
    const axisHtml = [];
    for (let i = 0; i < tickCount; i += 1) {
      const idx = Math.floor((i / Math.max(1, tickCount - 1)) * (bars.length - 1));
      const x = xOf(idx);
      const ts = soFmtTs(new Date(bars[idx].time * 1000).toISOString()).slice(5, 16);
      axisHtml.push('<line x1="' + x.toFixed(2) + '" y1="' + (height - 20) + '" x2="' + x.toFixed(2) + '" y2="' + (height - 16) + '" stroke="#6e7681" stroke-width="1"></line>');
      axisHtml.push('<text x="' + x.toFixed(2) + '" y="' + (height - 4) + '" fill="#6e7681" font-size="10" text-anchor="middle">' + soEsc(ts) + '</text>');
    }
    const svg = ""
      + '<svg viewBox="0 0 ' + width + " " + height + '" preserveAspectRatio="none">'
      + '<rect x="0" y="0" width="' + width + '" height="' + height + '" fill="transparent"></rect>'
      + '<line x1="' + padX + '" y1="' + (height - 20) + '" x2="' + (width - padX) + '" y2="' + (height - 20) + '" stroke="#30363d" stroke-width="1"></line>'
      + candleHtml.join("")
      + markerHtml.join("")
      + axisHtml.join("")
      + "</svg>";
    return { svg: svg, markerEvents: markerEvents };
  }

  function renderLineChartRuntime(valuesLike, key, color, title) {
    const rows = Array.isArray(valuesLike) ? valuesLike : [];
    if (!rows.length) {
      return '<div class="strategy-chart-title">' + soEsc(title || "") + '</div><svg viewBox="0 0 1100 150"><text x="26" y="42" fill="#8b949e" font-size="12">暂无数据</text></svg>';
    }
    const values = rows.map(function(item) { return soNum(item && item[key], 0); });
    const minV = Math.min.apply(null, values);
    const maxV = Math.max.apply(null, values);
    const width = 1100;
    const height = 150;
    const path = buildLinePathRuntime(values, minV, maxV, width, height, 36, 14);
    const firstV = values[0];
    const lastV = values[values.length - 1];
    const diff = lastV - firstV;
    const diffText = (diff > 0 ? "+" : "") + diff.toFixed(4);
    return ""
      + '<div class="strategy-chart-title"><span>' + soEsc(title || "") + '</span><span>' + soEsc(diffText) + "</span></div>"
      + '<svg viewBox="0 0 ' + width + " " + height + '" preserveAspectRatio="none">'
      + '<path d="' + path + '" fill="none" stroke="' + soEsc(color || "#79c0ff") + '" stroke-width="2"></path>'
      + "</svg>";
  }

  function normalizeFeatureRelationsRuntime(detailLike) {
    const detail = detailLike && typeof detailLike === "object" ? detailLike : {};
    const rows = Array.isArray(detail?.details?.featureRelations)
      ? detail.details.featureRelations
      : [];
    const categoryLabels = {
      trend: "趋势类",
      momentum: "动量类",
      volatility: "波动类",
      volume: "成交量类",
      structure: "结构类",
      risk: "风控类",
    };
    if (rows.length) {
      return rows.map(function(item) {
        const row = item && typeof item === "object" ? item : {};
        const mainCategory = soText(row.mainCategory || "", "other");
        return {
          featureRef: soText(row.featureRef || row.featureId || row.featureName || ""),
          featureName: soText(row.featureName || row.featureRef || row.featureId || ""),
          featureVersion: soText(row.featureVersion || "v1.0.0"),
          relationType: soText(row.relationType || "signal_input"),
          mainCategory: mainCategory,
          mainCategoryLabel: soText(row.mainCategoryLabel || categoryLabels[mainCategory] || "其他"),
          outputType: soText(row.outputType || ""),
          outputTypeLabel: soText(row.outputTypeLabel || row.outputType || ""),
          tags: Array.isArray(row.tags) ? row.tags : [],
          tagLabels: Array.isArray(row.tagLabels) ? row.tagLabels : [],
        };
      });
    }
    const version = detail.version && typeof detail.version === "object" ? detail.version : {};
    const signalLayer = version.signalLayer && typeof version.signalLayer === "object" ? version.signalLayer : {};
    const refs = Array.isArray(signalLayer.featureRefs) ? signalLayer.featureRefs : [];
    return refs.map(function(refLike) {
      const ref = soText(refLike || "");
      return {
        featureRef: ref,
        featureName: ref || "未命名特征",
        featureVersion: "v1.0.0",
        relationType: "signal_input",
        mainCategory: "other",
        mainCategoryLabel: "其他",
        outputType: "",
        outputTypeLabel: "",
        tags: [],
        tagLabels: [],
      };
    });
  }

  function resolveLayerFeatureBucketsRuntime(detailLike) {
    const detail = detailLike && typeof detailLike === "object" ? detailLike : {};
    const rows = normalizeFeatureRelationsRuntime(detail);
    const empty = { signal: [], position: [], risk: [], execution: [] };
    rows.forEach(function(item) {
      const row = item && typeof item === "object" ? item : {};
      const relation = soText(row.relationType || "").toLowerCase();
      const category = soText(row.mainCategory || "other").toLowerCase();
      const featureGroup = soText(row.featureGroup || "").toLowerCase();
      let bucket = "signal";
      if (relation.includes("position") || relation.includes("sizing") || relation.includes("exposure") || featureGroup === "position") bucket = "position";
      else if (relation.includes("risk") || category === "risk" || featureGroup === "risk") bucket = "risk";
      else if (relation.includes("execution") || relation.includes("order") || relation.includes("fee") || relation.includes("slippage") || featureGroup === "execution") bucket = "execution";
      empty[bucket].push(row);
    });
    return empty;
  }

  function renderLayerFeatureChipsRuntime(rowsLike, emptyTextLike) {
    const rows = Array.isArray(rowsLike) ? rowsLike : [];
    const emptyText = soText(emptyTextLike || "未绑定特征", "未绑定特征");
    if (!rows.length) {
      return '<div class="strategy-relation-empty">' + soEsc(emptyText) + "</div>";
    }
    return rows.map(function(item) {
      const row = item && typeof item === "object" ? item : {};
      const outputText = soText(row.outputTypeLabel || row.outputType || "");
      const tags = Array.isArray(row.tagLabels) && row.tagLabels.length ? row.tagLabels.join("/") : "";
      const meta = [soText(row.featureVersion || "v1.0.0"), outputText, tags].filter(Boolean).join(" · ");
      return ''
        + '<div class="strategy-feature-chip">'
        + '<div class="name">' + soEsc(soText(row.featureName || row.featureRef || "-")) + "</div>"
        + '<div class="meta">' + soEsc(meta) + "</div>"
        + "</div>";
    }).join("");
  }

  function normalizeStrategyLayersRuntime(detailLike) {
    const detail = detailLike && typeof detailLike === "object" ? detailLike : {};
    const version = detail.version && typeof detail.version === "object" ? detail.version : {};
    const fromDetails = detail.details && typeof detail.details === "object" ? detail.details : {};
    const layerPack = fromDetails.layers && typeof fromDetails.layers === "object" ? fromDetails.layers : {};
    return {
      signalLayer: layerPack.signalLayer && typeof layerPack.signalLayer === "object"
        ? layerPack.signalLayer
        : (version.signalLayer && typeof version.signalLayer === "object" ? version.signalLayer : {}),
      positionLayer: layerPack.positionLayer && typeof layerPack.positionLayer === "object"
        ? layerPack.positionLayer
        : (version.positionLayer && typeof version.positionLayer === "object" ? version.positionLayer : {}),
      riskLayer: layerPack.riskLayer && typeof layerPack.riskLayer === "object"
        ? layerPack.riskLayer
        : (version.riskLayer && typeof version.riskLayer === "object" ? version.riskLayer : {}),
      executionLayer: layerPack.executionLayer && typeof layerPack.executionLayer === "object"
        ? layerPack.executionLayer
        : (version.executionLayer && typeof version.executionLayer === "object" ? version.executionLayer : {}),
    };
  }

  function renderLayerKvRowsRuntime(rowsLike) {
    const rows = Array.isArray(rowsLike) ? rowsLike : [];
    const valid = rows.filter(function(item) {
      const row = item && typeof item === "object" ? item : {};
      return soText(row.k || "") && soText(row.v || "");
    });
    if (!valid.length) {
      return '<div class="strategy-layer-empty">暂无配置</div>';
    }
    return valid.map(function(item) {
      const row = item && typeof item === "object" ? item : {};
      return '<div class="strategy-layer-kv"><span>' + soEsc(soText(row.k || "")) + '</span><b>' + soEsc(soText(row.v || "")) + "</b></div>";
    }).join("");
  }

  function renderEditableNumberFieldRuntime(labelLike, fieldLike, valueLike, optionsLike) {
    const label = soText(labelLike || "");
    const field = soText(fieldLike || "");
    const options = optionsLike && typeof optionsLike === "object" ? optionsLike : {};
    const minAttr = Number.isFinite(Number(options.min)) ? (' min="' + String(Number(options.min)) + '"') : "";
    const maxAttr = Number.isFinite(Number(options.max)) ? (' max="' + String(Number(options.max)) + '"') : "";
    const stepAttr = Number.isFinite(Number(options.step)) ? (' step="' + String(Number(options.step)) + '"') : "";
    const suffix = soText(options.suffix || "");
    const value = Number.isFinite(Number(valueLike)) ? Number(valueLike) : Number(options.fallback || 0);
    return ''
      + '<label class="strategy-layer-field">'
      + '<span class="k">' + soEsc(label) + "</span>"
      + '<div class="input-wrap">'
      + '<input type="number" data-sl-edit-field="' + soEsc(field) + '" value="' + soEsc(String(value)) + '"' + minAttr + maxAttr + stepAttr + ">"
      + (suffix ? ('<em>' + soEsc(suffix) + "</em>") : "")
      + "</div>"
      + "</label>";
  }

  function renderEditableTextFieldRuntime(labelLike, fieldLike, valueLike, optionsLike) {
    const label = soText(labelLike || "");
    const field = soText(fieldLike || "");
    const options = optionsLike && typeof optionsLike === "object" ? optionsLike : {};
    const placeholder = soText(options.placeholder || "");
    const value = soText(valueLike || "");
    return ''
      + '<label class="strategy-layer-field">'
      + '<span class="k">' + soEsc(label) + "</span>"
      + '<input type="text" data-sl-edit-field="' + soEsc(field) + '" value="' + soEsc(value) + '" placeholder="' + soEsc(placeholder) + '">'
      + "</label>";
  }

  function renderEditableSelectFieldRuntime(labelLike, fieldLike, valueLike, optionsLike) {
    const label = soText(labelLike || "");
    const field = soText(fieldLike || "");
    const value = soText(valueLike || "");
    const options = Array.isArray(optionsLike) ? optionsLike : [];
    const optionsHtml = options.map(function(itemLike) {
      const item = itemLike && typeof itemLike === "object" ? itemLike : {};
      const key = soText(item.value || "");
      const text = soText(item.label || key);
      const selected = key === value ? ' selected' : "";
      return '<option value="' + soEsc(key) + '"' + selected + ">" + soEsc(text) + "</option>";
    }).join("");
    return ''
      + '<label class="strategy-layer-field">'
      + '<span class="k">' + soEsc(label) + "</span>"
      + '<select data-sl-edit-field="' + soEsc(field) + '">' + optionsHtml + "</select>"
      + "</label>";
  }

  function renderBasicInfoSectionRuntime(detailLike) {
    const detail = detailLike && typeof detailLike === "object" ? detailLike : {};
    const strategy = detail.strategy && typeof detail.strategy === "object" ? detail.strategy : {};
    const sourceLabel = soText(strategy.sourceLabel || strategy.source || "未知来源");
    return ""
      + '<section class="strategy-detail-section">'
      + '<div class="strategy-detail-section-title">1-基本信息</div>'
      + '<div class="strategy-basic-grid">'
      + '<label class="strategy-basic-item">'
      + '<span class="k">策略名称</span>'
      + '<input data-sl-edit-field="name" type="text" value="' + soEsc(soText(strategy.name || "")) + '" placeholder="请输入策略名称">'
      + "</label>"
      + '<div class="strategy-basic-item">'
      + '<span class="k">创建时间</span>'
      + '<span class="v">' + soEsc(soFmtTs(strategy.createdAt || "")) + "</span>"
      + "</div>"
      + '<div class="strategy-basic-item">'
      + '<span class="k">策略来源</span>'
      + '<span class="v">' + soEsc(sourceLabel) + "</span>"
      + "</div>"
      + "</div>"
      + "</section>";
  }


  function buildStrategyCodeRuntime(detailLike) {
    const detail = detailLike && typeof detailLike === "object" ? detailLike : {};
    const layers = normalizeStrategyLayersRuntime(detail);
    const signal = layers.signalLayer || {};
    const position = layers.positionLayer || {};
    const risk = layers.riskLayer || {};
    const exec = layers.executionLayer || {};
    const refs = normalizeFeatureRelationsRuntime(detail).map(function(item) {
      return soText(item.featureRef || item.featureName || "");
    }).filter(Boolean);
    const logic = soText(detail?.details?.expression || signal.signalLogic || "true", "true");
    const lines = [
      "// ThunderClaw Strategy Runtime Preview",
      "const strategy = {",
      "  signalType: '" + soText(signal.signalType || "composite") + "',",
      "  expression: " + JSON.stringify(logic) + ",",
      "  featureRefs: " + JSON.stringify(refs) + ",",
      "  position: {",
      "    mode: '" + soText(position.mode || "risk_budget") + "',",
      "    maxPositions: " + String(Math.max(1, Math.floor(soNum(position.maxPositions, 1)))) + ",",
      "    maxExposurePct: " + String(soNum(position.maxExposurePct, 35)) + ",",
      "    leverageLimit: " + String(soNum(position.leverageLimit, 10)) + ",",
      "  },",
      "  risk: {",
      "    stopLossPct: " + String(soNum(risk.stopLossPct, 2.5)) + ",",
      "    takeProfitPct: " + String(soNum(risk.takeProfitPct, 5.5)) + ",",
      "    maxDrawdownPct: " + String(soNum(risk.maxDrawdownPct, 18)) + ",",
      "    maxConsecutiveLoss: " + String(Math.max(1, Math.floor(soNum(risk.maxConsecutiveLoss, 3)))) + ",",
      "  },",
      "  execution: {",
      "    orderMode: '" + soText(exec.orderMode || "market") + "',",
      "    slippageBps: " + String(soNum(exec.slippageBps, 6)) + ",",
      "    feeModel: '" + soText(exec.feeModel || "taker") + "',",
      "  },",
      "};",
      "",
      "module.exports = strategy;",
    ];
    return lines.join("\n");
  }

  function renderGeneratedFeatureCodeSectionRuntime(detailLike) {
    const detail = detailLike && typeof detailLike === "object" ? detailLike : {};
    const rows = Array.isArray(detail?.details?.generatedFeatureCode) ? detail.details.generatedFeatureCode : [];
    if (!rows.length) {
      return '<div class="strategy-feature-code-empty">暂无特征执行代码（先确认特征并执行回测后可见）。</div>';
    }
    return '<div class="strategy-feature-code-list">' + rows.slice(0, 40).map(function(itemLike, idx) {
      const item = itemLike && typeof itemLike === "object" ? itemLike : {};
      const ref = soText(item.featureRef || item.ref || ('feature_' + String(idx + 1)));
      const source = [soText(item.sourceType || item.type || ''), soText(item.provider || '')].filter(Boolean).join(' / ');
      const column = soText(item.column || item.outputColumn || '');
      const expr = soText(item.expression || item.code || item.featureCode || '', '# 暂无代码');
      return ''
        + '<div class="strategy-feature-code-item">'
        + '<div class="strategy-feature-code-head"><span>' + soEsc(ref) + '</span><span class="strategy-feature-code-meta">' + soEsc((source || '-') + (column ? (' · 列=' + column) : '')) + '</span></div>'
        + '<pre class="strategy-feature-code-pre"><code>' + soEsc(expr) + '</code></pre>'
        + '</div>';
    }).join('') + '</div>';
  }

  function renderStrategyDetailSectionRuntime(detailLike) {
    const detail = detailLike && typeof detailLike === "object" ? detailLike : {};
    const layers = normalizeStrategyLayersRuntime(detail);
    const signalLayer = layers.signalLayer;
    const positionLayer = layers.positionLayer;
    const riskLayer = layers.riskLayer;
    const executionLayer = layers.executionLayer;
    const expression = soText(
      detail?.details?.expression
      || signalLayer?.signalLogic
      || "",
      "未配置策略表达式",
    );
    const relations = normalizeFeatureRelationsRuntime(detail);
    const featureRefsText = relations.map(function(item) {
      return soText(item.featureRef || item.featureName || "");
    }).filter(Boolean).join(", ");
    const layerFeatureBuckets = resolveLayerFeatureBucketsRuntime(detail);
    const signalParam = signalLayer?.params && typeof signalLayer.params === "object" ? signalLayer.params : {};
    const signalControls = ""
      + renderEditableSelectFieldRuntime("信号类型", "signalType", soText(signalLayer.signalType || "composite"), [
        { value: "composite", label: "composite" },
        { value: "weighted", label: "weighted" },
        { value: "rule", label: "rule" },
      ])
      + renderEditableNumberFieldRuntime("多头阈值", "longThreshold", soNum(signalParam.longThreshold, 0.55), { min: 0.05, max: 1, step: 0.01 })
      + renderEditableNumberFieldRuntime("空头阈值", "shortThreshold", soNum(signalParam.shortThreshold, 0.55), { min: 0.05, max: 1, step: 0.01 })
      + renderEditableNumberFieldRuntime("信号边际", "signalMargin", soNum(signalParam.signalMargin, 0.08), { min: 0.01, max: 0.5, step: 0.01 })
      + renderEditableNumberFieldRuntime("最大持仓K线", "maxHoldBars", soNum(signalParam.maxHoldBars, 96), { min: 4, max: 3000, step: 1 });
    const positionControls = ""
      + renderEditableTextFieldRuntime("仓位模式", "positionMode", soText(positionLayer.mode || "risk_budget"))
      + renderEditableNumberFieldRuntime("最大持仓数", "maxPositions", Math.max(1, Math.floor(soNum(positionLayer.maxPositions, 1))), { min: 1, max: 20, step: 1 })
      + renderEditableNumberFieldRuntime("最大敞口", "maxExposurePct", soNum(positionLayer.maxExposurePct, 35), { min: 1, max: 100, step: 0.5, suffix: "%" })
      + renderEditableNumberFieldRuntime("最小名义仓位", "minNotional", soNum(positionLayer.minNotional, 10), { min: 1, max: 1000000, step: 1 })
      + renderEditableNumberFieldRuntime("最大名义仓位", "maxNotional", soNum(positionLayer.maxNotional, 80), { min: 1, max: 2000000, step: 1 })
      + renderEditableNumberFieldRuntime("杠杆上限", "leverageLimit", soNum(positionLayer.leverageLimit, 10), { min: 1, max: 125, step: 0.5 });
    const riskControls = ""
      + renderEditableNumberFieldRuntime("止损", "stopLossPct", soNum(riskLayer.stopLossPct, 2.5), { min: 0.1, max: 80, step: 0.1, suffix: "%" })
      + renderEditableNumberFieldRuntime("止盈", "takeProfitPct", soNum(riskLayer.takeProfitPct, 5.5), { min: 0.1, max: 400, step: 0.1, suffix: "%" })
      + renderEditableNumberFieldRuntime("最大回撤", "maxDrawdownPct", soNum(riskLayer.maxDrawdownPct, 18), { min: 0.1, max: 95, step: 0.1, suffix: "%" })
      + renderEditableNumberFieldRuntime("日频上限", "frequencyLimitPerDay", Math.max(1, Math.floor(soNum(riskLayer.frequencyLimitPerDay, 12))), { min: 1, max: 1000, step: 1 })
      + renderEditableNumberFieldRuntime("连亏限制", "maxConsecutiveLoss", Math.max(1, Math.floor(soNum(riskLayer.maxConsecutiveLoss, 3))), { min: 1, max: 100, step: 1 });
    const executionControls = ""
      + renderEditableSelectFieldRuntime("下单模式", "orderMode", soText(executionLayer.orderMode || "market"), [
        { value: "market", label: "market" },
        { value: "limit", label: "limit" },
      ])
      + renderEditableNumberFieldRuntime("滑点", "slippageBps", soNum(executionLayer.slippageBps, 6), { min: 0, max: 300, step: 0.1, suffix: "bps" })
      + renderEditableSelectFieldRuntime("手续费模型", "feeModel", soText(executionLayer.feeModel || "taker"), [
        { value: "taker", label: "taker" },
        { value: "maker", label: "maker" },
      ])
      + renderEditableNumberFieldRuntime("重试次数", "retryCount", Math.max(0, Math.floor(soNum(executionLayer.retryCount, 2))), { min: 0, max: 20, step: 1 })
      + renderEditableNumberFieldRuntime("重试退避", "retryBackoffMs", Math.max(0, Math.floor(soNum(executionLayer.retryBackoffMs, 400))), { min: 0, max: 10000, step: 50, suffix: "ms" });
    return ""
      + '<section class="strategy-detail-section">'
      + '<div class="strategy-detail-section-title">2-策略详情</div>'
      + '<div class="strategy-expression-layer">'
      + '<div class="strategy-chart-title"><span>第一层：整体策略表达式</span><span>这里定义总策略逻辑（可直接编辑）</span></div>'
      + '<textarea class="strategy-detail-expression" data-sl-edit-field="signalLogic" placeholder="请输入策略表达式/信号逻辑">' + soEsc(expression) + "</textarea>"
      + '<div class="strategy-chart-title"><span>特征引用</span><span>输入支持英文逗号/换行分隔</span></div>'
      + '<textarea class="strategy-detail-expression" data-sl-edit-field="featureRefs" placeholder="feature_id_1, feature_id_2 ...">' + soEsc(featureRefsText) + "</textarea>"
      + "</div>"
      + '<div class="strategy-chart-title"><span>第二层：四层可调参数与特征分布</span><span>调整参数后可直接执行回放</span></div>'+ '<div class="strategy-chart-title"><span>策略执行代码预览</span><span>用于快速核对当前策略执行逻辑</span></div>'+ '<pre class="strategy-detail-expression"><code>' + soEsc(buildStrategyCodeRuntime(detail)) + '</code></pre>'
      + '<div class="strategy-chart-title"><span>特征计算代码（回测实际使用）</span><span>以下代码会在 Freqtrade populate_indicators 中写入 dataframe 列</span></div>'
      + renderGeneratedFeatureCodeSectionRuntime(detail)
      + '<div class="strategy-layer-grid">'
      + '<div class="strategy-layer-card signal">'
      + '<div class="strategy-layer-head"><span>信号层</span><small>信号阈值 + 特征类型分布</small></div>'
      + '<div class="strategy-layer-controls">' + signalControls + "</div>"
      + '<div class="strategy-feature-groups compact">'
      + renderLayerFeatureChipsRuntime(layerFeatureBuckets.signal, "当前仅使用表达式信号")
      + "</div>"
      + "</div>"
      + '<div class="strategy-layer-card position">'
      + '<div class="strategy-layer-head"><span>仓位层</span><small>资金分配与仓位边界</small></div>'
      + '<div class="strategy-layer-controls">' + positionControls + "</div>"
      + '<div class="strategy-feature-groups compact">'
      + renderLayerFeatureChipsRuntime(layerFeatureBuckets.position, "当前仓位层暂无绑定特征")
      + "</div>"
      + "</div>"
      + '<div class="strategy-layer-card risk">'
      + '<div class="strategy-layer-head"><span>风控层</span><small>止损止盈/回撤/风控暂停</small></div>'
      + '<div class="strategy-layer-controls">' + riskControls + "</div>"
      + '<div class="strategy-chart-title"><span>风控暂停条件</span><span>用于运行时风险状态切换</span></div>'
      + '<textarea class="strategy-detail-expression" data-sl-edit-field="riskPauseCondition" placeholder="例如：max_drawdown > 18% 或 连续亏损 >= 3">' + soEsc(soText(riskLayer.riskPauseCondition || "")) + "</textarea>"
      + '<div class="strategy-feature-groups compact">'
      + renderLayerFeatureChipsRuntime(layerFeatureBuckets.risk, "当前风控层暂无绑定特征")
      + "</div>"
      + "</div>"
      + '<div class="strategy-layer-card execution">'
      + '<div class="strategy-layer-head"><span>执行层</span><small>成交模型/滑点/手续费/重试</small></div>'
      + '<div class="strategy-layer-controls">' + executionControls + "</div>"
      + '<div class="strategy-feature-groups compact">'
      + renderLayerFeatureChipsRuntime(layerFeatureBuckets.execution, "当前执行层暂无绑定特征")
      + "</div>"
      + "</div>"
      + "</div>"
      + "</section>";
  }

  function renderPlaybackListRuntime(tradingLike) {
    const trading = tradingLike && typeof tradingLike === "object" ? tradingLike : {};
    const list = Array.isArray(trading.backtestPlaybacks) ? trading.backtestPlaybacks : [];
    if (!list.length) {
      return '<div class="strategy-playback-empty">暂无回测回放记录</div>';
    }
    return list.slice(0, 80).map(function(item) {
      const row = item && typeof item === "object" ? item : {};
      const playbackId = soText(row.playbackId || "");
      const selected = Boolean(row.selected) || (soText(trading.selectedPlaybackId || "") && soText(trading.selectedPlaybackId || "") === playbackId);
      return ""
        + '<button type="button" class="strategy-playback-item' + (selected ? " active" : "") + '" data-sl-playback-id="' + soEsc(playbackId) + '">'
        + '<span class="title">' + soEsc(soText(row.label || playbackId || "回测记录")) + "</span>"
        + '<span class="meta">' + soEsc(soFmtTs(row.createdAt || row.updatedAt || "")) + " · " + soEsc(soFmtPct(row.latestReturnPct, 2)) + " / " + soEsc(soFmtPct(row.maxDrawdownPct, 2)) + "</span>"
        + "</button>";
    }).join("");
  }

  function renderTradingEffectsSectionRuntime(detailLike, optionsLike) {
    const detail = detailLike && typeof detailLike === "object" ? detailLike : {};
    const options = optionsLike && typeof optionsLike === "object" ? optionsLike : {};
    const trading = detail.trading && typeof detail.trading === "object" ? detail.trading : {};
    const mode = soText(options.tradingMode || trading.mode || "backtest", "backtest");
    const rangeDays = Math.max(1, Math.min(365, Math.floor(soNum(options.rangeDays || detail?.visualization?.rangeDays || 30))));
    const visualization = detail.visualization && typeof detail.visualization === "object" ? detail.visualization : {};
    const events = Array.isArray(visualization.events) ? visualization.events : [];
    const summary = visualization.summary && typeof visualization.summary === "object"
      ? visualization.summary
      : (trading.summary && typeof trading.summary === "object" ? trading.summary : {});
    const barsData = pickBarsForRangeRuntime(options.ohlcvByTf || {}, rangeDays);
    let bars = barsData.bars;
    if (!bars.length) {
      bars = buildSyntheticBarsFromEventsRuntime(events, rangeDays);
    }
    const kline = renderKlineChartRuntime({ bars: bars, events: events });
    const equityChart = renderLineChartRuntime(visualization.equityCurve || [], "equity", "#7ee787", "权益曲线");
    const drawdownChart = renderLineChartRuntime(visualization.drawdownCurve || [], "drawdownPct", "#ff7b72", "回撤曲线(%)");
    const tabs = [
      { key: "live", label: "a-实盘交易" },
      { key: "paper", label: "c-模拟交易" },
      { key: "backtest", label: "b-回测交易" },
    ];
    const tabHtml = tabs.map(function(item) {
      const active = item.key === mode;
      return '<button type="button" class="strategy-mode-tab' + (active ? " active" : "") + '" data-sl-trading-mode="' + soEsc(item.key) + '">' + soEsc(item.label) + "</button>";
    }).join("");
    const playbackPanel = mode === "backtest"
      ? '<aside class="strategy-playback-list">' + renderPlaybackListRuntime(trading) + "</aside>"
      : "";
    const chartPanelClass = mode === "backtest"
      ? "strategy-trading-main with-playbacks"
      : "strategy-trading-main";
    const tradingSource = soText(trading.source || "-", "-");
    const positionSummary = trading.positionSummary && typeof trading.positionSummary === "object"
      ? trading.positionSummary
      : {};
    const positionText = soText(positionSummary.note || positionSummary.state || "-", "-");
    const html = ""
      + '<section class="strategy-detail-section">'
      + '<div class="strategy-detail-section-title">3-交易效果</div>'
      + '<div class="strategy-trading-tabs">' + tabHtml + "</div>"
      + '<div class="strategy-trading-meta">'
      + '<span>当前视图：' + soEsc(soTradingModeLabel(mode)) + "</span>"
      + '<span>数据来源：' + soEsc(tradingSource) + "</span>"
      + '<span>仓位状态：' + soEsc(positionText) + "</span>"
      + '<span>交易数：' + soEsc(String(Math.max(0, Math.floor(soNum(summary.tradeCount, 0))))) + "</span>"
      + '<span>收益：' + soEsc(soFmtPct(summary.latestReturnPct, 2)) + "</span>"
      + '<span>回撤：' + soEsc(soFmtPct(summary.maxDrawdownPct, 2)) + "</span>"
      + '<button type="button" class="strategy-run-replay-btn" data-sl-editor-action="replay">执行当前策略回测</button>'+ '<span class="strategy-replay-progress" data-sl-replay-progress>等待开始</span>'
      + "</div>"
      + '<div class="' + chartPanelClass + '">'
      + playbackPanel
      + '<div class="strategy-detail-charts">'
      + '<div class="strategy-chart-box" data-sl-chart="kline"><div class="strategy-chart-title"><span>K线主图（' + soEsc(soText(barsData.tf || "1h")) + "）+ 交易标记</span><span>点击标记查看交易详情</span></div>" + kline.svg + '<div class="strategy-trade-popover" id="sl-strategy-trade-popover"></div></div>'
      + '<div class="strategy-chart-box" data-sl-chart="equity">' + equityChart + "</div>"
      + '<div class="strategy-chart-box" data-sl-chart="drawdown">' + drawdownChart + "</div>"
      + "</div>"
      + "</div>"
      + "</section>";
    return {
      html: html,
      markerEvents: kline.markerEvents || [],
    };
  }

  function renderStrategyDetailRuntime(detailLike, optionsLike) {
    const detail = detailLike && typeof detailLike === "object" ? detailLike : {};
    const options = optionsLike && typeof optionsLike === "object" ? optionsLike : {};
    const tradingOut = renderTradingEffectsSectionRuntime(detail, options);
    const html = ""
      + '<div class="strategy-detail-sections">'
      + renderBasicInfoSectionRuntime(detail)
      + renderStrategyDetailSectionRuntime(detail)
      + tradingOut.html
      + '<div class="strategy-detail-editor"><div class="actions"><button type="button" data-sl-editor-action="replay">执行回放</button><button type="button" class="primary" data-sl-editor-action="save">保存草稿</button></div></div>'
      + "</div>";
    return {
      html: html,
      markerEvents: tradingOut.markerEvents || [],
      replayEvents: tradingOut.markerEvents || [],
    };
  }

  function renderStrategyListRuntime(rowsLike) {
    const rows = Array.isArray(rowsLike) ? rowsLike : [];
    if (!rows.length) {
      return '<div class="strategy-ops-item"><div class="top"><div class="name">暂无策略</div></div><div class="metrics">你可以通过对话卡片“保存草稿”，或点击“新建草稿”。</div></div>';
    }
    return rows.map(function(item) {
      const row = item && typeof item === "object" ? item : {};
      return ""
        + '<div class="strategy-ops-item" data-sl-strategy-id="' + soEsc(soText(row.strategyId || "")) + '">'
        + '<div class="top">'
        + '<div class="name">' + soEsc(soText(row.name || row.strategyId || "-")) + "</div>"
        + '<div class="badges">'
        + '<span class="badge status">' + soEsc(soStatusLabel(row.status || "")) + "</span>"
        + '<span class="badge env">' + soEsc(soEnvLabel(row.runtimeEnv || "")) + "</span>"
        + "</div>"
        + "</div>"
        + '<div class="metrics">'
        + '<div>最近收益<span class="v">' + soEsc(soFmtPct(row.latestReturnPct, 2)) + "</span></div>"
        + '<div>最大回撤<span class="v">' + soEsc(soFmtPct(row.maxDrawdownPct, 2)) + "</span></div>"
        + '<div>特征数量<span class="v">' + soEsc(String(Math.max(0, Math.floor(soNum(row.featureCount, 0))))) + "</span></div>"
        + '<div>更新时间<span class="v">' + soEsc(soFmtTs(row.updatedAt || "")) + "</span></div>"
        + "</div>"
        + '<div class="actions">'
        + '<button type="button" data-sl-action="detail">查看详情</button>'
        + '<button type="button" data-sl-action="publish" class="warn">发布新版本</button>'
        + '<button type="button" data-sl-action="start-paper">启动模拟</button>'
        + '<button type="button" data-sl-action="start-live">启动实盘</button>'
        + '<button type="button" data-sl-action="pause" class="danger">暂停</button>'
        + "</div>"
        + "</div>";
    }).join("");
  }

  function renderTradePopoverRuntime(eventLike) {
    const event = eventLike && typeof eventLike === "object" ? eventLike : null;
    if (!event) return "";
    const reasonAnalysis = event.reasonAnalysis && typeof event.reasonAnalysis === "object"
      ? event.reasonAnalysis
      : null;
    let analysisHtml = "";
    if (reasonAnalysis) {
      const topFeatures = Array.isArray(reasonAnalysis.topFeatures) ? reasonAnalysis.topFeatures.slice(0, 4) : [];
      const blocked = Array.isArray(reasonAnalysis.blockedReasons) ? reasonAnalysis.blockedReasons.slice(0, 4) : [];
      const summaryText = soText(reasonAnalysis.trigger || reasonAnalysis.summary || "", "");
      const scoreText = Number.isFinite(Number(reasonAnalysis.longScore)) || Number.isFinite(Number(reasonAnalysis.shortScore))
        ? ('L=' + soNum(reasonAnalysis.longScore, 0).toFixed(3) + ' / S=' + soNum(reasonAnalysis.shortScore, 0).toFixed(3))
        : "";
      analysisHtml = ""
        + '<div class="strategy-trade-analysis">'
        + (summaryText ? ('<div class="row"><span>命中规则</span><b>' + soEsc(summaryText) + "</b></div>") : "")
        + (scoreText ? ('<div class="row"><span>信号分数</span><b>' + soEsc(scoreText) + "</b></div>") : "");
      if (blocked.length) {
        analysisHtml += '<div class="row"><span>阻断因素</span><b>' + soEsc(blocked.join(" / ")) + "</b></div>";
      }
      if (topFeatures.length) {
        analysisHtml += '<div class="hits">'
          + topFeatures.map(function(item) {
            const row = item && typeof item === "object" ? item : {};
            const meta = [soText(row.category || ""), Number(soNum(row.score, 0)).toFixed(3), "值=" + Number(soNum(row.value, 0)).toFixed(4)]
              .filter(Boolean)
              .join(" · ");
            return '<div class="hit"><span>' + soEsc(soText(row.featureName || row.featureRef || "-")) + '</span><em>' + soEsc(meta) + "</em></div>";
          }).join("")
          + "</div>";
      }
      analysisHtml += "</div>";
    }
    const decisionSnapshot = event.decisionSnapshot && typeof event.decisionSnapshot === "object"
      ? event.decisionSnapshot
      : null;
    let layerHtml = "";
    if (decisionSnapshot) {
      const signal = decisionSnapshot.signal && typeof decisionSnapshot.signal === "object" ? decisionSnapshot.signal : {};
      const position = decisionSnapshot.position && typeof decisionSnapshot.position === "object" ? decisionSnapshot.position : {};
      const risk = decisionSnapshot.risk && typeof decisionSnapshot.risk === "object" ? decisionSnapshot.risk : {};
      const execution = decisionSnapshot.execution && typeof decisionSnapshot.execution === "object" ? decisionSnapshot.execution : {};
      const externalSignals = Array.isArray(signal.externalSignals) ? signal.externalSignals.slice(0, 4) : [];
      const extSummary = externalSignals.map(function(item) {
        const row = item && typeof item === "object" ? item : {};
        const ref = soText(row.featureRef || "-");
        const bias = soText(row.bias || "neutral");
        const score = soNum(row.score, 0).toFixed(3);
        const conf = soNum(row.confidence, 0).toFixed(3);
        return ref + "(" + bias + ", s=" + score + ", c=" + conf + ")";
      }).join(" | ");
      layerHtml = ''
        + '<div class="strategy-trade-analysis">'
        + '<div class="row"><span>信号层</span><b>' + soEsc(soText(signal.signalType || "-") + " / Δ=" + soNum(signal.observedDeltaPct, 0).toFixed(3) + "%") + '</b></div>'
        + '<div class="row"><span>外部信号</span><b>' + soEsc("score=" + soNum(signal.externalSignalScore, 0).toFixed(3) + (extSummary ? " / " + extSummary : "")) + '</b></div>'
        + '<div class="row"><span>仓位层</span><b>' + soEsc("maxPos=" + String(Math.max(1, Math.floor(soNum(position.maxPositions, 1)))) + " / lev=" + soNum(position.leverageLimit, 0).toFixed(2)) + '</b></div>'
        + '<div class="row"><span>风控层</span><b>' + soEsc("SL=" + soNum(risk.stopLossPct, 0).toFixed(2) + "% TP=" + soNum(risk.takeProfitPct, 0).toFixed(2) + "% DD=" + soNum(risk.maxDrawdownPct, 0).toFixed(2) + "%") + '</b></div>'
        + '<div class="row"><span>执行层</span><b>' + soEsc(soText(execution.orderMode || "-") + " / " + soText(execution.feeModel || "-") + " / " + soNum(execution.slippageBps, 0).toFixed(2) + "bps") + '</b></div>'
        + '</div>';
    }
    return ""
      + "<div><strong>" + soEsc(soTradeTypeLabel(event.tradeType || "")) + "</strong> · " + soEsc(soFmtTs(new Date(soNum(event.time, 0) * 1000).toISOString())) + "</div>"
      + "<div>价格：" + soEsc(String(soNum(event.price, 0).toFixed(2))) + " · 数量：" + soEsc(String(soNum(event.quantity, 0).toFixed(5))) + "</div>"
      + "<div>手续费：" + soEsc(String(soNum(event.fee, 0).toFixed(4))) + " · 滑点：" + soEsc(String(soNum(event.slippageBps, 0).toFixed(2))) + " bps</div>"
      + "<div>触发：" + soEsc(soText(event.reasonRule || "-")) + "</div>"
      + analysisHtml
      + layerHtml;
  }

  globalObj.strategyOpsRuntime = {
    renderStrategyListRuntime: renderStrategyListRuntime,
    renderStrategyDetailRuntime: renderStrategyDetailRuntime,
    renderTradePopoverRuntime: renderTradePopoverRuntime,
    soStatusLabel: soStatusLabel,
    soEnvLabel: soEnvLabel,
    soFmtPct: soFmtPct,
    soFmtTs: soFmtTs,
  };
})(typeof window !== "undefined" ? window : this);
