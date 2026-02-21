import fs from 'node:fs';
import path from 'node:path';

function nowIso() {
  return new Date().toISOString();
}

function safeJson(raw, fallback = null) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function createAuditLog(options = {}) {
  const filePath = path.resolve(String(options.filePath || 'memory/runtime-audit.jsonl'));

  function append(event, payload) {
    const row = {
      ts: nowIso(),
      event: String(event || 'unknown'),
      payload: payload && typeof payload === 'object' ? payload : { value: payload },
    };
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
    } catch {}
    return row;
  }

  function list(optionsLike = {}) {
    const options = optionsLike && typeof optionsLike === 'object' ? optionsLike : {};
    const limit = Math.max(1, Math.min(3000, Number(options.limit || 120) || 120));
    const event = String(options.event || '').trim();
    try {
      if (!fs.existsSync(filePath)) return [];
      const raw = fs.readFileSync(filePath, 'utf8');
      const rows = String(raw || '')
        .split(/\r?\n/)
        .map((line) => safeJson(line, null))
        .filter(Boolean);
      const filtered = event ? rows.filter((x) => String(x?.event || '') === event) : rows;
      return filtered.slice(-limit).reverse();
    } catch {
      return [];
    }
  }

  return {
    append,
    list,
    filePath,
  };
}
