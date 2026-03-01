/**
 * Agent runtime — handles running agent turns (chat completion via OpenClaw),
 * reply extraction from agent payloads, and rule-based fallback.
 */

/**
 * Extract clean reply text from OpenClaw agent JSON payload.
 * Strips internal control fragments, prompt leakage, and formatting artifacts.
 */
export function extractAgentReply(payload) {
  function stripControlFragments(textLike) {
    const raw = String(textLike || "");
    if (!raw) return "";
    return raw.replace(/[【\[]([^】\]]{0,480})[】\]]/g, (full, inner) => {
      const body = String(inner || "").trim().toLowerCase();
      if (!body) return full;
      const hasControl =
        body.includes("assistant to=final")
        || body.includes("reply tag")
        || body.includes("no tools")
        || body.includes("consistent tone")
        || body.includes("just output")
        || body.includes("need respond")
        || body.includes("with tag")
        || body.includes("קצר");
      return hasControl ? "" : full;
    });
  }
  function isLikelyInternalControlLine(lineLike) {
    const line = String(lineLike || "").trim().toLowerCase();
    if (!line) return false;
    if (line.includes("no tools") && (line.includes("tag") || line.includes("respond") || line.includes("need"))) return true;
    let score = 0;
    if (line.includes("assistant to=final")) score += 2;
    if (line.includes("reply tag")) score += 2;
    if (line.includes("no tools")) score += 2;
    if (line.includes("need respond")) score += 2;
    if (line.includes("with tag") || line.endsWith(" tag")) score += 1;
    if (line.includes("consistent tone")) score += 1;
    if (line.includes("output.") || line.includes("just output")) score += 1;
    if (line.includes("קצר")) score += 1;
    if (line.startsWith("need ")) score += 1;
    if (line.startsWith("need just ")) score += 1;
    return score >= 3;
  }
  function sanitizeAgentReplyText(textLike) {
    const original = String(textLike || "").trim();
    const raw = stripControlFragments(original).trim();
    if (!raw) return "";
    const cleanedLines = raw.split(/\r?\n/)
      .map((line) => String(line || "").trimEnd())
      .filter((line) => !isLikelyInternalControlLine(line));
    let cleaned = stripControlFragments(cleanedLines.join("\n")).trim();
    if (!cleaned) {
      cleaned = stripControlFragments(
        original.replace(/【[^】]{0,480}(assistant to=final|reply tag|no tools|need respond|with tag|just output)[^】]{0,480}】/ig, ""),
      ).trim();
    }
    return cleaned || raw || original;
  }
  if (!payload || typeof payload !== "object") return "";
  const containers = [];
  if (payload.result && typeof payload.result === "object") containers.push(payload.result);
  containers.push(payload);
  const texts = [];
  for (const container of containers) {
    const payloads = Array.isArray(container?.payloads) ? container.payloads : [];
    for (const item of payloads) {
      if (!item || typeof item !== "object") continue;
      if (typeof item.text === "string" && item.text.trim()) { texts.push(sanitizeAgentReplyText(item.text)); continue; }
      const content = item.content;
      if (typeof content === "string" && content.trim()) { texts.push(sanitizeAgentReplyText(content)); continue; }
      if (Array.isArray(content)) {
        const joined = content.map((part) => {
          if (typeof part === "string") return part.trim();
          if (part && typeof part === "object" && typeof part.text === "string") return part.text.trim();
          return "";
        }).filter(Boolean).join("\n");
        if (joined) texts.push(sanitizeAgentReplyText(joined));
      }
    }
  }
  if (texts.length > 0) return sanitizeAgentReplyText(texts.join("\n\n"));
  if (typeof payload.summary === "string") return payload.summary;
  const nestedError = payload?.error;
  if (typeof nestedError === "string" && nestedError.trim()) return nestedError.trim();
  if (nestedError && typeof nestedError === "object" && typeof nestedError.message === "string") return nestedError.message.trim();
  return "";
}

export function buildRuleBasedAgentReply(messageLike = "") {
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

/**
 * Create agent runtime with injected dependencies.
 */
export function createAgentRuntime({
  runOpenClawCommand,
  parseJsonSafe,
  waitGatewayHealthy,
  startGateway,
  looksLikeGatewayTransportError,
  buildLocalAgentEnvFromStore,
  normalizeSessionId,
  getCurrentRuntimeModelRefFromStore,
}) {
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

  return { runAgentTurn };
}
