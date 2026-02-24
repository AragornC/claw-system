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
    pendingBotEchoes: [],
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

  function ackBotEcho(textLike, tsLike, idLike, sourceLike) {
    const text = String(textLike || '').trim();
    if (!text) return false;
    const idNum = Number(idLike);
    const tsMs = Number.isFinite(Date.parse(String(tsLike || ''))) ? Date.parse(String(tsLike || '')) : Date.now();
    const source = String(sourceLike || 'dashboard') || 'dashboard';
    const rows = load();
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const row = rows[i] && typeof rows[i] === 'object' ? rows[i] : null;
      if (!row || String(row.role || '') !== 'bot') continue;
      if (String(row.text || '').trim() !== text) continue;
      if (String(row.source || '') !== source) continue;
      if (Number.isFinite(Number(row.id)) && Number(row.id) > 0) continue;
      const rowMs = Number.isFinite(Date.parse(String(row.ts || ''))) ? Date.parse(String(row.ts || '')) : tsMs;
      if (Math.abs(tsMs - rowMs) > 180000) continue;
      row.id = Number.isFinite(idNum) && idNum > 0 ? idNum : null;
      row.ts = tsLike || row.ts;
      save(rows);
      return true;
    }
    return append({
      source: source,
      ts: tsLike || null,
      id: Number.isFinite(idNum) ? idNum : null,
      role: 'bot',
      text,
    });
  }

  return {
    load,
    save,
    append,
    ackUserEcho,
    ackBotEcho,
  };
}


function fmtChatTsRuntime(tsLike) {
  const ms = Number.isFinite(Date.parse(String(tsLike || ''))) ? Date.parse(String(tsLike || '')) : Date.now();
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return hh + ':' + mm + ':' + ss;
}

function createChatMessageElementRuntime(roleClass, textLike, tsLike, statusTextLike, pendingKeyLike, statusClassLike) {
  const row = document.createElement('div');
  row.className = 'ai-msg-row ' + String(roleClass || 'bot');
  const pendingKey = String(pendingKeyLike || '').trim();
  if (pendingKey) row.setAttribute('data-pending-key', pendingKey);

  const div = document.createElement('div');
  div.className = 'ai-msg ' + String(roleClass || 'bot');
  const textEl = document.createElement('div');
  textEl.className = 'ai-msg-text';
  textEl.textContent = String(textLike || '').trim();

  const metaEl = document.createElement('div');
  metaEl.className = 'ai-msg-meta';
  const tsEl = document.createElement('span');
  tsEl.className = 'ai-msg-time';
  tsEl.textContent = fmtChatTsRuntime(tsLike);
  metaEl.appendChild(tsEl);

  const statusText = String(statusTextLike || '').trim();
  if (statusText) {
    const statusEl = document.createElement('span');
    statusEl.className = 'ai-msg-status ' + String(statusClassLike || 'sending');
    statusEl.textContent = statusText;
    metaEl.appendChild(statusEl);
  }

  div.appendChild(textEl);
  row.appendChild(metaEl);
  row.appendChild(div);
  return row;
}

function finishRowPendingStateRuntime(rowLike) {
  const row = rowLike || null;
  if (!row) return;
  row.classList.remove('pending');
  row.removeAttribute('data-pending-key');
  const statusEl = row.querySelector('.ai-msg-status');
  if (statusEl) statusEl.remove();
}

function setRowTextWithTypewriterRuntime(rowLike, textLike, optionsLike) {
  const row = rowLike || null;
  const textEl = row ? row.querySelector('.ai-msg-text') : null;
  if (!row || !textEl) return;
  const text = String(textLike || '');
  const options = optionsLike && typeof optionsLike === 'object' ? optionsLike : {};
  const enabled = options.enabled !== false;
  const onDone = typeof options.onDone === 'function' ? options.onDone : null;
  if (!enabled || !text) {
    textEl.textContent = text;
    if (onDone) onDone();
    return;
  }
  const len = text.length;
  const tickMs = Math.max(10, Number(options.tickMs) || 14);
  const maxDurationMs = Math.max(700, Number(options.maxDurationMs) || 2600);
  const step = Math.max(1, Math.ceil(len / Math.max(1, Math.floor(maxDurationMs / tickMs))));
  let cursor = 0;
  textEl.textContent = '';
  (function draw() {
    cursor = Math.min(len, cursor + step);
    textEl.textContent = text.slice(0, cursor);
    if (cursor >= len) {
      if (onDone) onDone();
      return;
    }
    window.setTimeout(draw, tickMs);
  })();
}

function markPendingDeliveredRuntime(boxLike, pendingKeyLike, tsLike) {
  const box = boxLike || null;
  const pendingKey = String(pendingKeyLike || '').trim();
  if (!box || !pendingKey) return;
  const selector = '.ai-msg-row.user[data-pending-key="' + pendingKey.replace(/"/g, '\\"') + '"]';
  const node = box.querySelector(selector);
  if (!node) return;
  node.removeAttribute('data-pending-key');
  const metaEl = node.querySelector('.ai-msg-meta');
  if (!metaEl) return;
  const statusEl = metaEl.querySelector('.ai-msg-status');
  if (statusEl) statusEl.remove();
  const tsEl = metaEl.querySelector('.ai-msg-time');
  if (tsEl) tsEl.textContent = fmtChatTsRuntime(tsLike);
}


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


function createChatInputGuardRuntime() {
  let inFlight = false;
  return {
    isLocked() {
      return inFlight;
    },
    lock() {
      if (inFlight) return false;
      inFlight = true;
      return true;
    },
    unlock() {
      inFlight = false;
    },
  };
}

function bindChatInputEnterRuntime(inputLike, onEnterLike) {
  const input = inputLike || null;
  const onEnter = typeof onEnterLike === 'function' ? onEnterLike : null;
  if (!input || !onEnter) return false;
  input.addEventListener('keydown', function(ev) {
    if (ev.key !== 'Enter') return;
    ev.preventDefault();
    onEnter();
  });
  return true;
}


function looksLikeConfigIntentRuntime(queryLike) {
  const text = String(queryLike || '').trim();
  if (!text) return false;
  if (!text.startsWith('/')) return false;
  const cmd = text.split(/\s+/, 1)[0].toLowerCase();
  return new Set([
    '/model',
    '/models',
    '/deepseek',
    '/telegram',
    '/oauth',
    '/openai',
    '/chatgpt',
    '/codex-login',
    '/anthropic',
    '/claude-login',
    '/xbrain',
    '/xbrain-open',
    '/onboard',
  ]).has(cmd);
}


function createChatApiClientRuntime(optionsLike = {}) {
  const options = optionsLike && typeof optionsLike === 'object' ? optionsLike : {};
  const routes = options.routes && typeof options.routes === 'object' ? options.routes : {};
  const buildClientContext = typeof options.buildClientContext === 'function' ? options.buildClientContext : () => ({});
  const setAiLinkStatus = typeof options.setAiLinkStatus === 'function' ? options.setAiLinkStatus : () => {};

  async function askOpenClaw(queryLike) {
    const query = String(queryLike || '').trim();
    const resp = await fetch(String(routes.aiChat || '/api/ai/chat'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({
        message: query,
        clientContext: buildClientContext(),
      }),
    });
    let payload = null;
    try {
      payload = await resp.json();
    } catch {}
    if (!resp.ok || !payload || payload.ok !== true || !String(payload.reply || '').trim()) {
      const reason = payload && payload.error ? String(payload.error) : 'HTTP ' + resp.status;
      throw new Error(reason);
    }
    setAiLinkStatus('ok', 'OpenClaw: 交易域已绑定');
    return {
      reply: String(payload.reply || '').trim(),
      actions: Array.isArray(payload.actions) ? payload.actions : [],
      source: String(payload.source || 'openclaw'),
      executionTrace: Array.isArray(payload.executionTrace) ? payload.executionTrace : [],
      state: payload && typeof payload.state === 'object' ? payload.state : null,
      modelRefUsed: String(payload?.modelRefUsed || '').trim(),
      runtimeModelRef: String(payload?.runtimeModelRef || '').trim(),
      sessionIdUsed: String(payload?.sessionIdUsed || '').trim(),
      modelAutoSync: payload && typeof payload.modelAutoSync === 'object' ? payload.modelAutoSync : null,
    };
  }

  async function askConfigChannel(queryLike) {
    const query = String(queryLike || '').trim();
    const resp = await fetch(String(routes.configChat || '/api/config/chat'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({ message: query }),
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const payload = await resp.json().catch(function() {
      return null;
    });
    if (!payload || payload.ok !== true) throw new Error('invalid payload');
    return {
      handled: Boolean(payload.handled),
      reply: String(payload.reply || '').trim(),
      state: payload && typeof payload.state === 'object' ? payload.state : null,
      modelRefUsed: String(payload?.modelRefUsed || '').trim(),
      runtimeModelRef: String(payload?.runtimeModelRef || '').trim(),
    };
  }

  return {
    askOpenClaw,
    askConfigChannel,
  };
}


function attachExecutionTraceReplayRuntime(rowLike, traceLike) {
  const row = rowLike || null;
  if (!row) return false;
  const items = normalizeExecutionTrace(traceLike);
  if (!items.length) return false;

  const container = document.createElement('div');
  container.className = 'ai-trace-runtime';
  container.style.marginTop = '8px';
  container.style.fontSize = '12px';
  container.style.color = '#8b949e';

  const controls = document.createElement('div');
  controls.style.display = 'flex';
  controls.style.alignItems = 'center';
  controls.style.gap = '8px';

  const replayBtn = document.createElement('button');
  replayBtn.type = 'button';
  replayBtn.textContent = '回放执行轨迹';
  replayBtn.style.border = '1px solid #2d3a4f';
  replayBtn.style.background = 'rgba(0,0,0,0.2)';
  replayBtn.style.color = '#8b949e';
  replayBtn.style.borderRadius = '999px';
  replayBtn.style.padding = '2px 8px';
  replayBtn.style.cursor = 'pointer';

  const status = document.createElement('span');
  status.textContent = '0/' + String(items.length);
  status.style.fontVariantNumeric = 'tabular-nums';

  controls.appendChild(replayBtn);
  controls.appendChild(status);

  const body = document.createElement('div');
  body.className = 'ai-trace-runtime-body';
  body.style.marginTop = '6px';
  body.style.whiteSpace = 'pre-wrap';
  body.style.lineHeight = '1.35';
  body.style.display = 'none';

  container.appendChild(controls);
  container.appendChild(body);

  const host = row.querySelector('.ai-msg') || row;
  host.appendChild(container);

  let playing = false;
  let timer = null;

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    playing = false;
    replayBtn.textContent = '回放执行轨迹';
  }

  replayBtn.addEventListener('click', function() {
    if (playing) {
      stop();
      return;
    }
    playing = true;
    replayBtn.textContent = '停止回放';
    body.style.display = '';
    body.textContent = '';
    let idx = 0;
    timer = setInterval(function() {
      const item = items[idx];
      if (!item) {
        stop();
        return;
      }
      const line =
        String(idx + 1) +
        ') ' +
        String(item.step || 'step') +
        (item.summary ? ': ' + String(item.summary) : '') +
        (item.ts ? ' @ ' + String(item.ts) : '');
      body.textContent += (idx === 0 ? '' : '\n') + line;
      idx += 1;
      status.textContent = String(Math.min(idx, items.length)) + '/' + String(items.length);
      if (idx >= items.length) {
        stop();
      }
    }, 280);
  });

  return true;
}


