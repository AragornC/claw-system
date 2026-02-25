(function(globalObj) {
  function soText(valueLike, fallback = "") {
    const s = String(valueLike == null ? "" : valueLike).trim();
    return s || String(fallback || "");
  }

  function soNum(valueLike, fallback = 0) {
    const n = Number(valueLike);
    return Number.isFinite(n) ? n : Number(fallback || 0);
  }

  function soClamp(valueLike, min, max, fallback = 0) {
    const n = soNum(valueLike, fallback);
    if (Number.isFinite(min) && n < min) return min;
    if (Number.isFinite(max) && n > max) return max;
    return n;
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
        return {
          time: time,
          open: open,
          high: high,
          low: low,
          close: close,
        };
      })
      .filter(Boolean)
      .sort(function(a, b) { return a.time - b.time; });
  }

  function buildSyntheticBarsFromEventsRuntime(eventsLike, rangeDaysLike) {
    const rows = Array.isArray(eventsLike) ? eventsLike : [];
    const rangeDays = Math.max(1, Math.min(365, Math.floor(soNum(rangeDaysLike, 30))));
    const nowSec = Math.floor(Date.now() / 1000);
    const pointCount = Math.max(120, Math.min(1800, rangeDays * 24));
    const stepSec = 3600;
    const start = nowSec - pointCount * stepSec;
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
        const t = Math.floor(soNum(ev.time, 0));
        if (!t) return;
        const nearest = bars.reduce(function(prev, item) {
          const gap = Math.abs(item.time - t);
          if (!prev || gap < prev.gap) return { idx: bars.indexOf(item), gap: gap };
          return prev;
        }, null);
        if (!nearest) return;
        const bar = bars[nearest.idx];
        const force = soNum(ev.price, bar.close || price);
        bar.high = Math.max(bar.high, force + 12 + idx % 5);
        bar.low = Math.min(bar.low, force - 12 - idx % 5);
        bar.close = force;
      });
    }
    return bars;
  }

  function pickBarsForRangeRuntime(ohlcvByTfLike, rangeDaysLike) {
    const map = ohlcvByTfLike && typeof ohlcvByTfLike === "object" ? ohlcvByTfLike : {};
    var tf = "1h";
    var rows = normalizeBarsRuntime(map["1h"]);
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
    const svg = ''
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
    return ''
      + '<div class="strategy-chart-title"><span>' + soEsc(title || "") + '</span><span>' + soEsc(diffText) + '</span></div>'
      + '<svg viewBox="0 0 ' + width + " " + height + '" preserveAspectRatio="none">'
      + '<path d="' + path + '" fill="none" stroke="' + soEsc(color || "#79c0ff") + '" stroke-width="2"></path>'
      + "</svg>";
  }

  function renderStructureCardsRuntime(detailLike) {
    const detail = detailLike && typeof detailLike === "object" ? detailLike : {};
    const version = detail.version && typeof detail.version === "object" ? detail.version : {};
    const signalLayer = version.signalLayer && typeof version.signalLayer === "object" ? version.signalLayer : {};
    const positionLayer = version.positionLayer && typeof version.positionLayer === "object" ? version.positionLayer : {};
    const riskLayer = version.riskLayer && typeof version.riskLayer === "object" ? version.riskLayer : {};
    const executionLayer = version.executionLayer && typeof version.executionLayer === "object" ? version.executionLayer : {};
    const featureLocks = Array.isArray(version.lockedFeatureVersions) ? version.lockedFeatureVersions : [];
    function jsonOf(objLike) {
      try { return JSON.stringify(objLike || {}, null, 2); } catch { return "{}"; }
    }
    const featureText = featureLocks.length
      ? featureLocks.map(function(item) {
        return soText(item.featureName || item.featureId || "-")
          + "@" + soText(item.featureVersion || "v1.0.0");
      }).slice(0, 6).join(" / ")
      : "未锁定特征版本";
    return ''
      + '<div class="strategy-detail-structure">'
      + '<div class="strategy-structure-card">'
      + '<div class="h"><span>信号层</span><span>' + soEsc(featureLocks.length + " 个特征") + '</span></div>'
      + '<div class="summary">逻辑：' + soEsc(soText(signalLayer.signalLogic || "未配置")) + '</div>'
      + '<div class="summary">引用特征：' + soEsc(featureText) + '</div>'
      + '<details><summary>查看参数与规则细节</summary><pre>' + soEsc(jsonOf(signalLayer)) + '</pre></details>'
      + '</div>'
      + '<div class="strategy-structure-card">'
      + '<div class="h"><span>仓位层</span><span>' + soEsc(soText(positionLayer.mode || "-")) + '</span></div>'
      + '<div class="summary">最大仓位：' + soEsc(String(positionLayer.maxPositions || "-")) + ' · 最大敞口：' + soEsc(String(positionLayer.maxExposurePct || "-")) + '%</div>'
      + '<div class="summary">Notional 区间：' + soEsc(String(positionLayer.minNotional || "-")) + ' - ' + soEsc(String(positionLayer.maxNotional || "-")) + '</div>'
      + '<details><summary>查看仓位规则细节</summary><pre>' + soEsc(jsonOf(positionLayer)) + '</pre></details>'
      + '</div>'
      + '<div class="strategy-structure-card">'
      + '<div class="h"><span>风控层</span><span>回撤阈值 ' + soEsc(String(riskLayer.maxDrawdownPct || "-")) + '%</span></div>'
      + '<div class="summary">止损/止盈：' + soEsc(String(riskLayer.stopLossPct || "-")) + '% / ' + soEsc(String(riskLayer.takeProfitPct || "-")) + '%</div>'
      + '<div class="summary">频控：每日 ' + soEsc(String(riskLayer.frequencyLimitPerDay || "-")) + ' 次 · 连亏上限 ' + soEsc(String(riskLayer.maxConsecutiveLoss || "-")) + '</div>'
      + '<details><summary>查看风控规则细节</summary><pre>' + soEsc(jsonOf(riskLayer)) + '</pre></details>'
      + '</div>'
      + '<div class="strategy-structure-card">'
      + '<div class="h"><span>执行层</span><span>' + soEsc(soText(executionLayer.orderMode || "-")) + '</span></div>'
      + '<div class="summary">滑点：' + soEsc(String(executionLayer.slippageBps || "-")) + ' bps · 手续费模型：' + soEsc(soText(executionLayer.feeModel || "-")) + '</div>'
      + '<div class="summary">重试：' + soEsc(String(executionLayer.retryCount || "-")) + ' 次 · 回退：' + soEsc(String(executionLayer.retryBackoffMs || "-")) + 'ms</div>'
      + '<details><summary>查看执行参数细节</summary><pre>' + soEsc(jsonOf(executionLayer)) + '</pre></details>'
      + '</div>'
      + '</div>';
  }

  function renderEditorRuntime(detailLike) {
    const detail = detailLike && typeof detailLike === "object" ? detailLike : {};
    const strategy = detail.strategy && typeof detail.strategy === "object" ? detail.strategy : {};
    const version = detail.version && typeof detail.version === "object" ? detail.version : {};
    const signalLayer = version.signalLayer && typeof version.signalLayer === "object" ? version.signalLayer : {};
    const riskLayer = version.riskLayer && typeof version.riskLayer === "object" ? version.riskLayer : {};
    const featureRefs = Array.isArray(signalLayer.featureRefs) ? signalLayer.featureRefs.join(", ") : "";
    return ''
      + '<div class="strategy-detail-editor">'
      + '<div class="strategy-chart-title"><span>策略编辑器（草稿）</span><span>支持对话草稿继续完善</span></div>'
      + '<div class="row">'
      + '<input data-sl-edit-field="name" type="text" value="' + soEsc(soText(strategy.name || "")) + '" placeholder="策略名称">'
      + '<input data-sl-edit-field="description" type="text" value="' + soEsc(soText(strategy.description || "")) + '" placeholder="策略描述">'
      + '</div>'
      + '<textarea data-sl-edit-field="featureRefs" placeholder="引用特征（英文逗号分隔，支持 feature_id / name）">' + soEsc(featureRefs) + '</textarea>'
      + '<textarea data-sl-edit-field="signalLogic" placeholder="信号逻辑摘要">' + soEsc(soText(signalLayer.signalLogic || "")) + '</textarea>'
      + '<textarea data-sl-edit-field="riskPauseCondition" placeholder="风控暂停条件">' + soEsc(soText(riskLayer.riskPauseCondition || "")) + '</textarea>'
      + '<div class="actions"><button type="button" data-sl-editor-action="save">保存草稿</button></div>'
      + '</div>';
  }

  function renderAuditsRuntime(auditsLike) {
    const rows = Array.isArray(auditsLike) ? auditsLike : [];
    if (!rows.length) {
      return '<div class="strategy-detail-audits"><div class="audit-item">暂无审计记录</div></div>';
    }
    const body = rows.slice(0, 80).map(function(item) {
      const audit = item && typeof item === "object" ? item : {};
      return '<div class="audit-item">'
        + '<div><strong>' + soEsc(soText(audit.action || "-")) + '</strong> · ' + soEsc(soFmtTs(audit.ts || "")) + '</div>'
        + '<div>状态：' + soEsc(soStatusLabel(audit.fromStatus || "")) + ' -> ' + soEsc(soStatusLabel(audit.toStatus || "")) + '</div>'
        + '<div>说明：' + soEsc(soText(audit.reason || "-")) + '</div>'
        + '</div>';
    }).join("");
    return '<div class="strategy-detail-audits">' + body + "</div>";
  }

  function renderStrategyDetailRuntime(detailLike, optionsLike) {
    const detail = detailLike && typeof detailLike === "object" ? detailLike : {};
    const options = optionsLike && typeof optionsLike === "object" ? optionsLike : {};
    const rangeDays = Math.max(1, Math.min(365, Math.floor(soNum(options.rangeDays || detail?.visualization?.rangeDays || 30))));
    const visualization = detail.visualization && typeof detail.visualization === "object" ? detail.visualization : {};
    const events = Array.isArray(visualization.events) ? visualization.events : [];
    var barsData = pickBarsForRangeRuntime(options.ohlcvByTf || {}, rangeDays);
    var bars = barsData.bars;
    if (!bars.length) bars = buildSyntheticBarsFromEventsRuntime(events, rangeDays);
    const kline = renderKlineChartRuntime({ bars: bars, events: events });
    const equityChart = renderLineChartRuntime(visualization.equityCurve || [], "equity", "#7ee787", "权益曲线");
    const drawdownChart = renderLineChartRuntime(visualization.drawdownCurve || [], "drawdownPct", "#ff7b72", "回撤曲线(%)");
    const html = ''
      + renderStructureCardsRuntime(detail)
      + '<div class="strategy-detail-charts">'
      + '<div class="strategy-chart-box" data-sl-chart="kline"><div class="strategy-chart-title"><span>K线主图（' + soEsc(soText(barsData.tf || "1h")) + '）+ 交易标记</span><span>点击标记查看交易详情</span></div>' + kline.svg + '<div class="strategy-trade-popover" id="sl-strategy-trade-popover"></div></div>'
      + '<div class="strategy-chart-box" data-sl-chart="equity">' + equityChart + '</div>'
      + '<div class="strategy-chart-box" data-sl-chart="drawdown">' + drawdownChart + '</div>'
      + '</div>'
      + renderEditorRuntime(detail)
      + renderAuditsRuntime(detail.audits || []);
    return {
      html: html,
      markerEvents: kline.markerEvents || [],
      replayEvents: kline.markerEvents || [],
    };
  }

  function renderStrategyListRuntime(rowsLike) {
    const rows = Array.isArray(rowsLike) ? rowsLike : [];
    if (!rows.length) {
      return '<div class="strategy-ops-item"><div class="top"><div class="name">暂无策略</div></div><div class="metrics">你可以通过对话卡片“保存草稿”，或点击“新建草稿”。</div></div>';
    }
    return rows.map(function(item) {
      const row = item && typeof item === "object" ? item : {};
      return ''
        + '<div class="strategy-ops-item" data-sl-strategy-id="' + soEsc(soText(row.strategyId || "")) + '">'
        + '<div class="top">'
        + '<div class="name">' + soEsc(soText(row.name || row.strategyId || "-")) + '</div>'
        + '<div class="badges">'
        + '<span class="badge status">' + soEsc(soStatusLabel(row.status || "")) + '</span>'
        + '<span class="badge env">' + soEsc(soEnvLabel(row.runtimeEnv || "")) + '</span>'
        + '</div>'
        + '</div>'
        + '<div class="metrics">'
        + '<div>最近收益<span class="v">' + soEsc(soFmtPct(row.latestReturnPct, 2)) + '</span></div>'
        + '<div>最大回撤<span class="v">' + soEsc(soFmtPct(row.maxDrawdownPct, 2)) + '</span></div>'
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
    return ''
      + '<div><strong>' + soEsc(soTradeTypeLabel(event.tradeType || "")) + '</strong> · ' + soEsc(soFmtTs(new Date(soNum(event.time, 0) * 1000).toISOString())) + '</div>'
      + '<div>价格：' + soEsc(String(soNum(event.price, 0).toFixed(2))) + ' · 数量：' + soEsc(String(soNum(event.quantity, 0).toFixed(5))) + '</div>'
      + '<div>手续费：' + soEsc(String(soNum(event.fee, 0).toFixed(4))) + ' · 滑点：' + soEsc(String(soNum(event.slippageBps, 0).toFixed(2))) + ' bps</div>'
      + '<div>触发：' + soEsc(soText(event.reasonRule || "-")) + '</div>';
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
