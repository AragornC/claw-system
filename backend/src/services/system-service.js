export function handleTelegramEventsRequest(req, res, deps) {
  const d = deps && typeof deps === 'object' ? deps : {};
  d.handleTelegramEventsApi?.(req, res);
}

export function handleTelegramHealthRequest(req, res, deps) {
  const d = deps && typeof deps === 'object' ? deps : {};
  d.handleTelegramHealthApi?.(req, res);
}

export async function handleTelegramTestRequest(req, res, deps) {
  const d = deps && typeof deps === 'object' ? deps : {};
  await d.handleTelegramTestApi?.(req, res);
}

export async function handleTelegramHandshakeRequest(req, res, deps) {
  const d = deps && typeof deps === 'object' ? deps : {};
  await d.handleTelegramHandshakeApi?.(req, res);
}

export function handleMemoryHealthRequest(req, res, deps) {
  const d = deps && typeof deps === 'object' ? deps : {};
  d.handleMemoryHealthApi?.(req, res);
}
