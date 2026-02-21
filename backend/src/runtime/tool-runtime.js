function toTraceId() {
  return `trace-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function safeObj(value) {
  return value && typeof value === 'object' ? value : {};
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeToolRow(rowLike) {
  const row = rowLike && typeof rowLike === 'object' ? rowLike : {};
  return {
    name: String(row.name || '').trim(),
    description: String(row.description || ''),
    inputSchema: row.inputSchema && typeof row.inputSchema === 'object' ? row.inputSchema : {},
    permissions: row.permissions && typeof row.permissions === 'object' ? row.permissions : {},
    visibility: String(row.visibility || 'global'),
    idempotent: Boolean(row.idempotent),
    annotations: row.annotations && typeof row.annotations === 'object' ? row.annotations : {},
  };
}

export function createToolRuntime(options = {}) {
  const executeStrategyToolCalls =
    typeof options.executeStrategyToolCalls === 'function'
      ? options.executeStrategyToolCalls
      : async () => ({ summaries: [], actions: [], toolResults: [] });
  const buildMcpStyleToolManifest =
    typeof options.buildMcpStyleToolManifest === 'function' ? options.buildMcpStyleToolManifest : () => ({ tools: [] });
  const checkMcpBridgeConnectivity =
    typeof options.checkMcpBridgeConnectivity === 'function'
      ? options.checkMcpBridgeConnectivity
      : async () => ({ ok: false, error: 'bridge_check_missing' });
  const resolveToolAdapterMode =
    typeof options.resolveToolAdapterMode === 'function' ? options.resolveToolAdapterMode : () => 'internal';
  const emitAudit = typeof options.emitAudit === 'function' ? options.emitAudit : () => {};

  const defaultTimeoutMs = Math.max(1200, Number(options.timeoutMs || 6000) || 6000);
  const defaultRetry = Math.max(0, Math.min(3, Number(options.retry || 1) || 1));

  function getManifest() {
    const raw = safeObj(buildMcpStyleToolManifest());
    const tools = Array.isArray(raw.tools) ? raw.tools.map(normalizeToolRow).filter((x) => x.name) : [];
    return {
      tools,
      runtime: {
        adapterMode: String(resolveToolAdapterMode() || 'internal'),
        timeoutMs: defaultTimeoutMs,
        retry: defaultRetry,
      },
    };
  }

  async function invokeTool(toolNameLike, argsLike = {}, contextLike = {}) {
    const traceId = toTraceId();
    const tool = String(toolNameLike || '').trim();
    const args = safeObj(argsLike);
    const context = safeObj(contextLike);
    if (!tool) return { ok: false, error: 'tool_required', traceId };

    const source = String(context.source || 'runtime');
    const rawMessage = String(context.rawMessage || '');
    const timeoutMs = Math.max(800, Number(context.timeoutMs || defaultTimeoutMs) || defaultTimeoutMs);
    const retry = Math.max(0, Math.min(3, Number(context.retry ?? defaultRetry) || defaultRetry));
    const startedAt = Date.now();

    emitAudit('tool.invoke.start', { traceId, tool, source, timeoutMs, retry });

    const attempts = [];
    for (let attempt = 0; attempt <= retry; attempt += 1) {
      try {
        const runner = executeStrategyToolCalls([{ tool, arguments: args }], source, rawMessage);
        const out = await Promise.race([
          runner,
          new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), timeoutMs)),
        ]);

        if (out?.timeout) {
          attempts.push({ ok: false, error: 'tool_timeout', attempt });
        } else {
          const result = {
            ok: true,
            traceId,
            tool,
            attempt,
            elapsedMs: Date.now() - startedAt,
            summaries: Array.isArray(out?.summaries) ? out.summaries : [],
            actions: Array.isArray(out?.actions) ? out.actions : [],
            toolResults: Array.isArray(out?.toolResults) ? out.toolResults : [],
          };
          emitAudit('tool.invoke.finish', {
            traceId,
            tool,
            attempt,
            elapsedMs: result.elapsedMs,
            resultCount: result.toolResults.length,
          });
          return result;
        }
      } catch (err) {
        attempts.push({
          ok: false,
          error: String(err?.message || err || 'tool_invoke_failed'),
          attempt,
        });
      }
      if (attempt < retry) await sleep(150 * (attempt + 1));
    }

    const error = attempts[attempts.length - 1]?.error || 'tool_invoke_failed';
    emitAudit('tool.invoke.error', { traceId, tool, error, attempts });
    return {
      ok: false,
      traceId,
      tool,
      error,
      elapsedMs: Date.now() - startedAt,
      attempts,
    };
  }

  return {
    getManifest,
    invokeTool,
    invoke: invokeTool,
    checkBridge: checkMcpBridgeConnectivity,
  };
}
