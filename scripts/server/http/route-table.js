/**
 * API Route Table — maps HTTP method+path to handler functions.
 */

function expectHandler(handlers, key) {
  const fn = handlers?.[key];
  if (typeof fn !== "function") {
    throw new Error(`Missing handler: ${key}`);
  }
  return fn;
}

export function buildApiRouteTable(handlers = {}) {
  return [
    // Status
    { method: "GET", path: "/api/status", handler: expectHandler(handlers, "handleStatus") },

    // Chat
    { method: "GET", path: "/api/ai/health", handler: expectHandler(handlers, "handleAiHealth") },
    { method: "POST", path: "/api/config/chat", handler: expectHandler(handlers, "handleConfigChat") },
    { method: "POST", path: "/api/ai/chat", handler: expectHandler(handlers, "handleAiChat") },
    { method: "POST", path: "/api/ai/chat/stream", handler: expectHandler(handlers, "handleAiChatStream") },
    { method: "GET", path: "/api/chat/history", handler: expectHandler(handlers, "handleChatHistory") },
    { method: "POST", path: "/api/chat/cards/status", handler: expectHandler(handlers, "handleChatCardStatus") },

    // Session
    { method: "POST", path: "/api/session/archive", handler: expectHandler(handlers, "handleSessionArchive") },
    { method: "GET", path: "/api/session/list", handler: expectHandler(handlers, "handleSessionList") },
    { method: "POST", path: "/api/session/restore", handler: expectHandler(handlers, "handleSessionRestore") },

    // Xbrain (model config — 虾脑)
    { method: "GET", path: "/api/xbrain/state", handler: expectHandler(handlers, "handleXbrainState") },
    { method: "POST", path: "/api/xbrain/update", handler: expectHandler(handlers, "handleXbrainUpdate") },
    { method: "POST", path: "/api/xbrain/model/switch", handler: expectHandler(handlers, "handleXbrainModelSwitch") },
    { method: "GET", path: "/api/xbrain/models/catalog", handler: expectHandler(handlers, "handleXbrainModelsCatalog") },
    { method: "POST", path: "/api/xbrain/models/connect", handler: expectHandler(handlers, "handleXbrainModelConnect") },
    { method: "POST", path: "/api/xbrain/models/disconnect", handler: expectHandler(handlers, "handleXbrainModelDisconnect") },
    { method: "GET", path: "/api/xbrain/auth/status", handler: expectHandler(handlers, "handleXbrainAuthStatus") },
    { method: "POST", path: "/api/xbrain/auth/start", handler: expectHandler(handlers, "handleXbrainAuthStart") },
    { method: "POST", path: "/api/xbrain/auth/input", handler: expectHandler(handlers, "handleXbrainAuthInput") },
    { method: "POST", path: "/api/xbrain/auth/disconnect", handler: expectHandler(handlers, "handleXbrainAuthDisconnect") },
    { method: "POST", path: "/api/xbrain/provider/remove", handler: expectHandler(handlers, "handleXbrainProviderRemove") },
    { method: "POST", path: "/api/xbrain/lock", handler: expectHandler(handlers, "handleXbrainLock") },

    // Strategy Lab — Features
    { method: "GET", path: "/api/strategy/features", handler: expectHandler(handlers, "handleStrategyFeatures") },
    { method: "POST", path: "/api/strategy/features/delete", handler: expectHandler(handlers, "handleStrategyFeatureDelete") },
    { method: "POST", path: "/api/strategy/features/evaluate", handler: expectHandler(handlers, "handleStrategyFeatureEvaluate") },
    { method: "POST", path: "/api/strategy/features/update-config", handler: expectHandler(handlers, "handleStrategyFeatureUpdateConfig") },

    // Strategy Lab — Versions
    { method: "GET", path: "/api/strategy/versions", handler: expectHandler(handlers, "handleStrategyVersions") },
    { method: "POST", path: "/api/strategy/versions/propose", handler: expectHandler(handlers, "handleStrategyVersionsPropose") },
    { method: "POST", path: "/api/strategy/versions/evaluate", handler: expectHandler(handlers, "handleStrategyVersionsEvaluate") },
    { method: "POST", path: "/api/strategy/artifacts/report", handler: expectHandler(handlers, "handleStrategyArtifactReport") },

    // Strategy Lab — Intent (feature generation flow)
    { method: "POST", path: "/api/strategy/intent-candidates", handler: expectHandler(handlers, "handleStrategyIntentCandidates") },
    { method: "POST", path: "/api/strategy/intent-candidates/generate-code", handler: expectHandler(handlers, "handleStrategyIntentGenerateCode") },
    { method: "POST", path: "/api/strategy/intent-candidates/apply", handler: expectHandler(handlers, "handleStrategyIntentApply") },
    { method: "POST", path: "/api/strategy/intent-clarify", handler: expectHandler(handlers, "handleStrategyIntentClarify") },
    { method: "POST", path: "/api/strategy/intent-confirm", handler: expectHandler(handlers, "handleStrategyIntentConfirm") },

    // Strategy Lab — Entities (strategies)
    { method: "GET", path: "/api/strategy/entities", handler: expectHandler(handlers, "handleStrategyEntities") },
    { method: "GET", path: "/api/strategy/entities/detail", handler: expectHandler(handlers, "handleStrategyEntityDetail") },
    { method: "GET", path: "/api/strategy/entities/audits", handler: expectHandler(handlers, "handleStrategyEntityAudits") },
    { method: "POST", path: "/api/strategy/entities/save-draft", handler: expectHandler(handlers, "handleStrategyEntityDraftSave") },
    { method: "POST", path: "/api/strategy/entities/replay", handler: expectHandler(handlers, "handleStrategyEntityReplay") },
    { method: "POST", path: "/api/strategy/entities/publish", handler: expectHandler(handlers, "handleStrategyEntityPublish") },
    { method: "POST", path: "/api/strategy/entities/status", handler: expectHandler(handlers, "handleStrategyEntityStatus") },
    { method: "POST", path: "/api/strategy/entities/delete", handler: expectHandler(handlers, "handleStrategyEntityDelete") },
  ];
}
