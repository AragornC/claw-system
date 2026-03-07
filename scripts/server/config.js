/**
 * ThunderClaw Server Configuration
 *
 * All paths, constants, and environment-derived config in one place.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT_DIR = path.resolve(__dirname, "..", "..");
export const WEB_DIR = ""; // No separate web dir — frontend served from REPORT_DIR
export const REPORT_DIR = path.resolve(ROOT_DIR, "memory", "report");
export const MEMORY_DIR = path.resolve(ROOT_DIR, "memory");
export const XBRAIN_STATE_PATH = path.join(MEMORY_DIR, "xbrain-state.json");
export const CHAT_HISTORY_PATH = path.join(MEMORY_DIR, "chat-history.json");
export const STRATEGY_LAB_STATE_PATH = path.join(MEMORY_DIR, "strategy-lab.json");
export const DEFAULT_PORT = Number.parseInt(process.env.THUNDERCLAW_PORT ?? "3456", 10) || 3456;
export const MAX_CHAT_EVENTS = 2_000;
