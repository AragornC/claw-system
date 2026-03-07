#!/usr/bin/env node
/**
 * ThunderClaw Server — entry point (delegates to server/app.js)
 */
import { startThunderClawServer } from "./server/app.js";
import { fileURLToPath } from "node:url";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startThunderClawServer();
}

export { startThunderClawServer };
