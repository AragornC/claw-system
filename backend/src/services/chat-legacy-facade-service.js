function ensureFn(fnLike, fallback = null) {
  return typeof fnLike === 'function' ? fnLike : fallback;
}

export function createChatLegacyFacadeService(options = {}) {
  const buildLayeredMemoryBundleImpl = ensureFn(options.buildLayeredMemoryBundleImpl, () => ({}));
  const resolveCapabilityAdapterImpl = ensureFn(options.resolveCapabilityAdapterImpl, () => ({
    mode: 'internal',
    listTools: () => [],
    invokeTool: async () => ({ ok: false, error: 'adapter_missing' }),
  }));
  const handleNaturalLanguageToolOrchestrationImpl = ensureFn(
    options.handleNaturalLanguageToolOrchestrationImpl,
    async () => ({ handled: false }),
  );
  const handleChatApiImpl = ensureFn(options.handleChatApiImpl, async (_req, res) => {
    res.statusCode = 503;
    res.end('chat_facade_unavailable');
  });

  return {
    buildLayeredMemoryBundle(queryText) {
      return buildLayeredMemoryBundleImpl(queryText);
    },
    resolveCapabilityAdapter(optionsLike = {}) {
      return resolveCapabilityAdapterImpl(optionsLike);
    },
    async handleNaturalLanguageToolOrchestration(messageLike = '', source = 'dashboard') {
      return handleNaturalLanguageToolOrchestrationImpl(messageLike, source);
    },
    async handleChatApi(req, res) {
      return handleChatApiImpl(req, res);
    },
  };
}
