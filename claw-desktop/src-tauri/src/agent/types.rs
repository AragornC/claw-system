use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolParam {
    pub name: String,
    #[serde(rename = "type")]
    pub param_type: String,
    pub req: bool,
    pub desc: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolFunction {
    pub id: String,
    pub cat: String,
    pub perm: String,
    pub desc: String,
    pub params: Vec<ToolParam>,
    pub agents: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillCustomSection {
    pub title: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Skill {
    pub id: String,
    pub agent: String,
    pub desc: String,
    pub fns: Vec<String>,
    pub guide: String,
    pub constraints: Vec<String>,
    #[serde(rename = "eval")]
    pub evaluator: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub custom: Vec<SkillCustomSection>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Agent {
    pub id: String,
    pub name: String,
    pub role: String,
    pub active: bool,
    pub desc: String,
    #[serde(rename = "systemPrompt")]
    pub system_prompt: String,
    pub memory: String,
    pub skills: Vec<String>,
    pub fns: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AgentConfig {
    pub agents: Vec<Agent>,
    pub skills: Vec<Skill>,
    pub functions: Vec<ToolFunction>,
}
