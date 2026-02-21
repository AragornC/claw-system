export function handleStrategyArtifactsRequest(req, res, url, deps) {
  const d = deps && typeof deps === 'object' ? deps : {};
  if (String(req.method || 'GET').toUpperCase() !== 'GET') {
    res.statusCode = 405;
    res.setHeader('Allow', 'GET');
    res.end('Method Not Allowed');
    return;
  }
  const q = String(url.searchParams.get('q') || '').trim();
  const limit = Number(url.searchParams.get('limit') || String(d.STRATEGY_ARTIFACTS_TOPK || 8));
  const artifactId = String(url.searchParams.get('artifactId') || '').trim().toLowerCase();
  const list = d.listStrategyArtifacts ? d.listStrategyArtifacts(limit, q) : [];
  const item = artifactId && d.listStrategyArtifacts
    ? d.listStrategyArtifacts(1000).find((x) => x.artifactId === artifactId) || null
    : null;
  d.sendJson?.(res, 200, {
    ok: true,
    total: Object.keys(d.strategyArtifactState?.artifacts || {}).length,
    latestUpdatedAt: d.strategyArtifactState?.lastUpdatedAt || null,
    artifactId: artifactId || null,
    artifact: item,
    artifacts: list,
  });
}

export async function handleStrategyArtifactReportRequest(req, res, deps) {
  const d = deps && typeof deps === 'object' ? deps : {};
  if (String(req.method || 'GET').toUpperCase() !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Allow', 'POST');
    res.end('Method Not Allowed');
    return;
  }
  const limit = Math.max(Number(d.JSON_BODY_LIMIT || 64 * 1024), 256 * 1024);
  const body = await d.readJsonBody?.(req, limit);
  if (!body || body.ok !== true) {
    d.sendJson?.(res, body?.error === 'payload too large' ? 413 : 400, { ok: false, error: body?.error || 'invalid request body' });
    return;
  }
  const payload =
    body.value?.report && typeof body.value.report === 'object'
      ? body.value.report
      : body.value && typeof body.value === 'object'
        ? body.value
        : {};
  const result = d.registerStrategyArtifactReport ? d.registerStrategyArtifactReport(payload) : null;
  if (!result?.ok) {
    d.sendJson?.(res, 400, { ok: false, error: String(result?.reason || 'invalid report') });
    return;
  }
  d.sendJson?.(res, 200, {
    ok: true,
    duplicate: Boolean(result.duplicate),
    artifactId: result.artifactId || null,
    version: result.version || null,
    reward: result.reward ?? null,
    learningWeight: result.learningWeight ?? null,
    scoreEma: result.scoreEma ?? null,
    strength: result.strength ?? null,
  });
}

export function handleStrategyFeaturesRequest(req, res, url, deps) {
  const d = deps && typeof deps === 'object' ? deps : {};
  if (String(req.method || 'GET').toUpperCase() !== 'GET') {
    res.statusCode = 405;
    res.setHeader('Allow', 'GET');
    res.end('Method Not Allowed');
    return;
  }
  const q = String(url.searchParams.get('q') || '').trim();
  const group = String(url.searchParams.get('group') || '').trim();
  const enabledLike = String(url.searchParams.get('enabled') || '').trim();
  const enabled =
    enabledLike === '1' || /^true$/i.test(enabledLike)
      ? true
      : enabledLike === '0' || /^false$/i.test(enabledLike)
        ? false
        : null;
  const list = d.listStrategyFeatures ? d.listStrategyFeatures({ q, group, enabled }) : [];
  d.sendJson?.(res, 200, {
    ok: true,
    total: Array.isArray(list) ? list.length : 0,
    features: Array.isArray(list) ? list : [],
  });
}

export async function handleStrategyFeatureUpsertRequest(req, res, deps) {
  const d = deps && typeof deps === 'object' ? deps : {};
  if (String(req.method || 'GET').toUpperCase() !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Allow', 'POST');
    res.end('Method Not Allowed');
    return;
  }
  const limit = Math.max(Number(d.JSON_BODY_LIMIT || 64 * 1024), 256 * 1024);
  const body = await d.readJsonBody?.(req, limit);
  if (!body || body.ok !== true) {
    d.sendJson?.(res, body?.error === 'payload too large' ? 413 : 400, { ok: false, error: body?.error || 'invalid request body' });
    return;
  }
  const payload =
    body.value?.feature && typeof body.value.feature === 'object'
      ? body.value.feature
      : body.value && typeof body.value === 'object'
        ? body.value
        : {};
  const out = d.upsertStrategyFeature ? d.upsertStrategyFeature(payload) : { ok: false, reason: 'not_available' };
  if (!out?.ok) {
    d.sendJson?.(res, 400, { ok: false, error: String(out?.reason || 'invalid feature') });
    return;
  }
  d.sendJson?.(res, 200, { ok: true, feature: out.feature || null });
}

export function handleStrategyVersionsRequest(req, res, url, deps) {
  const d = deps && typeof deps === 'object' ? deps : {};
  if (String(req.method || 'GET').toUpperCase() !== 'GET') {
    res.statusCode = 405;
    res.setHeader('Allow', 'GET');
    res.end('Method Not Allowed');
    return;
  }
  const limit = Number(url.searchParams.get('limit') || '50');
  const strategyId = String(url.searchParams.get('strategyId') || '').trim();
  const list = d.listStrategyVersions ? d.listStrategyVersions({ limit, strategyId }) : [];
  d.sendJson?.(res, 200, {
    ok: true,
    total: Array.isArray(list) ? list.length : 0,
    versions: Array.isArray(list) ? list : [],
  });
}

export async function handleStrategyVersionCreateRequest(req, res, deps) {
  const d = deps && typeof deps === 'object' ? deps : {};
  if (String(req.method || 'GET').toUpperCase() !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Allow', 'POST');
    res.end('Method Not Allowed');
    return;
  }
  const limit = Math.max(Number(d.JSON_BODY_LIMIT || 64 * 1024), 256 * 1024);
  const body = await d.readJsonBody?.(req, limit);
  if (!body || body.ok !== true) {
    d.sendJson?.(res, body?.error === 'payload too large' ? 413 : 400, { ok: false, error: body?.error || 'invalid request body' });
    return;
  }
  const payload = body.value && typeof body.value === 'object' ? body.value : {};
  const out = d.createStrategyVersion ? d.createStrategyVersion(payload) : { ok: false, reason: 'not_available' };
  if (!out?.ok) {
    d.sendJson?.(res, 400, { ok: false, error: String(out?.reason || 'create failed') });
    return;
  }
  d.sendJson?.(res, 200, { ok: true, version: out.version || null });
}

export async function handleStrategyVersionProposeRequest(req, res, deps) {
  const d = deps && typeof deps === 'object' ? deps : {};
  if (String(req.method || 'GET').toUpperCase() !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Allow', 'POST');
    res.end('Method Not Allowed');
    return;
  }
  const limit = Math.max(Number(d.JSON_BODY_LIMIT || 64 * 1024), 256 * 1024);
  const body = await d.readJsonBody?.(req, limit);
  if (!body || body.ok !== true) {
    d.sendJson?.(res, body?.error === 'payload too large' ? 413 : 400, { ok: false, error: body?.error || 'invalid request body' });
    return;
  }
  const payload = body.value && typeof body.value === 'object' ? body.value : {};
  const out = d.proposeStrategyVersionsByPrompt ? d.proposeStrategyVersionsByPrompt(payload) : { ok: false, reason: 'not_available' };
  if (!out?.ok) {
    d.sendJson?.(res, 400, { ok: false, error: String(out?.reason || 'propose failed') });
    return;
  }
  d.sendJson?.(res, 200, {
    ok: true,
    baseVersionId: out.baseVersionId || null,
    proposals: Array.isArray(out.proposals) ? out.proposals : [],
  });
}

export async function handleStrategyVersionEvaluateRequest(req, res, deps) {
  const d = deps && typeof deps === 'object' ? deps : {};
  if (String(req.method || 'GET').toUpperCase() !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Allow', 'POST');
    res.end('Method Not Allowed');
    return;
  }
  const limit = Math.max(Number(d.JSON_BODY_LIMIT || 64 * 1024), 256 * 1024);
  const body = await d.readJsonBody?.(req, limit);
  if (!body || body.ok !== true) {
    d.sendJson?.(res, body?.error === 'payload too large' ? 413 : 400, { ok: false, error: body?.error || 'invalid request body' });
    return;
  }
  const payload = body.value && typeof body.value === 'object' ? body.value : {};
  const out = d.evaluateStrategyVersion ? d.evaluateStrategyVersion(payload) : { ok: false, reason: 'not_available' };
  if (!out?.ok) {
    d.sendJson?.(res, 400, { ok: false, error: String(out?.reason || 'evaluate failed') });
    return;
  }
  d.sendJson?.(res, 200, {
    ok: true,
    version: out.version || null,
    report: out.report || null,
  });
}
