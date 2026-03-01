/**
 * Agent runtime — handles running agent turns (chat completion via OpenClaw),
 * reply extraction, and rule-based fallback.
 */

export function createAgentRuntime({
  runOpenClawCommand,
  parseJsonSafe,
  extractAgentReply,
  waitGatewayHealthy,
  startGateway,
  looksLikeGatewayTransportError,
  buildLocalAgentEnvFromStore,
  normalizeSessionId,
  getCurrentRuntimeModelRefFromStore,
}) {
  function buildRuleBasedAgentReply(messageLike = "") {
    const text = String(messageLike || "").trim();
    if (!text) return "收到。";
    const lower = text.toLowerCase();
    const hasTrade = lower.includes("btc") || lower.includes("eth") || lower.includes("策略")
      || lower.includes("止损") || lower.includes("止盈");
    if (hasTrade) {
      return "建议先从低风险回测开始：定义入场条件、止损1%-2%、止盈2%-4%、单笔风险不超过总资金1%。";
    }
    return "收到，当前外部模型暂不可用，已切换本地规则回复。";
  }

  async function runAgentTurn(params) {
    const message = String(params?.message ?? "").trim();
    const sessionIdRaw = String(params?.sessionId ?? "thunderclaw-main").trim() || "thunderclaw-main";
    const preferredModelRef = String(params?.modelRef || "").trim() || getCurrentRuntimeModelRefFromStore();
    const sessionId = normalizeSessionId(sessionIdRaw);
    const thinking = String(params?.thinking ?? "").trim();
    const modelSet = { attempted: false, ok: null, error: null, modelRef: preferredModelRef };
    const args = ["agent", "--session-id", sessionId, "--message", message, "--json"];
    if (thinking) args.push("--thinking", thinking);

    const gatewayBeforeRun = await waitGatewayHealthy({ timeoutMs: 4_000, pollMs: 700 }).catch(() => ({ ok: false }));
    if (!gatewayBeforeRun?.ok) {
      startGateway();
      await waitGatewayHealthy({ timeoutMs: 20_000, pollMs: 1_000 }).catch(() => null);
    }

    let result = await runOpenClawCommand(args, { timeoutMs: 180_000 });
    if (!result.ok) {
      const errText = [result.stderr, result.stdout].filter(Boolean).join("\n");
      if (looksLikeGatewayTransportError(errText)) {
        startGateway();
        await waitGatewayHealthy({ timeoutMs: 15_000, pollMs: 1000 }).catch(() => null);
        result = await runOpenClawCommand(args, { timeoutMs: 180_000 });
      }
    }
    if (!result.ok) {
      const localArgs = [...args, "--local"];
      result = await runOpenClawCommand(localArgs, { timeoutMs: 180_000, env: buildLocalAgentEnvFromStore() });
    }

    const payload = parseJsonSafe(result.stdout);
    let reply = extractAgentReply(payload);
    if (!reply) {
      const errText = String(result.stderr || "").trim();
      const errLine = errText.split(/\r?\n/)
        .find((line) => /HTTP\s+\d{3}|authentication|api key|gateway closed|connection error/i.test(String(line || "")));
      if (errLine) reply = errLine;
    }
    if (!result.ok) {
      reply = buildRuleBasedAgentReply(message);
      result = { ok: true, code: 0, timedOut: false, stdout: result.stdout, stderr: result.stderr, source: "rule_fallback" };
    }
    if (!reply) reply = "收到，但暂时没有可返回内容。";

    return { result, payload, reply, sessionId, modelRef: preferredModelRef, modelSet };
  }

  return { runAgentTurn, buildRuleBasedAgentReply };
}
