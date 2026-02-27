import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

function toText(valueLike, fallback = "") {
  const s = String(valueLike ?? "").trim();
  return s || fallback;
}

function toNum(valueLike, fallback = 0) {
  const n = Number(valueLike);
  return Number.isFinite(n) ? n : Number(fallback || 0);
}

function clamp(valueLike, min, max, fallback = 0) {
  const n = toNum(valueLike, fallback);
  if (Number.isFinite(min) && n < min) return min;
  if (Number.isFinite(max) && n > max) return max;
  return n;
}

function hashSeed(textLike = "") {
  const raw = toText(textLike || "");
  let seed = 0;
  for (let i = 0; i < raw.length; i += 1) {
    seed = (seed * 131 + raw.charCodeAt(i)) % 2147483647;
  }
  return seed;
}

function normalizeFeatureRefList(rowsLike = []) {
  const rows = Array.isArray(rowsLike) ? rowsLike : [];
  return rows.map((v) => toText(v || "").toLowerCase()).filter(Boolean);
}

function inferExternalType(featureRefLike = "") {
  const ref = toText(featureRefLike || "").toLowerCase();
  if (!ref) return "";
  if (ref.includes("polymarket") || ref.includes("prediction")) return "prediction";
  if (ref.includes("twitter") || ref.includes("x_") || ref.includes("tweet") || ref.includes("social")) return "social";
  if (ref.includes("news") || ref.includes("headline") || ref.includes("sentiment")) return "news";
  return "";
}

function detectAssetKeywords(contextLike = "") {
  const text = toText(contextLike).toUpperCase();
  if (text.includes("ETH")) return ["ETH", "ETHEREUM"];
  if (text.includes("SOL")) return ["SOL", "SOLANA"];
  if (text.includes("BNB")) return ["BNB", "BINANCE"];
  return ["BTC", "BITCOIN"];
}

function execCurl(args = [], timeoutMs = 7000) {
  const run = spawnSync("curl", ["-L", "--silent", "--show-error", "--max-time", String(Math.max(2, Math.floor(timeoutMs / 1000))), ...args], {
    encoding: "utf8",
    timeout: timeoutMs,
  });
  if (run.status !== 0) {
    return { ok: false, error: toText(run.stderr || run.stdout || "curl_failed") };
  }
  return { ok: true, text: toText(run.stdout || "") };
}

function scoreByLexicon(textRows = []) {
  const bullishWords = ["surge", "bull", "rally", "breakout", "approval", "adoption", "record", "增长", "利好", "上涨", "突破"];
  const bearishWords = ["drop", "bear", "hack", "ban", "selloff", "lawsuit", "outflow", "下跌", "利空", "风险", "暴跌"];
  let score = 0;
  textRows.forEach((rowLike) => {
    const row = toText(rowLike).toLowerCase();
    bullishWords.forEach((w) => {
      if (row.includes(w)) score += 0.18;
    });
    bearishWords.forEach((w) => {
      if (row.includes(w)) score -= 0.18;
    });
  });
  return clamp(score, -1, 1, 0);
}

function parseRssTitles(xmlLike = "") {
  const xml = toText(xmlLike || "");
  if (!xml) return [];
  const titles = [];
  const regex = /<title>([^<]+)<\/title>/gi;
  let m = regex.exec(xml);
  while (m) {
    const title = toText(m[1] || "");
    if (title && !title.toLowerCase().includes("rss")) titles.push(title);
    m = regex.exec(xml);
    if (titles.length >= 60) break;
  }
  return titles;
}


function includesAny(text = "", keywords = []) {
  return keywords.some((kw) => text.includes(String(kw || "").toLowerCase()));
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTERNAL_SIGNAL_RULES_PATH = path.join(__dirname, "intent-skills", "skills", "external-signal", "references", "rules.json");

function loadExternalSignalRules() {
  try {
    if (!fs.existsSync(EXTERNAL_SIGNAL_RULES_PATH)) return [];
    const parsed = JSON.parse(fs.readFileSync(EXTERNAL_SIGNAL_RULES_PATH, "utf8"));
    const features = Array.isArray(parsed?.features) ? parsed.features : [];
    return features.map((item) => ({
      id: toText(item?.id || ""),
      keywords: Array.isArray(item?.keywords) ? item.keywords : [],
      candidate: item?.candidate && typeof item.candidate === "object" ? item.candidate : {},
    }));
  } catch {
    return [];
  }
}

const EXTERNAL_SIGNAL_RULES = loadExternalSignalRules();

function fetchNewsSignal(contextLike = "") {
  const url = toText(process.env.THUNDERCLAW_NEWS_RSS_URL || "https://www.coindesk.com/arc/outboundfeeds/rss/");
  const rsp = execCurl([url], 8000);
  if (!rsp.ok) return { ok: false, score: 0, sourceLabel: "news", sourceUrl: url, error: rsp.error };
  const titles = parseRssTitles(rsp.text);
  const assetWords = detectAssetKeywords(contextLike).map((v) => v.toLowerCase());
  const filtered = titles.filter((t) => assetWords.some((kw) => t.toLowerCase().includes(kw))).slice(0, 20);
  const score = scoreByLexicon(filtered.length ? filtered : titles.slice(0, 20));
  return { ok: true, score, sourceLabel: "news", sourceUrl: url, sampleSize: filtered.length || titles.length };
}

function fetchSocialSignal(contextLike = "") {
  const [asset] = detectAssetKeywords(contextLike);
  const query = encodeURIComponent(`${asset} lang:en`);
  const template = toText(process.env.THUNDERCLAW_SOCIAL_RSS_URL || "https://nitter.net/search/rss?f=tweets&q={query}");
  const url = template.replace("{query}", query);
  const rsp = execCurl([url], 8000);
  if (!rsp.ok) return { ok: false, score: 0, sourceLabel: "social", sourceUrl: url, error: rsp.error };
  const titles = parseRssTitles(rsp.text).slice(0, 30);
  const score = scoreByLexicon(titles);
  return { ok: true, score, sourceLabel: "social", sourceUrl: url, sampleSize: titles.length };
}

function fetchPredictionSignal() {
  const url = toText(process.env.THUNDERCLAW_PREDICTION_API_URL || "https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=50");
  const rsp = execCurl([url], 9000);
  if (!rsp.ok) return { ok: false, score: 0, sourceLabel: "prediction", sourceUrl: url, error: rsp.error };
  let rows = [];
  try {
    const parsed = JSON.parse(rsp.text || "[]");
    rows = Array.isArray(parsed) ? parsed : [];
  } catch {
    return { ok: false, score: 0, sourceLabel: "prediction", sourceUrl: url, error: "invalid_json" };
  }
  const scores = rows.slice(0, 30).map((m) => {
    const p = toNum(m?.lastTradePrice || m?.bestBid || m?.price || 0.5, 0.5);
    return clamp((p - 0.5) * 2, -1, 1, 0);
  });
  const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
  return { ok: true, score: clamp(avg, -1, 1, 0), sourceLabel: "prediction", sourceUrl: url, sampleSize: scores.length };
}

const LIVE_CACHE = new Map();

function resolveLiveSignalByType(type = "", contextText = "") {
  if (type === "news") return fetchNewsSignal(contextText);
  if (type === "social") return fetchSocialSignal(contextText);
  if (type === "prediction") return fetchPredictionSignal();
  return { ok: false, score: 0, sourceLabel: type || "unknown", sourceUrl: "", error: "unsupported_type" };
}

function resolveScoreForRef({ ref = "", type = "", contextText = "", ts = 0, useLive = false }) {
  const cacheKey = `${type}|${contextText}`;
  if (useLive) {
    const hit = LIVE_CACHE.get(cacheKey);
    const now = Date.now();
    if (hit && now - hit.ts < 5 * 60 * 1000) {
      return { ...hit.payload, fromCache: true };
    }
    const payload = resolveLiveSignalByType(type, contextText);
    LIVE_CACHE.set(cacheKey, { ts: now, payload });
    return payload;
  }
  const seed = hashSeed(ref) + hashSeed(contextText) + ts;
  const oscillation = Math.sin(seed / 97) * 0.65 + Math.cos(seed / 53) * 0.35;
  return { ok: true, score: clamp(oscillation, -1, 1, 0), sourceLabel: `${type}_synthetic`, sourceUrl: "", sampleSize: 0 };
}

export function buildExternalSignalSnapshot(paramsLike = {}) {
  const params = paramsLike && typeof paramsLike === "object" ? paramsLike : {};
  const featureRefs = normalizeFeatureRefList(params.featureRefs || []);
  const ts = Math.max(0, Math.floor(toNum(params.timeSec, 0)));
  const contextText = toText(params.contextText || "");
  const useLive = ["1", "true", "yes", "on"].includes(toText(process.env.THUNDERCLAW_EXTERNAL_SIGNAL_LIVE || "0").toLowerCase());
  const externalRows = [];
  featureRefs.forEach((ref) => {
    const type = inferExternalType(ref);
    if (!type) return;
    const resolved = resolveScoreForRef({ ref, type, contextText, ts, useLive });
    const score = clamp(resolved.score, -1, 1, 0);
    externalRows.push({
      featureRef: ref,
      sourceType: type,
      score: Number(score.toFixed(6)),
      bias: score >= 0 ? "bullish" : "bearish",
      confidence: Number(clamp(Math.abs(score), 0, 1, 0).toFixed(6)),
      sourceLabel: toText(resolved.sourceLabel || type),
      sourceUrl: toText(resolved.sourceUrl || ""),
      sampleSize: Math.max(0, Math.floor(toNum(resolved.sampleSize, 0))),
      dataLive: Boolean(useLive),
      sourceStatus: resolved.ok ? "ok" : "degraded",
      sourceError: resolved.ok ? "" : toText(resolved.error || ""),
    });
  });
  return {
    externalSignals: externalRows,
    externalSignalScore: Number(externalRows.reduce((acc, row) => acc + toNum(row.score, 0), 0).toFixed(6)),
  };
}

export function detectExternalSignalFeaturesFromText(textLike = "") {
  const text = toText(textLike || "").toLowerCase();
  return EXTERNAL_SIGNAL_RULES
    .filter((rule) => includesAny(text, rule.keywords || []))
    .map((rule) => ({
      ...(rule.candidate || {}),
      feature: {
        ...((rule.candidate && rule.candidate.feature) || {}),
      },
    }));
}
