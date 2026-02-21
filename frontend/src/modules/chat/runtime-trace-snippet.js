export const CHAT_RUNTIME_TRACE_SNIPPET = String.raw`
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
`;
