/**
 * Gateway lifecycle manager — manages the OpenClaw Gateway process,
 * stale lock cleanup, and log buffering.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_GATEWAY_LOG_LINES = 500;

export function createGatewayManager({ resolveOpenClawCommand, rootDir }) {
  const gatewayState = {
    proc: null,
    pid: null,
    startedAt: null,
    logs: [],
  };

  function pushGatewayLog(stream, line) {
    const parts = String(line).replace(/\r\n/g, "\n").split("\n").filter(Boolean);
    for (const part of parts) {
      gatewayState.logs.push({ ts: new Date().toISOString(), stream, line: part });
    }
    if (gatewayState.logs.length > MAX_GATEWAY_LOG_LINES) {
      gatewayState.logs.splice(0, gatewayState.logs.length - MAX_GATEWAY_LOG_LINES);
    }
  }

  function resolveGatewayLockDirPath() {
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    const suffix = uid != null ? `openclaw-${uid}` : "openclaw";
    return path.join(os.tmpdir(), suffix);
  }

  function readProcState(pid) {
    const statPath = `/proc/${pid}/stat`;
    const raw = fs.readFileSync(statPath, "utf8");
    const closeIdx = raw.lastIndexOf(")");
    if (closeIdx < 0) return "";
    const rest = raw.slice(closeIdx + 2).trim();
    if (!rest) return "";
    return String(rest.split(" ")[0] || "").trim();
  }

  function cleanupStaleGatewayLocks() {
    const lockDir = resolveGatewayLockDirPath();
    const removed = [];
    const kept = [];
    const errors = [];
    let entries = [];
    try { entries = fs.readdirSync(lockDir, { withFileTypes: true }); } catch { return { lockDir, removed, kept, errors }; }
    for (const entry of entries) {
      if (!entry || !entry.isFile()) continue;
      const name = String(entry.name || "");
      if (!/^gateway\..+\.lock$/i.test(name)) continue;
      const lockPath = path.join(lockDir, name);
      let stale = false;
      let pid = null;
      try {
        const raw = fs.readFileSync(lockPath, "utf8");
        const parsed = JSON.parse(raw);
        const pidNum = Number(parsed?.pid);
        if (Number.isFinite(pidNum) && pidNum > 1) {
          pid = pidNum;
          let state = "";
          try { state = readProcState(pidNum); } catch { state = ""; }
          if (!state || state === "Z") { stale = true; }
          else { try { process.kill(pidNum, 0); stale = false; } catch { stale = true; } }
        } else { stale = true; }
      } catch { stale = true; }
      if (!stale) { kept.push({ path: lockPath, pid }); continue; }
      try { fs.unlinkSync(lockPath); removed.push({ path: lockPath, pid }); }
      catch (error) { errors.push({ path: lockPath, error: String(error) }); }
    }
    return { lockDir, removed, kept, errors };
  }

  function gatewayIsRunning() {
    return Boolean(gatewayState.proc && gatewayState.proc.exitCode === null);
  }

  function startGateway() {
    if (gatewayIsRunning()) {
      return { started: false, message: "Gateway is already running", pid: gatewayState.pid };
    }
    const lockCleanup = cleanupStaleGatewayLocks();
    if (lockCleanup.removed.length > 0) {
      pushGatewayLog("system", `removed stale gateway locks: ${lockCleanup.removed.map((x) => path.basename(x.path)).join(", ")}`);
    }
    const resolved = resolveOpenClawCommand();
    const args = [...resolved.prefixArgs, "gateway", "run", "--allow-unconfigured", "--ws-log", "compact", "--force"];
    const child = spawn(resolved.command, args, { cwd: rootDir, env: process.env, stdio: "pipe" });
    gatewayState.proc = child;
    gatewayState.pid = child.pid ?? null;
    gatewayState.startedAt = new Date().toISOString();
    pushGatewayLog("system", `gateway start requested (pid=${gatewayState.pid ?? "unknown"})`);
    child.stdout.on("data", (chunk) => pushGatewayLog("stdout", String(chunk)));
    child.stderr.on("data", (chunk) => pushGatewayLog("stderr", String(chunk)));
    child.on("error", (error) => pushGatewayLog("system", `gateway process error: ${String(error)}`));
    child.on("close", (code, signal) => {
      pushGatewayLog("system", `gateway exited code=${code ?? "null"} signal=${signal ?? "none"}`);
      gatewayState.proc = null;
      gatewayState.pid = null;
      gatewayState.startedAt = null;
    });
    return { started: true, message: "Gateway started", pid: gatewayState.pid };
  }

  function stopGateway() {
    if (!gatewayIsRunning()) return { stopped: false, message: "Gateway is not running" };
    gatewayState.proc.kill("SIGTERM");
    pushGatewayLog("system", "gateway stop requested");
    return { stopped: true, message: "Gateway stop signal sent" };
  }

  return {
    gatewayState,
    pushGatewayLog,
    gatewayIsRunning,
    startGateway,
    stopGateway,
    cleanupStaleGatewayLocks,
  };
}
