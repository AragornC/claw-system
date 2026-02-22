#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const cmd = String(args[0] || "help").trim().toLowerCase();

function printHelp() {
  console.log(
    [
      "ThunderClaw CLI (OpenClaw 启动版)",
      "",
      "可用命令:",
      "  thunderclaw help",
      "  thunderclaw start [--port 3456]",
      "  thunderclaw status",
      "  thunderclaw assets",
      "  thunderclaw idea",
      "",
      "说明:",
      "  start: 启动 ThunderClaw 本地控制台（/ 默认旧功能页，虾脑内含模型注册中心）。",
      "  status: 检查 OpenClaw CLI 是否已就绪。",
    ].join("\n"),
  );
}

if (cmd === "help" || cmd === "--help" || cmd === "-h") {
  printHelp();
  process.exit(0);
} else if (cmd === "start") {
  const portFlag = args.find((arg) => String(arg).startsWith("--port="));
  const idx = args.indexOf("--port");
  const rawPort = portFlag
    ? String(portFlag).slice("--port=".length)
    : idx >= 0
      ? String(args[idx + 1] || "")
      : "";
  const parsedPort = Number.parseInt(rawPort, 10);
  const port = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 3456;
  const { startThunderClawServer } = await import("./thunderclaw-server.js");
  startThunderClawServer({ port, host: "127.0.0.1" });
} else if (cmd === "status") {
  const bin = path.resolve(
    root,
    "node_modules/.bin",
    process.platform === "win32" ? "openclaw.cmd" : "openclaw",
  );
  const version = spawnSync(bin, ["--version"], { encoding: "utf8" });
  if (version.status === 0) {
    console.log(`OpenClaw: ${String(version.stdout || "").trim()}`);
    console.log("状态: 可用");
    process.exit(0);
  }
  console.log("OpenClaw: 未就绪");
  console.log(String(version.stderr || version.stdout || "").trim() || "请先执行 npm install");
  process.exit(1);
} else if (cmd === "assets") {
  console.log(path.resolve(root, "memory/report/index.html"));
  console.log(path.resolve(root, "memory/report/app-icon.svg"));
  console.log(path.resolve(root, "memory/report/app-icon-maskable.svg"));
  process.exit(0);
} else if (cmd === "idea") {
  console.log(path.resolve(root, "THUNDERCLAW_PRODUCT_IDEA.md"));
  process.exit(0);
} else {
  printHelp();
}
