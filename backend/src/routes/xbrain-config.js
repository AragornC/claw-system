export async function handleXbrainConfigRoute(pathname, req, res, handlers) {
  const h = handlers && typeof handlers === 'object' ? handlers : {};
  if (pathname === '/api/xbrain/state') {
    await h.handleXbrainStateApi?.(req, res);
    return true;
  }
  if (pathname === '/api/xbrain/model/switch') {
    await h.handleXbrainModelSwitchApi?.(req, res);
    return true;
  }
  if (pathname === '/api/xbrain/update') {
    await h.handleXbrainUpdateApi?.(req, res);
    return true;
  }
  if (pathname === '/api/xbrain/lock') {
    await h.handleXbrainLockApi?.(req, res);
    return true;
  }
  return false;
}
