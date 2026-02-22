#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const WEB_DIR = path.resolve(ROOT_DIR, "web");
const DEFAULT_PORT = Number.parseInt(process.env.THUNDERCLAW_PORT ?? "3456", 10) || 3456;
const MAX_BODY_BYTES = 1_000_000;
const MAX_GATEWAY_LOG_LINES = 500;

const gatewayState = {
  proc: null,
  pid: null,
  startedAt: null,
  logs: [],
};

function resolveOpenClawCommand() {
  const localBinName = process.platform === "win32" ? "openclaw.cmd" : "openclaw";
  const localBin = path.join(ROOT_DIR, "node_modules", ".bin", localBinName);
  if (fs.existsSync(localBin)) {
    return {
      command: localBin,
      prefixArgs: [],
      source: "local",
    };
  }
  return {
    command: "npx",
    prefixArgs: ["--yes", "openclaw@latest"],
    source: "npx",
  };
}

function parseJsonSafe(text) {
  if (typeof text !== "string") {
    return null;
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      const maybeJson = trimmed.slice(start, end + 1);
      try {
        return JSON.parse(maybeJson);
      } catch {
        return null;
      }
    }
    return null;
  }
}

function pushGatewayLog(stream, line) {
  const parts = String(line)
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter(Boolean);
  for (const part of parts) {
    gatewayState.logs.push({
      ts: new Date().toISOString(),
      stream,
      line: part,
    });
  }
  if (gatewayState.logs.length > MAX_GATEWAY_LOG_LINES) {
    gatewayState.logs.splice(0, gatewayState.logs.length - MAX_GATEWAY_LOG_LINES);
  }
}

async function runOpenClawCommand(args, options = {}) {
  const resolved = resolveOpenClawCommand();
  const finalArgs = [...resolved.prefixArgs, ...args];
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 120_000;
  const env = {
    ...process.env,
    ...options.env,
  };

  return await new Promise((resolve) => {
    const child = spawn(resolved.command, finalArgs, {
      cwd: ROOT_DIR,
      env,
      stdio: "pipe",
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      }, 1_000).unref();
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        code: null,
        timedOut,
        stdout,
        stderr: `${stderr}\n${String(error)}`.trim(),
        source: resolved.source,
      });
    });

    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0 && !timedOut,
        code,
        timedOut,
        stdout,
        stderr,
        source: resolved.source,
      });
    });
  });
}

function extractAgentReply(payload) {
  if (!payload || typeof payload !== "object") {
    return "";
  }
  const result = payload.result;
  if (!result || typeof result !== "object") {
    const summary = payload.summary;
    return typeof summary === "string" ? summary : "";
  }
  const payloads = Array.isArray(result.payloads) ? result.payloads : [];
  const texts = [];
  for (const item of payloads) {
    if (!item || typeof item !== "object") {
      continue;
    }
    if (typeof item.text === "string" && item.text.trim()) {
      texts.push(item.text.trim());
    }
  }
  if (texts.length > 0) {
    return texts.join("\n\n");
  }
  if (typeof payload.summary === "string") {
    return payload.summary;
  }
  return "";
}

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function guessContentType(filePath) {
  if (filePath.endsWith(".html")) {
    return "text/html; charset=utf-8";
  }
  if (filePath.endsWith(".js")) {
    return "application/javascript; charset=utf-8";
  }
  if (filePath.endsWith(".css")) {
    return "text/css; charset=utf-8";
  }
  if (filePath.endsWith(".svg")) {
    return "image/svg+xml";
  }
  if (filePath.endsWith(".json")) {
    return "application/json; charset=utf-8";
  }
  return "application/octet-stream";
}

async function serveStatic(req, res) {
  const rawUrl = new URL(req.url ?? "/", "http://localhost");
  let pathname = decodeURIComponent(rawUrl.pathname);
  if (pathname === "/") {
    pathname = "/index.html";
  }

  const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const targetPath = path.join(WEB_DIR, safePath);

  if (!targetPath.startsWith(WEB_DIR)) {
    sendJson(res, 400, { ok: false, error: "Invalid path" });
    return;
  }

  try {
    const stat = await fsp.stat(targetPath);
    if (!stat.isFile()) {
      sendJson(res, 404, { ok: false, error: "Not found" });
      return;
    }
    const content = await fsp.readFile(targetPath);
    res.writeHead(200, {
      "Content-Type": guessContentType(targetPath),
      "Cache-Control": "no-store",
    });
    res.end(content);
  } catch {
    sendJson(res, 404, { ok: false, error: "Not found" });
  }
}

async function readJsonBody(req) {
  return await new Promise((resolve, reject) => {
    let raw = "";
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      raw += String(chunk);
    });
    req.on("end", () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", (error) => {
      reject(error);
    });
  });
}

function gatewayIsRunning() {
  return Boolean(gatewayState.proc && gatewayState.proc.exitCode === null);
}

function startGateway() {
  if (gatewayIsRunning()) {
    return {
      started: false,
      message: "Gateway is already running",
      pid: gatewayState.pid,
    };
  }

  const resolved = resolveOpenClawCommand();
  const args = [...resolved.prefixArgs, "gateway", "run", "--allow-unconfigured", "--ws-log", "compact"];
  const child = spawn(resolved.command, args, {
    cwd: ROOT_DIR,
    env: process.env,
    stdio: "pipe",
  });

  gatewayState.proc = child;
  gatewayState.pid = child.pid ?? null;
  gatewayState.startedAt = new Date().toISOString();
  pushGatewayLog("system", `gateway start requested (pid=${gatewayState.pid ?? "unknown"})`);

  child.stdout.on("data", (chunk) => {
    pushGatewayLog("stdout", String(chunk));
  });

  child.stderr.on("data", (chunk) => {
    pushGatewayLog("stderr", String(chunk));
  });

  child.on("error", (error) => {
    pushGatewayLog("system", `gateway process error: ${String(error)}`);
  });

  child.on("close", (code, signal) => {
    pushGatewayLog("system", `gateway exited code=${code ?? "null"} signal=${signal ?? "none"}`);
    gatewayState.proc = null;
    gatewayState.pid = null;
    gatewayState.startedAt = null;
  });

  return {
    started: true,
    message: "Gateway started",
    pid: gatewayState.pid,
  };
}

function stopGateway() {
  if (!gatewayIsRunning()) {
    return {
      stopped: false,
      message: "Gateway is not running",
    };
  }
  gatewayState.proc.kill("SIGTERM");
  pushGatewayLog("system", "gateway stop requested");
  return {
    stopped: true,
    message: "Gateway stop signal sent",
  };
}

async function handleStatus(req, res) {
  const versionRes = await runOpenClawCommand(["--version"], { timeoutMs: 20_000 });
  const versionText = versionRes.stdout.trim() || versionRes.stderr.trim();

  const stateDir = path.join(os.homedir(), ".openclaw");
  const configPath = path.join(stateDir, "config.json");
  const configExists = fs.existsSync(configPath);

  const healthRes = await runOpenClawCommand(["gateway", "health", "--json"], { timeoutMs: 8_000 });
  const healthJson = parseJsonSafe(healthRes.stdout);

  const modelsRes = await runOpenClawCommand(["models", "status", "--json"], {
    timeoutMs: 15_000,
  });
  const modelsJson = parseJsonSafe(modelsRes.stdout);

  sendJson(res, 200, {
    ok: true,
    openclaw: {
      available: versionRes.ok,
      version: versionText,
      source: versionRes.source,
    },
    config: {
      path: configPath,
      exists: configExists,
    },
    gateway: {
      managedByThunderClaw: gatewayIsRunning(),
      pid: gatewayState.pid,
      startedAt: gatewayState.startedAt,
      healthy: healthRes.ok,
      health: healthJson,
      healthError: healthRes.ok ? null : (healthRes.stderr || healthRes.stdout || "").trim() || null,
      logsTail: gatewayState.logs.slice(-60),
    },
    models: {
      ok: modelsRes.ok,
      status: modelsJson,
      error: modelsRes.ok ? null : (modelsRes.stderr || modelsRes.stdout || "").trim() || null,
    },
  });
}

function providerToAuthConfig(provider) {
  const map = {
    "openai-api-key": {
      authChoice: "openai-api-key",
      flag: "--openai-api-key",
    },
    "anthropic-api-key": {
      authChoice: "apiKey",
      flag: "--anthropic-api-key",
    },
    "openrouter-api-key": {
      authChoice: "openrouter-api-key",
      flag: "--openrouter-api-key",
    },
    "gemini-api-key": {
      authChoice: "gemini-api-key",
      flag: "--gemini-api-key",
    },
    "zai-api-key": {
      authChoice: "zai-api-key",
      flag: "--zai-api-key",
    },
  };
  return map[provider] ?? null;
}

async function handleSetup(req, res) {
  const body = await readJsonBody(req);
  const provider = String(body.provider ?? "").trim();
  const apiKey = String(body.apiKey ?? "").trim();
  const gatewayPort = Number.parseInt(String(body.gatewayPort ?? "18789"), 10) || 18789;
  const gatewayAuth = String(body.gatewayAuth ?? "token").trim() === "password" ? "password" : "token";
  const providerConfig = providerToAuthConfig(provider);

  if (!providerConfig) {
    sendJson(res, 400, { ok: false, error: "Unsupported provider" });
    return;
  }
  if (!apiKey) {
    sendJson(res, 400, { ok: false, error: "API Key is required" });
    return;
  }

  const args = [
    "onboard",
    "--non-interactive",
    "--accept-risk",
    "--mode",
    "local",
    "--flow",
    "quickstart",
    "--skip-channels",
    "--skip-skills",
    "--skip-health",
    "--skip-ui",
    "--gateway-bind",
    "loopback",
    "--gateway-auth",
    gatewayAuth,
    "--gateway-port",
    String(gatewayPort),
    "--auth-choice",
    providerConfig.authChoice,
    providerConfig.flag,
    apiKey,
  ];

  const result = await runOpenClawCommand(args, { timeoutMs: 240_000 });
  sendJson(res, result.ok ? 200 : 500, {
    ok: result.ok,
    command: [
      "openclaw",
      ...args.slice(0, -1),
      "***",
    ].join(" "),
    exitCode: result.code,
    timedOut: result.timedOut,
    stdout: result.stdout,
    stderr: result.stderr,
  });
}

async function handleSetModel(req, res) {
  const body = await readJsonBody(req);
  const model = String(body.model ?? "").trim();
  if (!model) {
    sendJson(res, 400, { ok: false, error: "model is required" });
    return;
  }
  const result = await runOpenClawCommand(["models", "set", model], { timeoutMs: 30_000 });
  sendJson(res, result.ok ? 200 : 500, {
    ok: result.ok,
    exitCode: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
  });
}

async function handleChat(req, res) {
  const body = await readJsonBody(req);
  const message = String(body.message ?? "").trim();
  const sessionId = String(body.sessionId ?? "thunderclaw-main").trim() || "thunderclaw-main";
  const thinking = String(body.thinking ?? "").trim();

  if (!message) {
    sendJson(res, 400, { ok: false, error: "message is required" });
    return;
  }

  const args = [
    "agent",
    "--session-id",
    sessionId,
    "--message",
    message,
    "--json",
  ];
  if (thinking) {
    args.push("--thinking", thinking);
  }

  const result = await runOpenClawCommand(args, { timeoutMs: 180_000 });
  const payload = parseJsonSafe(result.stdout);
  const reply = extractAgentReply(payload);

  sendJson(res, result.ok ? 200 : 500, {
    ok: result.ok,
    exitCode: result.code,
    timedOut: result.timedOut,
    reply,
    payload,
    stdout: result.stdout,
    stderr: result.stderr,
  });
}

async function requestHandler(req, res) {
  try {
    const method = req.method ?? "GET";
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;

    if (method === "GET" && pathname === "/api/status") {
      await handleStatus(req, res);
      return;
    }
    if (method === "POST" && pathname === "/api/setup") {
      await handleSetup(req, res);
      return;
    }
    if (method === "POST" && pathname === "/api/models/set") {
      await handleSetModel(req, res);
      return;
    }
    if (method === "POST" && pathname === "/api/gateway/start") {
      sendJson(res, 200, { ok: true, ...startGateway() });
      return;
    }
    if (method === "POST" && pathname === "/api/gateway/stop") {
      sendJson(res, 200, { ok: true, ...stopGateway() });
      return;
    }
    if (method === "GET" && pathname === "/api/gateway/logs") {
      sendJson(res, 200, { ok: true, logs: gatewayState.logs });
      return;
    }
    if (method === "POST" && pathname === "/api/chat") {
      await handleChat(req, res);
      return;
    }

    await serveStatic(req, res);
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      error: String(error),
    });
  }
}

export function startThunderClawServer(options = {}) {
  const port = Number.parseInt(String(options.port ?? DEFAULT_PORT), 10) || DEFAULT_PORT;
  const host = String(options.host ?? "127.0.0.1");
  const server = http.createServer((req, res) => {
    void requestHandler(req, res);
  });
  server.listen(port, host, () => {
    console.log(`ThunderClaw server running at http://${host}:${port}`);
    console.log("Open the page to configure OpenClaw and start chatting.");
  });
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startThunderClawServer();
}
