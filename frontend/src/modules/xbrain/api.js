export function buildXbrainStateUrl(reportBuildId, forceRefresh) {
  const refresh = forceRefresh ? '1' : '0';
  return '/api/xbrain/state?refresh=' + refresh + '&v=' + encodeURIComponent(String(reportBuildId || ''));
}

export async function requestXbrainJson(fetchFn, pathname, body) {
  const fn = typeof fetchFn === 'function' ? fetchFn : fetch;
  const opts = {
    method: body == null ? 'GET' : 'POST',
    cache: 'no-store',
  };
  if (body != null) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body || {});
  }
  const resp = await fn(pathname, opts);
  const payload = await resp.json().catch(() => null);
  if (!resp.ok || !payload || payload.ok !== true) {
    const reason = payload && payload.error ? String(payload.error) : ('HTTP ' + resp.status);
    throw new Error(reason);
  }
  return payload;
}

export async function requestXbrainState(fetchFn, reportBuildId, forceRefresh) {
  return requestXbrainJson(fetchFn, buildXbrainStateUrl(reportBuildId, forceRefresh), null);
}

export async function requestXbrainAuthStatus(fetchFn, reportBuildId) {
  const url = '/api/xbrain/auth/status?v=' + encodeURIComponent(String(reportBuildId || ''));
  return requestXbrainJson(fetchFn, url, null);
}

export async function requestXbrainAuthStart(fetchFn, provider) {
  return requestXbrainJson(fetchFn, '/api/xbrain/auth/start', { provider });
}

export async function requestXbrainModelSwitch(fetchFn, modelRef, provider) {
  return requestXbrainJson(fetchFn, '/api/xbrain/model/switch', {
    modelId: String(modelRef || ''),
    modelProvider: String(provider || ''),
  });
}
