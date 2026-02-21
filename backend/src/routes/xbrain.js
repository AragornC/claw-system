import { handleXbrainAuthRoute } from './xbrain-auth.js';
import { handleXbrainConfigRoute } from './xbrain-config.js';

export async function handleXbrainRoute(url, req, res, handlers) {
  const pathname = String(url?.pathname || '');
  const authHandled = await handleXbrainAuthRoute(pathname, req, res, handlers);
  if (authHandled) return true;
  const configHandled = await handleXbrainConfigRoute(pathname, req, res, handlers);
  if (configHandled) return true;
  return false;
}
