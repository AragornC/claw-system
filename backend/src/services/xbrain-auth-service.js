export function createXbrainAuthService(deps) {
  const d = deps && typeof deps === 'object' ? deps : {};
  const fs = d.fs;
  const path = d.path;
  const os = d.os;
  const workdir = String(d.workdir || process.cwd());
  const openclawAgentId = String(d.openclawAgentId || 'main').trim() || 'main';
  const safeErrMsg = typeof d.safeErrMsg === 'function'
    ? d.safeErrMsg
    : (err, fallback = 'unknown error') => String(err?.message || fallback);
  const hasOwn = typeof d.hasOwn === 'function'
    ? d.hasOwn
    : (objLike, key) => Boolean(objLike && Object.prototype.hasOwnProperty.call(objLike, key));

  function normalizeOAuthProvider(providerLike) {
    const providerRaw = String(providerLike || '').trim().toLowerCase();
    if (providerRaw === 'chatgpt' || providerRaw === 'openai' || providerRaw === 'codex') return 'openai-codex';
    if (providerRaw === 'anthropic') return 'anthropic';
    return '';
  }

  function parseAuthUrlFromOutput(textLike) {
    const text = String(textLike || '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
    const matches = text.match(/https?:\/\/[^\s"'<>]+/gi) || [];
    if (!matches.length) return '';
    const preferred = matches.find((u) => /(auth\.openai\.com|chatgpt\.com|oauth|authorize|signin|login)/i.test(u));
    return String(preferred || '').trim();
  }

  function parseAuthUrlFromOutputByProvider(providerLike, textLike) {
    const provider = String(providerLike || '').trim().toLowerCase();
    const text = String(textLike || '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
    const matches = text.match(/https?:\/\/[^\s"'<>]+/gi) || [];
    if (!matches.length) return '';
    if (provider === 'anthropic') {
      const anth = matches.find((u) => /(anthropic\.com|console\.anthropic\.com)/i.test(u));
      if (anth) return String(anth).trim();
    }
    if (provider === 'openai-codex') {
      const oa = matches.find((u) => /(auth\.openai\.com|chatgpt\.com)/i.test(u));
      if (oa) return String(oa).trim();
    }
    return parseAuthUrlFromOutput(text);
  }

  function resolveXbrainAuthLaunch(providerLike, cli, options) {
    const provider = normalizeOAuthProvider(providerLike);
    const c = cli && typeof cli === 'object' ? cli : {};
    const opts = options && typeof options === 'object' ? options : {};
    const nodePath = String(opts.nodePath || process.execPath);
    const openaiRunner = String(opts.openaiRunner || '').trim();
    const prefixArgs = Array.isArray(c.prefixArgs) ? c.prefixArgs : [];
    const command = String(c.command || '');
    if (provider === 'openai-codex') {
      return {
        phase: 'preparing',
        mode: 'runner',
        command: nodePath,
        args: [openaiRunner],
      };
    }
    if (provider === 'anthropic') {
      return {
        phase: 'authenticating',
        mode: 'expect_setup_token',
        command,
        args: [...prefixArgs, 'models', 'auth', 'setup-token', '--provider', 'anthropic', '--yes'],
      };
    }
    return {
      phase: 'authenticating',
      mode: 'expect',
      command,
      args: [...prefixArgs, 'models', 'auth', 'login', '--provider', provider, '--set-default'],
    };
  }

  function inferXbrainAuthPhaseFromOutput(providerLike, outputTail) {
    const provider = normalizeOAuthProvider(providerLike);
    const tail = String(outputTail || '').toLowerCase();
    if (/open this url|complete sign-in in browser|oauth url ready|browser will open|open: https?:\/\//i.test(tail)) {
      return 'waiting_browser';
    }
    if (/paste the redirect url|redirect url|required|paste.*callback/i.test(tail)) {
      return 'waiting_redirect';
    }
    if (provider === 'openai-codex' && /onboard|quickstart|setup|wizard/i.test(tail)) {
      return 'preparing';
    }
    return 'authenticating';
  }

  function resetXbrainAuthState(authState, payload) {
    const state = authState && typeof authState === 'object' ? authState : {};
    const p = payload && typeof payload === 'object' ? payload : {};
    state.running = true;
    state.pid = p.pid ?? null;
    state.provider = String(p.provider || '');
    state.phase = String(p.phase || 'authenticating');
    state.startedAt = String(p.startedAt || '');
    state.finishedAt = null;
    state.exitCode = null;
    state.url = null;
    state.outputTail = '';
    state.error = null;
    return state;
  }

  function appendOutputTail(prevTail, chunk, maxLen = 8000) {
    const next = String(prevTail || '') + String(chunk || '');
    const max = Number.isFinite(maxLen) ? Math.max(200, Number(maxLen)) : 8000;
    return next.slice(-max);
  }

  function buildAuthStatusView(authState) {
    const state = authState && typeof authState === 'object' ? authState : {};
    return {
      running: Boolean(state.running),
      pid: state.pid ?? null,
      provider: state.provider ?? null,
      phase: String(state.phase || 'idle'),
      startedAt: state.startedAt ?? null,
      finishedAt: state.finishedAt ?? null,
      exitCode: state.exitCode ?? null,
      url: state.url ?? null,
      outputTail: String(state.outputTail || ''),
      waitingInput: false,
      error: state.error ?? null,
    };
  }

  function validateAuthInput(authState, authProc, inputLike) {
    const state = authState && typeof authState === 'object' ? authState : {};
    const proc = authProc && typeof authProc === 'object' ? authProc : null;
    if (!state.running || !proc || typeof proc.write !== 'function') {
      return { ok: false, status: 409, error: '当前没有进行中的登录流程。' };
    }
    const value = String(inputLike || '').trim();
    if (!value) return { ok: false, status: 400, error: 'input 不能为空。' };
    if (proc.kind === 'runner') {
      return {
        ok: false,
        status: 400,
        error: '当前登录流程已改为自动回调，不再支持手工提交 redirect URL。',
      };
    }
    return { ok: true, value };
  }

  function executeAuthInput(authState, authProc, inputLike, options) {
    const state = authState && typeof authState === 'object' ? authState : {};
    const proc = authProc && typeof authProc === 'object' ? authProc : null;
    const opts = options && typeof options === 'object' ? options : {};
    const check = validateAuthInput(state, proc, inputLike);
    if (!check.ok) {
      return {
        ok: false,
        status: Number(check.status || 400),
        error: String(check.error || '输入失败'),
      };
    }
    const errFormatter = typeof opts.errFormatter === 'function'
      ? opts.errFormatter
      : (err, fallback = 'unknown error') => String(err?.message || fallback);
    try {
      proc.write(check.value + '\n');
      state.phase = 'authenticating';
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        status: 500,
        error: errFormatter(err, '写入登录输入失败'),
      };
    }
  }

  function toTclList(values) {
    const arr = Array.isArray(values) ? values : [];
    return arr
      .map((item) => '{' + String(item ?? '').replace(/\\/g, '\\\\').replace(/\}/g, '\\}') + '}')
      .join(' ');
  }

  function buildExpectScript(command, args, mode) {
    const cmdList = toTclList([command || '', ...(Array.isArray(args) ? args : [])]);
    if (String(mode || '') === 'expect_setup_token') {
      return [
        'log_user 1',
        'set timeout -1',
        'spawn ' + cmdList,
        'expect eof',
      ].join('; ');
    }
    return [
      'log_user 1',
      'set timeout -1',
      'spawn ' + cmdList,
      'interact',
    ].join('; ');
  }

  function createAuthProcessHandle(childProc, kind) {
    const child = childProc && typeof childProc === 'object' ? childProc : null;
    return {
      kind: String(kind || 'unknown'),
      pid: child?.pid || null,
      write: (line) => child?.stdin && child.stdin.write(String(line || '')),
      kill: () => child?.kill && child.kill(),
    };
  }

  function initializeAuthProcess(authState, childProc, config) {
    const state = authState && typeof authState === 'object' ? authState : {};
    const child = childProc && typeof childProc === 'object' ? childProc : null;
    const c = config && typeof config === 'object' ? config : {};
    const handle = createAuthProcessHandle(child, c.kind || 'unknown');
    resetXbrainAuthState(state, {
      pid: handle.pid,
      provider: c.provider,
      phase: c.phase,
      startedAt: c.startedAt,
    });
    return handle;
  }

  function applyExpectOutputChunk(authState, providerLike, chunk, parseUrlByProvider) {
    const state = authState && typeof authState === 'object' ? authState : {};
    const next = appendOutputTail(state.outputTail, chunk, 8000);
    state.outputTail = next;
    state.phase = inferXbrainAuthPhaseFromOutput(providerLike, next);
    if (!state.url && typeof parseUrlByProvider === 'function') {
      const u = parseUrlByProvider(providerLike, next);
      if (u) state.url = u;
    }
    return state;
  }

  function bindAuthOutputStreams(childProc, authState, options) {
    const child = childProc && typeof childProc === 'object' ? childProc : null;
    const state = authState && typeof authState === 'object' ? authState : {};
    const opts = options && typeof options === 'object' ? options : {};
    if (!child) return;
    const mode = String(opts.mode || '');
    if (mode === 'runner') {
      child.stdout?.on('data', (chunk) => {
        applyRunnerOutputChunk(state, chunk, opts.runnerHandlers);
      });
      child.stderr?.on('data', (buf) => {
        state.outputTail = appendOutputTail(state.outputTail, buf, Number(opts.maxTail || 8000));
      });
      return;
    }
    const provider = opts.provider;
    const parseUrlByProvider = opts.parseUrlByProvider;
    const onData = (chunk) => {
      applyExpectOutputChunk(state, provider, chunk, parseUrlByProvider);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
  }

  function applyRunnerOutputChunk(authState, chunk, handlers) {
    const text = String(chunk || '');
    const lines = text.split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      let evt = null;
      try { evt = JSON.parse(line); } catch {}
      applyRunnerEvent(authState, evt, handlers);
    }
    return authState;
  }

  function buildAuthSpawnOptions(cwd, envLike) {
    return {
      cwd: String(cwd || process.cwd()),
      env: envLike && typeof envLike === 'object' ? envLike : process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    };
  }

  function markAuthProcessError(authState, errLike, fallback, errFormatter, nowFn) {
    const state = authState && typeof authState === 'object' ? authState : {};
    const safeErr = typeof errFormatter === 'function'
      ? errFormatter
      : (err, fb = 'unknown error') => String(err?.message || fb);
    const now = typeof nowFn === 'function' ? nowFn : () => new Date().toISOString();
    state.running = false;
    state.finishedAt = now();
    state.phase = 'failed';
    state.error = safeErr(errLike, fallback || 'process failed');
    return state;
  }

  function finalizeAuthProcessClose(authState, payload) {
    const state = authState && typeof authState === 'object' ? authState : {};
    const p = payload && typeof payload === 'object' ? payload : {};
    const now = typeof p.nowFn === 'function' ? p.nowFn : () => new Date().toISOString();
    const mode = String(p.mode || '');
    const provider = normalizeOAuthProvider(p.provider);
    const requireNoErrorOnSuccess = mode === 'runner';
    state.running = false;
    state.finishedAt = now();
    state.exitCode = Number.isFinite(p.exitCode) ? Number(p.exitCode) : -1;
    const tail = String(state.outputTail || '');
    if (mode === 'expect' && state.exitCode === 0 && /bad flag|no such file|error:|oauth requires interactive mode/i.test(tail)) {
      state.exitCode = 1;
    }
    if (state.exitCode !== 0 && !state.error) {
      state.error = buildAuthExitError(provider, tail, state.exitCode);
    }
    state.phase = state.exitCode === 0 && (!requireNoErrorOnSuccess || !state.error) ? 'done' : 'failed';
    return state;
  }

  function bindAuthProcessLifecycle(childProc, authState, options) {
    const child = childProc && typeof childProc === 'object' ? childProc : null;
    const state = authState && typeof authState === 'object' ? authState : {};
    const opts = options && typeof options === 'object' ? options : {};
    if (!child || typeof child.on !== 'function') return;
    child.on('error', (err) => {
      markAuthProcessError(
        state,
        err,
        opts.errorFallback || 'auth process failed',
        opts.errFormatter,
        opts.nowFn,
      );
      if (typeof opts.onFinalize === 'function') opts.onFinalize('error');
    });
    child.on('close', (code) => {
      finalizeAuthProcessClose(state, {
        mode: opts.mode,
        provider: opts.provider,
        exitCode: code,
        nowFn: opts.nowFn,
      });
      if (typeof opts.onFinalize === 'function') opts.onFinalize('close');
    });
  }

  function startAuthProcessByMode(params) {
    const p = params && typeof params === 'object' ? params : {};
    const launch = p.launch && typeof p.launch === 'object' ? p.launch : {};
    const mode = String(launch.mode || '');
    const spawnFn = typeof p.spawnFn === 'function' ? p.spawnFn : null;
    if (!spawnFn) {
      throw new Error('spawnFn is required');
    }
    const spawnOptions = p.spawnOptions && typeof p.spawnOptions === 'object'
      ? p.spawnOptions
      : buildAuthSpawnOptions(process.cwd(), process.env);
    const authState = p.authState && typeof p.authState === 'object' ? p.authState : {};
    const provider = p.provider;
    const startedAt = typeof p.startedAt === 'function' ? p.startedAt() : new Date().toISOString();
    const runnerHandlers = p.runnerHandlers && typeof p.runnerHandlers === 'object' ? p.runnerHandlers : {};
    const parseUrlByProvider = typeof p.parseUrlByProvider === 'function' ? p.parseUrlByProvider : parseAuthUrlFromOutputByProvider;
    const onFinalize = typeof p.onFinalize === 'function' ? p.onFinalize : undefined;
    const errFormatter = typeof p.errFormatter === 'function' ? p.errFormatter : safeErrMsg;
    const nowFn = typeof p.nowFn === 'function' ? p.nowFn : () => new Date().toISOString();
    const fallbackCommand = String(p.fallbackCommand || '');

    if (mode === 'runner') {
      const child = spawnFn(launch.command, Array.isArray(launch.args) ? launch.args : [], spawnOptions);
      const processHandle = initializeAuthProcess(authState, child, {
        kind: 'runner',
        provider,
        phase: launch.phase,
        startedAt,
      });
      bindAuthOutputStreams(child, authState, {
        mode: 'runner',
        maxTail: 8000,
        runnerHandlers,
      });
      bindAuthProcessLifecycle(child, authState, {
        mode: 'runner',
        provider,
        errorFallback: 'oauth runner spawn failed',
        errFormatter,
        nowFn,
        onFinalize,
      });
      return { ok: true, processHandle };
    }

    const expectScript = buildExpectScript(launch.command || fallbackCommand, launch.args, mode);
    const child = spawnFn('expect', ['-c', expectScript], spawnOptions);
    const processHandle = initializeAuthProcess(authState, child, {
      kind: 'expect',
      provider,
      phase: launch.phase,
      startedAt,
    });
    bindAuthOutputStreams(child, authState, {
      mode: 'expect',
      provider,
      parseUrlByProvider,
    });
    bindAuthProcessLifecycle(child, authState, {
      mode: 'expect',
      provider,
      errorFallback: 'auth login spawn failed',
      errFormatter,
      nowFn,
      onFinalize,
    });
    return { ok: true, processHandle };
  }

  function applyRunnerEvent(authState, eventLike, handlers) {
    const state = authState && typeof authState === 'object' ? authState : {};
    const evt = eventLike && typeof eventLike === 'object' ? eventLike : null;
    const h = handlers && typeof handlers === 'object' ? handlers : {};
    if (!evt) return;
    if (evt.type === 'auth_url') {
      const url = String(evt.url || '').trim();
      if (url) state.url = url;
      state.phase = 'waiting_browser';
      return;
    }
    if (evt.type === 'auto_callback_unavailable') {
      state.phase = 'failed';
      state.error = String(evt.message || '自动回调不可用');
      return;
    }
    if (evt.type === 'progress') {
      const msg = String(evt.message || '').trim();
      if (msg) state.outputTail = appendOutputTail(state.outputTail, '\n' + msg);
      if (state.phase === 'preparing') state.phase = 'authenticating';
      return;
    }
    if (evt.type === 'done') {
      if (typeof h.saveOpenAICodexOAuthCredentials === 'function') {
        try {
          h.saveOpenAICodexOAuthCredentials(evt.credentials || {});
        } catch (err) {
          const msg = typeof h.safeErrMsg === 'function'
            ? h.safeErrMsg(err, '保存 OAuth 凭证失败')
            : String(err?.message || '保存 OAuth 凭证失败');
          state.error = msg;
        }
      }
      return;
    }
    if (evt.type === 'error') {
      state.error = String(evt.error || 'OAuth 登录失败');
    }
  }

  function buildAuthExitError(providerLike, outputTail, exitCodeLike) {
    const provider = normalizeOAuthProvider(providerLike);
    const tail = String(outputTail || '');
    const code = Number.isFinite(exitCodeLike) ? Number(exitCodeLike) : -1;
    if (code === 0) return '';
    if (/No provider plugins found/i.test(tail)) {
      return '登录失败：OpenClaw 模型能力尚未准备好。请重试“一键登录”，系统会自动初始化。';
    }
    if (/unknown provider/i.test(tail)) {
      return provider === 'anthropic'
        ? '登录失败：当前环境缺少 Anthropic provider。请先完成 OpenClaw 模型插件安装。'
        : '登录失败：当前环境缺少 OpenAI OAuth provider，已无法继续授权。';
    }
    if (/oauth requires interactive mode/i.test(tail)) {
      return '登录失败：当前流程未进入交互授权，请重试“一键登录”。';
    }
    if (/interactive TTY/i.test(tail)) {
      return '登录失败：认证环境初始化异常，请重试。';
    }
    if (provider === 'anthropic' && /token|setup-token|clipboard|paste/i.test(tail)) {
      return '登录失败：Anthropic 需要 token 登录。请在 OpenClaw 完成 setup-token 后重试。';
    }
    return '登录流程退出，code=' + String(code);
  }

  function resolveOpenClawStateDir() {
    const raw = String(process.env.OPENCLAW_STATE_DIR || '').trim();
    if (!raw) return path.resolve(os.homedir(), '.openclaw');
    return path.isAbsolute(raw) ? raw : path.resolve(workdir, raw);
  }

  function writeJsonFileSafe(targetPath, data) {
    const dir = path.dirname(targetPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(targetPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  }

  function saveOpenAICodexOAuthCredentials(credentialsLike) {
    const credentials = credentialsLike && typeof credentialsLike === 'object' ? credentialsLike : null;
    if (!credentials) throw new Error('OAuth credentials 为空。');
    const stateDir = resolveOpenClawStateDir();
    const authPath = path.resolve(stateDir, 'agents', openclawAgentId, 'auth-profiles.json');
    let store = { version: 1, profiles: {} };
    try {
      if (fs.existsSync(authPath)) {
        const raw = fs.readFileSync(authPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          store = {
            version: Number(parsed.version || 1) || 1,
            profiles: parsed.profiles && typeof parsed.profiles === 'object' ? parsed.profiles : {},
            order: parsed.order && typeof parsed.order === 'object' ? parsed.order : undefined,
            lastGood: parsed.lastGood && typeof parsed.lastGood === 'object' ? parsed.lastGood : undefined,
            usageStats: parsed.usageStats && typeof parsed.usageStats === 'object' ? parsed.usageStats : undefined,
          };
        }
      }
    } catch {}
    store.profiles['openai-codex:default'] = {
      ...credentials,
      type: 'oauth',
      provider: 'openai-codex',
    };
    writeJsonFileSafe(authPath, store);
    const legacyOauthPath = path.resolve(stateDir, 'credentials', 'oauth.json');
    writeJsonFileSafe(legacyOauthPath, { 'openai-codex': credentials });
  }

  function disconnectOAuthCredentials(providerLike) {
    const provider = normalizeOAuthProvider(providerLike);
    if (!provider) {
      return { ok: false, status: 400, error: 'provider 仅支持 openai/anthropic。' };
    }
    const stateDir = resolveOpenClawStateDir();
    const authPath = path.resolve(stateDir, 'agents', openclawAgentId, 'auth-profiles.json');
    const legacyOauthPath = path.resolve(stateDir, 'credentials', 'oauth.json');
    let removed = 0;
    try {
      const store = fs.existsSync(authPath)
        ? JSON.parse(fs.readFileSync(authPath, 'utf8'))
        : { version: 1, profiles: {} };
      const profiles = store && typeof store === 'object' && store.profiles && typeof store.profiles === 'object'
        ? store.profiles
        : {};
      Object.keys(profiles).forEach((k) => {
        const key = String(k || '').toLowerCase();
        if (provider === 'openai-codex' && key.startsWith('openai-codex:')) {
          delete profiles[k];
          removed += 1;
        }
        if (provider === 'anthropic' && key.startsWith('anthropic:')) {
          delete profiles[k];
          removed += 1;
        }
      });
      store.profiles = profiles;
      writeJsonFileSafe(authPath, store);
    } catch (err) {
      return { ok: false, status: 500, error: safeErrMsg(err, '清理 OAuth 凭据失败') };
    }
    try {
      if (fs.existsSync(legacyOauthPath)) {
        const legacy = JSON.parse(fs.readFileSync(legacyOauthPath, 'utf8'));
        if (legacy && typeof legacy === 'object') {
          if (provider === 'openai-codex' && hasOwn(legacy, 'openai-codex')) {
            delete legacy['openai-codex'];
            removed += 1;
          }
          if (provider === 'anthropic' && hasOwn(legacy, 'anthropic')) {
            delete legacy['anthropic'];
            removed += 1;
          }
          writeJsonFileSafe(legacyOauthPath, legacy);
        }
      }
    } catch {}
    return { ok: true, removed };
  }

  return {
    normalizeOAuthProvider,
    parseAuthUrlFromOutput,
    parseAuthUrlFromOutputByProvider,
    resolveXbrainAuthLaunch,
    inferXbrainAuthPhaseFromOutput,
    resetXbrainAuthState,
    appendOutputTail,
    buildAuthStatusView,
    validateAuthInput,
    executeAuthInput,
    buildExpectScript,
    createAuthProcessHandle,
    initializeAuthProcess,
    applyExpectOutputChunk,
    bindAuthOutputStreams,
    applyRunnerOutputChunk,
    buildAuthSpawnOptions,
    startAuthProcessByMode,
    markAuthProcessError,
    finalizeAuthProcessClose,
    bindAuthProcessLifecycle,
    applyRunnerEvent,
    buildAuthExitError,
    resolveOpenClawStateDir,
    saveOpenAICodexOAuthCredentials,
    disconnectOAuthCredentials,
  };
}
