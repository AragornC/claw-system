import {
  handleMemoryHealthRequest,
  handleTelegramEventsRequest,
  handleTelegramHealthRequest,
  handleTelegramHandshakeRequest,
  handleTelegramTestRequest,
} from '../services/system-service.js';

export async function handleSystemRoute(url, req, res, deps) {
  const pathname = String(url?.pathname || '');
  const d = deps && typeof deps === 'object' ? deps : {};

  if (pathname === '/api/telegram/events') {
    handleTelegramEventsRequest(req, res, d);
    return true;
  }
  if (pathname === '/api/telegram/health') {
    handleTelegramHealthRequest(req, res, d);
    return true;
  }
  if (pathname === '/api/telegram/test') {
    await handleTelegramTestRequest(req, res, d);
    return true;
  }
  if (pathname === '/api/telegram/handshake') {
    await handleTelegramHandshakeRequest(req, res, d);
    return true;
  }
  if (pathname === '/api/memory/health') {
    handleMemoryHealthRequest(req, res, d);
    return true;
  }
  return false;
}
