#!/usr/bin/env node
/**
 * 展示层：生成报告页 index.html，不嵌入任何数据；
 * 页面通过 fetch('decisions.json') 与 fetch('ohlcv.json') 加载数据。
 * 需配合 serve-report.js 在本地服务下打开。
 *
 * Usage: node scripts/perp-report-viewer.js
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKDIR = process.env.OPENCLAW_WORKDIR || process.cwd();
const REPORT_DIR = path.resolve(WORKDIR, 'memory/report');
const INDEX_PATH = path.resolve(REPORT_DIR, 'index.html');

const TF_CONFIG = [
  { key: '1m', label: '分时(1分钟)', seconds: 60 },
  { key: '5m', label: '5分钟', seconds: 300 },
  { key: '15m', label: '15分钟', seconds: 900 },
  { key: '1h', label: '1小时', seconds: 3600 },
  { key: '4h', label: '4小时', seconds: 14400 },
  { key: '1d', label: '日线', seconds: 86400 },
];

const tfOptions = TF_CONFIG.map((t) => `<option value="${t.key}"${t.key === '1m' ? ' selected' : ''}>${t.label}</option>`).join('');

const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Perp K 线 + 决策</title>
  <script src="https://unpkg.com/lightweight-charts@4.2.0/dist/lightweight-charts.standalone.production.js"></script>
  <style>
    :root { --bg: #0f1419; --card: #1a2332; --border: #2d3a4f; --text: #e6edf3; --muted: #8b949e; --green: #3fb950; --red: #f85149; --yellow: #d29922; }
    * { box-sizing: border-box; }
    body { font-family: ui-sans-serif, system-ui, sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 16px; line-height: 1.5; -webkit-tap-highlight-color: transparent; }
    h1 { font-size: 1.25rem; margin: 0 0 4px; }
    .chart-header { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; flex-wrap: wrap; }
    .chart-header .meta { color: var(--muted); font-size: 0.875rem; margin: 0; }
    .chart-header select { background: var(--card); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; font-size: 0.875rem; cursor: pointer; }
    #chart-wrap { height: clamp(300px, 52vh, 460px); margin-bottom: 16px; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; position: relative; touch-action: manipulation; }
    #detail-popover { display: none; position: absolute; z-index: 100; min-width: 320px; max-width: 420px; max-height: min(75vh, 380px); overflow-y: auto; overflow-x: hidden; -webkit-overflow-scrolling: touch; background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 12px; box-shadow: 0 8px 24px rgba(0,0,0,0.4); font-size: 0.8125rem; }
    #detail-popover.visible { display: block; }
    #detail-popover .popover-close { position: absolute; top: 8px; right: 8px; background: none; border: none; color: var(--muted); cursor: pointer; font-size: 1.1rem; line-height: 1; padding: 4px; }
    #detail-popover .popover-close:hover { color: var(--text); }
    #detail-popover .popover-ts { color: var(--muted); margin-bottom: 8px; padding-right: 24px; }
    #detail-popover .popover-row { margin-bottom: 6px; }
    #detail-popover .popover-label { color: var(--muted); margin-right: 6px; }
    #detail-popover .badge { display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 0.75rem; }
    #detail-popover .badge.yes { background: rgba(63,185,80,0.2); color: var(--green); }
    #detail-popover .badge.no { background: rgba(248,81,73,0.2); color: var(--red); }
    #detail-popover .badge.dry { background: rgba(210,153,34,0.2); color: var(--yellow); }
    #detail-popover .reason { word-break: break-word; margin-top: 4px; color: var(--text); }
    #detail-popover .popover-section { margin-top: 8px; padding-top: 6px; border-top: 1px solid var(--border); }
    #detail-popover .popover-section-title { color: var(--muted); font-size: 0.75rem; margin-bottom: 4px; }
    #detail-popover .news-link { display: block; font-size: 0.75rem; margin-top: 4px; color: #58a6ff; text-decoration: none; }
    #detail-popover .news-link:hover { text-decoration: underline; }
    #detail-popover .news-list-wrap { max-height: 160px; overflow-y: auto; margin-top: 4px; -webkit-overflow-scrolling: touch; }
    #detail-popover .plan-reason-block { margin-top: 4px; padding: 6px 8px; background: rgba(0,0,0,0.2); border-radius: 4px; font-size: 0.75rem; color: var(--text); word-break: break-word; }
    #detail-popover .algo-line { font-size: 0.75rem; margin-top: 2px; color: var(--text); word-break: break-word; }
    #detail-popover .calc-grid { display: grid; grid-template-columns: auto 1fr; gap: 2px 12px; font-size: 0.75rem; margin-top: 4px; }
    #detail-popover .calc-k { color: var(--muted); }
    #detail-popover .calc-v { color: var(--text); text-align: right; }
    #detail-popover .strategy-block { margin-top: 6px; padding: 6px 8px; background: rgba(0,0,0,0.15); border-radius: 4px; font-size: 0.75rem; }
    #detail-popover .strategy-name { color: var(--yellow); font-weight: 600; margin-bottom: 4px; }
    #detail-popover .strategy-indicators { color: var(--muted); margin-bottom: 4px; line-height: 1.5; }
    #detail-popover .strategy-apply { color: var(--text); border-left: 2px solid var(--border); padding-left: 8px; }
    #detail-popover .popover-pin-hint { font-size: 0.7rem; color: var(--muted); margin-top: 6px; }
    #detail-popover .chart-lines-hint { font-size: 0.7rem; color: var(--green); margin-top: 6px; }
    #detail-popover .calc-k.clickable { cursor: pointer; text-decoration: underline; text-decoration-style: dotted; }
    #detail-popover .calc-k.clickable:hover { color: var(--text); }
    #indicator-hover-tooltip { display: none; position: fixed; z-index: 250; max-width: 280px; background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; box-shadow: 0 8px 24px rgba(0,0,0,0.5); font-size: 0.75rem; pointer-events: none; }
    #indicator-hover-tooltip.visible { display: block; }
    #indicator-hover-tooltip.pinned { pointer-events: auto; }
    #indicator-hover-tooltip .calc-tt-title { color: var(--yellow); font-weight: 600; margin-bottom: 6px; }
    #indicator-hover-tooltip .calc-tt-value { color: var(--green); margin-bottom: 6px; }
    #indicator-hover-tooltip .calc-tt-steps { margin-bottom: 6px; }
    #indicator-hover-tooltip .calc-tt-step { margin: 2px 0; padding-left: 4px; border-left: 2px solid var(--border); color: var(--text); }
    #indicator-hover-tooltip .calc-tt-formula { background: rgba(0,0,0,0.3); padding: 6px 8px; border-radius: 4px; font-family: ui-monospace, monospace; font-size: 0.7rem; color: var(--muted); margin-bottom: 6px; word-break: break-all; }
    #indicator-hover-tooltip .calc-tt-chart { color: var(--green); font-size: 0.7rem; margin-bottom: 6px; }
    #indicator-hover-tooltip .calc-tt-minichart { width: 256px; height: 72px; margin: 6px 0; border-radius: 4px; overflow: hidden; background: rgba(0,0,0,0.2); }
    #indicator-hover-tooltip .calc-tt-close { display: none; margin-top: 6px; padding: 4px 10px; font-size: 0.7rem; background: var(--border); border: none; border-radius: 4px; color: var(--text); cursor: pointer; }
    #indicator-hover-tooltip.pinned .calc-tt-close { display: inline-block; }
    #detail-popover .logic-result-block { margin-top: 6px; padding: 8px; background: rgba(63,185,80,0.08); border-radius: 4px; border-left: 3px solid var(--green); font-size: 0.75rem; line-height: 1.5; }
    #detail-popover .summary-row { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
    #detail-popover .summary-chip { display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px; border-radius: 999px; font-size: 0.72rem; border: 1px solid var(--border); background: rgba(0,0,0,0.2); color: var(--text); }
    #detail-popover .summary-chip.k { color: var(--muted); font-size: 0.68rem; }
    #detail-popover .decision-tree-wrap { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--border); }
    #detail-popover .decision-tree-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
    #detail-popover .decision-tree-title { color: var(--text); font-weight: 600; font-size: 0.82rem; }
    #detail-popover .decision-tree-sub { color: var(--muted); font-size: 0.7rem; }
    #detail-popover .decision-tree-grid { display: grid; grid-template-columns: 1.15fr 0.85fr; gap: 10px; }
    #detail-popover .decision-tree-main { min-width: 0; }
    #detail-popover .decision-side { min-width: 0; display: flex; flex-direction: column; gap: 8px; }
    #detail-popover .decision-tree { display: flex; align-items: stretch; gap: 6px; overflow-x: auto; padding-bottom: 4px; -webkit-overflow-scrolling: touch; }
    #detail-popover .dt-node { min-width: 210px; flex: 0 0 210px; border: 1px solid var(--border); border-radius: 10px; background: rgba(0,0,0,0.16); padding: 8px; opacity: 0; transform: translateY(8px); animation: dtNodeIn 0.28s ease forwards; animation-delay: calc(var(--i) * 70ms); }
    #detail-popover .dt-node.pass { border-color: rgba(63,185,80,0.5); background: rgba(63,185,80,0.08); }
    #detail-popover .dt-node.fail { border-color: rgba(248,81,73,0.5); background: rgba(248,81,73,0.08); }
    #detail-popover .dt-node.warn { border-color: rgba(210,153,34,0.5); background: rgba(210,153,34,0.08); }
    #detail-popover .dt-node.neutral { border-color: rgba(139,148,158,0.45); background: rgba(139,148,158,0.06); }
    #detail-popover .dt-node.blocker { animation: dtNodeIn 0.28s ease forwards, dtBlockPulse 1.8s ease-out infinite; animation-delay: calc(var(--i) * 70ms), 0.9s; }
    #detail-popover .dt-top { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
    #detail-popover .dt-step { width: 18px; height: 18px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 0.66rem; color: var(--text); border: 1px solid var(--border); background: rgba(0,0,0,0.25); }
    #detail-popover .dt-label { font-size: 0.75rem; font-weight: 600; flex: 1; min-width: 0; }
    #detail-popover .dt-state { font-size: 0.65rem; border-radius: 999px; padding: 1px 6px; border: 1px solid transparent; }
    #detail-popover .dt-node.pass .dt-state { color: var(--green); border-color: rgba(63,185,80,0.5); }
    #detail-popover .dt-node.fail .dt-state { color: var(--red); border-color: rgba(248,81,73,0.5); }
    #detail-popover .dt-node.warn .dt-state { color: var(--yellow); border-color: rgba(210,153,34,0.5); }
    #detail-popover .dt-node.neutral .dt-state { color: var(--muted); border-color: rgba(139,148,158,0.45); }
    #detail-popover .dt-desc { font-size: 0.74rem; line-height: 1.35; color: var(--text); word-break: break-word; }
    #detail-popover .dt-extra { margin-top: 4px; font-size: 0.68rem; color: var(--muted); word-break: break-word; }
    #detail-popover .dt-arrow { align-self: center; flex: 0 0 auto; color: var(--muted); font-size: 0.95rem; }
    #detail-popover .path-compare { margin-top: 8px; border: 1px solid var(--border); border-radius: 8px; padding: 8px; background: rgba(0,0,0,0.12); }
    #detail-popover .path-title { font-size: 0.74rem; color: var(--muted); margin-bottom: 6px; }
    #detail-popover .path-track { margin-top: 6px; }
    #detail-popover .path-track-head { font-size: 0.7rem; color: var(--text); margin-bottom: 4px; display: flex; justify-content: space-between; gap: 8px; }
    #detail-popover .path-steps { display: flex; flex-wrap: wrap; gap: 6px; }
    #detail-popover .path-step { display: inline-flex; align-items: center; gap: 4px; font-size: 0.68rem; border-radius: 999px; padding: 2px 8px; border: 1px solid var(--border); background: rgba(0,0,0,0.18); }
    #detail-popover .path-step.pass { color: var(--green); border-color: rgba(63,185,80,0.45); }
    #detail-popover .path-step.fail { color: var(--red); border-color: rgba(248,81,73,0.45); }
    #detail-popover .path-step.warn { color: var(--yellow); border-color: rgba(210,153,34,0.45); }
    #detail-popover .path-step.neutral { color: var(--muted); border-color: rgba(139,148,158,0.45); }
    #detail-popover .path-step.skip { color: var(--muted); border-color: rgba(139,148,158,0.35); opacity: 0.75; }
    #detail-popover .block-cause { border: 1px solid var(--border); border-radius: 8px; padding: 8px; background: rgba(0,0,0,0.16); }
    #detail-popover .block-cause .bc-title { font-size: 0.72rem; color: var(--muted); margin-bottom: 4px; }
    #detail-popover .block-cause .bc-main { font-size: 0.78rem; color: var(--text); font-weight: 600; margin-bottom: 3px; }
    #detail-popover .block-cause .bc-desc { font-size: 0.7rem; color: var(--muted); word-break: break-word; }
    #detail-popover .impact-panel { border: 1px solid var(--border); border-radius: 8px; padding: 8px; background: rgba(0,0,0,0.16); }
    #detail-popover .impact-title { font-size: 0.72rem; color: var(--muted); margin-bottom: 6px; }
    #detail-popover .impact-item { margin-bottom: 8px; }
    #detail-popover .impact-item:last-child { margin-bottom: 0; }
    #detail-popover .impact-meta { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 0.68rem; margin-bottom: 4px; }
    #detail-popover .impact-name { color: var(--text); }
    #detail-popover .impact-score { color: var(--muted); white-space: nowrap; }
    #detail-popover .impact-bar { position: relative; height: 8px; border-radius: 999px; background: rgba(139,148,158,0.22); overflow: hidden; }
    #detail-popover .impact-fill { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 999px; }
    #detail-popover .impact-fill.pass { background: linear-gradient(90deg, rgba(63,185,80,0.75), rgba(63,185,80,0.95)); }
    #detail-popover .impact-fill.fail { background: linear-gradient(90deg, rgba(248,81,73,0.75), rgba(248,81,73,0.95)); }
    #detail-popover .impact-fill.warn { background: linear-gradient(90deg, rgba(210,153,34,0.75), rgba(210,153,34,0.95)); }
    #detail-popover .impact-threshold { position: absolute; top: -2px; bottom: -2px; width: 2px; background: rgba(230,237,243,0.75); }
    #detail-popover .impact-rule { margin-top: 3px; font-size: 0.64rem; color: var(--muted); }
    #detail-popover details.fold { margin-top: 8px; border: 1px solid var(--border); border-radius: 8px; background: rgba(0,0,0,0.12); overflow: hidden; }
    #detail-popover details.fold > summary { cursor: pointer; list-style: none; padding: 8px 10px; font-size: 0.76rem; color: var(--text); border-bottom: 1px solid transparent; }
    #detail-popover details.fold > summary::-webkit-details-marker { display: none; }
    #detail-popover details.fold > summary::after { content: '▾'; float: right; color: var(--muted); }
    #detail-popover details.fold[open] > summary { border-bottom-color: var(--border); }
    #detail-popover details.fold[open] > summary::after { content: '▴'; }
    #detail-popover .fold-body { padding: 8px 10px; }
    #detail-popover .compact-kv { display: grid; grid-template-columns: auto 1fr; gap: 4px 10px; font-size: 0.74rem; }
    #detail-popover .compact-kv .k { color: var(--muted); }
    #detail-popover .compact-kv .v { color: var(--text); word-break: break-word; }
    @keyframes dtNodeIn {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes dtBlockPulse {
      0% { box-shadow: 0 0 0 0 rgba(248,81,73,0.38); }
      70% { box-shadow: 0 0 0 7px rgba(248,81,73,0.0); }
      100% { box-shadow: 0 0 0 0 rgba(248,81,73,0.0); }
    }
    .filters { margin-bottom: 8px; display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .filters label { display: flex; align-items: center; gap: 6px; cursor: pointer; }
    .filters input { accent-color: var(--green); }
    table { width: 100%; border-collapse: collapse; font-size: 0.8125rem; }
    th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--border); }
    th { color: var(--muted); font-weight: 600; position: sticky; top: 0; background: var(--bg); }
    tr:hover { background: var(--card); }
    tr.highlight { background: rgba(63,185,80,0.15); }
    .ts { white-space: nowrap; color: var(--muted); cursor: pointer; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; font-weight: 500; }
    .badge.yes { background: rgba(63,185,80,0.2); color: var(--green); }
    .badge.no { background: rgba(248,81,73,0.2); color: var(--red); }
    .badge.dry { background: rgba(210,153,34,0.2); color: var(--yellow); }
    .reason { max-width: 280px; word-break: break-word; }
    .detail { font-size: 0.75rem; color: var(--muted); margin-top: 2px; }
    .error-row { background: rgba(248,81,73,0.08); }
    .empty { text-align: center; padding: 24px; color: var(--muted); }
    .load-error { color: var(--red); padding: 16px; }
    .load-error pre { font-size: 0.75rem; margin-top: 8px; }
    @media (max-width: 768px) {
      body { padding: 10px; }
      h1 { font-size: 1.05rem; margin-bottom: 6px; }
      .chart-header { gap: 8px; margin-bottom: 6px; }
      .chart-header .meta { font-size: 0.75rem; line-height: 1.35; }
      .chart-header select { font-size: 16px; padding: 8px 10px; }
      #chart-wrap { height: min(56vh, 420px); min-height: 280px; border-radius: 10px; }
      #detail-popover { position: fixed; left: 8px !important; right: 8px !important; bottom: 8px !important; top: auto !important; width: auto !important; max-width: none; max-height: 68vh; border-radius: 12px; z-index: 300; }
      #detail-popover .popover-close { font-size: 1.25rem; padding: 8px; top: 4px; right: 4px; }
      #indicator-hover-tooltip { display: none !important; }
      #detail-popover .decision-tree-grid { grid-template-columns: 1fr; }
      #detail-popover .decision-tree { flex-direction: column; gap: 4px; overflow-x: hidden; }
      #detail-popover .dt-node { min-width: 0; width: 100%; }
      #detail-popover .dt-arrow { transform: rotate(90deg); align-self: flex-start; margin-left: 10px; }
      .filters { gap: 6px; flex-wrap: nowrap; overflow-x: auto; padding-bottom: 4px; -webkit-overflow-scrolling: touch; }
      .filters label { font-size: 0.8rem; padding: 4px 8px; border: 1px solid var(--border); border-radius: 999px; background: var(--card); white-space: nowrap; }
      .filters input { width: 16px; height: 16px; }
      #table-wrap { display: block !important; }
      #table-wrap thead { display: none; }
      #table-wrap tbody,
      #table-wrap tr,
      #table-wrap td { display: block; width: 100%; }
      #table-wrap tr { margin-bottom: 10px; border: 1px solid var(--border); border-radius: 10px; background: var(--card); padding: 6px 8px; }
      #table-wrap td { border-bottom: 0; padding: 6px 4px; display: flex; gap: 8px; align-items: flex-start; }
      #table-wrap td::before { content: attr(data-label); color: var(--muted); min-width: 44px; flex: 0 0 44px; }
      #table-wrap td.reason { max-width: none; }
      #table-wrap .ts { white-space: normal; }
      #table-wrap .detail { margin-top: 0; }
    }
  </style>
</head>
<body>
  <h1>Perp K 线 + 决策点</h1>
  <div class="chart-header">
    <select id="tf-select">${tfOptions}</select>
    <span class="meta" id="meta-symbol">· 电脑可悬停，手机可点击决策点/记录看详情</span>
  </div>
  <div id="chart-wrap"><p class="load-error">加载中…</p></div>
  <div id="indicator-hover-tooltip"></div>
  <div class="filters" id="filters" style="display:none">
    <label><input type="checkbox" id="filter-executed" /> 仅已下单</label>
    <label><input type="checkbox" id="filter-skipped" /> 仅未下单</label>
    <label><input type="checkbox" id="filter-signal" /> 仅有信号</label>
    <label><input type="checkbox" id="filter-errors" /> 含错误</label>
  </div>
  <table id="table-wrap" style="display:none">
    <thead>
      <tr>
        <th>时间</th>
        <th>信号</th>
        <th>计划</th>
        <th>新闻</th>
        <th>执行</th>
        <th>原因</th>
      </tr>
    </thead>
    <tbody id="tbody"></tbody>
  </table>
  <script>
    const TF_CONFIG = ${JSON.stringify(TF_CONFIG)};
    const TF_SECONDS = Object.fromEntries(TF_CONFIG.map(t => [t.key, t.seconds]));

    function buildMarkersForTf(records, tfSeconds) {
      return records.filter(r => r.ts && !r.stage).map(r => {
        const tsMs = new Date(r.ts).getTime();
        const time = Math.floor(tsMs / 1000 / tfSeconds) * tfSeconds;
        let color = '#8b949e', text = '';
        if (r.executor) {
          if (r.executor.executed) { color = '#3fb950'; text = r.signal?.plan?.side === 'long' ? '开多' : '开空'; }
          else if (r.executor.dryRun && (r.executor.wouldOpenPosition || r.executor.reason === 'dry_run_open')) { color = '#d29922'; text = 'Dry'; }
          else { color = '#f85149'; text = (r.executor.reason || 'skip').slice(0, 6); }
        }
        return { time, position: 'belowBar', color, shape: 'circle', text: text || '·', id: r.ts, size: 0.75 };
      });
    }

    function showLoadError(msg) {
      document.getElementById('chart-wrap').innerHTML = '<p class="load-error">加载数据失败。请先运行 <code>node scripts/perp-report-data.js</code> 再通过 <code>node scripts/serve-report.js</code> 打开本页（不要直接双击 HTML 文件）。</p><pre>' + (msg || '') + '</pre>';
    }

    async function load() {
      const [decisions, ohlcvPayload] = await Promise.all([
        fetch('decisions.json').then(r => { if (!r.ok) throw new Error(r.statusText); return r.json(); }),
        fetch('ohlcv.json').then(r => { if (!r.ok) throw new Error(r.statusText); return r.json(); })
      ]);
      const RECORDS = Array.isArray(decisions) ? decisions : [];
      const OHLCV_BY_TF = (ohlcvPayload && ohlcvPayload.data) ? ohlcvPayload.data : (ohlcvPayload || {});
      const symbol = (ohlcvPayload && ohlcvPayload.symbol) ? ohlcvPayload.symbol : 'BTC/USDT:USDT';
      const MARKERS_BY_TF = {};
      (TF_CONFIG || []).forEach(({ key, seconds }) => { MARKERS_BY_TF[key] = buildMarkersForTf(RECORDS, seconds); });
      init(RECORDS, OHLCV_BY_TF, MARKERS_BY_TF, symbol);
    }

    function init(RECORDS, OHLCV_BY_TF, MARKERS_BY_TF, symbol) {
      const isTouchDevice = window.matchMedia('(hover: none), (pointer: coarse)').matches;
      const RECORDS_WITH_TS = RECORDS
        .filter(r => r && r.ts && !r.stage)
        .map(r => ({ r, tsSec: Math.floor(new Date(r.ts).getTime() / 1000) }))
        .filter(x => Number.isFinite(x.tsSec));
      document.getElementById('meta-symbol').textContent = symbol + (isTouchDevice
        ? ' · 手机端：点击决策点或下方记录看详情，双指缩放 K 线'
        : ' · 鼠标悬停决策点显示详情，点击可放大该段');
      document.getElementById('chart-wrap').innerHTML = '<div id="detail-popover"></div>';
      document.getElementById('filters').style.display = 'flex';
      document.getElementById('table-wrap').style.display = 'table';
      const chartEl = document.createElement('div');
      chartEl.style.height = '100%';
      document.getElementById('chart-wrap').insertBefore(chartEl, document.getElementById('detail-popover'));

      let currentTf = '1m';
      let currentOhlcv = OHLCV_BY_TF[currentTf] || [];
      const chartWrap = document.getElementById('chart-wrap');
      const popover = document.getElementById('detail-popover');

      const chart = LightweightCharts.createChart(chartEl, {
        layout: { background: { type: 'solid', color: '#0f1419' }, textColor: '#8b949e' },
        grid: { vertLines: { color: '#1a2332' }, horzLines: { color: '#1a2332' } },
        rightPriceScale: { borderColor: '#2d3a4f', scaleMargins: { top: 0.1, bottom: 0.2 } },
        timeScale: { borderColor: '#2d3a4f', timeVisible: true, secondsVisible: false },
      });
      const candleSeries = chart.addCandlestickSeries({ upColor: '#3fb950', downColor: '#f85149', borderVisible: false });
      function resizeChart() {
        const w = Math.floor(chartEl.clientWidth || chartWrap.clientWidth || 0);
        const h = Math.floor(chartEl.clientHeight || chartWrap.clientHeight || 0);
        if (w > 0 && h > 0) chart.applyOptions({ width: w, height: h });
      }
      if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(resizeChart);
        ro.observe(chartEl);
      }
      window.addEventListener('resize', resizeChart, { passive: true });
      resizeChart();

      function setTf(tf) {
        currentTf = tf;
        currentOhlcv = OHLCV_BY_TF[tf] || [];
        candleSeries.setData(currentOhlcv);
        candleSeries.setMarkers((MARKERS_BY_TF[tf] || []).map(m => ({ ...m, time: m.time, size: isTouchDevice ? 1.2 : 0.75 })));
        chart.timeScale().fitContent();
        if (typeof clearDecisionPriceLines === 'function') clearDecisionPriceLines();
      }
      document.getElementById('tf-select').addEventListener('change', e => setTf(e.target.value));
      setTf('1m');

      var decisionPriceLines = [];
      function clearDecisionPriceLines() { var list = (decisionPriceLines && Array.isArray(decisionPriceLines)) ? decisionPriceLines : []; decisionPriceLines = []; list.forEach(function(pl) { try { candleSeries.removePriceLine(pl); } catch (_) {} }); }
      function applyDecisionPriceLines(record) {
        clearDecisionPriceLines();
        if (!record || !record.signal) return;
        var alg = record.signal.algorithm;
        var calc = (alg && alg.meta && alg.meta.calc) ? alg.meta.calc : (alg && alg.calc) ? alg.calc : null;
        var level = (alg && alg.meta && alg.meta.level != null) ? alg.meta.level : (calc && calc['突破位'] != null) ? calc['突破位'] : null;
        if (level != null) {
          decisionPriceLines.push(candleSeries.createPriceLine({ price: level, color: '#d29922', lineWidth: 2, lineStyle: 2, axisLabelVisible: true, title: '突破位 ' + Number(level).toFixed(0) }));
        }
        var tol = (calc && calc['容差'] != null) ? calc['容差'] : null;
        if (level != null && tol != null) {
          decisionPriceLines.push(candleSeries.createPriceLine({ price: level + tol, color: 'rgba(139,148,158,0.7)', lineWidth: 1, lineStyle: 0, axisLabelVisible: true, title: '上界+' + Number(tol).toFixed(0) }));
          decisionPriceLines.push(candleSeries.createPriceLine({ price: level - tol, color: 'rgba(139,148,158,0.7)', lineWidth: 1, lineStyle: 0, axisLabelVisible: true, title: '下界-' + Number(tol).toFixed(0) }));
        }
        var emaKey = null;
        if (calc && typeof calc === 'object') { Object.keys(calc).forEach(function(k) { if (/1H_EMA\\d+/.test(k) || (k.indexOf('EMA') >= 0 && typeof calc[k] === 'number')) emaKey = emaKey || k; }); }
        if (emaKey && calc[emaKey] != null) {
          decisionPriceLines.push(candleSeries.createPriceLine({ price: calc[emaKey], color: '#58a6ff', lineWidth: 2, lineStyle: 2, axisLabelVisible: true, title: emaKey + ' ' + Number(calc[emaKey]).toFixed(0) }));
        }
      }

      function escapeHtml(s) { const x = arguments[0]; if (x == null) return ''; return String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
      var INDICATOR_EXPLAIN = {
        '4H_EMA快': { steps: ['取 4 小时图最近 20 根 K 线收盘价', 'EMA(n) = 收盘 × 2/(1+n) + 原EMA × (1 - 2/(1+n))', '逐根递推得当前 4H_EMA快'], formula: '新EMA = 收盘×2/21 + 原EMA×19/21', chartHint: '4H 图切换周期可查' },
        '4H_EMA慢': { steps: ['取 4 小时图最近 50 根 K 线收盘价', '同上 EMA 递推，n=50'], formula: '新EMA = 收盘×2/51 + 原EMA×49/51', chartHint: '4H 图切换周期可查' },
        '4H_ADX': { steps: ['由 4H 的 +DM、-DM、TR 算 +DI、-DI', 'DX = |+DI - -DI| / (+DI + -DI) × 100', 'ADX = DX 的 14 期平滑'], formula: 'ADX(14)，≥15 视为有趋势', chartHint: '4H 图查看' },
        '1H_ATR': { steps: ['每根 K 线：TR = max(高-低, |高-前收|, |低-前收|)', 'ATR = TR 的 14 期均线'], formula: 'ATR(14)；容差 = 系数 × ATR', chartHint: '图中灰线为突破位±容差' },
        '突破位': { steps: ['取 1 小时图前 15 根 K 线', '做多：突破位 = max(这 15 根的 最高价)', '做空：突破位 = min(这 15 根的 最低价)'], formula: 'Donchian(15)：前15根高/低的极值', chartHint: '图中黄线即本单突破位' },
        '容差': { steps: ['先算 1H_ATR(14)', '容差 = 系数 × 1H_ATR', '突破回踩系数≈0.25，趋势再入≈0.35'], formula: '容差 = 系数 × ATR', chartHint: '图中灰线为上/下界' },
        '收盘': { steps: ['当前 1 小时 K 线结束时的成交价'], formula: '即该 K 线收盘价', chartHint: 'K 线烛身顶或底' },
        '高': { steps: ['当前 1 小时 K 线内的最高价'], formula: '该根 K 线的 高', chartHint: '图中该 K 线上影/烛顶' },
        '低': { steps: ['当前 1 小时 K 线内的最低价'], formula: '该根 K 线的 低', chartHint: '图中该 K 线下影/烛底' },
        '方向': { steps: ['由 4H_EMA快、4H_EMA慢 比较', '快线 > 慢线 → long，否则 short'], formula: 'bias = 多空方向', chartHint: '决定做多/做空' }
      };
      function getIndicatorExplain(key) {
        if (INDICATOR_EXPLAIN[key]) return INDICATOR_EXPLAIN[key];
        if (key.indexOf('EMA') >= 0) { var m = key.match(/(\\d+)/g); var period = (m && m.length) ? m[m.length - 1] : '20'; return { steps: ['取 1 小时图最近 ' + period + ' 根 K 线收盘价', 'EMA 递推：新 = 收×2/(1+n) + 原×(1-2/(1+n))'], formula: 'EMA(' + period + ')', chartHint: '图中蓝线即本单该 EMA' }; }
        return { steps: ['策略内部计算'], formula: '-', chartHint: '图中或已标出' };
      }
      function executorReasonToChinese(reason) {
        if (!reason) return '';
        var s = String(reason);
        if (/blocked_by_news/i.test(s)) return '新闻风控拦截';
        if (/no_plan/i.test(s)) return '无交易计划';
        if (/position_open|idempotent/i.test(s)) return '已有持仓或重复';
        if (/daily_cap/i.test(s)) return '触及日亏损上限';
        if (/min_interval/i.test(s)) return '距上次开仓间隔不足';
        if (/dry_run_open|wouldOpenPosition/i.test(s)) return 'Dry-run 会开仓';
        if (/opened|executed/i.test(s)) return '已下单';
        if (/auto_disabled/i.test(s)) return '自动禁用';
        return s;
      }
      function planReasonToChinese(reason) {
        if (!reason || typeof reason !== 'string') return reason || '';
        var s = reason.trim();
        var retestRe = new RegExp('v5\\\\s+retest:\\\\s*bias=(long|short)(?:;\\\\s*breakout@([^;]+))?(?:;\\\\s*breakout)?(?:;\\\\s*level=([\\\\d.]+))?(?:;\\\\s*tol=([\\\\d.]+))?', 'i');
        var retest = s.match(retestRe);
        if (retest) {
          var sideCn = retest[1].toLowerCase() === 'long' ? '做多' : '做空';
          var timeStr = '';
          if (retest[2]) { try { timeStr = new Date(retest[2].trim()).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch (_) {} }
          var levelStr = retest[3] ? (Number(retest[3]).toLocaleString('zh-CN') + ' 美元') : '';
          var tolStr = retest[4] ? ('容差 ' + Number(retest[4]).toFixed(0) + ' 美元') : '';
          if (levelStr && tolStr && timeStr) return '1 小时图在 ' + timeStr + ' 曾出现' + (retest[1].toLowerCase() === 'long' ? '向上' : '向下') + '突破。当前 K 线回踩至约 ' + levelStr + '（' + tolStr + '）后，' + (retest[1].toLowerCase() === 'long' ? '收盘重新站上该位' : '收盘重新跌破该位') + '，策略确认为' + sideCn + '信号。';
          if (levelStr && tolStr) return '1 小时图突破后，价格回踩至约 ' + levelStr + '（' + tolStr + '）并收盘确认，策略给出' + sideCn + '信号。';
          if (levelStr) return '1 小时图突破后回踩至约 ' + levelStr + ' 并确认，策略给出' + sideCn + '信号。';
          return '1 小时图突破后回踩确认，策略给出' + sideCn + '信号。';
        }
        var reentryRe = new RegExp('v5\\\\s+reentry:\\\\s*bias=(long|short);\\\\s*ema(\\\\d+)=([\\\\d.]+)(?:;\\\\s*tol=([\\\\d.]+))?', 'i');
        var reentry = s.match(reentryRe);
        if (reentry) {
          var sideCn2 = reentry[1].toLowerCase() === 'long' ? '做多' : '做空';
          var emaVal = Number(reentry[3]).toLocaleString('zh-CN');
          var tolStr2 = reentry[4] ? ('容差 ' + Number(reentry[4]).toFixed(0) + ' 美元内') : '';
          return '趋势内再次入场：价格回踩 1 小时 EMA' + reentry[2] + '（约 ' + emaVal + ' 美元）' + (tolStr2 ? '，在' + tolStr2 + '触及' : '') + '后收盘确认，策略给出' + sideCn2 + '信号。';
        }
        return s;
      }
      function renderDetailCard(r) {
        const ts = r.ts ? new Date(r.ts).toLocaleString('zh-CN', { hour12: false }) : '-';
        const p = r?.signal?.plan || null;
        const hasAlert = Boolean(r?.signal?.hasAlert);
        const planSide = p?.side || '';
        const planLevel = p?.level || '';
        const planReasonText = p?.reason ? planReasonToChinese(String(p.reason)) : '';
        const newsBlocked = r?.decision?.blockedByNews === true;
        const newsReasonText = Array.isArray(r?.decision?.newsReason) && r.decision.newsReason.length
          ? String(r.decision.newsReason.join('; '))
          : '';
        const e = r?.executor || null;
        const executed = Boolean(e?.executed);
        const dryRunOpen = Boolean(e?.dryRun && (e?.wouldOpenPosition || e?.reason === 'dry_run_open'));
        const skipped = Boolean(e?.skipped);
        const execReasonRaw = e?.reason ? String(e.reason) : '';
        const execReasonText = execReasonRaw ? executorReasonToChinese(execReasonRaw) : '';
        const signalLevelText = hasAlert
          ? ((planSide === 'long' ? '做多' : planSide === 'short' ? '做空' : '信号') + (planLevel ? (' · ' + planLevel) : ''))
          : '无信号';
        const resultText = executed
          ? '已下单'
          : (dryRunOpen ? 'Dry-run 会开仓' : (skipped ? '未下单' : '-'));
        function statusLabel(s) {
          if (s === 'pass') return '通过';
          if (s === 'fail') return '阻断';
          if (s === 'warn') return '观察';
          return '信息';
        }
        function nodeHtml(step, stage, idx, blockerIdx) {
          const status = stage?.status || 'neutral';
          const blockerCls = idx === blockerIdx ? ' blocker' : '';
          return '<div class="dt-node ' + status + blockerCls + '" style="--i:' + (idx + 1) + ';">' +
            '<div class="dt-top"><span class="dt-step">' + step + '</span><span class="dt-label">' + escapeHtml(stage?.label || '-') + '</span><span class="dt-state">' + statusLabel(status) + '</span></div>' +
            '<div class="dt-desc">' + escapeHtml(stage?.desc || '-') + '</div>' +
            (stage?.extra ? '<div class="dt-extra">' + escapeHtml(stage.extra) + '</div>' : '') +
          '</div>';
        }
        function flowStep(label, status, text) {
          return '<span class="path-step ' + status + '"><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(text) + '</strong></span>';
        }
        function clampPct(v) {
          const n = Number(v);
          if (!Number.isFinite(n)) return 0;
          if (n < 0) return 0;
          if (n > 100) return 100;
          return n;
        }
        function impactState(score, threshold, mode) {
          const s = Number(score);
          const t = Number(threshold);
          if (!Number.isFinite(s) || !Number.isFinite(t)) return 'warn';
          const pass = mode === 'min' ? s >= t : s <= t;
          if (!pass) return 'fail';
          if (Math.abs(s - t) <= 8) return 'warn';
          return 'pass';
        }
        function impactRow(name, score, threshold, mode, ruleText) {
          const s = clampPct(score);
          const t = clampPct(threshold);
          const state = impactState(s, t, mode);
          return '<div class="impact-item">' +
            '<div class="impact-meta"><span class="impact-name">' + escapeHtml(name) + '</span><span class="impact-score">' + s.toFixed(0) + ' / 100</span></div>' +
            '<div class="impact-bar"><span class="impact-fill ' + state + '" style="width:' + s + '%"></span><span class="impact-threshold" style="left:' + t + '%"></span></div>' +
            '<div class="impact-rule">' + escapeHtml(ruleText) + '</div>' +
          '</div>';
        }

        const signalStatus = hasAlert ? 'pass' : 'fail';
        const signalDesc = hasAlert
          ? ('识别到 ' + (planSide === 'long' ? '做多' : planSide === 'short' ? '做空' : '交易') + (planLevel ? ('（' + planLevel + '）') : '') + ' 计划')
          : (r?.signal?.note || '策略未产出可执行计划');
        const signalExtra = planReasonText || (r?.signal?.note ? String(r.signal.note) : '');

        const newsStatus = !hasAlert ? 'neutral' : (newsBlocked ? 'fail' : 'pass');
        const newsDesc = !hasAlert ? '无交易计划，新闻门控未触发' : (newsBlocked ? '新闻风控判定为阻断' : '新闻风控放行');
        const newsExtra = newsBlocked ? (newsReasonText || '检测到负面新闻因素') : '未命中新闻拦截条件';

        let riskStatus = 'neutral';
        let riskDesc = '未进入执行器风控检查';
        let riskExtra = '';
        if (hasAlert) {
          if (!e) {
            riskStatus = 'neutral';
            riskDesc = '执行器未返回状态';
          } else if (executed || dryRunOpen) {
            riskStatus = 'pass';
            riskDesc = '仓位/频率/风险阈值检查通过';
            riskExtra = execReasonText || '满足开仓条件';
          } else if (skipped) {
            riskStatus = 'fail';
            riskDesc = '执行前风控规则触发拦截';
            riskExtra = execReasonText || execReasonRaw || '未通过执行条件';
          } else {
            riskStatus = 'warn';
            riskDesc = '执行器返回未知状态';
            riskExtra = execReasonText || execReasonRaw || '';
          }
        }

        const resultStatus = executed ? 'pass' : (dryRunOpen ? 'warn' : (skipped ? 'fail' : 'neutral'));
        const resultDesc = executed
          ? '订单已提交到交易所'
          : (dryRunOpen ? '仅模拟开仓，不会真实下单' : (skipped ? '本轮未执行下单' : '暂无执行结果'));
        const resultExtra = execReasonText || execReasonRaw || '';

        const stages = [
          { key: 'signal', short: '信号', label: '信号识别', status: signalStatus, desc: signalDesc, extra: signalExtra },
          { key: 'news', short: '新闻', label: '新闻门控', status: newsStatus, desc: newsDesc, extra: newsExtra },
          { key: 'risk', short: '风控', label: '账户风控', status: riskStatus, desc: riskDesc, extra: riskExtra },
          { key: 'exec', short: '执行', label: '执行结果', status: resultStatus, desc: resultDesc, extra: resultExtra },
        ];
        const blockerIdx = stages.findIndex(s => s.status === 'fail');
        const nodes = stages.map(function(stage, idx) {
          return nodeHtml(idx + 1, stage, idx, blockerIdx);
        });

        const idealFlow = stages.map(function(stage) { return flowStep(stage.short, 'pass', '通过'); }).join('');
        const actualFlow = stages.map(function(stage, idx) {
          if (blockerIdx >= 0 && idx > blockerIdx) return flowStep(stage.short, 'skip', '跳过');
          return flowStep(stage.short, stage.status, statusLabel(stage.status));
        }).join('');
        const pathCompareHtml = '<div class="path-compare">' +
          '<div class="path-title">候选路径 vs 实际路径</div>' +
          '<div class="path-track"><div class="path-track-head"><span>候选路径（理想）</span><span>全链路通过</span></div><div class="path-steps">' + idealFlow + '</div></div>' +
          '<div class="path-track"><div class="path-track-head"><span>实际路径（本单）</span><span>' + escapeHtml(blockerIdx >= 0 ? ('在「' + stages[blockerIdx].short + '」节点阻断') : (resultStatus === 'warn' ? '观察态/模拟态' : '全链路放行')) + '</span></div><div class="path-steps">' + actualFlow + '</div></div>' +
        '</div>';

        const blockTitle = blockerIdx >= 0
          ? ('阻断节点：' + stages[blockerIdx].label)
          : (resultStatus === 'warn' ? '流程告警：观察态' : '流程通过：无阻断');
        const blockDesc = blockerIdx >= 0
          ? (stages[blockerIdx].extra || stages[blockerIdx].desc || '触发阻断')
          : (resultStatus === 'warn' ? '当前为 dry-run 或策略观察态，不会真实下单。' : '所有关键关口均已放行。');

        const signalScore = hasAlert ? (planLevel === 'very-strong' ? 90 : 74) : 16;
        const newsRiskScore = newsBlocked ? 92 : ((Array.isArray(r?.decision?.newsItems) && r.decision.newsItems.length) ? 42 : 28);
        let riskPressureScore = 24;
        if (hasAlert && skipped && !newsBlocked) riskPressureScore = 86;
        else if (hasAlert && dryRunOpen) riskPressureScore = 58;
        else if (hasAlert && executed) riskPressureScore = 44;
        const execReadyScore = executed ? 95 : (dryRunOpen ? 68 : (hasAlert ? 30 : 14));
        const impactHtml = '<div class="impact-panel">' +
          '<div class="impact-title">阻断原因看板（评分与阈值）</div>' +
          impactRow('信号强度', signalScore, 55, 'min', '规则：>=55 视为可继续') +
          impactRow('新闻风险', newsRiskScore, 70, 'max', '规则：<=70 才可放行') +
          impactRow('账户风控压力', riskPressureScore, 75, 'max', '规则：<=75 才可放行') +
          impactRow('执行就绪度', execReadyScore, 60, 'min', '规则：>=60 才会尝试下单') +
        '</div>';

        const sidePanelHtml = '<div class="decision-side">' +
          '<div class="block-cause"><div class="bc-title">当前关键结论</div><div class="bc-main">' + escapeHtml(blockTitle) + '</div><div class="bc-desc">' + escapeHtml(blockDesc) + '</div></div>' +
          impactHtml +
        '</div>';
        const treeMainHtml = '<div class="decision-tree-main">' +
          '<div class="decision-tree-head"><div class="decision-tree-title">决策流程图</div><div class="decision-tree-sub">Signal → News → Risk → Execute</div></div>' +
          '<div class="decision-tree">' + nodes.map(function(n, i) { return n + (i < nodes.length - 1 ? '<div class="dt-arrow">➜</div>' : ''); }).join('') + '</div>' +
          pathCompareHtml +
        '</div>';
        const treeHtml = '<div class="decision-tree-wrap"><div class="decision-tree-grid">' + treeMainHtml + sidePanelHtml + '</div></div>';

        var alg = r.signal && r.signal.algorithm;
        var calc = (alg && alg.meta && alg.meta.calc) ? alg.meta.calc : (alg && alg.calc) ? alg.calc : null;
        if (!calc && (alg || p?.reason)) {
          calc = {};
          if (alg && alg.meta) {
            if (alg.meta.level != null) calc['突破位'] = Number(alg.meta.level);
            if (alg.meta.bias) calc['方向'] = alg.meta.bias;
            if (alg.meta.adx != null) calc['4H_ADX'] = Number(alg.meta.adx);
          }
          var reasonStr = p?.reason ? String(p.reason).trim() : '';
          var retestM = reasonStr.match(new RegExp('v5\\\\s+retest:\\\\s*bias=(long|short)(?:;\\\\s*breakout@([^;]+))?(?:;\\\\s*breakout)?(?:;\\\\s*level=([\\\\d.]+))?(?:;\\\\s*tol=([\\\\d.]+))?', 'i'));
          if (retestM) { if (retestM[3]) calc['突破位'] = Number(retestM[3]); if (retestM[4]) calc['容差'] = Number(retestM[4]); }
          var reentryM = reasonStr.match(new RegExp('v5\\\\s+reentry:\\\\s*bias=(long|short);\\\\s*ema(\\\\d+)=([\\\\d.]+)(?:;\\\\s*tol=([\\\\d.]+))?', 'i'));
          if (reentryM) { calc['1H_EMA' + reentryM[2]] = Number(reentryM[3]); if (reentryM[4]) calc['容差'] = Number(reentryM[4]); }
          if (Object.keys(calc).length === 0) calc = null;
        }
        var strategyDoc = '' +
          '<div class="strategy-block"><div class="strategy-name">策略一：突破回踩</div><div class="strategy-indicators">指标：4H EMA快/慢、4H ADX、1H ATR、突破位、容差</div><div class="strategy-apply">触发：突破后回踩到突破位±容差，并收盘重新确认方向。</div></div>' +
          '<div class="strategy-block"><div class="strategy-name">策略二：趋势再入</div><div class="strategy-indicators">指标：1H EMA20、1H ATR、容差</div><div class="strategy-apply">触发：趋势中回踩 EMA20，在容差范围内触及并收盘确认。</div></div>';
        var algoDetails = strategyDoc;
        if (calc && typeof calc === 'object') {
          var rows = Object.keys(calc).map(function(k) {
            var v = calc[k];
            var vStr = typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : String(v);
            return '<span class="calc-k clickable" data-calc-key="' + escapeHtml(k) + '" data-calc-value="' + escapeHtml(vStr) + '" title="点击查看计算过程">' + escapeHtml(k) + '</span><span class="calc-v">' + escapeHtml(vStr) + '</span>';
          }).join('');
          algoDetails += '<div class="algo-line">本单关键指标（点击名称可查看算法说明）</div><div class="calc-grid">' + rows + '</div><div class="chart-lines-hint">图中横线为突破位 / EMA / 容差上下界</div>';
        } else if (alg) {
          var parts = [];
          if (alg.note) parts.push(String(alg.note));
          if (alg.meta) {
            if (alg.meta.bias) parts.push('bias=' + String(alg.meta.bias));
            if (alg.meta.adx != null) parts.push('ADX=' + Number(alg.meta.adx).toFixed(1));
            if (alg.meta.breakout) parts.push('breakout ' + String(alg.meta.breakout.side || '') + ' @ ' + (alg.meta.breakout.level != null ? Number(alg.meta.breakout.level).toFixed(2) : '-'));
          }
          if (parts.length) algoDetails += '<div class="algo-line">' + escapeHtml(parts.join(' · ')) + '</div>';
        } else if (planReasonText) {
          algoDetails += '<div class="algo-line">' + escapeHtml(planReasonText) + '</div>';
        }

        var newsLinkHtml = '';
        if (r.decision && Array.isArray(r.decision.newsItems) && r.decision.newsItems.length) {
          newsLinkHtml = r.decision.newsItems.map(function(it) {
            var u = (it && it.url) ? String(it.url) : '';
            if (!u) return '';
            var t = (it && it.title) ? escapeHtml(it.title) : '';
            var lab = (it && it.tsLocal) ? escapeHtml(it.tsLocal) + ' ' + t : t;
            return '<a class="news-link" href="' + escapeHtml(u) + '" target="_blank" rel="noopener">' + lab + '</a>';
          }).filter(Boolean).join('');
        }

        var summaryRow = '<div class="summary-row">' +
          '<span class="summary-chip"><span class="summary-chip k">信号</span><span class="badge ' + (hasAlert ? (planSide === 'short' ? 'no' : 'yes') : 'no') + '">' + escapeHtml(signalLevelText) + '</span></span>' +
          '<span class="summary-chip"><span class="summary-chip k">新闻</span><span class="badge ' + (newsBlocked ? 'no' : 'yes') + '">' + (newsBlocked ? '拦截' : '放行') + '</span></span>' +
          '<span class="summary-chip"><span class="summary-chip k">结果</span><span class="badge ' + (executed ? 'yes' : (dryRunOpen ? 'dry' : 'no')) + '">' + escapeHtml(resultText) + '</span></span>' +
        '</div>';

        var primaryReason = planReasonText || (hasAlert ? (r?.signal?.note || '策略给出信号，但未附可读理由。') : '本轮无交易计划。');
        var finalReason = execReasonText || execReasonRaw || (executed ? '执行成功' : (skipped ? '未满足执行条件' : '无'));
        var reasonPanel = '<details class="fold" open><summary>一眼看懂：核心原因</summary><div class="fold-body"><div class="logic-result-block"><strong>为什么会这样决策：</strong>' + escapeHtml(primaryReason) + '<br/><strong>为什么是这个结果：</strong>' + escapeHtml(finalReason) + '</div></div></details>';

        var metricsPanel = '<details class="fold"><summary>策略与指标详情</summary><div class="fold-body">' + algoDetails + '</div></details>';
        var newsPanel = newsLinkHtml
          ? '<details class="fold"><summary>新闻源（可点击跳转）</summary><div class="fold-body"><div class="news-list-wrap">' + newsLinkHtml + '</div><div class="popover-pin-hint">提示：点击图表固定弹窗后再打开链接更顺手。</div></div></details>'
          : '';
        var rawPanel = '<details class="fold"><summary>执行字段与原始状态</summary><div class="fold-body"><div class="compact-kv">' +
          '<div class="k">cycleId</div><div class="v">' + escapeHtml(r?.cycleId || '-') + '</div>' +
          '<div class="k">计划</div><div class="v">' + escapeHtml(p ? ((p.side || '-') + ' / ' + (p.level || '-')) : 'none') + '</div>' +
          '<div class="k">执行器 reason</div><div class="v">' + escapeHtml(execReasonRaw || '-') + '</div>' +
          '<div class="k">日内PnL</div><div class="v">' + (e && e.dailyRealizedPnlUSDT != null ? escapeHtml(String(e.dailyRealizedPnlUSDT) + ' USDT') : '-') + '</div>' +
        '</div></div></details>';

        return '<button class="popover-close" type="button" aria-label="关闭">&times;</button>' +
          '<div class="popover-ts">' + ts + '</div>' +
          summaryRow +
          treeHtml +
          reasonPanel +
          metricsPanel +
          newsPanel +
          rawPanel;
      }
      var currentPopoverRecord = null;
      var popoverPinned = false;
      popover.addEventListener('click', function(e) { if (e.target.classList.contains('popover-close')) { popoverPinned = false; hidePopover(); } });
      var calcTooltipTimer = null;
      var calcTooltipPinned = false;
      var miniChartInstance = null;
      var hoverTooltip = document.getElementById('indicator-hover-tooltip');
      function hideCalcTooltip() {
        calcTooltipPinned = false;
        hoverTooltip.classList.remove('visible', 'pinned');
        hoverTooltip.style.pointerEvents = '';
        if (miniChartInstance) { try { miniChartInstance.remove(); } catch (_) {} miniChartInstance = null; }
      }
      function showCalcTooltip(el, isPinned) {
        if (!el || !el.getAttribute('data-calc-key')) return;
        if (calcTooltipTimer) { clearTimeout(calcTooltipTimer); calcTooltipTimer = null; }
        if (miniChartInstance) { try { miniChartInstance.remove(); } catch (_) {} miniChartInstance = null; }
        var key = el.getAttribute('data-calc-key'), val = el.getAttribute('data-calc-value') || '';
        var explain = getIndicatorExplain(key);
        var steps = (explain.steps && explain.steps.length) ? explain.steps.map(function(s, i) { return '<div class="calc-tt-step">' + (i + 1) + '. ' + escapeHtml(s) + '</div>'; }).join('') : '';
        hoverTooltip.innerHTML = '<div class="calc-tt-title">' + escapeHtml(key) + '</div><div class="calc-tt-value">本单数值：' + escapeHtml(val) + '</div><div class="calc-tt-steps">' + steps + '</div><div class="calc-tt-formula">' + escapeHtml(explain.formula) + '</div><div class="calc-tt-chart">' + escapeHtml(explain.chartHint) + '</div><div class="calc-tt-minichart" id="calc-tt-minichart"></div><button type="button" class="calc-tt-close">点击关闭</button>';
        var chartWrap = document.getElementById('calc-tt-minichart');
        var tf = (key.indexOf('4H') === 0) ? '4h' : '1h';
        var ohlcv = OHLCV_BY_TF[tf] || [];
        if (chartWrap && ohlcv.length > 0 && typeof LightweightCharts !== 'undefined') {
          var decisionTs = currentPopoverRecord && currentPopoverRecord.ts ? new Date(currentPopoverRecord.ts).getTime() / 1000 : 0;
          var tfSec = TF_SECONDS[tf] || 3600;
          var barT = Math.floor(decisionTs / tfSec) * tfSec;
          var idx = ohlcv.findIndex(function(b) { return b.time >= barT; });
          if (idx < 0) idx = ohlcv.length - 1;
          var from = Math.max(0, idx - 22);
          var slice = ohlcv.slice(from, idx + 6);
          try {
            miniChartInstance = LightweightCharts.createChart(chartWrap, { width: 256, height: 72, layout: { background: { type: 'solid', color: 'rgba(0,0,0,0.2)' }, textColor: '#8b949e' }, grid: { vertLines: { visible: false }, horzLines: { visible: false } }, rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.1, bottom: 0.1 } }, timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false } });
            var series = miniChartInstance.addCandlestickSeries({ upColor: '#3fb950', downColor: '#f85149', borderVisible: false });
            series.setData(slice);
            miniChartInstance.timeScale().fitContent();
          } catch (err) {}
        }
        if (isPinned) { calcTooltipPinned = true; hoverTooltip.classList.add('pinned'); hoverTooltip.style.pointerEvents = 'auto'; }
        hoverTooltip.classList.add('visible');
        var rect = el.getBoundingClientRect();
        var left = rect.right + 8, top = rect.top;
        if (left + 280 > window.innerWidth) left = rect.left - 288;
        var h = hoverTooltip.offsetHeight || 220;
        if (top + h > window.innerHeight - 8) top = window.innerHeight - h - 8;
        if (top < 8) top = 8;
        hoverTooltip.style.left = left + 'px'; hoverTooltip.style.top = top + 'px';
        hoverTooltip.querySelector('.calc-tt-close').onclick = function() { hideCalcTooltip(); };
      }
      popover.addEventListener('mouseover', function(e) {
        if (calcTooltipPinned) return;
        var el = e.target.closest && e.target.closest('.calc-k.clickable');
        if (el && el.getAttribute('data-calc-key')) showCalcTooltip(el, false);
      });
      popover.addEventListener('mouseout', function(e) {
        var el = e.target.closest && e.target.closest('.calc-k.clickable');
        var rel = e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest('.calc-k.clickable');
        if (el && !rel && !calcTooltipPinned) calcTooltipTimer = setTimeout(hideCalcTooltip, 120);
      });
      popover.addEventListener('click', function(e) {
        var el = e.target.closest && e.target.closest('.calc-k.clickable');
        if (el && el.getAttribute('data-calc-key')) { e.preventDefault(); e.stopPropagation(); showCalcTooltip(el, true); }
      });
      document.addEventListener('click', function(e) {
        if (calcTooltipPinned && hoverTooltip && !hoverTooltip.contains(e.target) && !popover.contains(e.target)) hideCalcTooltip();
      });
      function showPopoverAt(record, clientX, clientY) {
        currentPopoverRecord = record;
        const rect = chartWrap.getBoundingClientRect();
        popover.innerHTML = renderDetailCard(record);
        popover.classList.add('visible');
        applyDecisionPriceLines(record);
        popover.style.right = '';
        popover.style.bottom = '';
        popover.style.width = '';
        var left = clientX - rect.left + 12, top = clientY - rect.top - 8;
        if (left + 320 > rect.width) left = rect.width - 330;
        if (top < 8) top = 8;
        if (top + 280 > rect.height) top = rect.height - 290;
        popover.style.left = left + 'px'; popover.style.top = top + 'px';
      }
      function showPopoverPinned(record) {
        currentPopoverRecord = record;
        const rect = chartWrap.getBoundingClientRect();
        popover.innerHTML = renderDetailCard(record);
        popover.classList.add('visible');
        applyDecisionPriceLines(record);
        if (isTouchDevice) {
          popover.style.left = '8px';
          popover.style.right = '8px';
          popover.style.bottom = '8px';
          popover.style.top = 'auto';
          popover.style.width = 'auto';
        } else {
          popover.style.right = '';
          popover.style.bottom = '';
          popover.style.width = '';
          popover.style.left = Math.max(8, rect.width - 340) + 'px';
          popover.style.top = '8px';
        }
        popoverPinned = true;
      }
      function hidePopover() { popoverPinned = false; clearDecisionPriceLines(); popover.classList.remove('visible'); if (typeof hideCalcTooltip === 'function') hideCalcTooltip(); }
      function getRecordAtCoord(x, fuzzyBars) {
        const fuzz = Number.isFinite(Number(fuzzyBars)) ? Math.max(0, Number(fuzzyBars)) : 0;
        const time = chart.timeScale().coordinateToTime(x);
        if (time === null || time === undefined) return null;
        const t = typeof time === 'number' ? time : (time && time.year ? new Date(time.year, (time.month || 1) - 1, time.day || 1).getTime() / 1000 : 0);
        if (!(Number.isFinite(t) && t > 0)) return null;
        const tfSec = TF_SECONDS[currentTf] || 3600;
        const barStart = Math.floor(t / tfSec) * tfSec, barEnd = barStart + tfSec;
        const inWindow = (ts, bStart, bEnd) => ts >= bStart && ts < bEnd;
        let matched = RECORDS_WITH_TS.filter(x => inWindow(x.tsSec, barStart, barEnd));
        if (!matched.length && fuzz > 0) {
          for (let d = 1; d <= fuzz; d++) {
            const leftStart = barStart - d * tfSec;
            const leftEnd = barEnd - d * tfSec;
            const rightStart = barStart + d * tfSec;
            const rightEnd = barEnd + d * tfSec;
            matched = RECORDS_WITH_TS.filter(x => inWindow(x.tsSec, leftStart, leftEnd) || inWindow(x.tsSec, rightStart, rightEnd));
            if (matched.length) break;
          }
        }
        return matched.length ? matched[matched.length - 1].r : null;
      }
      let hidePopoverTimer = null;
      chart.subscribeCrosshairMove(function(param) {
        if (isTouchDevice || popoverPinned) return;
        const rect = chartWrap.getBoundingClientRect();
        if (!param.point) { if (hidePopoverTimer) clearTimeout(hidePopoverTimer); hidePopoverTimer = setTimeout(hidePopover, 80); return; }
        if (hidePopoverTimer) { clearTimeout(hidePopoverTimer); hidePopoverTimer = null; }
        const record = getRecordAtCoord(param.point.x, 0);
        if (!record) { hidePopover(); return; }
        showPopoverAt(record, rect.left + param.point.x, rect.top + param.point.y);
      });
      popover.addEventListener('mouseenter', function() { if (hidePopoverTimer) { clearTimeout(hidePopoverTimer); hidePopoverTimer = null; } });
      chart.subscribeClick(function(param) {
        if (!param.point) return;
        const record = getRecordAtCoord(param.point.x, isTouchDevice ? 2 : 1);
        if (record) { showPopoverPinned(record); }
        const time = chart.timeScale().coordinateToTime(param.point.x);
        if (time == null) return;
        const t = typeof time === 'number' ? time : (time && time.year ? new Date(time.year, (time.month || 1) - 1, time.day || 1).getTime() / 1000 : 0);
        const tfSec = TF_SECONDS[currentTf] || 3600, barStart = Math.floor(t / tfSec) * tfSec;
        const idx = currentOhlcv.findIndex(c => c.time >= barStart);
        if (idx >= 0) chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, idx - 15), to: Math.min(currentOhlcv.length, idx + 10) });
      });
      chartWrap.addEventListener('mouseleave', function(e) { if (!popoverPinned && (!e.relatedTarget || !popover.contains(e.relatedTarget))) hidePopover(); });
      popover.addEventListener('mouseleave', function(e) { if (!popoverPinned && (!e.relatedTarget || !chartWrap.contains(e.relatedTarget))) hidePopover(); });
      document.addEventListener('click', function(e) {
        if (popoverPinned && !popover.contains(e.target) && !chartWrap.contains(e.target) && !(hoverTooltip && hoverTooltip.contains(e.target))) { popoverPinned = false; hidePopover(); }
      });

      const tbody = document.getElementById('tbody');
      const filterExecuted = document.getElementById('filter-executed');
      const filterSkipped = document.getElementById('filter-skipped');
      const filterSignal = document.getElementById('filter-signal');
      const filterErrors = document.getElementById('filter-errors');
      function row(r, index) {
        const isErr = !r.ok || r.stage, cls = isErr ? 'error-row' : '';
        const ts = r.ts ? new Date(r.ts).toLocaleString('zh-CN', { hour12: false }) : '-';
        const tsAttr = r.ts ? ' data-ts="' + escapeHtml(r.ts) + '"' : '';
        let signal = '-';
        if (r.signal) { signal = (r.signal.hasAlert ? '<span class="badge yes">有</span>' : '<span class="badge no">无</span>') + (r.signal.note ? '<span class="detail">' + escapeHtml(r.signal.note) + '</span>' : ''); } else if (r.error) signal = '<span class="badge no">' + escapeHtml(r.error) + '</span>';
        let plan = '-';
        if (r.signal?.plan) { const p = r.signal.plan; plan = '<span class="badge ' + (p.side === 'long' ? 'yes' : 'no') + '">' + escapeHtml(p.side) + '</span> ' + escapeHtml(p.level || ''); if (p.reason) plan += '<div class="detail">' + escapeHtml(String(p.reason).slice(0, 100)) + '</div>'; }
        let news = r.decision ? (r.decision.blockedByNews ? '<span class="badge no">拦截</span>' + (r.decision.newsReason?.length ? '<div class="detail">' + escapeHtml(r.decision.newsReason.slice(0, 2).join('; ')) + '</div>' : '') : '<span class="badge yes">放行</span>') : '-';
        let exec = '-', reason = '-';
        if (r.executor) { const e = r.executor; if (e.executed) exec = '<span class="badge yes">已下单</span>'; else if (e.dryRun && (e.wouldOpenPosition || e.reason === 'dry_run_open')) exec = '<span class="badge dry">Dry-run 会开仓</span>'; else if (e.skipped) exec = '<span class="badge no">未下单</span>'; reason = e.reason ? escapeHtml(e.reason) : '-'; if (e.dailyRealizedPnlUSDT != null) reason += ' <span class="detail">日盈亏 ' + Number(e.dailyRealizedPnlUSDT).toFixed(2) + ' USDT</span>'; } else if (r.error) reason = escapeHtml(r.error);
        return '<tr class="' + cls + '" data-index="' + index + '"' + tsAttr + '><td class="ts" data-label="时间">' + ts + '</td><td data-label="信号">' + signal + '</td><td data-label="计划">' + plan + '</td><td data-label="新闻">' + news + '</td><td data-label="执行">' + exec + '</td><td class="reason" data-label="原因">' + reason + '</td></tr>';
      }
      function render() {
        let list = RECORDS.slice().reverse();
        if (filterExecuted.checked) list = list.filter(r => r.executor?.executed);
        if (filterSkipped.checked) list = list.filter(r => r.executor?.skipped);
        if (filterSignal.checked) list = list.filter(r => r.signal?.hasAlert && !r.executor?.executed);
        if (filterErrors.checked) list = list.filter(r => !r.ok || r.stage);
        if (list.length === 0) { tbody.innerHTML = '<tr><td colspan="6" class="empty">无记录或过滤后为空</td></tr>'; return; }
        tbody.innerHTML = list.map((r, i) => row(r, i)).join('');
        function barIndexForTime(tsStr) { const t = Math.floor(new Date(tsStr).getTime() / 1000); for (let i = currentOhlcv.length - 1; i >= 0; i--) if (currentOhlcv[i].time <= t) return i; return 0; }
        tbody.querySelectorAll('tr[data-ts]').forEach(tr => { tr.addEventListener('click', () => { tbody.querySelectorAll('tr').forEach(t => t.classList.remove('highlight')); tr.classList.add('highlight'); const ts = tr.getAttribute('data-ts'); if (!ts) return; const idx = barIndexForTime(ts); chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, idx - 25), to: Math.min(currentOhlcv.length, idx + 8) }); const record = RECORDS.find(r => r && r.ts === ts && !r.stage); if (record) showPopoverPinned(record); }); });
      }
      [filterExecuted, filterSkipped, filterSignal, filterErrors].filter(Boolean).forEach(el => el.addEventListener('change', render));
      render();
    }

    load().catch(e => showLoadError(e && e.message));
  </script>
</body>
</html>`;

function main() {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(INDEX_PATH, HTML, 'utf8');
  console.log('Wrote', INDEX_PATH);
}

main();
