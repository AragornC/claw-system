export function createXbrainConfigService(deps) {
  const d = deps && typeof deps === 'object' ? deps : {};
  const providerModelOptions = d.providerModelOptions && typeof d.providerModelOptions === 'object'
    ? d.providerModelOptions
    : {};

  async function switchModel(payloadLike) {
    const payload = payloadLike && typeof payloadLike === 'object' ? payloadLike : {};
    const modelIdRaw = String(payload.modelId || '').trim();
    if (!modelIdRaw) {
      return { ok: false, status: 400, error: 'modelId 必填。' };
    }
    const providerRaw = String(payload.modelProvider || d.inferXbrainProviderFromModelId(modelIdRaw)).trim();
    const provider = d.normalizeXbrainModelProvider(providerRaw);
    const modelId = d.normalizeXbrainModelIdForProvider(provider, modelIdRaw);
    const providerUi = d.normalizeProviderForUi(provider);
    const current = d.ensureXbrainState();
    const registry = d.normalizeXbrainModelRegistry(current?.base?.modelRegistry || []);
    const registryByProvider = registry.filter((m) => d.normalizeProviderForUi(d.inferXbrainProviderFromModelId(m)) === providerUi);
    const providerOnline = registryByProvider.length > 0;
    const catalog = Array.isArray(providerModelOptions[providerUi]) ? providerModelOptions[providerUi] : [];
    const requestedKnown = catalog.includes(modelId);
    if (registry.length && !registry.includes(modelId) && (!providerOnline || !requestedKnown)) {
      return {
        ok: false,
        status: 400,
        error: '该模型未上线或未在当前厂商可用列表中，请先在 A1 完成配置/上线。',
        state: d.buildXbrainPublicState(),
      };
    }

    const out = d.applyXbrainBasePatch({ modelProvider: provider, modelId }, { password: '' });
    if (!out || out.ok !== true) {
      return {
        ok: false,
        status: Number(out?.status || 400),
        error: String(out?.error || '切换失败'),
        state: d.buildXbrainPublicState(),
      };
    }

    const openclawModelSync = await d.syncXbrainBaseToOpenClaw(out.state?.base || { modelProvider: provider, modelId });
    if (openclawModelSync?.ok) {
      const switched = {
        checkedAt: d.nowIso(),
        modelId,
        modelProvider: d.inferXbrainProviderFromModelId(modelId),
        modelApi: d.xbrainProviderApiLabel(provider),
        source: 'xbrain:model-switch',
        error: null,
      };
      d.xbrainAgentRuntimeState.value = switched;
      d.xbrainModelProbeState.value = switched;
      d.xbrainModelProbeState.lastAt = Date.now();
    }
    const runtimeModel = await d.probeXbrainRuntimeModel(true);
    const providerAuth = await d.probeXbrainProviderAuth(true);
    return {
      ok: true,
      modelId,
      modelProvider: provider,
      state: d.buildXbrainPublicState(runtimeModel, providerAuth),
      openclawModelSync,
    };
  }

  async function updateSection(payloadLike) {
    const payload = payloadLike && typeof payloadLike === 'object' ? payloadLike : {};
    const section = String(payload.section || '').trim().toLowerCase();
    const values = payload.values && typeof payload.values === 'object' ? payload.values : {};
    const password = String(payload.password || '').trim();

    let out = null;
    if (section === 'base') out = d.applyXbrainBasePatch(values, { password: '' });
    else if (section === 'channel') out = d.applyXbrainChannelPatch(values, { password: '' });
    else if (section === 'exchange') out = d.applyXbrainExchangePatch(values, { password });
    else if (section === 'strategy') out = d.applyXbrainStrategyPatch(values, { password });
    else return { ok: false, status: 400, error: 'section 必须是 base/channel/exchange/strategy' };

    if (!out || out.ok !== true) {
      return {
        ok: false,
        status: Number(out?.status || 400),
        error: String(out?.error || '更新失败'),
        state: d.buildXbrainPublicState(),
      };
    }

    let openclawModelSync = null;
    if (section === 'base') {
      if (d.hasOwn(values, 'modelProvider') || d.hasOwn(values, 'modelId')) {
        openclawModelSync = await d.syncXbrainBaseToOpenClaw(out.state?.base || values);
      } else if (d.hasOwn(values, 'deepseekApiKey')) {
        openclawModelSync = await d.syncXbrainDeepseekProviderConfig(out.state?.base || values);
      }
    }
    const runtimeModel = section === 'base' ? await d.probeXbrainRuntimeModel(true) : null;
    const providerAuth = section === 'base' ? await d.probeXbrainProviderAuth(true) : null;
    const stateForReply = section === 'base'
      ? d.buildXbrainPublicState(runtimeModel, providerAuth)
      : (out.state || d.buildXbrainPublicState());
    return {
      ok: true,
      section,
      updated: out.updated || {},
      state: stateForReply,
      openclawModelSync,
    };
  }

  function manageLock(payloadLike) {
    const payload = payloadLike && typeof payloadLike === 'object' ? payloadLike : {};
    const section = String(payload.section || '').trim().toLowerCase();
    const action = String(payload.action || '').trim().toLowerCase();
    const password = String(payload.password || '').trim();
    const currentPassword = String(payload.currentPassword || '').trim();

    const lock = d.xbrainSectionLock(section);
    if (!lock) {
      return { ok: false, status: 400, error: '仅支持 base/channel/exchange/strategy 的锁管理。' };
    }

    if (section === 'base') {
      if (action === 'unlock') {
        d.setXbrainSectionLock('base', false);
        return { ok: true, section, action, state: d.buildXbrainPublicState() };
      }
      if (action === 'lock') {
        d.setXbrainSectionLock('base', true);
        return { ok: true, section, action, state: d.buildXbrainPublicState() };
      }
      if (action === 'set_password') {
        return { ok: false, status: 400, error: '基础配置不支持密码，仅支持锁定/解锁。', state: d.buildXbrainPublicState() };
      }
    }

    if (action === 'unlock') {
      if (!d.xbrainVerifyPassword(section, password)) {
        return { ok: false, status: 403, error: '密码错误，无法解锁。', state: d.buildXbrainPublicState() };
      }
      d.setXbrainSectionLock(section, false);
      return { ok: true, section, action, state: d.buildXbrainPublicState() };
    }

    if (action === 'lock') {
      if (password) {
        const setPwd = d.setXbrainSectionPassword(section, password, currentPassword);
        if (!setPwd.ok) {
          return {
            ok: false,
            status: Number(setPwd.status || 400),
            error: String(setPwd.error || '设置密码失败'),
            state: d.buildXbrainPublicState(),
          };
        }
      } else {
        d.setXbrainSectionLock(section, true);
      }
      return { ok: true, section, action, state: d.buildXbrainPublicState() };
    }

    if (action === 'set_password') {
      const setPwd = d.setXbrainSectionPassword(section, password, currentPassword);
      if (!setPwd.ok) {
        return {
          ok: false,
          status: Number(setPwd.status || 400),
          error: String(setPwd.error || '设置密码失败'),
          state: d.buildXbrainPublicState(),
        };
      }
      return {
        ok: true,
        section,
        action,
        state: setPwd.state || d.buildXbrainPublicState(),
      };
    }

    return { ok: false, status: 400, error: 'action 必须是 lock/unlock/set_password' };
  }

  return {
    switchModel,
    updateSection,
    manageLock,
  };
}
