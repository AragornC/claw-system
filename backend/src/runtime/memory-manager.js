import fs from 'node:fs';
import path from 'node:path';

function tokenize(textLike) {
  return String(textLike || '')
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/i)
    .map((x) => x.trim())
    .filter(Boolean);
}

function scoreText(queryTokens, textLike) {
  const body = String(textLike || '').toLowerCase();
  if (!body) return 0;
  let hit = 0;
  for (const t of queryTokens) {
    if (body.includes(t)) hit += 1;
  }
  return hit / Math.max(1, queryTokens.length);
}

function readFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function toLineSnippet(text, maxLines = 8) {
  return String(text || '')
    .split(/\r?\n/)
    .filter((x) => String(x || '').trim().length > 0)
    .slice(0, maxLines)
    .join('\n');
}

export function createMemoryManager(options = {}) {
  const workspaceDir = path.resolve(String(options.workspaceDir || process.cwd()));
  const memoryDir = path.resolve(workspaceDir, 'memory');
  const longMemoryPath = path.resolve(workspaceDir, 'MEMORY.md');
  const shortMemoryProvider =
    typeof options.buildLayeredMemoryBundle === 'function' ? options.buildLayeredMemoryBundle : null;

  function buildBundle(queryText) {
    if (!shortMemoryProvider) return {};
    try {
      return shortMemoryProvider(String(queryText || ''));
    } catch {
      return {};
    }
  }

  function listMemoryFiles() {
    const out = [];
    if (fs.existsSync(longMemoryPath)) out.push(longMemoryPath);
    try {
      const rows = fs.readdirSync(memoryDir, { withFileTypes: true });
      for (const row of rows) {
        if (!row.isFile()) continue;
        if (!/\.md$/i.test(row.name)) continue;
        out.push(path.resolve(memoryDir, row.name));
      }
    } catch {}
    return out;
  }

  function search(queryText, optionsLike = {}) {
    const q = String(queryText || '').trim();
    if (!q) return [];
    const maxResults = Math.max(1, Math.min(30, Number(optionsLike.maxResults || 8) || 8));
    const minScore = Math.max(0, Math.min(1, Number(optionsLike.minScore || 0.12) || 0.12));
    const tokens = tokenize(q);
    const files = listMemoryFiles();
    const hits = [];
    for (const filePath of files) {
      const rel = path.relative(workspaceDir, filePath) || path.basename(filePath);
      const text = readFileSafe(filePath);
      if (!text) continue;
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        const s = scoreText(tokens, line);
        if (s < minScore) continue;
        hits.push({
          path: rel,
          score: Number(s.toFixed(3)),
          startLine: i + 1,
          endLine: i + 1,
          snippet: toLineSnippet(lines.slice(Math.max(0, i - 2), i + 3).join('\n'), 5),
        });
      }
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, maxResults);
  }

  function get(relPathLike, fromLike, linesLike) {
    const relPath = String(relPathLike || '').trim();
    if (!relPath) {
      return { path: '', text: '', error: 'path_required' };
    }
    const fullPath = path.resolve(workspaceDir, relPath);
    if (!fullPath.startsWith(workspaceDir)) {
      return { path: relPath, text: '', error: 'path_forbidden' };
    }
    const text = readFileSafe(fullPath);
    if (!text) return { path: relPath, text: '' };
    const rows = text.split(/\r?\n/);
    const from = Math.max(1, Number(fromLike || 1) || 1);
    const count = Math.max(1, Math.min(400, Number(linesLike || rows.length) || rows.length));
    const start = from - 1;
    return {
      path: relPath,
      text: rows.slice(start, start + count).join('\n'),
    };
  }

  return {
    buildBundle,
    search,
    get,
    listMemoryFiles,
  };
}
