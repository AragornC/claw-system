/**
 * Shared HTTP helper functions for the ThunderClaw server.
 */
import fsp from "node:fs/promises";
import path from "node:path";

const MAX_BODY_BYTES = 1_000_000;

export function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

export async function readJsonBody(req) {
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
    req.on("error", (error) => reject(error));
  });
}

export function guessContentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  if (filePath.endsWith(".webp")) return "image/webp";
  if (filePath.endsWith(".png")) return "image/png";
  if (filePath.endsWith(".jpg") || filePath.endsWith(".jpeg")) return "image/jpeg";
  if (filePath.endsWith(".gif")) return "image/gif";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

export function createStaticFileServer({ reportDir, webDir }) {
  return async function serveStatic(req, res) {
    const rawUrl = new URL(req.url ?? "/", "http://localhost");
    const pathname = decodeURIComponent(rawUrl.pathname);
    const candidates = [];
    if (pathname === "/") {
      candidates.push(path.join(reportDir, "index.html"));
    } else {
      const safePath = path
        .normalize(pathname)
        .replace(/^([/\\])+/, "")
        .replace(/^(\.\.[/\\])+/, "");
      candidates.push(path.join(reportDir, safePath), path.join(webDir, safePath));
    }
    for (const targetPath of candidates) {
      const isInReport = targetPath.startsWith(reportDir);
      const isInWeb = targetPath.startsWith(webDir);
      if (!isInReport && !isInWeb) continue;
      try {
        const stat = await fsp.stat(targetPath);
        if (!stat.isFile()) continue;
        const content = await fsp.readFile(targetPath);
        res.writeHead(200, {
          "Content-Type": guessContentType(targetPath),
          "Cache-Control": "no-store",
        });
        res.end(content);
        return;
      } catch {}
    }
    sendJson(res, 404, { ok: false, error: "Not found" });
  };
}
