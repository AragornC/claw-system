#!/usr/bin/env node
/**
 * ThunderClaw Boot — starts the server.
 */
import { startThunderClawServer } from "./app.js";

const port = Number.parseInt(process.env.THUNDERCLAW_PORT || "3456", 10) || 3456;
const host = String(process.env.THUNDERCLAW_HOST || "127.0.0.1").trim() || "127.0.0.1";
startThunderClawServer({ port, host });
