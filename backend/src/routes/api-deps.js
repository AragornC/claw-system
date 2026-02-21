function pick(source, keys) {
  const src = source && typeof source === 'object' ? source : {};
  const out = {};
  for (const key of keys) out[key] = src[key];
  return out;
}

const API_DEP_KEYS = [
  'handleTelegramEventsApi',
  'handleTelegramHealthApi',
  'handleTelegramTestApi',
  'handleTelegramHandshakeApi',
  'handleMemoryHealthApi',
  'sendJson',
  'readJsonBody',
  'registerStrategyArtifactReport',
  'listStrategyArtifacts',
  'strategyArtifactState',
  'STRATEGY_ARTIFACTS_TOPK',
  'JSON_BODY_LIMIT',
  'listStrategyFeatures',
  'upsertStrategyFeature',
  'listStrategyVersions',
  'createStrategyVersion',
  'proposeStrategyVersionsByPrompt',
  'evaluateStrategyVersion',
  'listChatHistory',
  'chatHistorySeq',
  'runtimeMode',
  'runtimeHandleRoute',
  'handleConfigChatApi',
  'handleChatApi',
  'handleChatApiOpenClaw',
  'handleRuntimeTasksApi',
  'handleRuntimeTaskRetryApi',
  'handleRuntimeSchedulesApi',
  'handleRuntimeSchedulesPatchApi',
  'handleRuntimeSchedulesDeleteApi',
  'legacyHandleConfigChatApi',
  'legacyHandleChatApi',
  'buildLayeredMemoryBundle',
  'buildTradingContext',
  'executeStrategyToolCalls',
  'buildMcpStyleToolManifest',
  'checkMcpBridgeConnectivity',
  'resolveToolAdapterMode',
  'handleXbrainStateApi',
  'handleXbrainAuthStatusApi',
  'handleXbrainAuthStartApi',
  'handleXbrainAuthDisconnectApi',
  'handleXbrainProviderRemoveApi',
  'handleXbrainAuthInputApi',
  'handleXbrainModelSwitchApi',
  'handleXbrainUpdateApi',
  'handleXbrainLockApi',
];

export function buildServeApiDeps(source) {
  return pick(source, API_DEP_KEYS);
}
