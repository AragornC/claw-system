export const CHAT_RUNTIME_RENDER_SNIPPET = String.raw`
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
`;
