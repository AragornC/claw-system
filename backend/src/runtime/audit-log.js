import fs from 'node:fs';
import path from 'node:path';

function nowIso() {
  return new Date().toISOString();
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

  return {
    append,
    filePath,
  };
}
