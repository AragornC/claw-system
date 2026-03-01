/**
 * Shared utility functions used across the ThunderClaw server codebase.
 * Consolidates the duplicated helpers that previously existed in 8+ files.
 */

export function toText(valueLike, fallback = "") {
  const s = String(valueLike ?? "").trim();
  return s || fallback;
}

export function clampNumber(valueLike, min, max, fallback = 0) {
  const n = Number(valueLike);
  if (!Number.isFinite(n)) return fallback;
  if (Number.isFinite(min) && n < min) return min;
  if (Number.isFinite(max) && n > max) return max;
  return n;
}

export function slugify(valueLike) {
  const raw = String(valueLike ?? "").trim().toLowerCase();
  let slug = "";
  let prevDash = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    const code = ch.charCodeAt(0);
    const isLower = code >= 97 && code <= 122;
    const isDigit = code >= 48 && code <= 57;
    if (isLower || isDigit) {
      slug += ch;
      prevDash = false;
    } else if (!prevDash) {
      slug += "-";
      prevDash = true;
    }
    if (slug.length >= 56) break;
  }
  while (slug.startsWith("-")) slug = slug.slice(1);
  while (slug.endsWith("-")) slug = slug.slice(0, -1);
  return slug.slice(0, 48) || "";
}

export function uniqStrings(valuesLike) {
  const rows = Array.isArray(valuesLike) ? valuesLike : [];
  const set = new Set();
  rows.forEach((item) => {
    const v = String(item ?? "").trim();
    if (v) set.add(v);
  });
  return Array.from(set);
}

export function pickEnum(valueLike, allowedSet, fallback) {
  const v = String(valueLike ?? "").trim().toLowerCase();
  if (allowedSet.has(v)) return v;
  return fallback;
}

export function nowIso() {
  return new Date().toISOString();
}

export function parsePositiveInt(valueLike, fallback, min, max) {
  const n = Number.parseInt(String(valueLike ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  if (Number.isFinite(min) && n < min) return fallback;
  if (Number.isFinite(max) && n > max) return max;
  return n;
}

export function normalizeArray(rowsLike) {
  return Array.isArray(rowsLike) ? rowsLike : [];
}

export function normalizeBars(barsLike = []) {
  return normalizeArray(barsLike)
    .map((item) => {
      const row = item && typeof item === "object" ? item : {};
      const rawTs = Math.floor(Number(row.time || row.ts || row.t || 0));
      const time = rawTs > 9_999_999_999 ? Math.floor(rawTs / 1000) : rawTs;
      const open = Number(row.open);
      const high = Number(row.high);
      const low = Number(row.low);
      const close = Number(row.close);
      const volume = Math.max(0, Number(row.volume) || 0);
      if (!Number.isFinite(time) || time <= 0) return null;
      if (![open, high, low, close].every(Number.isFinite)) return null;
      return { time, open, high, low, close, volume };
    })
    .filter(Boolean)
    .sort((a, b) => a.time - b.time);
}

/**
 * Loose JSON parser: tries JSON.parse first, then fenced code blocks, then brace extraction.
 */
export function parseJsonLoose(textLike) {
  const text = String(textLike ?? "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {}
  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    try {
      return JSON.parse(String(fencedMatch[1]).trim());
    } catch {}
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {}
  }
  const arrStart = text.indexOf("[");
  const arrEnd = text.lastIndexOf("]");
  if (arrStart >= 0 && arrEnd > arrStart) {
    try {
      return JSON.parse(text.slice(arrStart, arrEnd + 1));
    } catch {}
  }
  return null;
}

export function maskSecret(valueRaw) {
  const value = String(valueRaw ?? "").trim();
  if (!value) return "(未设置)";
  if (value.length <= 8) return `${value.slice(0, 2)}***`;
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

export function hashSeed(textLike = "") {
  const raw = toText(textLike);
  let seed = 0;
  for (let i = 0; i < raw.length; i += 1) {
    seed = (seed * 131 + raw.charCodeAt(i)) % 2147483647;
  }
  return seed;
}

export function buildSyntheticBars(rangeDaysLike = 30, stepSecLike = 3600) {
  const rangeDays = Math.max(1, Math.min(365, Math.floor(clampNumber(rangeDaysLike, 1, 365, 30))));
  const stepSec = Math.max(300, Math.min(86400, Math.floor(clampNumber(stepSecLike, 300, 86400, 3600))));
  const count = Math.max(120, Math.floor((rangeDays * 86400) / stepSec));
  const start = Math.floor(Date.now() / 1000) - count * stepSec;
  const out = [];
  let price = 100;
  for (let i = 0; i < count; i += 1) {
    const t = start + i * stepSec;
    const drift = Math.sin(i / 9) * 0.007 + Math.cos(i / 17) * 0.004;
    const next = Math.max(0.1, price * (1 + drift));
    out.push({
      time: t,
      open: price,
      high: Math.max(price, next) * 1.0025,
      low: Math.min(price, next) * 0.9975,
      close: next,
      volume: 1000 + i,
    });
    price = next;
  }
  return out;
}

export function pyString(valueLike = "") {
  return JSON.stringify(String(valueLike ?? ""));
}
