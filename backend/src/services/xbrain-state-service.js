export function createXbrainStateService(deps) {
  const d = deps && typeof deps === 'object' ? deps : {};
  const providerKeys = Array.isArray(d.providerKeys) ? d.providerKeys.slice() : [];
  const providerModelOptions = d.providerModelOptions && typeof d.providerModelOptions === 'object'
    ? d.providerModelOptions
    : {};

  function removeProviderFromXbrain(providerLike, passwordLike = '') {
    const providerUi = d.normalizeProviderForUi(providerLike);
    if (!providerKeys.includes(providerUi)) {
      return { ok: false, status: 400, error: 'provider 不支持。' };
    }
    if (d.xbrainIsLocked('base') && !d.xbrainVerifyPassword('base', passwordLike)) {
      return { ok: false, status: 423, error: '基础配置已锁定，请输入正确模块密码后重试。' };
    }
    const state = d.ensureXbrainState();
    const prevCatalog = Array.isArray(state?.base?.providerCatalog) ? state.base.providerCatalog : providerKeys.slice();
    const nextCatalog = prevCatalog
      .map((p) => d.normalizeProviderForUi(p))
      .filter((p) => providerKeys.includes(p) && p !== providerUi);
    if (!nextCatalog.length) {
      return { ok: false, status: 400, error: '至少保留一个模型厂商。' };
    }
    const currentRegistry = Array.isArray(state?.base?.modelRegistry) ? state.base.modelRegistry : [];
    const nextRegistry = d.normalizeXbrainModelRegistry(currentRegistry.filter((modelRef) => {
      return d.normalizeProviderForUi(d.inferXbrainProviderFromModelId(modelRef)) !== providerUi;
    }));
    const preferredModel = d.normalizeXbrainModelIdForProvider(
      nextCatalog[0],
      providerModelOptions[nextCatalog[0]]?.[0] || '',
    );
    state.base.providerCatalog = nextCatalog;
    state.base.modelRegistry = nextRegistry;
    if (d.normalizeProviderForUi(state.base.modelProvider) === providerUi) {
      state.base.modelProvider = d.normalizeXbrainModelProvider(nextCatalog[0]);
      state.base.modelId = preferredModel;
    }
    if (d.normalizeProviderForUi(state.base.modelProvider) === 'deepseek' && !nextCatalog.includes('deepseek')) {
      state.base.modelProvider = d.normalizeXbrainModelProvider(nextCatalog[0]);
      state.base.modelId = preferredModel;
    }
    state.base.updatedAt = d.nowIso();
    state.updatedAt = state.base.updatedAt;
    d.saveXbrainState();
    if (providerUi === 'chatgpt' || providerUi === 'anthropic') {
      void d.disconnectOAuthCredentials(providerUi);
    }
    return {
      ok: true,
      removedProvider: providerUi,
      state: d.buildXbrainPublicState(),
    };
  }

  return {
    removeProviderFromXbrain,
  };
}
