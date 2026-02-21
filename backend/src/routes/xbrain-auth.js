export async function handleXbrainAuthRoute(pathname, req, res, handlers) {
  const h = handlers && typeof handlers === 'object' ? handlers : {};
  if (pathname === '/api/xbrain/auth/status') {
    await h.handleXbrainAuthStatusApi?.(req, res);
    return true;
  }
  if (pathname === '/api/xbrain/auth/start') {
    await h.handleXbrainAuthStartApi?.(req, res);
    return true;
  }
  if (pathname === '/api/xbrain/auth/disconnect') {
    await h.handleXbrainAuthDisconnectApi?.(req, res);
    return true;
  }
  if (pathname === '/api/xbrain/auth/input') {
    await h.handleXbrainAuthInputApi?.(req, res);
    return true;
  }
  if (pathname === '/api/xbrain/provider/remove') {
    await h.handleXbrainProviderRemoveApi?.(req, res);
    return true;
  }
  return false;
}
