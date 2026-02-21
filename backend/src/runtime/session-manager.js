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
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function nowIso() {
  return new Date().toISOString();
}

function readJsonSafe(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJsonSafe(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function createSessionManager(options = {}) {
  const filePath = path.resolve(String(options.filePath || 'memory/runtime-sessions.json'));
  const maxEvents = Math.max(50, Number(options.maxEvents || 1200));

  function loadState() {
    return readJsonSafe(filePath, { version: 1, sessions: {}, updatedAt: nowIso() });
  }

  function saveState(state) {
    const next = state && typeof state === 'object' ? state : { version: 1, sessions: {} };
    next.updatedAt = nowIso();
    writeJsonSafe(filePath, next);
    return next;
  }

  function ensureSession(sessionKeyLike, meta = {}) {
    const sessionKey = String(sessionKeyLike || '').trim() || 'dashboard:default';
    const state = loadState();
    const existing = state.sessions[sessionKey];
    if (existing) return existing;
    const created = {
      key: sessionKey,
      id: crypto.randomUUID(),
      createdAt: nowIso(),
      updatedAt: nowIso(),
      status: 'active',
      meta: meta && typeof meta === 'object' ? meta : {},
      events: [],
      summary: '',
    };
    state.sessions[sessionKey] = created;
    saveState(state);
    return created;
  }

  function appendEvent(sessionKeyLike, event) {
    const sessionKey = String(sessionKeyLike || '').trim() || 'dashboard:default';
    const state = loadState();
    const session = state.sessions[sessionKey] || ensureSession(sessionKey);
    const safe = event && typeof event === 'object' ? event : { type: 'event', detail: String(event || '') };
    session.events.push({
      id: crypto.randomUUID(),
      ts: nowIso(),
      ...safe,
    });
    if (session.events.length > maxEvents) {
      session.events = session.events.slice(-maxEvents);
    }
    session.updatedAt = nowIso();
    state.sessions[sessionKey] = session;
    saveState(state);
    return session;
  }

  function listSessions() {
    const state = loadState();
    return Object.values(state.sessions || {}).map((session) => ({
      key: session.key,
      id: session.id,
      status: session.status || 'active',
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      eventCount: Array.isArray(session.events) ? session.events.length : 0,
      summary: String(session.summary || ''),
    }));
  }

  function getSession(sessionKeyLike) {
    const sessionKey = String(sessionKeyLike || '').trim() || 'dashboard:default';
    const state = loadState();
    return state.sessions[sessionKey] || null;
  }

  function patchSession(sessionKeyLike, patch) {
    const sessionKey = String(sessionKeyLike || '').trim() || 'dashboard:default';
    const state = loadState();
    const session = state.sessions[sessionKey] || ensureSession(sessionKey);
    const p = patch && typeof patch === 'object' ? patch : {};
    if (typeof p.summary === 'string') session.summary = p.summary;
    if (typeof p.status === 'string') session.status = p.status;
    if (p.meta && typeof p.meta === 'object') session.meta = { ...(session.meta || {}), ...p.meta };
    session.updatedAt = nowIso();
    state.sessions[sessionKey] = session;
    saveState(state);
    return session;
  }

  function resetSession(sessionKeyLike) {
    const sessionKey = String(sessionKeyLike || '').trim() || 'dashboard:default';
    const state = loadState();
    const session = state.sessions[sessionKey] || ensureSession(sessionKey);
    session.events = [];
    session.summary = '';
    session.updatedAt = nowIso();
    state.sessions[sessionKey] = session;
    saveState(state);
    return session;
  }

  return {
    ensureSession,
    appendEvent,
    listSessions,
    getSession,
    patchSession,
    resetSession,
    filePath,
  };
}
