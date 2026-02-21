function toText(v) {
  return String(v || '').trim();
}

function toObject(v) {
  return v && typeof v === 'object' ? v : {};
}

export function createChatToolOrchestrationService(depsLike = {}) {
  const deps = depsLike && typeof depsLike === 'object' ? depsLike : {};
  const strategyToolRegistry =
    typeof deps.strategyToolRegistry === 'function' ? deps.strategyToolRegistry : () => ({});
  const resolveToolAdapterMode =
    typeof deps.resolveToolAdapterMode === 'function' ? deps.resolveToolAdapterMode : () => 'internal';
  const resolveMcpBridgeConfig =
    typeof deps.resolveMcpBridgeConfig === 'function'
      ? deps.resolveMcpBridgeConfig
      : () => ({ enabled: false });
  const callMcpBridgeTool =
    typeof deps.callMcpBridgeTool === 'function'
      ? deps.callMcpBridgeTool
      : async () => ({ ok: false, error: 'mcp_bridge_missing' });
  const buildMcpStyleToolManifest =
    typeof deps.buildMcpStyleToolManifest === 'function'
      ? deps.buildMcpStyleToolManifest
      : () => ({ tools: [] });
  const truncText = typeof deps.truncText === 'function' ? deps.truncText : (v) => String(v || '');
  const buildLayeredMemoryBundle =
    typeof deps.buildLayeredMemoryBundle === 'function' ? deps.buildLayeredMemoryBundle : () => ({});
  const buildTradingContext =
    typeof deps.buildTradingContext === 'function'
      ? deps.buildTradingContext
      : () => ({ digest: null, context: {} });
  const runOpenClawToolRouter =
    typeof deps.runOpenClawToolRouter === 'function'
      ? deps.runOpenClawToolRouter
      : async () => ({ reply: '', toolCalls: [] });

  function resolveCapabilityAdapter(optionsLike = {}) {
    const options = toObject(optionsLike);
    const source = toText(options.source || 'dashboard');
    const rawMessage = toText(options.rawMessage || '');
    const registry = strategyToolRegistry(source, rawMessage);
    const mode = resolveToolAdapterMode();
    const mcpCfg = resolveMcpBridgeConfig();
    const mcpBridgeEnabled = Boolean(mcpCfg?.enabled);
    const mcpBridgePreferredTools = new Set(['get_market_news_impact', 'get_strategy_metrics', 'list_strategy_features']);

    async function invokeWithMode(toolNameLike, argsLike) {
      const toolName = toText(toolNameLike);
      const args = toObject(argsLike);
      const runner = registry[toolName];
      if (typeof runner !== 'function') {
        return { ok: false, error: 'tool_not_found', summary: '' };
      }

      if (mode === 'mcp') {
        let bridged = null;
        if (mcpBridgeEnabled && mcpBridgePreferredTools.has(toolName)) {
          bridged = await callMcpBridgeTool(toolName, args, { source });
          if (bridged?.ok) {
            return {
              ok: true,
              summary: toText(bridged.summary || ''),
              actions: Array.isArray(bridged.actions) ? bridged.actions : [],
              data: bridged.data && typeof bridged.data === 'object' ? bridged.data : null,
              adapterMeta: {
                mode: 'mcp',
                transport: 'mcp-bridge',
                fallbackToInternal: false,
                bridgeEnabled: true,
                traceId: bridged.traceId || null,
                retryCount: Number(bridged.retryCount || 0),
                attempts: Array.isArray(bridged.attempts) ? bridged.attempts.slice(0, 4) : [],
              },
            };
          }
        }
        const out = await runner(args);
        return {
          ok: true,
          ...(out && typeof out === 'object' ? out : {}),
          adapterMeta: {
            mode: 'mcp',
            transport: mcpBridgeEnabled ? 'mcp-bridge-fallback-internal' : 'mcp-skeleton-fallback',
            fallbackToInternal: true,
            bridgeEnabled: mcpBridgeEnabled,
            bridgeError: bridged?.ok ? null : toText(bridged?.error || ''),
            bridgeTraceId: bridged?.traceId || null,
          },
        };
      }

      const out = await runner(args);
      return {
        ok: true,
        ...(out && typeof out === 'object' ? out : {}),
        adapterMeta: {
          mode: 'internal',
          transport: 'inproc',
          fallbackToInternal: false,
        },
      };
    }

    return {
      mode,
      listTools() {
        const tools = Array.isArray(buildMcpStyleToolManifest()?.tools)
          ? buildMcpStyleToolManifest().tools
          : [];
        return tools.filter((tool) => {
          const adapters = Array.isArray(tool?.annotations?.adapters)
            ? tool.annotations.adapters
            : ['internal'];
          return adapters.includes(mode);
        });
      },
      async invokeTool(toolNameLike, argsLike) {
        return invokeWithMode(toolNameLike, argsLike);
      },
    };
  }

  async function executeStrategyToolCalls(toolCallsLike = [], source = 'dashboard', rawMessage = '') {
    const calls = Array.isArray(toolCallsLike) ? toolCallsLike : [];
    const summaries = [];
    const actions = [];
    const toolResults = [];
    const adapter = resolveCapabilityAdapter({ source, rawMessage });
    const capabilitySet = new Set(adapter.listTools().map((x) => toText(x?.name || '')));
    for (const call of calls.slice(0, 4)) {
      const tool = toText(call?.tool || '');
      const args = toObject(call?.arguments);
      if (!tool) continue;
      if (!capabilitySet.has(tool)) continue;
      const out = await adapter.invokeTool(tool, args);
      if (out?.ok === false) continue;
      const summary = truncText(toText(out?.summary || ''), 4000);
      if (summary) summaries.push(summary);
      if (Array.isArray(out?.actions)) out.actions.forEach((a) => actions.push(a));
      toolResults.push({
        tool,
        arguments: args,
        summary,
        data: out?.data && typeof out.data === 'object' ? out.data : null,
        adapter: adapter.mode,
        adapterMeta: out?.adapterMeta && typeof out.adapterMeta === 'object' ? out.adapterMeta : null,
      });
    }
    return { summaries, actions, toolResults };
  }

  async function handleNaturalLanguageToolOrchestration(messageLike = '', source = 'dashboard', contextLike = {}) {
    const message = toText(messageLike);
    if (!message) return { handled: false };
    if (/^(\/|记忆状态|工件状态|使用工件|反馈工件|反馈\s)/i.test(message)) return { handled: false };
    const context = toObject(contextLike);
    try {
      const memoryBundle = buildLayeredMemoryBundle(message);
      const trading = buildTradingContext(
        {
          currentView: toText(context.currentView || 'dashboard'),
          sessionKey: toText(context.sessionKey || ''),
          sessionPreview: Array.isArray(context.sessionPreview) ? context.sessionPreview.slice(-12) : [],
          userIntentHint: 'tool-router:' + source,
        },
        memoryBundle,
      );
      const maxSteps = 3;
      const routeDeadlineAt = Date.now() + 18_000;
      const planState = {
        toolResults: [],
      };
      const replies = [];
      const allSummaries = [];
      const allActions = [];
      for (let step = 1; step <= maxSteps; step += 1) {
        const remainMs = routeDeadlineAt - Date.now();
        if (remainMs <= 1200) break;
        const routedAny = await Promise.race([
          runOpenClawToolRouter(message, trading.context, {
            step,
            maxSteps,
            toolResults: planState.toolResults,
          })
            .then((v) => ({ ok: true, value: v }))
            .catch(() => ({ ok: false })),
          new Promise((resolve) =>
            setTimeout(
              () => resolve({ ok: false, timeout: true }),
              Math.max(1000, Math.min(3500, remainMs - 300)),
            ),
          ),
        ]);
        if (!routedAny || routedAny.ok !== true || !routedAny.value) break;
        const routed = routedAny.value;
        if (routed.reply) replies.push(String(routed.reply));
        if (!Array.isArray(routed.toolCalls) || !routed.toolCalls.length) break;
        const executed = await executeStrategyToolCalls(routed.toolCalls, source, message);
        if (Array.isArray(executed.summaries)) {
          executed.summaries.filter(Boolean).forEach((s) => allSummaries.push(String(s)));
        }
        if (Array.isArray(executed.actions)) {
          executed.actions.forEach((a) => allActions.push(a));
        }
        if (Array.isArray(executed.toolResults) && executed.toolResults.length) {
          planState.toolResults = planState.toolResults.concat(executed.toolResults).slice(-12);
        }
        if (!executed.toolResults || !executed.toolResults.length) break;
      }
      const parts = replies.concat(allSummaries);
      const reply = parts.filter(Boolean).join('\n\n').trim();
      return {
        handled: Boolean(reply),
        reply: reply || '已处理你的请求。',
        actions: allActions,
      };
    } catch {
      return { handled: false };
    }
  }

  return {
    resolveCapabilityAdapter,
    executeStrategyToolCalls,
    handleNaturalLanguageToolOrchestration,
  };
}
