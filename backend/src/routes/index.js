import { handleSystemRoute } from './system.js';
import { handleStrategyRoute } from './strategy.js';
import { handleChatRoute } from './chat.js';
import { handleXbrainRoute } from './xbrain.js';
import { buildApiRouteDeps } from './dependency-map.js';

export async function handleApiRoute(url, req, res, deps) {
  const routeDeps = buildApiRouteDeps(deps);

  const systemHandled = await handleSystemRoute(url, req, res, routeDeps.system);
  if (systemHandled) return true;

  const strategyHandled = await handleStrategyRoute(url, req, res, routeDeps.strategy);
  if (strategyHandled) return true;

  const chatHandled = await handleChatRoute(url, req, res, routeDeps.chat);
  if (chatHandled) return true;

  const xbrainHandled = await handleXbrainRoute(url, req, res, routeDeps.xbrain);
  if (xbrainHandled) return true;

  return false;
}
