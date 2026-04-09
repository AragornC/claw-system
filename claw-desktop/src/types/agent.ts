export interface Agent {
  id: string;
  name: string;
  role: string;
  active: boolean;
  desc: string;
  systemPrompt: string;
  memory: string;
  skills: string[];
  fns: string[];
}

export interface SkillCustomSection {
  title: string;
  content: string;
}

export interface Skill {
  id: string;
  agent: string;
  desc: string;
  fns: string[];
  guide: string;
  constraints: string[];
  eval: string[];
  custom?: SkillCustomSection[];
}

export interface ToolParam {
  name: string;
  type: string;
  req: boolean;
  desc: string;
}

export type PermLevel = "auto" | "ask" | "deny";

export interface ToolFunction {
  id: string;
  cat: string;
  perm: PermLevel;
  desc: string;
  params: ToolParam[];
  agents: string[];
}

export interface AgentConfig {
  agents: Agent[];
  skills: Skill[];
  functions: ToolFunction[];
}

export type ActiveView = {
  type: "agent" | "skill" | "fn";
  id: string;
} | null;

export interface ValidationIssue {
  type: "err" | "warn";
  msg: string;
}

export interface DroppedLine {
  section: string;
  line: string;
}

export interface ParsedSkill {
  desc?: string;
  fns?: string[];
  guide?: string;
  constraints?: string[];
  eval?: string[];
  custom?: SkillCustomSection[];
  _dropped: DroppedLine[];
}
