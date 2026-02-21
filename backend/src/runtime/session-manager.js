import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function nowIso() {
  return new Date().toISOString();
}

function safeJson(raw, fallback) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function normalizeEvent(input) {
  if (input && typeof input === 'object') return input;
  return {
    type: 'event',
    detail: String(input || ''),
  };
}

export function createSessionManager(options = {}) {
  const storePath = path.resolve(String(options.storePath || options.filePath || 'memory/runtime-sessions.json'));
  const maxEvents = Math.max(80, Math.min(4000, Number(options.maxEvents || 1200) || 1200));
  let state = {
    updatedAt: nowIso(),
    sessions: {},
  };

  function load() {
    try {
      if (!fs.existsSync(storePath)) return;
      const parsed = safeJson(fs.readFileSync(storePath, 'utf8'), null);
      if (!parsed || typeof parsed !== 'object') return;
      state = {
        updatedAt: String(parsed.updatedAt || nowIso()),
        sessions: parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {},
      };
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

  function ensureSession(sessionKeyLike, patchLike = {}) {
    const key = normalizeSessionKey(sessionKeyLike);
    if (!state.sessions[key]) {
      state.sessions[key] = {
        key,
        id: crypto.randomUUID(),
        createdAt: nowIso(),
        updatedAt: nowIso(),
        status: 'active',
        turns: 0,
        meta: {},
        summary: '',
        events: [],
      };
    }
    const session = state.sessions[key];
    const patch = patchLike && typeof patchLike === 'object' ? patchLike : {};
    if (patch.meta && typeof patch.meta === 'object') {
      session.meta = { ...(session.meta || {}), ...patch.meta };
    }
    if (typeof patch.status === 'string' && patch.status.trim()) {
      session.status = patch.status.trim();
    }
    session.updatedAt = nowIso();
    save();
    return session;
  }

  function touch(sessionKeyLike, patchLike = {}) {
    const patch = patchLike && typeof patchLike === 'object' ? patchLike : {};
    const session = ensureSession(sessionKeyLike, patch);
    session.turns = Number(session.turns || 0) + (patch.incrementTurns === false ? 0 : 1);
    if (patch.event) {
      const event = normalizeEvent(patch.event);
      session.events.push({
        id: crypto.randomUUID(),
        ts: nowIso(),
        ...event,
      });
      if (session.events.length > maxEvents) {
        session.events = session.events.slice(-maxEvents);
      }
    }
    session.updatedAt = nowIso();
    save();
    return session;
  }

  function appendEvent(sessionKeyLike, eventLike) {
    return touch(sessionKeyLike, { incrementTurns: false, event: eventLike });
  }

  function get(sessionKeyLike) {
    const key = normalizeSessionKey(sessionKeyLike);
    return state.sessions[key] || null;
  }

  function list(limitLike = 100) {
    const limit = Math.max(1, Math.min(800, Number(limitLike || 100) || 100));
    return Object.values(state.sessions)
      .sort((a, b) => new Date(String(b?.updatedAt || 0)).getTime() - new Date(String(a?.updatedAt || 0)).getTime())
      .slice(0, limit)
      .map((session) => ({
        ...session,
        eventCount: Array.isArray(session.events) ? session.events.length : 0,
      }));
  }

  function compact(sessionKeyLike, optionsLike = {}) {
    const session = ensureSession(sessionKeyLike);
    const options = optionsLike && typeof optionsLike === 'object' ? optionsLike : {};
    const keepEvents = Math.max(10, Math.min(maxEvents, Number(options.keepEvents || 160) || 160));
    const events = Array.isArray(session.events) ? session.events : [];
    if (events.length <= keepEvents) return session;

    const dropped = events.slice(0, events.length - keepEvents);
    const droppedSummary = dropped
      .slice(-12)
      .map((x) => String(x?.detail || x?.text || x?.type || '').trim())
      .filter(Boolean)
      .join(' | ')
      .slice(0, 900);

    session.events = events.slice(-keepEvents);
    if (droppedSummary) {
      session.summary = session.summary ? `${session.summary}\n${droppedSummary}` : droppedSummary;
    }
    session.status = 'active';
    session.updatedAt = nowIso();
    save();
    return session;
  }

  function reset(sessionKeyLike) {
    const key = normalizeSessionKey(sessionKeyLike);
    const prev = state.sessions[key];
    state.sessions[key] = {
      key,
      id: crypto.randomUUID(),
      createdAt: nowIso(),
      updatedAt: nowIso(),
      status: 'active',
      turns: 0,
      meta: prev?.meta && typeof prev.meta === 'object' ? prev.meta : {},
      summary: '',
      events: [],
    };
    save();
    return state.sessions[key];
  }

  function resume(sessionKeyLike) {
    const session = ensureSession(sessionKeyLike);
    session.status = 'active';
    session.updatedAt = nowIso();
    save();
    return session;
  }

  load();

  return {
    storePath,
    normalizeSessionKey,
    ensureSession,
    touch,
    appendEvent,
    get,
    list,
    reset,
    compact,
    resume,
  };
}
