#!/usr/bin/env node
import http from 'node:http';
import { URL } from 'node:url';

const PORT = Math.max(1, Math.min(65535, Number(process.argv[2] || process.env.THUNDERCLAW_MCP_BRIDGE_PORT || 9001) || 9001));
const HOST = process.env.THUNDERCLAW_MCP_BRIDGE_HOST || '127.0.0.1';
const TARGET_BASE = (process.env.THUNDERCLAW_MCP_BRIDGE_TARGET || 'http://127.0.0.1:8765').replace(/\/+$/, '');
const BRIDGE_TOKEN = String(process.env.THUNDERCLAW_MCP_BRIDGE_TOKEN || '').trim();
const DEFAULT_INVOKE_TIMEOUT_MS = Math.max(1200, Math.min(15000, Number(process.env.THUNDERCLAW_MCP_BRIDGE_INVOKE_TIMEOUT_MS || 6000) || 6000));
const DEFAULT_INVOKE_RETRY = Math.max(0, Math.min(3, Number(process.env.THUNDERCLAW_MCP_BRIDGE_INVOKE_RETRY || 1) || 1));
const DEFAULT_FALLBACK_MODE = String(process.env.THUNDERCLAW_MCP_BRIDGE_FALLBACK || 'internal').trim().toLowerCase();

const TOOL_DEFINITIONS = Object.freeze([
  {
    name: 'get_market_news_impact',
    description: '抓取宏观/币圈新闻并生成影响评估',
    inputSchema: {
      type: 'object',
      properties: {
        asset: { type: 'string' },
        q: { type: 'string' },
        limit: { type: 'number' },
      },
      additionalProperties: false,
    },
    permissionLevel: 'read',
    visibility: 'global',
    idempotent: true,
  },
  {
    name: 'get_strategy_metrics',
    description: '读取策略工件并聚合关键指标',
    inputSchema: {
      type: 'object',
      properties: {
        strategy: { type: 'string' },
      },
      additionalProperties: false,
    },
    permissionLevel: 'read',
    visibility: 'global',
    idempotent: true,
  },
  {
    name: 'list_strategy_features',
    description: '列出已注册策略特征',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string' },
        group: { type: 'string' },
        enabledOnly: { type: 'boolean' },
        limit: { type: 'number' },
      },
      additionalProperties: false,
    },
    permissionLevel: 'read',
    visibility: 'global',
    idempotent: true,
  },
  {
    name: 'create_strategy_features',
    description: '创建/更新策略特征',
    inputSchema: {
      type: 'object',
      properties: {
        features: { type: 'array', items: { type: 'object' } },
      },
      additionalProperties: false,
    },
    permissionLevel: 'write',
    visibility: 'global',
    idempotent: false,
  },
  {
    name: 'generate_strategy_versions',
    description: '基于提示词生成策略版本候选',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string' },
        baseVersionId: { type: 'string' },
      },
      additionalProperties: false,
    },
    permissionLevel: 'write',
    visibility: 'global',
    idempotent: false,
  },
  {
    name: 'list_strategy_versions',
    description: '列出策略版本',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number' },
      },
      additionalProperties: false,
    },
    permissionLevel: 'read',
    visibility: 'global',
    idempotent: true,
  },
]);

function sendJson(res, code, payload) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function clampNum(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function createTraceId() {
  return `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function withTimeout(promise, timeoutMs) {
  const ms = Math.max(600, Number(timeoutMs || DEFAULT_INVOKE_TIMEOUT_MS) || DEFAULT_INVOKE_TIMEOUT_MS);
  let timer = null;
  return Promise.race([
    promise.finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('invoke_timeout')), ms);
    }),
  ]);
}

function buildToolsManifest() {
  return {
    schemaVersion: 'mcp-tool-manifest-v2',
    namespace: 'thunderclaw.strategy',
    generatedAt: new Date().toISOString(),
    tools: TOOL_DEFINITIONS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      permissionLevel: tool.permissionLevel,
      visibility: tool.visibility,
      idempotent: tool.idempotent,
    })),
  };
}

function normalizeInvokeOptions(bodyLike = {}) {
  const body = bodyLike && typeof bodyLike === 'object' ? bodyLike : {};
  const timeoutMs = clampNum(body.timeoutMs != null ? body.timeoutMs : DEFAULT_INVOKE_TIMEOUT_MS, 800, 20000);
  const retry = clampNum(body.retry != null ? body.retry : DEFAULT_INVOKE_RETRY, 0, 3);
  const fallback = String(body.fallback || DEFAULT_FALLBACK_MODE || 'internal').trim().toLowerCase();
  return {
    traceId: String(body.traceId || createTraceId()),
    timeoutMs,
    retry,
    fallback: fallback === 'none' ? 'none' : 'internal',
  };
}

function decodeHtml(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

async function fetchTextWithTimeout(url, timeoutMs = 4500) {
  const ac = new AbortController();
  const timer = setTimeout(() => {
    try {
      ac.abort();
    } catch {}
  }, timeoutMs);
  try {
    const resp = await fetch(url, {
      method: 'GET',
      signal: ac.signal,
      headers: {
        'User-Agent': 'thunderclaw-mcp-bridge-local/1.0',
        Accept: 'application/rss+xml, application/xml, text/xml, text/html, application/json',
      },
    });
    if (!resp.ok) throw new Error('http_' + resp.status);
    return await resp.text();
  } finally {
    clearTimeout(timer);
  }
}

function parseRssTitles(xmlLike, sourceName, limit = 8) {
  const xml = String(xmlLike || '');
  const out = [];
  const itemMatches = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  for (const item of itemMatches.slice(0, 40)) {
    const titleMatch = item.match(/<title>([\s\S]*?)<\/title>/i);
    if (!titleMatch || !titleMatch[1]) continue;
    const raw = decodeHtml(titleMatch[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim());
    if (!raw) continue;
    out.push({ title: raw, source: sourceName });
    if (out.length >= limit) break;
  }
  return out;
}

function scoreHeadlineSentiment(titleLike = '') {
  const t = String(titleLike || '').toLowerCase();
  let score = 0;
  const pos = ['surge', 'rally', 'gain', 'approval', 'adopt', 'bull', 'inflow', 'record high', 'beats', 'upgrade', '利好', '上涨', '突破', '增持', '通过'];
  const neg = ['hack', 'exploit', 'lawsuit', 'ban', 'outflow', 'dump', 'plunge', 'liquidation', 'default', 'downgrade', 'fraud', 'war', 'tariff', 'bear', '利空', '下跌', '暴跌', '清算', '监管打击', '风险'];
  const risk = ['hack', 'exploit', 'war', 'tariff', 'ban', 'lawsuit', 'fraud', 'liquidation', '监管', '冲突', '黑客', '清算'];
  pos.forEach((k) => { if (t.includes(k)) score += 1; });
  neg.forEach((k) => { if (t.includes(k)) score -= 1; });
  const riskHits = risk.reduce((n, k) => n + (t.includes(k) ? 1 : 0), 0);
  return {
    score,
    riskHits,
  };
}

function isMostlyEnglish(textLike = '') {
  const t = String(textLike || '');
  const letters = (t.match(/[A-Za-z]/g) || []).length;
  const cjk = (t.match(/[\u4e00-\u9fff]/g) || []).length;
  return letters > 0 && letters >= cjk * 2;
}

function headlineToZhSummary(titleLike = '') {
  const t = String(titleLike || '').trim();
  const lower = t.toLowerCase();
  if (!t) return '暂无标题';
  if (/(etf).*(outflow|withdraw)/i.test(lower)) return 'ETF 资金流出，短线风险偏高。';
  if (/(etf).*(inflow)/i.test(lower)) return 'ETF 资金流入，市场风险偏好提升。';
  if (/(hack|exploit|fraud|lawsuit|ban|liquidation|监管打击|黑客|清算)/i.test(lower)) return '出现监管/安全负面事件，建议收紧风险。';
  if (/(record high|surge|rally|突破|上涨|增持|approval|adopt)/i.test(lower)) return '偏利好信号，趋势延续概率提升。';
  if (/(fed|美联储|利率|cpi|通胀|tariff|关税|war|冲突)/i.test(lower)) return '宏观变量扰动增强，建议降低杠杆观察。';
  if (/(bitcoin|btc|比特币)/i.test(lower)) return 'BTC 相关事件，可能影响短期波动与情绪。';
  if (/(ethereum|eth|以太坊)/i.test(lower)) return 'ETH 相关事件，关注主流币联动风险。';
  return '事件信息中性，建议结合价格与成交量确认。';
}

async function buildMarketNewsImpact(argsLike = {}) {
  const args = argsLike && typeof argsLike === 'object' ? argsLike : {};
  const limit = clampNum(args.limit != null ? args.limit : 6, 3, 12);
  const asset = String(args.asset || 'BTC').trim().toUpperCase();
  const q = String(args.q || '').trim();
  const feeds = [
    { url: 'https://news.google.com/rss/search?q=BTC+OR+Bitcoin+crypto&hl=zh-CN&gl=CN&ceid=CN:zh-Hans', source: 'google-news-zh' },
    { url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', source: 'coindesk' },
    { url: 'https://cointelegraph.com/rss', source: 'cointelegraph' },
  ];
  const fetches = await Promise.allSettled(
    feeds.map((f) => fetchTextWithTimeout(f.url, 5000).then((text) => ({ source: f.source, text }))),
  );
  const headlines = [];
  fetches.forEach((it) => {
    if (it.status !== 'fulfilled') return;
    const rows = parseRssTitles(it.value.text, it.value.source, 10);
    rows.forEach((r) => headlines.push(r));
  });
  const unique = [];
  const seen = new Set();
  headlines.forEach((h) => {
    const key = h.title.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    unique.push(h);
  });
  const filtered = unique
    .filter((h) => {
      const t = h.title.toLowerCase();
      if (!q) return true;
      return t.includes(q.toLowerCase());
    })
    .filter((h) => {
      const t = h.title.toLowerCase();
      return (
        t.includes(asset.toLowerCase()) ||
        /(bitcoin|btc|ethereum|eth|crypto|market|fed|sec|etf|比特币|以太坊|加密|宏观|监管|美联储|关税|冲突)/i.test(t)
      );
    })
    .slice(0, limit);
  const scored = filtered.map((h) => {
    const s = scoreHeadlineSentiment(h.title);
    return { ...h, sentiment: s.score, riskHits: s.riskHits };
  });
  const sentimentAgg = scored.reduce((n, x) => n + Number(x.sentiment || 0), 0);
  const riskAgg = scored.reduce((n, x) => n + Number(x.riskHits || 0), 0);
  const sentimentScore = Number((scored.length ? sentimentAgg / scored.length : 0).toFixed(3));
  const eventIntensity = Math.max(1, Math.min(5, Math.round(Math.abs(sentimentAgg) / 2 + riskAgg / 2 + (scored.length >= 5 ? 1 : 0))));
  const riskLevel = riskAgg >= 4 || sentimentScore <= -0.6 ? 'high' : riskAgg >= 2 || sentimentScore < 0 ? 'medium' : 'low';
  const summaryLines = [];
  if (!scored.length) {
    summaryLines.push('当前未抓到足够新闻样本，建议稍后重试或放宽关键词。');
  } else {
    summaryLines.push(
      '新闻影响评估：sentiment=' +
        String(sentimentScore) +
        ' · intensity=' +
        String(eventIntensity) +
        '/5 · risk=' +
        riskLevel,
    );
    scored.slice(0, 5).forEach((x, idx) => {
      const zhLine = headlineToZhSummary(x.title);
      if (isMostlyEnglish(x.title)) {
        summaryLines.push(String(idx + 1) + '. [' + x.source + '] ' + zhLine + '（原文：' + x.title + '）');
      } else {
        summaryLines.push(String(idx + 1) + '. [' + x.source + '] ' + x.title + '；解读：' + zhLine);
      }
    });
  }
  const featureCandidates = [
    {
      name: 'news_sentiment_score',
      group: 'event',
      kind: 'filter',
      description: '用新闻情绪分过滤入场信号（当前估计=' + String(sentimentScore) + '）。',
      paramsDefault: { thresholdLong: Math.max(0.1, 0.2 + sentimentScore / 4), thresholdShort: Math.min(-0.1, -0.2 + sentimentScore / 4), windowHours: 24 },
      enabled: true,
    },
    {
      name: 'event_intensity',
      group: 'event',
      kind: 'indicator',
      description: '将事件冲击映射为强度等级（当前=' + String(eventIntensity) + '/5）。',
      paramsDefault: { minLevel: Math.max(2, Math.min(4, eventIntensity)), coolDownMinutes: riskLevel === 'high' ? 120 : 60 },
      enabled: true,
    },
    {
      name: 'risk_switch_on_breaking_news',
      group: 'risk',
      kind: 'risk',
      description: '高风险新闻时触发风控开关。',
      paramsDefault: { intensityThreshold: Math.max(3, eventIntensity), sentimentThreshold: -0.4, pauseMinutes: riskLevel === 'high' ? 90 : 45, tightenStopMultiplier: riskLevel === 'high' ? 0.75 : 0.9 },
      enabled: true,
    },
  ];
  return {
    summary: summaryLines.join('\n'),
    data: {
      asset,
      q,
      sentimentScore,
      eventIntensity,
      riskLevel,
      headlines: scored,
      featureCandidates,
    },
  };
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += String(chunk || '');
      if (raw.length > 1_500_000) {
        resolve({ ok: false, error: 'payload_too_large' });
        try {
          req.destroy();
        } catch {}
      }
    });
    req.on('error', () => resolve({ ok: false, error: 'request_stream_error' }));
    req.on('end', () => {
      try {
        resolve({ ok: true, value: raw.trim() ? JSON.parse(raw) : {} });
      } catch {
        resolve({ ok: false, error: 'invalid_json' });
      }
    });
  });
}

async function fetchJson(pathname) {
  const resp = await fetch(TARGET_BASE + pathname, { method: 'GET' });
  const txt = await resp.text();
  let json = null;
  try {
    json = JSON.parse(txt);
  } catch {
    json = null;
  }
  if (!resp.ok || !json || json.ok !== true) {
    throw new Error('upstream ' + resp.status + ': ' + String(txt || '').slice(0, 260));
  }
  return json;
}

async function postJson(pathname, body) {
  const resp = await fetch(TARGET_BASE + pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const txt = await resp.text();
  let json = null;
  try {
    json = JSON.parse(txt);
  } catch {
    json = null;
  }
  if (!resp.ok || !json || json.ok !== true) {
    throw new Error('upstream ' + resp.status + ': ' + String(txt || '').slice(0, 260));
  }
  return json;
}

function formatMetricsFromArtifacts(payload, strategyFilter) {
  const rows = Array.isArray(payload?.artifacts) ? payload.artifacts : [];
  const selected = strategyFilter
    ? rows.filter((x) => String(x?.strategyType || '') === strategyFilter)
    : rows;
  const byStrategy = new Map();
  selected.forEach((r) => {
    const key = String(r?.strategyType || 'unknown');
    if (!byStrategy.has(key)) byStrategy.set(key, []);
    byStrategy.get(key).push(r);
  });
  const metrics = Array.from(byStrategy.entries()).map(([strategy, list]) => {
    const latest = (list || [])
      .slice()
      .sort((a, b) => new Date(String(b?.updatedAt || 0)).getTime() - new Date(String(a?.updatedAt || 0)).getTime())[0] || {};
    return {
      strategy,
      winRate: Number(latest?.avgWinRate || latest?.winRate || 0),
      netPnlPct: Number(latest?.avgNetPnlPct || latest?.netPnlPct || 0),
      maxDrawdownPct: Number(latest?.avgDrawdownPct || latest?.maxDrawdownPct || 0),
      tradeCount: Number(latest?.totalTrades || latest?.tradeCount || 0),
      updatedAt: latest?.updatedAt || latest?.createdAt || '',
    };
  });
  metrics.sort((a, b) => b.winRate - a.winRate);
  if (!metrics.length) {
    return {
      summary: '当前还没有可用的策略评估数据。先跑一轮回验/对比，我就能给你准确结果。',
      data: { rows: [], strategy: strategyFilter || null },
    };
  }
  const lines = [];
  lines.push(strategyFilter ? ('策略 ' + strategyFilter + ' 的表现：') : '当前策略表现：');
  metrics.slice(0, 6).forEach((m, idx) => {
    const pnl = Number(m.netPnlPct || 0);
    lines.push(
      String(idx + 1) +
        '. ' +
        m.strategy +
        ' · 胜率=' +
        Number(m.winRate).toFixed(2) +
        '% · 净收益=' +
        (pnl >= 0 ? '+' : '') +
        pnl.toFixed(2) +
        '% · 回撤=' +
        Number(m.maxDrawdownPct).toFixed(2) +
        '% · 样本=' +
        String(Math.max(0, Math.round(m.tradeCount || 0))),
    );
  });
  lines.push('当前胜率最高：' + String(metrics[0].strategy) + '（' + Number(metrics[0].winRate).toFixed(2) + '%）。');
  return {
    summary: lines.join('\n'),
    data: { rows: metrics, strategy: strategyFilter || null },
  };
}

async function invokeTool(tool, args) {
  const a = args && typeof args === 'object' ? args : {};
  if (tool === 'get_market_news_impact') {
    return await buildMarketNewsImpact(a);
  }
  if (tool === 'get_strategy_metrics') {
    const artifacts = await fetchJson('/api/strategy/artifacts?limit=80');
    return formatMetricsFromArtifacts(artifacts, String(a.strategy || '').trim());
  }
  if (tool === 'list_strategy_features') {
    const q = encodeURIComponent(String(a.q || '').trim());
    const group = encodeURIComponent(String(a.group || '').trim());
    const payload = await fetchJson('/api/strategy/features?q=' + q + '&group=' + group);
    let rows = Array.isArray(payload?.features) ? payload.features : [];
    if (a.enabledOnly === true) rows = rows.filter((x) => x?.enabled !== false);
    const limit = clampNum(a.limit != null ? a.limit : 12, 1, 30);
    const slice = rows.slice(0, limit);
    const summary = slice.length
      ? ['当前交易特征：']
          .concat(
            slice.map((f, idx) => String(idx + 1) + '. ' + String(f?.name || f?.featureId || '-') + ' [' + String(f?.group || '-') + '/' + String(f?.kind || '-') + '] ' + (f?.enabled === false ? '关闭' : '启用')),
          )
          .join('\n')
      : '当前没有符合条件的交易特征。';
    return { summary, data: { total: slice.length, rows: slice } };
  }
  if (tool === 'create_strategy_features') {
    const list = Array.isArray(a.features) ? a.features : [];
    const out = [];
    for (const item of list.slice(0, 6)) {
      if (!item || typeof item !== 'object') continue;
      const payload = await postJson('/api/strategy/features/upsert', {
        name: String(item.name || '').trim(),
        group: String(item.group || 'custom').trim(),
        kind: String(item.kind || 'indicator').trim(),
        description: String(item.description || '').trim(),
        paramsDefault: item.paramsDefault && typeof item.paramsDefault === 'object' ? item.paramsDefault : {},
        enabled: item.enabled !== false,
      });
      if (payload?.feature) out.push(payload.feature);
    }
    const summary = out.length
      ? ['已新增特征：']
          .concat(out.map((f, idx) => String(idx + 1) + '. ' + String(f?.name || f?.featureId || '-') + ' [' + String(f?.group || '-') + '/' + String(f?.kind || '-') + ']'))
          .join('\n')
      : '未新增任何特征（可能是参数不完整）。';
    return { summary, data: { total: out.length, rows: out } };
  }
  if (tool === 'generate_strategy_versions') {
    const payload = await postJson('/api/strategy/versions/propose', {
      message: String(a.message || '').trim(),
      baseVersionId: String(a.baseVersionId || '').trim() || null,
    });
    const rows = Array.isArray(payload?.proposals) ? payload.proposals : [];
    const summary = rows.length
      ? ['已生成策略候选版本：']
          .concat(rows.map((r, idx) => String(idx + 1) + '. ' + String(r?.version?.title || r?.version?.versionId || '-')))
          .join('\n')
      : '本次未生成新版本。';
    return {
      summary,
      actions: [{ type: 'switch_view', view: 'backtest' }],
      data: { total: rows.length, proposals: rows },
    };
  }
  if (tool === 'list_strategy_versions') {
    const limit = clampNum(a.limit != null ? a.limit : 10, 1, 40);
    const payload = await fetchJson('/api/strategy/versions?limit=' + String(limit));
    const rows = Array.isArray(payload?.versions) ? payload.versions : [];
    const summary = rows.length
      ? ['当前策略版本：']
          .concat(
            rows.map((v, idx) => String(idx + 1) + '. ' + String(v?.title || v?.versionId || '-') + '（' + String(v?.versionId || '-') + '）' + (Number.isFinite(Number(v?.score)) ? (' · score=' + Number(v.score).toFixed(4)) : '')),
          )
          .join('\n')
      : '当前还没有策略版本。';
    return { summary, data: { total: rows.length, rows: rows.slice(0, 20) } };
  }
  throw new Error('tool_not_supported: ' + tool);
}

async function invokeToolWithPolicy(toolName, args, policyLike = {}) {
  const policy = policyLike && typeof policyLike === 'object' ? policyLike : {};
  const traceId = String(policy.traceId || createTraceId());
  const timeoutMs = clampNum(policy.timeoutMs != null ? policy.timeoutMs : DEFAULT_INVOKE_TIMEOUT_MS, 800, 20000);
  const retry = clampNum(policy.retry != null ? policy.retry : DEFAULT_INVOKE_RETRY, 0, 3);
  const fallback = String(policy.fallback || DEFAULT_FALLBACK_MODE || 'internal').trim().toLowerCase();

  const attempts = [];
  const startedAt = Date.now();
  for (let attempt = 0; attempt <= retry; attempt += 1) {
    const aStarted = Date.now();
    try {
      const result = await withTimeout(invokeTool(toolName, args), timeoutMs);
      const summary = String(result?.summary || '').trim();
      const actions = Array.isArray(result?.actions) ? result.actions : [];
      const data = result?.data && typeof result.data === 'object' ? result.data : null;
      attempts.push({
        attempt,
        ok: true,
        elapsedMs: Date.now() - aStarted,
      });
      return {
        ok: true,
        traceId,
        tool: toolName,
        elapsedMs: Date.now() - startedAt,
        retryCount: attempt,
        timeoutMs,
        fallback,
        attempts,
        summary,
        actions,
        data,
        result: {
          summary,
          actions,
          data,
        },
        meta: {
          adapter: 'mcp-local',
          source: 'bridge-local',
        },
      };
    } catch (err) {
      attempts.push({
        attempt,
        ok: false,
        elapsedMs: Date.now() - aStarted,
        error: String(err?.message || err || 'invoke_failed'),
      });
    }
  }

  const last = attempts[attempts.length - 1] || null;
  return {
    ok: false,
    traceId,
    tool: toolName,
    elapsedMs: Date.now() - startedAt,
    timeoutMs,
    retry,
    fallback,
    attempts,
    error: String(last?.error || 'tool_invoke_failed'),
    detail: fallback === 'internal' ? 'fallback_to_internal_recommended' : '',
    canFallback: fallback === 'internal',
    meta: {
      adapter: 'mcp-local',
      source: 'bridge-local',
    },
  };
}

const server = http.createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const method = String(req.method || 'GET').toUpperCase();
    if (url.pathname === '/healthz') {
      return sendJson(res, 200, {
        ok: true,
        service: 'mcp-bridge-local',
        target: TARGET_BASE,
        tokenRequired: Boolean(BRIDGE_TOKEN),
        invokePolicy: {
          timeoutMs: DEFAULT_INVOKE_TIMEOUT_MS,
          retry: DEFAULT_INVOKE_RETRY,
          fallback: DEFAULT_FALLBACK_MODE,
        },
      });
    }
    if (url.pathname === '/tools' || url.pathname === '/tool/manifest') {
      return sendJson(res, 200, {
        ok: true,
        ...buildToolsManifest(),
      });
    }
    if (url.pathname !== '/tool/invoke') return sendJson(res, 404, { ok: false, error: 'not_found' });
    if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
    if (BRIDGE_TOKEN) {
      const auth = String(req.headers.authorization || '');
      if (auth !== 'Bearer ' + BRIDGE_TOKEN) {
        return sendJson(res, 401, { ok: false, error: 'unauthorized' });
      }
    }
    const body = await readJsonBody(req);
    if (!body.ok) return sendJson(res, 400, { ok: false, error: body.error || 'invalid_body' });
    const tool = String(body.value?.tool || '').trim();
    if (!tool) return sendJson(res, 400, { ok: false, error: 'tool_required' });
    const invokeOptions = normalizeInvokeOptions(body.value);
    try {
      const out = await invokeToolWithPolicy(tool, body.value?.arguments || {}, invokeOptions);
      return sendJson(res, 200, out);
    } catch (err) {
      return sendJson(res, 200, {
        ok: false,
        traceId: invokeOptions.traceId,
        tool,
        error: String(err?.message || err),
        timeoutMs: invokeOptions.timeoutMs,
        retry: invokeOptions.retry,
        fallback: invokeOptions.fallback,
        canFallback: invokeOptions.fallback === 'internal',
      });
    }
  })().catch((err) => {
    sendJson(res, 500, { ok: false, error: String(err?.message || err || 'internal_error') });
  });
});

server.listen(PORT, HOST, () => {
  process.stdout.write(
    '[mcp-bridge-local] listening http://' +
      HOST +
      ':' +
      PORT +
      ' -> target=' +
      TARGET_BASE +
      '\n',
  );
});

