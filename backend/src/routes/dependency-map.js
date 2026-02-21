function pick(source, keys) {
  const out = {};
  const src = source && typeof source === 'object' ? source : {};
  for (const key of keys) out[key] = src[key];
  return out;
}

const SYSTEM_KEYS = [
  'handleTelegramEventsApi',
  'handleTelegramHealthApi',
  'handleTelegramTestApi',
  'handleTelegramHandshakeApi',
  'handleMemoryHealthApi',
];

const STRATEGY_KEYS = [
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
];

const CHAT_KEYS = [
  'sendJson',
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
];

const XBRAIN_KEYS = [
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

export function buildApiRouteDeps(deps) {
  return {
    system: pick(deps, SYSTEM_KEYS),
    strategy: pick(deps, STRATEGY_KEYS),
    chat: pick(deps, CHAT_KEYS),
    xbrain: pick(deps, XBRAIN_KEYS),
  };
}
