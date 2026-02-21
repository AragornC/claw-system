export const CHAT_RUNTIME_STATE_SNIPPET = String.raw`
function createChatHistoryStateRuntime(globalKeyLike) {
  const key = String(globalKeyLike || '__thunderclawChatHistoryState');
  const g = typeof window !== 'undefined' ? window : globalThis;
  const existing = g && g[key] && typeof g[key] === 'object' ? g[key] : null;
  if (existing) return existing;
  const state = {
    started: false,
    busy: false,
    afterId: 0,
    timer: null,
    seenIds: new Set(),
    bootRendered: false,
    pendingUserEchoes: [],
    pendingSeq: 0,
  };
  if (g) g[key] = state;
  return state;
}

function createChatLogStoreRuntime(storageKeyLike, maxRowsLike) {
  const storageKey = String(storageKeyLike || 'thunderclaw.chat.log.v2');
  const maxRows = Math.max(100, Math.min(2000, Number(maxRowsLike || 800) || 800));

  function safeJsonParse(raw, fallback) {
    try {
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  function normalizeRole(roleLike) {
    const role = String(roleLike || '').trim().toLowerCase();
    if (role === 'user' || role === 'system' || role === 'bot') return role;
    return 'bot';
  }

  function normalizeRow(rowLike) {
    const row = rowLike && typeof rowLike === 'object' ? rowLike : {};
    const text = String(row.text || '').trim();
    if (!text) return null;
    const idNum = Number(row.id);
    return {
      id: Number.isFinite(idNum) && idNum > 0 ? idNum : null,
      ts: row.ts || new Date().toISOString(),
      role: normalizeRole(row.role),
      source: String(row.source || 'dashboard'),
      text,
    };
  }

  function load() {
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return [];
      const parsed = safeJsonParse(raw, []);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function save(rowsLike) {
    const rows = Array.isArray(rowsLike) ? rowsLike.map(normalizeRow).filter(Boolean).slice(-maxRows) : [];
    try {
      localStorage.setItem(storageKey, JSON.stringify(rows));
    } catch {}
    return rows;
  }

  function append(rowLike) {
    const row = normalizeRow(rowLike);
    if (!row) return false;
    const rows = load();
    rows.push(row);
    save(rows);
    return true;
  }

  function ackUserEcho(textLike, tsLike, idLike) {
    const text = String(textLike || '').trim();
    if (!text) return false;
    const idNum = Number(idLike);
    const tsMs = Number.isFinite(Date.parse(String(tsLike || ''))) ? Date.parse(String(tsLike || '')) : Date.now();
    const rows = load();
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const row = rows[i] && typeof rows[i] === 'object' ? rows[i] : null;
      if (!row || String(row.role || '') !== 'user') continue;
      if (String(row.text || '').trim() !== text) continue;
      if (Number.isFinite(Number(row.id)) && Number(row.id) > 0) continue;
      const rowMs = Number.isFinite(Date.parse(String(row.ts || ''))) ? Date.parse(String(row.ts || '')) : tsMs;
      if (Math.abs(tsMs - rowMs) > 120000) continue;
      row.id = Number.isFinite(idNum) && idNum > 0 ? idNum : null;
      row.ts = tsLike || row.ts;
      save(rows);
      return true;
    }
    return append({
      source: 'dashboard',
      ts: tsLike || null,
      id: Number.isFinite(idNum) ? idNum : null,
      role: 'user',
      text,
    });
  }

  return {
    load,
    save,
    append,
    ackUserEcho,
  };
}
`;
