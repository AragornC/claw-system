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
  if (!body || !queryTokens.length) return 0;
  let hit = 0;
  for (const token of queryTokens) {
    if (body.includes(token)) hit += 1;
  }
  return hit / queryTokens.length;
}

function readFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function toSnippet(lines, idx) {
  return lines
    .slice(Math.max(0, idx - 2), idx + 3)
    .map((x) => String(x || '').trimEnd())
    .filter((x) => x.trim().length > 0)
    .join('\n')
    .slice(0, 800);
}

export function createMemoryManager(options = {}) {
  const workspaceDir = path.resolve(String(options.workspaceDir || options.workdir || process.cwd()));
  const memoryDir = path.resolve(workspaceDir, 'memory');
  const longMemoryPath = path.resolve(workspaceDir, 'MEMORY.md');
  const shortMemoryProvider =
    typeof options.buildLayeredMemoryBundle === 'function' ? options.buildLayeredMemoryBundle : null;

  function listMemoryFiles() {
    const out = [];
    if (fs.existsSync(longMemoryPath)) out.push(longMemoryPath);
    try {
      const rows = fs.readdirSync(memoryDir, { withFileTypes: true });
      for (const row of rows) {
        if (!row.isFile()) continue;
        if (!/\.(md|txt|jsonl?)$/i.test(row.name)) continue;
        out.push(path.resolve(memoryDir, row.name));
      }
    } catch {}
    return out;
  }

  function search(queryText, optionsLike = {}) {
    const q = String(queryText || '').trim();
    if (!q) return [];
    const maxResults = Math.max(1, Math.min(60, Number(optionsLike.maxResults || optionsLike.limit || 8) || 8));
    const minScore = Math.max(0, Math.min(1, Number(optionsLike.minScore || 0.12) || 0.12));
    const queryTokens = tokenize(q);
    if (!queryTokens.length) return [];

    const hits = [];
    for (const filePath of listMemoryFiles()) {
      const rel = path.relative(workspaceDir, filePath) || path.basename(filePath);
      const text = readFileSafe(filePath);
      if (!text) continue;
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        const score = scoreText(queryTokens, lines[i]);
        if (score < minScore) continue;
        hits.push({
          path: rel,
          score: Number(score.toFixed(3)),
          startLine: i + 1,
          endLine: i + 1,
          snippet: toSnippet(lines, i),
        });
      }
    }

    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, maxResults);
  }

  function get(relPathLike, fromLike = 1, linesLike = 120) {
    const relPath = String(relPathLike || '').trim();
    if (!relPath) return { path: '', text: '', error: 'path_required' };
    const fullPath = path.resolve(workspaceDir, relPath);
    if (!fullPath.startsWith(workspaceDir)) {
      return { path: relPath, text: '', error: 'path_forbidden' };
    }
    const text = readFileSafe(fullPath);
    if (!text) return { path: relPath, text: '' };
    const rows = text.split(/\r?\n/);
    const from = Math.max(1, Number(fromLike || 1) || 1);
    const count = Math.max(1, Math.min(600, Number(linesLike || rows.length) || rows.length));
    const start = from - 1;
    return {
      path: relPath,
      text: rows.slice(start, start + count).join('\n'),
    };
  }

  function buildBundle(queryText) {
    const query = String(queryText || '');
    let layered = {};
    if (shortMemoryProvider) {
      try {
        layered = shortMemoryProvider(query) || {};
      } catch {
        layered = {};
      }
    }
    const relatedMemories = search(query, { maxResults: 8, minScore: 0.1 });
    return {
      ...layered,
      relatedMemories,
      query,
      generatedAt: new Date().toISOString(),
    };
  }

  return {
    listMemoryFiles,
    search,
    get,
    buildBundle,
    buildMemoryBundle: buildBundle,
  };
}
