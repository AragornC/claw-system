import fs from 'node:fs';
import path from 'node:path';

function nowIso() {
  return new Date().toISOString();
}

function safeParseJson(raw, fallback) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function createSessionManager(options = {}) {
  const storePath = path.resolve(String(options.storePath || 'memory/runtime-sessions.json'));
  let state = {
    updatedAt: nowIso(),
    sessions: {},
  };

  function load() {
    try {
      if (!fs.existsSync(storePath)) return;
      const raw = fs.readFileSync(storePath, 'utf8');
      const parsed = safeParseJson(raw, null);
      if (parsed && typeof parsed === 'object') {
        state = {
          updatedAt: String(parsed.updatedAt || nowIso()),
          sessions: parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {},
        };
      }
    } catch {}
  }

  function save() {
    state.updatedAt = nowIso();
    try {
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      fs.writeFileSync(storePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    } catch {}
  }

  function normalizeSessionKey(rawLike) {
    const raw = String(rawLike || '').trim();
    return raw || 'dashboard:main';
  }

  function ensureSession(sessionKeyLike) {
    const key = normalizeSessionKey(sessionKeyLike);
    if (!state.sessions[key]) {
      state.sessions[key] = {
        key,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        turns: 0,
        meta: {},
      };
      save();
    }
    return state.sessions[key];
  }

  function touch(sessionKeyLike, patchLike = {}) {
    const session = ensureSession(sessionKeyLike);
    const patch = patchLike && typeof patchLike === 'object' ? patchLike : {};
    session.updatedAt = nowIso();
    session.turns = Number(session.turns || 0) + 1;
    if (patch.meta && typeof patch.meta === 'object') {
      session.meta = { ...(session.meta || {}), ...patch.meta };
    }
    save();
    return session;
  }

  function get(sessionKeyLike) {
    const key = normalizeSessionKey(sessionKeyLike);
    return state.sessions[key] || null;
  }

  function list(limitLike = 100) {
    const limit = Math.max(1, Math.min(500, Number(limitLike || 100) || 100));
    return Object.values(state.sessions)
      .sort((a, b) => new Date(String(b?.updatedAt || 0)).getTime() - new Date(String(a?.updatedAt || 0)).getTime())
      .slice(0, limit);
  }

  function reset(sessionKeyLike) {
    const key = normalizeSessionKey(sessionKeyLike);
    delete state.sessions[key];
    save();
    return ensureSession(key);
  }

  load();

  return {
    storePath,
    normalizeSessionKey,
    ensureSession,
    touch,
    get,
    list,
    reset,
  };
}
