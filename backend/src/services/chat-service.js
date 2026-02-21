export function handleAiContextRequest(req, res, url, deps) {
  const d = deps && typeof deps === 'object' ? deps : {};
  if (String(req.method || 'GET').toUpperCase() !== 'GET') {
    res.statusCode = 405;
    res.setHeader('Allow', 'GET');
    res.end('Method Not Allowed');
    return;
  }
  const contextMemory = d.buildLayeredMemoryBundle ? d.buildLayeredMemoryBundle('') : {};
  const trading = d.buildTradingContext ? d.buildTradingContext(undefined, contextMemory) : { digest: null, context: null };
  const full = url.searchParams.get('full') === '1';
  d.sendJson?.(res, 200, {
    ok: true,
    binding: 'trading-context-v2',
    contextDigest: trading.digest,
    context: full ? trading.context : undefined,
  });
}

export function handleChatHistoryRequest(req, res, url, deps) {
  const d = deps && typeof deps === 'object' ? deps : {};
  if (String(req.method || 'GET').toUpperCase() !== 'GET') {
    res.statusCode = 405;
    res.setHeader('Allow', 'GET');
    res.end('Method Not Allowed');
    return;
  }
  const afterId = Number(url.searchParams.get('afterId') || '0');
  const limit = Number(url.searchParams.get('limit') || '120');
  d.sendJson?.(res, 200, {
    ok: true,
    latestEventId: Number(d.chatHistorySeq || 0),
    events: d.listChatHistory ? d.listChatHistory(afterId, limit) : [],
  });
}
