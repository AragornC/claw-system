// Sync Pyodide runtime assets from node_modules/pyodide/ → public/pyodide/
// so Vite serves them at /pyodide/* in dev and copies them into dist/ on build.
//
// Runs automatically on `npm install` (postinstall hook). Idempotent:
// re-copies on every run so a Pyodide version bump always lands.

import { copyFile, mkdir, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const src = join(root, "node_modules", "pyodide");
const dest = join(root, "public", "pyodide");

const FILES = [
  "pyodide.asm.js",
  "pyodide.asm.wasm",
  "pyodide.js",
  "pyodide.mjs",
  "python_stdlib.zip",
  "pyodide-lock.json",
];

try {
  await access(src);
} catch {
  // pyodide not installed yet (e.g. first npm install before deps resolve) —
  // exit cleanly, postinstall will re-run after deps land.
  console.log("[sync-pyodide] pyodide not in node_modules yet, skipping");
  process.exit(0);
}

await mkdir(dest, { recursive: true });
for (const f of FILES) {
  await copyFile(join(src, f), join(dest, f));
}
console.log(`[sync-pyodide] copied ${FILES.length} files → public/pyodide/`);
