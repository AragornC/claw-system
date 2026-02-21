function esc(v) {
  return String(v || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function normalizeExecutionTrace(traceLike) {
  if (!Array.isArray(traceLike)) return [];
  return traceLike
    .map((x) => {
      if (!x || typeof x !== 'object') return null;
      return {
        step: String(x.step || x.type || 'runtime'),
        ts: String(x.ts || ''),
        summary: String(x.summary || ''),
      };
    })
    .filter(Boolean)
    .slice(0, 20);
}

export function buildExecutionTraceHtml(traceLike) {
  const rows = normalizeExecutionTrace(traceLike);
  if (!rows.length) return '';
  const items = rows
    .map(
      (x, i) =>
        `<div class="ai-trace-item"><span class="ai-trace-idx">${i + 1}</span><span class="ai-trace-step">${esc(
          x.step,
        )}</span><span class="ai-trace-summary">${esc(x.summary)}</span></div>`,
    )
    .join('');
  return `<div class="ai-trace-block">${items}</div>`;
}

export function formatExecutionTrace(traceLike) {
  const rows = normalizeExecutionTrace(traceLike);
  if (!rows.length) return '';
  return rows
    .map((item, idx) => {
      const title = `${idx + 1}) ${item.step}`;
      if (!item.summary && !item.ts) return title;
      if (!item.ts) return `${title}: ${item.summary}`;
      if (!item.summary) return `${title}: ${item.ts}`;
      return `${title}: ${item.summary} @ ${item.ts}`;
    })
    .join('\n');
}
