import type {
  Skill,
  ToolFunction,
  ValidationIssue,
  ParsedSkill,
  SkillCustomSection,
} from "../types/agent";

const KNOWN_H2 = ["Tools", "Instructions", "Constraints", "Evaluator"];

export function buildSkillMd(
  skill: Skill,
  functions: ToolFunction[]
): string {
  let md = `---\nname: ${skill.id}\ndescription: >-\n  ${skill.desc}\n---\n\n`;
  md += `# ${skill.id}\n\n`;
  md += `${skill.desc}\n\n`;

  md += `## Tools\n\n`;
  for (const fid of skill.fns) {
    const fn = functions.find((f) => f.id === fid);
    md += `- \`${fid}\` — ${fn ? fn.desc : "(未注册)"}\n`;
  }

  md += `\n## Instructions\n\n${skill.guide}\n`;

  md += `\n## Constraints\n\n`;
  for (const c of skill.constraints) {
    md += `- ${c}\n`;
  }

  md += `\n## Evaluator\n\n`;
  for (const e of skill.eval) {
    md += `- ${e}\n`;
  }

  if (skill.custom && skill.custom.length > 0) {
    for (const c of skill.custom) {
      md += `\n## ${c.title}\n\n${c.content}\n`;
    }
  }

  return md;
}

export function parseMd(md: string): ParsedSkill {
  const parsed: ParsedSkill = { _dropped: [] };

  const descMatch = md.match(/description:\s*>-\s*\n\s*(.+)/);
  if (descMatch) parsed.desc = descMatch[1].trim();

  const toolsSec = md.match(/## Tools\s*\n\n([\s\S]*?)(?=\n##\s|\s*$)/);
  if (toolsSec) {
    const allLines = toolsSec[1].split("\n").filter((l) => l.trim());
    const fns: string[] = [];
    for (const l of allLines) {
      const m = l.match(/`([^`]+)`/);
      if (m) {
        fns.push(m[1]);
      } else if (!/^-\s*$/.test(l)) {
        parsed._dropped.push({ section: "Tools", line: l.trim() });
      }
    }
    if (fns.length) parsed.fns = fns;
  }

  const instrSec = md.match(/## Instructions\s*\n\n([\s\S]*?)(?=\n##\s|\s*$)/);
  if (instrSec) parsed.guide = instrSec[1].trim();

  const csSec = md.match(/## Constraints\s*\n\n([\s\S]*?)(?=\n##\s|\s*$)/);
  if (csSec) {
    const allLines = csSec[1].split("\n").filter((l) => l.trim());
    parsed.constraints = [];
    for (const l of allLines) {
      if (/^-\s*\S/.test(l)) {
        parsed.constraints.push(l.replace(/^-\s*/, ""));
      } else {
        parsed._dropped.push({ section: "Constraints", line: l.trim() });
      }
    }
  }

  const evSec = md.match(/## Evaluator\s*\n\n([\s\S]*?)(?=\n##\s|\s*$)/);
  if (evSec) {
    const allLines = evSec[1].split("\n").filter((l) => l.trim());
    parsed.eval = [];
    for (const l of allLines) {
      if (/^-\s*\S/.test(l)) {
        parsed.eval.push(l.replace(/^-\s*/, ""));
      } else {
        parsed._dropped.push({ section: "Evaluator", line: l.trim() });
      }
    }
  }

  const customMatches = [
    ...md.matchAll(/## (\S+.*)\n\n([\s\S]*?)(?=\n##\s|\s*$)/g),
  ];
  const custom: SkillCustomSection[] = [];
  for (const m of customMatches) {
    const title = m[1].trim();
    if (!KNOWN_H2.includes(title)) {
      custom.push({ title, content: m[2].trim() });
    }
  }
  parsed.custom = custom;

  return parsed;
}

export function validateSkill(
  skill: Skill,
  knownFnIds: string[]
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!skill.desc || skill.desc.trim().length < 5) {
    issues.push({ type: "err", msg: "描述不能为空或过短" });
  }
  if (!skill.fns || skill.fns.length === 0) {
    issues.push({ type: "err", msg: "至少需要一个 Tool" });
  }
  for (const fid of skill.fns) {
    if (!knownFnIds.includes(fid)) {
      issues.push({
        type: "err",
        msg: `Tool "${fid}" 未在 Function 注册表中找到`,
      });
    }
  }
  if (!skill.guide || skill.guide.trim().length < 10) {
    issues.push({ type: "warn", msg: "指引内容过短" });
  }
  if (!skill.constraints || skill.constraints.length === 0) {
    issues.push({ type: "warn", msg: "建议添加至少一条 Constraint" });
  }
  if (!skill.eval || skill.eval.length === 0) {
    issues.push({ type: "warn", msg: "建议添加至少一条 Evaluator 标准" });
  }

  return issues;
}

export function applyParsed(skill: Skill, parsed: ParsedSkill): void {
  if (parsed.desc !== undefined) skill.desc = parsed.desc;
  if (parsed.fns !== undefined) skill.fns = parsed.fns;
  if (parsed.guide !== undefined) skill.guide = parsed.guide;
  if (parsed.constraints !== undefined) skill.constraints = parsed.constraints;
  if (parsed.eval !== undefined) skill.eval = parsed.eval;
  if (parsed.custom !== undefined) skill.custom = parsed.custom;
}
