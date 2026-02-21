function toTraceId() {
  return `trace-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function safeObj(v) {
  return v && typeof v === 'object' ? v : {};
}

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
    const runner = executeStrategyToolCalls([{ tool, arguments: args }], String(context.source || 'runtime'), String(context.rawMessage || ''));
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
import crypto from 'node:crypto';

function withTimeout(promise, timeoutMs) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('tool_timeout')), timeoutMs)),
  ]);
}

function normalizeTools(manifestLike) {
  const tools = Array.isArray(manifestLike?.tools) ? manifestLike.tools : [];
  return tools.map((tool) => ({
    name: String(tool?.name || '').trim(),
    description: String(tool?.description || ''),
    inputSchema: tool?.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : {},
    annotations: tool?.annotations && typeof tool.annotations === 'object' ? tool.annotations : {},
  }));
}

export function createToolRuntime(options = {}) {
  const resolveCapabilityAdapter =
    typeof options.resolveCapabilityAdapter === 'function' ? options.resolveCapabilityAdapter : null;
  const buildManifest = typeof options.buildManifest === 'function' ? options.buildManifest : null;
  const executeInternalTool = typeof options.executeInternalTool === 'function' ? options.executeInternalTool : null;
  const auditLog = options.auditLog || null;

  function manifest() {
    const raw = buildManifest ? buildManifest() : { tools: [] };
    return { tools: normalizeTools(raw) };
  }

  async function invoke(toolNameLike, argsLike = {}, ctxLike = {}) {
    const toolName = String(toolNameLike || '').trim();
    const args = argsLike && typeof argsLike === 'object' ? argsLike : {};
    const ctx = ctxLike && typeof ctxLike === 'object' ? ctxLike : {};
    const traceId = crypto.randomUUID();
    const timeoutMs = Math.max(600, Math.min(20_000, Number(ctx.timeoutMs || 5000) || 5000));
    const retry = Math.max(0, Math.min(2, Number(ctx.retry || 1) || 1));
    let lastErr = null;
    for (let i = 0; i <= retry; i += 1) {
      try {
        let out = null;
        if (resolveCapabilityAdapter) {
          const adapter = resolveCapabilityAdapter({
            source: String(ctx.source || 'dashboard'),
            rawMessage: String(ctx.rawMessage || ''),
          });
          if (adapter && typeof adapter.invokeTool === 'function') {
            out = await withTimeout(adapter.invokeTool(toolName, args), timeoutMs);
          }
        }
        if (!out && executeInternalTool) {
          out = await withTimeout(executeInternalTool(toolName, args, ctx), timeoutMs);
        }
        if (!out) throw new Error('tool_no_output');
        const result = {
          ok: true,
          traceId,
          tool: toolName,
          retryCount: i,
          summary: String(out?.summary || ''),
          data: out?.data && typeof out.data === 'object' ? out.data : null,
          actions: Array.isArray(out?.actions) ? out.actions : [],
        };
        auditLog?.append?.('tool_invoked', { traceId, tool: toolName, retryCount: i });
        return result;
      } catch (err) {
        lastErr = err;
      }
    }
    const error = String(lastErr?.message || lastErr || 'tool_failed');
    auditLog?.append?.('tool_failed', { traceId, tool: toolName, error });
    return {
      ok: false,
      traceId,
      tool: toolName,
      error,
      actions: [],
    };
  }

  return {
    manifest,
    invoke,
  };
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeArgs(argsLike) {
  return argsLike && typeof argsLike === 'object' ? argsLike : {};
}

function withTimeout(promise, timeoutMs, label = 'timeout') {
  const ms = Math.max(500, Number(timeoutMs || 8000));
  let timer = null;
  return Promise.race([
    promise.finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), ms);
    }),
  ]);
}

export function createToolRuntime(options = {}) {
  const deps = options.deps && typeof options.deps === 'object' ? options.deps : {};
  const retry = Math.max(0, Math.min(3, Number(options.retry || 1)));
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || 8000));
  const fallbackToInternal = options.fallbackToInternal !== false;
  const mode = String(options.mode || process.env.THUNDERCLAW_TOOL_ADAPTER || 'internal').trim();

  async function listManifest() {
    if (typeof deps.buildMcpStyleToolManifest === 'function') {
      const out = deps.buildMcpStyleToolManifest();
      if (out && typeof out === 'object') return out;
    }
    return { tools: [] };
  }

  async function invokeViaInternal(tool, args, context = {}) {
    if (typeof deps.executeStrategyToolCalls !== 'function') {
      return { ok: false, error: 'internal_executor_missing' };
    }
    const out = await deps.executeStrategyToolCalls(
      [{ tool, arguments: args }],
      String(context.source || 'dashboard'),
      String(context.rawMessage || ''),
    );
    const first = Array.isArray(out?.toolResults) ? out.toolResults[0] : null;
    return {
      ok: true,
      summary: String(first?.summary || (Array.isArray(out?.summaries) ? out.summaries.join('\n') : '')),
      data: first?.data || null,
      actions: Array.isArray(out?.actions) ? out.actions : [],
      adapter: 'internal',
      adapterMeta: first?.adapterMeta || null,
    };
  }

  async function invokeViaMcp(tool, args) {
    if (typeof deps.callMcpBridgeTool !== 'function') {
      return { ok: false, error: 'mcp_bridge_missing' };
    }
    return deps.callMcpBridgeTool(tool, args, {});
  }

  async function invoke(toolLike, argsLike, context = {}) {
    const tool = String(toolLike || '').trim();
    const args = normalizeArgs(argsLike);
    if (!tool) return { ok: false, error: 'tool_required' };

    const attempts = [];
    for (let i = 0; i <= retry; i += 1) {
      try {
        const runner =
          mode === 'mcp'
            ? invokeViaMcp(tool, args)
            : invokeViaInternal(tool, args, context);
        const out = await withTimeout(runner, timeoutMs, 'tool_timeout');
        if (out?.ok !== false) return out;
        attempts.push(out);
      } catch (err) {
        attempts.push({ ok: false, error: String(err?.message || err) });
      }
      if (i < retry) await sleep(220 * (i + 1));
    }

    if (mode === 'mcp' && fallbackToInternal) {
      const out = await invokeViaInternal(tool, args, context);
      if (out?.ok !== false) {
        return {
          ...out,
          adapterMeta: { ...(out.adapterMeta || {}), fallbackFrom: 'mcp' },
        };
      }
    }
    return {
      ok: false,
      error: 'tool_invoke_failed',
      attempts,
    };
  }

  return {
    mode,
    listManifest,
    invoke,
  };
}
