var buildXbrainStateUrl = function buildXbrainStateUrl(reportBuildId, forceRefresh) {
  const refresh = forceRefresh ? '1' : '0';
  return '/api/xbrain/state?refresh=' + refresh + '&v=' + encodeURIComponent(String(reportBuildId || ''));
};
var requestXbrainJson = async function requestXbrainJson(fetchFn, pathname, body) {
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
};
var requestXbrainState = async function requestXbrainState(fetchFn, reportBuildId, forceRefresh) {
  return requestXbrainJson(fetchFn, buildXbrainStateUrl(reportBuildId, forceRefresh), null);
};
var requestXbrainAuthStatus = async function requestXbrainAuthStatus(fetchFn, reportBuildId) {
  const url = '/api/xbrain/auth/status?v=' + encodeURIComponent(String(reportBuildId || ''));
  return requestXbrainJson(fetchFn, url, null);
};
var requestXbrainAuthStart = async function requestXbrainAuthStart(fetchFn, provider) {
  return requestXbrainJson(fetchFn, '/api/xbrain/auth/start', { provider });
};
var requestXbrainAuthInput = async function requestXbrainAuthInput(fetchFn, input, attemptId) {
  return requestXbrainJson(fetchFn, '/api/xbrain/auth/input', {
    input: String(input || ''),
    attemptId: Number.isFinite(Number(attemptId)) ? Number(attemptId) : 0,
  });
};
var requestXbrainModelSwitch = async function requestXbrainModelSwitch(fetchFn, modelRef, provider) {
  return requestXbrainJson(fetchFn, '/api/xbrain/model/switch', {
    modelId: String(modelRef || ''),
    modelProvider: String(provider || ''),
  });
};
var buildXbrainFlowDeps = function buildXbrainFlowDeps(inputLike) {
  const i = inputLike && typeof inputLike === 'object' ? inputLike : {};
  return {
    normalizeProviderKey: i.normalizeProviderKey,
    providerLabel: i.providerLabel,
    fmtChatTs: i.fmtChatTs,
    setXbrainProbeSteps: i.setXbrainProbeSteps,
    setXbrainProbeModalTitle: i.setXbrainProbeModalTitle,
    setXbrainProbeModalOpen: i.setXbrainProbeModalOpen,
    syncXbrainModelOnlineButtonUi: i.syncXbrainModelOnlineButtonUi,
    getBaseLocked: i.getBaseLocked,
    getCurrentProvider: i.getCurrentProvider,
    fetchXbrainState: i.fetchXbrainState,
    getXbrainAuthStatus: i.getXbrainAuthStatus,
    getOauthConnected: i.getOauthConnected,
    getOauthMap: i.getOauthMap,
    setOauthConnected: i.setOauthConnected,
    rememberProviderCheck: i.rememberProviderCheck,
    setXbrainBaseSubStatus: i.setXbrainBaseSubStatus,
    safeLocalJsonWrite: i.safeLocalJsonWrite,
    oauthConnectedKey: i.oauthConnectedKey,
    switchXbrainRuntimeModel: i.switchXbrainRuntimeModel,
    getAuthMonitorRunning: i.getAuthMonitorRunning,
    setAuthMonitorRunning: i.setAuthMonitorRunning,
  };
};
var createXbrainFlowHelpers = function createXbrainFlowHelpers(deps) {
  const d = deps && typeof deps === 'object' ? deps : {};
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function runXbrainProviderProbeFlow(options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    const provider = d.normalizeProviderKey(opts.provider || d.getCurrentProvider?.() || 'deepseek');
    const showModal = opts.showModal !== false;
    const stepList = [];
    function refreshOnlineToggle() {
      d.syncXbrainModelOnlineButtonUi(Boolean(d.getBaseLocked?.()));
    }
    function pushStep(text, type) {
      stepList.push({ text, type: type || 'pending', ts: d.fmtChatTs(new Date().toISOString()) });
      if (showModal) d.setXbrainProbeSteps(stepList);
    }
    if (showModal) {
      d.setXbrainProbeModalTitle('模型检测流程（白盒）');
      d.setXbrainProbeModalOpen(true);
    }
    pushStep('1/4 读取当前配置与厂商：' + d.providerLabel(provider), 'pending');
    let state = null;
    try {
      state = await d.fetchXbrainState(true);
    } catch (err) {
      pushStep('2/4 配置读取失败：' + String(err?.message || err), 'err');
      d.rememberProviderCheck(provider, false, '配置读取失败');
      refreshOnlineToggle();
      return { ok: false, provider, error: String(err?.message || err) };
    }
    const base = state?.base && typeof state.base === 'object' ? state.base : {};
    const runtimeProvider = d.normalizeProviderKey(base.runtimeModelProvider || '');
    const runtimeModel = String(base.runtimeModelId || '').trim();
    const authStatus = await d.getXbrainAuthStatus().catch(() => ({}));
    const providerAuth = base.providerAuth && typeof base.providerAuth === 'object' ? base.providerAuth : {};
    const oauthConnected = Boolean(d.getOauthConnected?.(provider));
    const configured = Boolean(providerAuth?.[provider]?.configured);
    const configOk = configured || oauthConnected || (provider !== 'deepseek' && Number(authStatus?.exitCode) === 0);
    if (!configOk) {
      pushStep('2/4 API 配置校验未通过（请先完成连接配置）', 'err');
      d.rememberProviderCheck(provider, false, '配置校验未通过');
      refreshOnlineToggle();
      return { ok: false, provider, error: '配置校验未通过' };
    }
    pushStep('2/4 API 配置校验通过', 'ok');
    pushStep('3/4 执行 OpenClaw 会话模型探针（非模拟对话）', 'pending');
    const runtimeOk = provider === 'deepseek'
      ? runtimeProvider === 'deepseek' && Boolean(runtimeModel)
      : (runtimeProvider === provider && Boolean(runtimeModel)) || oauthConnected;
    if (!runtimeOk) {
      pushStep('4/4 检测未通过：当前会话探针未确认到该厂商可用', 'err');
      d.rememberProviderCheck(provider, false, '会话探针未确认');
      refreshOnlineToggle();
      return { ok: false, provider, error: '会话探针未确认' };
    }
    pushStep('4/4 检测通过：' + d.providerLabel(provider) + ' 可上线', 'ok');
    d.rememberProviderCheck(provider, true, runtimeModel || d.providerLabel(provider));
    refreshOnlineToggle();
    return { ok: true, provider, runtimeModel, runtimeProvider };
  }

  async function runThunderModelSwitchFlow(modelRef, provider) {
    const stepList = [];
    function pushStep(text, type) {
      stepList.push({
        text: String(text || ''),
        type: String(type || 'pending'),
        ts: d.fmtChatTs(new Date().toISOString()),
      });
      d.setXbrainProbeSteps(stepList);
    }
    d.setXbrainProbeModalTitle('模型切换流程（白盒）');
    d.setXbrainProbeModalOpen(true);
    pushStep('1/4 接收切换请求：' + modelRef, 'pending');
    const payload = await d.switchXbrainRuntimeModel(modelRef, provider);
    pushStep('2/4 写入虾脑配置完成', 'ok');
    const syncOk = payload?.openclawModelSync == null || payload?.openclawModelSync?.ok === true;
    if (!syncOk) {
      pushStep('3/4 OpenClaw 同步失败：' + String(payload?.openclawModelSync?.error || 'unknown'), 'err');
      throw new Error(String(payload?.openclawModelSync?.error || 'OpenClaw 同步失败'));
    }
    pushStep('3/4 OpenClaw 模型同步完成', 'ok');
    const freshState = await d.fetchXbrainState(true);
    pushStep('4/4 会话探针刷新完成', 'ok');
    return freshState;
  }

  async function waitForXbrainAuthUrl(maxAttempts, intervalMs) {
    const attempts = Number.isFinite(maxAttempts) ? Math.max(1, maxAttempts) : 10;
    const interval = Number.isFinite(intervalMs) ? Math.max(200, intervalMs) : 800;
    for (let i = 0; i < attempts; i += 1) {
      const status = await d.getXbrainAuthStatus();
      const url = String(status?.url || '').trim();
      if (url) return { status, url };
      if (!status?.running) return { status, url: '' };
      await sleep(interval);
    }
    const status = await d.getXbrainAuthStatus();
    return { status, url: String(status?.url || '').trim() };
  }

  async function monitorXbrainAuthCompletion(providerLike) {
    if (d.getAuthMonitorRunning?.()) return;
    d.setAuthMonitorRunning?.(true);
    const provider = d.normalizeProviderKey(providerLike);
    try {
      for (let i = 0; i < 120; i += 1) {
        const status = await d.getXbrainAuthStatus().catch(() => ({}));
        if (status?.running) {
          await sleep(2000);
          continue;
        }
        if (Number(status?.exitCode) === 0) {
          const fresh = await d.fetchXbrainState(true).catch(function () { return null; });
          const configured = Boolean(fresh?.base?.providerAuth?.[provider]?.configured);
          if (configured) {
            d.setOauthConnected?.(provider, true);
            d.safeLocalJsonWrite?.(d.oauthConnectedKey, d.getOauthMap?.());
            d.setXbrainBaseSubStatus?.('model', '登录完成，正在自动检测...', 'ok');
            await runXbrainProviderProbeFlow({ provider, showModal: false });
            break;
          }
          d.setXbrainBaseSubStatus?.('model', '登录流程结束，但未检测到有效授权。', 'err');
          break;
        }
        const err = String(status?.error || '').trim();
        if (err) {
          d.setXbrainBaseSubStatus?.('model', '登录失败：' + err, 'err');
        }
        break;
      }
    } catch { }
    d.setAuthMonitorRunning?.(false);
  }

  return {
    runXbrainProviderProbeFlow,
    runThunderModelSwitchFlow,
    waitForXbrainAuthUrl,
    monitorXbrainAuthCompletion,
  };
};
