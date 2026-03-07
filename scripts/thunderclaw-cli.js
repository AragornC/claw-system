#!/usr/bin/env node
/**
 * ThunderClaw CLI
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const cmd = String(args[0] || "help").trim().toLowerCase();

function readOption(key) {
  const flag = `--${key}`;
  const flagEq = `${flag}=`;
  const inline = args.find((a) => String(a).startsWith(flagEq));
  if (inline) return String(inline).slice(flagEq.length);
  const idx = args.indexOf(flag);
  return idx >= 0 ? String(args[idx + 1] || "") : "";
}

if (cmd === "help" || cmd === "--help" || cmd === "-h") {
  console.log([
    "ThunderClaw CLI",
    "",
    "Commands:",
    "  thunderclaw start [--port 3456] [--host 127.0.0.1]",
    "  thunderclaw help",
  ].join("\n"));
} else if (cmd === "start") {
  const rawPort = readOption("port");
  const port = Number.parseInt(rawPort, 10) || 3456;
  const host = readOption("host") || process.env.THUNDERCLAW_HOST || "127.0.0.1";
  process.env.THUNDERCLAW_PORT = String(port);
  process.env.THUNDERCLAW_HOST = host;
  await import("./server/app.js").then((m) => m.startThunderClawServer({ port, host }));
} else {
  console.log("Unknown command. Use: thunderclaw help");
}
