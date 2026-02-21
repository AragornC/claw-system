function toTraceId() {
  return `trace-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function safeObj(v) {
  return v && typeof v === 'object' ? v : {};
}

/**
 * OpenClaw-style ToolRuntime: 统一工具执行协议（traceId、timeout、retry、audit）
 * 支持 internal（executeStrategyToolCalls）与 MCP bridge 两种模式
 */
export function createToolRuntime(options = {}) {
  const executeStrategyToolCalls =
    typeof options.executeStrategyToolCalls === 'function'
      ? options.executeStrategyToolCalls
      : async () => ({ summaries: [], actions: [], toolResults: [] });
  const buildMcpStyleToolManifest =
    typeof options.buildMcpStyleToolManifest === 'function'
      ? options.buildMcpStyleToolManifest
      : () => ({ tools: [] });
  const checkMcpBridgeConnectivity =
    typeof options.checkMcpBridgeConnectivity === 'function'
      ? options.checkMcpBridgeConnectivity
      : async () => ({ ok: false, error: 'bridge_check_missing' });
  const resolveToolAdapterMode =
    typeof options.resolveToolAdapterMode === 'function'
      ? options.resolveToolAdapterMode
      : () => 'internal';
  const emitAudit = typeof options.emitAudit === 'function' ? options.emitAudit : () => {};
  const defaultTimeoutMs = Math.max(1000, Number(options.timeoutMs || 6000) || 6000);

  function getManifest() {
    const manifest = safeObj(buildMcpStyleToolManifest());
    return {
      ...manifest,
      runtime: {
        adapterMode: resolveToolAdapterMode(),
      },
    };
  }

  async function invokeTool(toolNameLike, argsLike = {}, contextLike = {}) {
    const traceId = toTraceId();
    const tool = String(toolNameLike || '').trim();
    const args = safeObj(argsLike);
    const context = safeObj(contextLike);
    if (!tool) {
      return { ok: false, error: 'tool_required', traceId };
    }
    const startedAt = Date.now();
    emitAudit('tool.invoke.start', { traceId, tool, args, context });
    const runner = executeStrategyToolCalls(
      [{ tool, arguments: args }],
      String(context.source || 'runtime'),
      String(context.rawMessage || ''),
    );
    let out = null;
    try {
      out = await Promise.race([
        runner,
        new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), defaultTimeoutMs)),
      ]);
    } catch (err) {
      emitAudit('tool.invoke.error', { traceId, tool, error: String(err?.message || err) });
      return { ok: false, error: String(err?.message || err || 'tool_invoke_failed'), traceId };
    }
    if (out?.timeout) {
      emitAudit('tool.invoke.timeout', { traceId, tool, timeoutMs: defaultTimeoutMs });
      return { ok: false, error: 'tool_timeout', traceId, timeoutMs: defaultTimeoutMs };
    }
    const result = {
      ok: true,
      traceId,
      tool,
      elapsedMs: Date.now() - startedAt,
      summaries: Array.isArray(out?.summaries) ? out.summaries : [],
      actions: Array.isArray(out?.actions) ? out.actions : [],
      toolResults: Array.isArray(out?.toolResults) ? out.toolResults : [],
    };
    emitAudit('tool.invoke.finish', {
      traceId,
      tool,
      elapsedMs: result.elapsedMs,
      resultCount: result.toolResults.length,
    });
    return result;
  }

  return {
    getManifest,
    invokeTool,
    checkBridge: checkMcpBridgeConnectivity,
  };
}
