import fs from "node:fs";
import path from "node:path";

function toText(valueLike, fallback = "") {
  const s = String(valueLike ?? "").trim();
  return s || fallback;
}

function toNum(valueLike, fallback = 0) {
  const n = Number(valueLike);
  return Number.isFinite(n) ? n : Number(fallback || 0);
}

function includesAny(text = "", keywords = []) {
  return (Array.isArray(keywords) ? keywords : []).some((kw) => text.includes(toText(kw).toLowerCase()));
}

function uniqBy(list = [], keyGetter = (x) => x) {
  const out = [];
  const seen = new Set();
  list.forEach((item) => {
    const key = toText(keyGetter(item), "");
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(item);
  });
  return out;
}

function parseFrontmatter(skillMarkdown = "") {
  const text = toText(skillMarkdown || "");
  if (!text.startsWith("---")) return {};
  const end = text.indexOf("\n---", 3);
  if (end < 0) return {};
  const block = text.slice(3, end).split("\n");
  const meta = {};
  block.forEach((line) => {
    const idx = line.indexOf(":");
    if (idx <= 0) return;
    const key = toText(line.slice(0, idx));
    const value = toText(line.slice(idx + 1));
    if (!key) return;
    meta[key] = value;
  });
  return meta;
}

function loadJsonSafe(filePath, fallback = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function loadSkillPackages() {
  const baseDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "skills");
  if (!fs.existsSync(baseDir)) return [];
  const dirs = fs.readdirSync(baseDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  return dirs.map((dir) => {
    const skillDir = path.join(baseDir, dir.name);
    const skillMarkdown = fs.existsSync(path.join(skillDir, "SKILL.md"))
      ? fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8")
      : "";
    const meta = parseFrontmatter(skillMarkdown);
    const rules = loadJsonSafe(path.join(skillDir, "references", "rules.json"), {});
    return {
      skillId: toText(meta.name || dir.name, dir.name),
      description: toText(meta.description || ""),
      rules,
    };
  });
}

const DECLARATIVE_SKILLS = loadSkillPackages();

function executeDeclarativeSkill(skill, context = {}) {
  const mergedText = toText(context.mergedText || "").toLowerCase();
  const rules = skill?.rules && typeof skill.rules === "object" ? skill.rules : {};
  const features = Array.isArray(rules.features) ? rules.features : [];
  const featureCandidates = features
    .filter((rule) => includesAny(mergedText, rule?.keywords || []))
    .map((rule) => {
      const candidate = rule?.candidate && typeof rule.candidate === "object" ? rule.candidate : null;
      return candidate ? JSON.parse(JSON.stringify(candidate)) : null;
    })
    .filter(Boolean);

  const keywordDetected = includesAny(mergedText, rules.keywords || []);
  const detected = keywordDetected || featureCandidates.length > 0;
  const defaultHints = rules.strategyHints && typeof rules.strategyHints === "object" ? rules.strategyHints : {};

  return {
    skillId: toText(skill.skillId || "unknown", "unknown"),
    intentDetected: detected,
    confidence: detected
      ? toNum(rules.confidenceWhenDetected, featureCandidates.length > 0 ? 0.68 : 0.62)
      : toNum(rules.confidenceWhenMissing, 0.3),
    reasoning: detected
      ? toText(rules.reasoningDetected || "识别到可执行策略上下文")
      : toText(rules.reasoningMissing || "未识别到策略上下文"),
    featureCandidates,
    strategyHints: defaultHints,
  };
}

export function runHeuristicIntentSkills(contextLike = {}) {
  const context = contextLike && typeof contextLike === "object" ? contextLike : {};
  const results = DECLARATIVE_SKILLS.map((skill) => {
    try {
      return executeDeclarativeSkill(skill, context);
    } catch (error) {
      return {
        skillId: toText(skill?.skillId || "unknown", "unknown"),
        intentDetected: false,
        confidence: 0,
        reasoning: `skill error: ${toText(error?.message || error)}`,
        featureCandidates: [],
        strategyHints: {},
      };
    }
  });

  const market = results.find((r) => r.skillId === "market-context") || { intentDetected: false, confidence: 0.2 };
  const features = uniqBy(
    results.flatMap((r) => (Array.isArray(r.featureCandidates) ? r.featureCandidates : [])),
    (row) => row?.feature?.name || row?.candidateId || "",
  );
  const strategyHints = results.reduce((acc, row) => ({
    ...acc,
    ...(row.strategyHints && typeof row.strategyHints === "object" ? row.strategyHints : {}),
  }), {});
  const avgConfidence = results.length
    ? results.reduce((acc, r) => acc + toNum(r.confidence, 0), 0) / results.length
    : 0;

  return {
    intentDetected: Boolean(market.intentDetected),
    confidence: Math.max(0.2, Math.min(0.85, avgConfidence + (features.length ? 0.08 : 0))),
    reasoning: market.intentDetected
      ? `启用声明式技能编排提取（skills=${results.map((r) => r.skillId).join(", ")})`
      : "对话中缺少明确交易对象或策略描述",
    featureCandidates: features,
    strategyHints,
    skillDebug: results,
  };
}
