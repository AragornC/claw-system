export const CHAT_RUNTIME_EVENTS_SNIPPET = String.raw`
function formatExecutionTraceRuntime(traceLike, limitLike) {
  const trace = Array.isArray(traceLike) ? traceLike : [];
  if (!trace.length) return '';
  const limit = Math.max(1, Math.min(24, Number(limitLike || 12) || 12));
  const lines = [];
  trace.slice(0, limit).forEach(function(item, idx) {
    const row = item && typeof item === 'object' ? item : null;
    if (!row) return;
    const step = String(row.step || row.type || 'step');
    const summary = String(row.summary || '').trim();
    const ts = String(row.ts || '').trim();
    if (summary && ts) lines.push(String(idx + 1) + ') ' + step + ': ' + summary + ' @ ' + ts);
    else if (summary) lines.push(String(idx + 1) + ') ' + step + ': ' + summary);
    else if (ts) lines.push(String(idx + 1) + ') ' + step + ': ' + ts);
    else lines.push(String(idx + 1) + ') ' + step);
  });
  return lines.join('\n');
}

function rememberSeenEventIdRuntime(stateLike, idLike, maxSeenLike, keepLike) {
  const state = stateLike && typeof stateLike === 'object' ? stateLike : null;
  if (!state) return;
  const idNum = Number(idLike);
  if (!Number.isFinite(idNum)) return;
  if (!(state.seenIds instanceof Set)) state.seenIds = new Set();
  state.seenIds.add(idNum);
  state.afterId = Math.max(Number(state.afterId || 0), idNum);
  const maxSeen = Math.max(500, Number(maxSeenLike || 3000) || 3000);
  const keep = Math.max(200, Math.min(maxSeen, Number(keepLike || 1800) || 1800));
  if (state.seenIds.size > maxSeen) {
    const sorted = Array.from(state.seenIds).sort(function(a, b) { return b - a; });
    state.seenIds = new Set(sorted.slice(0, keep));
  }
}

function findPendingEchoIndexRuntime(listLike, textLike, eventTsMsLike, maxAgeMsLike) {
  const rows = Array.isArray(listLike) ? listLike : [];
  const text = String(textLike || '').trim();
  const eventTsMs = Number(eventTsMsLike) || Date.now();
  const maxAgeMs = Math.max(10_000, Number(maxAgeMsLike || 120_000) || 120_000);
  if (!text) return -1;
  return rows.findIndex(function(item) {
    if (!item || typeof item !== 'object') return false;
    if (String(item.text || '').trim() !== text) return false;
    const ageMs = Math.abs(eventTsMs - Number(item.createdAt || 0));
    return ageMs <= maxAgeMs;
  });
}
`;
