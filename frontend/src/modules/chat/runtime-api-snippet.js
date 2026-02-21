export const CHAT_RUNTIME_API_SNIPPET = String.raw`
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
    };
  }

  return {
    askOpenClaw,
    askConfigChannel,
  };
}
`;
