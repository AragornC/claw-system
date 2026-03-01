/**
 * OpenClaw CLI wrapper — resolves the openclaw binary and provides
 * a spawn-based command runner for gateway, agent, config, and model operations.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function createOpenClawCli({ rootDir }) {
  function resolveOpenClawCommand() {
    const localBinName = process.platform === "win32" ? "openclaw.cmd" : "openclaw";
    const localBin = path.join(rootDir, "node_modules", ".bin", localBinName);
    if (fs.existsSync(localBin)) {
      return { command: localBin, prefixArgs: [], source: "local" };
    }
    return { command: "npx", prefixArgs: ["--yes", "openclaw@latest"], source: "npx" };
  }

  async function runOpenClawCommand(args, options = {}) {
    const resolved = resolveOpenClawCommand();
    const finalArgs = [...resolved.prefixArgs, ...args];
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 120_000;
    const env = { ...process.env, ...options.env };

    return await new Promise((resolve) => {
      const child = spawn(resolved.command, finalArgs, {
        cwd: rootDir,
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
        setTimeout(() => { if (!child.killed) child.kill("SIGKILL"); }, 1_000).unref();
      }, timeoutMs);

      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          ok: false, code: null, timedOut, stdout,
          stderr: `${stderr}\n${String(error)}`.trim(),
          source: resolved.source,
        });
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          ok: code === 0 && !timedOut, code, timedOut, stdout, stderr,
          source: resolved.source,
        });
      });
    });
  }

  function resolveOpenClawStateDir() {
    const explicit = String(process.env.OPENCLAW_STATE_DIR || "").trim();
    if (explicit) return path.resolve(explicit);
    const profile = String(process.env.OPENCLAW_PROFILE || "").trim();
    return path.join(os.homedir(), profile ? `.openclaw-${profile}` : ".openclaw");
  }

  function resolveOpenClawConfigPath() {
    const explicit = String(process.env.OPENCLAW_CONFIG_PATH || "").trim();
    if (explicit) return path.resolve(explicit);
    return path.join(resolveOpenClawStateDir(), "openclaw.json");
  }

  function resolveOpenClawDefaultAgentId(configLike) {
    const cfg = configLike && typeof configLike === "object" ? configLike : {};
    const candidates = [
      cfg?.agents?.defaultAgentId, cfg?.agents?.default, cfg?.agent?.default,
      cfg?.meta?.defaultAgentId, process.env.OPENCLAW_AGENT_ID,
    ].map((v) => String(v || "").trim()).filter(Boolean);
    return candidates[0] || "main";
  }

  function resolveOpenClawAgentDir(configLike) {
    const explicit = String(process.env.OPENCLAW_AGENT_DIR || process.env.PI_CODING_AGENT_DIR || "").trim();
    if (explicit) return path.resolve(explicit);
    const stateDir = resolveOpenClawStateDir();
    const agentsRoot = path.join(stateDir, "agents");
    const preferred = resolveOpenClawDefaultAgentId(configLike);
    const candidateIds = [preferred];
    if (!candidateIds.includes("main")) candidateIds.push("main");
    try {
      const discovered = fs.readdirSync(agentsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b));
      for (const id of discovered) {
        if (!candidateIds.includes(id)) candidateIds.push(id);
      }
    } catch {}
    for (const id of candidateIds) {
      const agentDir = path.join(agentsRoot, id, "agent");
      if (fs.existsSync(agentDir)) return agentDir;
    }
    return path.join(agentsRoot, preferred || "main", "agent");
  }

  function resolveOpenClawAuthStorePath(configLike) {
    return path.join(resolveOpenClawAgentDir(configLike), "auth-profiles.json");
  }

  return {
    resolveOpenClawCommand,
    runOpenClawCommand,
    resolveOpenClawStateDir,
    resolveOpenClawConfigPath,
    resolveOpenClawDefaultAgentId,
    resolveOpenClawAgentDir,
    resolveOpenClawAuthStorePath,
  };
}
