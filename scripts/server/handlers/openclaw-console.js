function openclawErrorText(result) {
  return (result?.stderr || result?.stdout || "").trim() || "openclaw command failed";
}

function parseJsonOrText(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function ensureConfigPath(configPathLike) {
  const configPath = String(configPathLike || "").trim();
  if (!configPath) {
    throw new Error("配置路径不能为空");
  }
  if (configPath.length > 220) {
    throw new Error("配置路径过长");
  }
  if (!/^[a-zA-Z0-9_\-.[\]]+$/.test(configPath)) {
    throw new Error("配置路径格式非法");
  }
  return configPath;
}

export function createOpenClawConsoleHandlers(deps = {}) {
  const runOpenClawCommand = deps.runOpenClawCommand;
  const parseJsonSafe = deps.parseJsonSafe;
  const readJsonBody = deps.readJsonBody;
  const sendJson = deps.sendJson;
  const getGatewayLogs = deps.getGatewayLogs;

  if (typeof runOpenClawCommand !== "function") throw new Error("runOpenClawCommand is required");
  if (typeof parseJsonSafe !== "function") throw new Error("parseJsonSafe is required");
  if (typeof readJsonBody !== "function") throw new Error("readJsonBody is required");
  if (typeof sendJson !== "function") throw new Error("sendJson is required");
  if (typeof getGatewayLogs !== "function") throw new Error("getGatewayLogs is required");

  async function handleOpenClawConsoleStatus(req, res) {
    const versionRes = await runOpenClawCommand(["--version"], { timeoutMs: 20_000 });
    const gatewayHealthRes = await runOpenClawCommand(["gateway", "health", "--json"], { timeoutMs: 10_000 });
    const cronStatusRes = await runOpenClawCommand(["cron", "status", "--json"], { timeoutMs: 10_000 });
    const cronListRes = await runOpenClawCommand(["cron", "list", "--all", "--json"], { timeoutMs: 12_000 });
    const gatewayHealth = parseJsonSafe(gatewayHealthRes.stdout);
    const cronStatus = parseJsonSafe(cronStatusRes.stdout);
    const cronList = parseJsonSafe(cronListRes.stdout);
    sendJson(res, 200, {
      ok: true,
      openclaw: {
        available: Boolean(versionRes.ok),
        version: String(versionRes.stdout || versionRes.stderr || "").trim(),
        source: versionRes.source,
      },
      gateway: {
        healthy: Boolean(gatewayHealthRes.ok),
        health: gatewayHealth,
        error: gatewayHealthRes.ok ? null : openclawErrorText(gatewayHealthRes),
        logsTail: getGatewayLogs().slice(-80),
      },
      cron: {
        statusOk: Boolean(cronStatusRes.ok),
        listOk: Boolean(cronListRes.ok),
        status: cronStatus,
        jobs: Array.isArray(cronList?.jobs) ? cronList.jobs : [],
        statusError: cronStatusRes.ok ? null : openclawErrorText(cronStatusRes),
        listError: cronListRes.ok ? null : openclawErrorText(cronListRes),
      },
    });
  }

  async function handleOpenClawCronList(req, res) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const includeDisabled = String(url.searchParams.get("all") || "1") !== "0";
    const args = ["cron", "list"];
    if (includeDisabled) args.push("--all");
    args.push("--json");
    const result = await runOpenClawCommand(args, { timeoutMs: 15_000 });
    if (!result.ok) {
      sendJson(res, 500, { ok: false, error: openclawErrorText(result) });
      return;
    }
    const payload = parseJsonSafe(result.stdout);
    sendJson(res, 200, {
      ok: true,
      jobs: Array.isArray(payload?.jobs) ? payload.jobs : [],
    });
  }

  async function handleOpenClawCronAdd(req, res) {
    const body = await readJsonBody(req);
    const name = String(body.name || "").trim() || `thunderclaw-${Date.now()}`;
    const every = String(body.every || "").trim();
    const message = String(body.message || "").trim();
    const session = String(body.session || "").trim();
    const channel = String(body.channel || "").trim();
    if (!every) {
      sendJson(res, 400, { ok: false, error: "every is required" });
      return;
    }
    if (!message) {
      sendJson(res, 400, { ok: false, error: "message is required" });
      return;
    }
    const args = [
      "cron",
      "add",
      "--name",
      name,
      "--every",
      every,
      "--message",
      message,
      "--json",
    ];
    if (body.disabled === true) args.push("--disabled");
    if (session === "main" || session === "isolated") {
      args.push("--session", session);
    }
    if (channel) {
      args.push("--channel", channel);
    }
    const result = await runOpenClawCommand(args, { timeoutMs: 25_000 });
    if (!result.ok) {
      sendJson(res, 500, { ok: false, error: openclawErrorText(result) });
      return;
    }
    const payload = parseJsonSafe(result.stdout);
    sendJson(res, 200, {
      ok: true,
      job: payload && typeof payload === "object" ? payload : null,
    });
  }

  async function handleOpenClawCronRemove(req, res) {
    const body = await readJsonBody(req);
    const id = String(body.id || "").trim();
    if (!id) {
      sendJson(res, 400, { ok: false, error: "id is required" });
      return;
    }
    const result = await runOpenClawCommand(["cron", "rm", id, "--json"], { timeoutMs: 20_000 });
    if (!result.ok) {
      sendJson(res, 500, { ok: false, error: openclawErrorText(result) });
      return;
    }
    const payload = parseJsonSafe(result.stdout);
    sendJson(res, 200, {
      ok: true,
      removed: Boolean(payload?.removed),
      raw: payload,
    });
  }

  async function handleOpenClawCronToggle(req, res) {
    const body = await readJsonBody(req);
    const id = String(body.id || "").trim();
    const enabled = body.enabled !== false;
    if (!id) {
      sendJson(res, 400, { ok: false, error: "id is required" });
      return;
    }
    const cmd = enabled ? "enable" : "disable";
    const result = await runOpenClawCommand(["cron", cmd, id], { timeoutMs: 20_000 });
    if (!result.ok) {
      sendJson(res, 500, { ok: false, error: openclawErrorText(result) });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      id,
      enabled,
    });
  }

  async function handleOpenClawConfigGet(req, res) {
    const body = await readJsonBody(req);
    let configPath;
    try {
      configPath = ensureConfigPath(body.path);
    } catch (error) {
      sendJson(res, 400, { ok: false, error: String(error?.message || error) });
      return;
    }
    const result = await runOpenClawCommand(["config", "get", configPath, "--json"], { timeoutMs: 15_000 });
    if (!result.ok) {
      sendJson(res, 400, { ok: false, error: openclawErrorText(result) });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      path: configPath,
      value: parseJsonOrText(result.stdout),
      raw: String(result.stdout || "").trim(),
    });
  }

  async function handleOpenClawConfigSet(req, res) {
    const body = await readJsonBody(req);
    let configPath;
    try {
      configPath = ensureConfigPath(body.path);
    } catch (error) {
      sendJson(res, 400, { ok: false, error: String(error?.message || error) });
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(body, "value")) {
      sendJson(res, 400, { ok: false, error: "value is required" });
      return;
    }
    const encodedValue = JSON.stringify(body.value);
    const result = await runOpenClawCommand(
      ["config", "set", configPath, encodedValue, "--strict-json"],
      { timeoutMs: 25_000 },
    );
    if (!result.ok) {
      sendJson(res, 500, { ok: false, error: openclawErrorText(result) });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      path: configPath,
      value: body.value,
      output: String(result.stdout || "").trim(),
    });
  }

  async function handleOpenClawConfigUnset(req, res) {
    const body = await readJsonBody(req);
    let configPath;
    try {
      configPath = ensureConfigPath(body.path);
    } catch (error) {
      sendJson(res, 400, { ok: false, error: String(error?.message || error) });
      return;
    }
    const result = await runOpenClawCommand(["config", "unset", configPath], { timeoutMs: 20_000 });
    if (!result.ok) {
      sendJson(res, 500, { ok: false, error: openclawErrorText(result) });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      path: configPath,
      output: String(result.stdout || "").trim(),
    });
  }

  return {
    handleOpenClawConsoleStatus,
    handleOpenClawCronList,
    handleOpenClawCronAdd,
    handleOpenClawCronRemove,
    handleOpenClawCronToggle,
    handleOpenClawConfigGet,
    handleOpenClawConfigSet,
    handleOpenClawConfigUnset,
  };
}
