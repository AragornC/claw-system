import {
  handleStrategyArtifactsRequest,
  handleStrategyArtifactReportRequest,
  handleStrategyFeaturesRequest,
  handleStrategyFeatureUpsertRequest,
  handleStrategyVersionsRequest,
  handleStrategyVersionCreateRequest,
  handleStrategyVersionProposeRequest,
  handleStrategyVersionEvaluateRequest,
} from '../services/strategy-service.js';

export async function handleStrategyRoute(url, req, res, deps) {
  const pathname = String(url?.pathname || '');
  const d = deps && typeof deps === 'object' ? deps : {};

  if (pathname === '/api/strategy/artifacts') {
    handleStrategyArtifactsRequest(req, res, url, d);
    return true;
  }
  if (pathname === '/api/strategy/artifacts/report') {
    await handleStrategyArtifactReportRequest(req, res, d);
    return true;
  }
  if (pathname === '/api/strategy/features') {
    handleStrategyFeaturesRequest(req, res, url, d);
    return true;
  }
  if (pathname === '/api/strategy/features/upsert') {
    await handleStrategyFeatureUpsertRequest(req, res, d);
    return true;
  }
  if (pathname === '/api/strategy/versions') {
    handleStrategyVersionsRequest(req, res, url, d);
    return true;
  }
  if (pathname === '/api/strategy/versions/create') {
    await handleStrategyVersionCreateRequest(req, res, d);
    return true;
  }
  if (pathname === '/api/strategy/versions/propose') {
    await handleStrategyVersionProposeRequest(req, res, d);
    return true;
  }
  if (pathname === '/api/strategy/versions/evaluate') {
    await handleStrategyVersionEvaluateRequest(req, res, d);
    return true;
  }
  return false;
}
