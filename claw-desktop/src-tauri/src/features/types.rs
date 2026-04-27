use serde::{Deserialize, Serialize};

/// Per-feature metadata stored in `_meta.json`. The Python code lives
/// alongside in `<slug>.py` — code is NEVER duplicated here.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeatureMeta {
    pub slug: String,
    pub display_name: String,
    #[serde(default)]
    pub category: String,
    #[serde(default = "default_description")]
    pub description: String,
    /// "user" | "llm" — provenance, useful for the UI to mark LLM-written
    /// features for extra scrutiny.
    #[serde(default = "default_created_by")]
    pub created_by: String,
    /// "draft" | "enabled" | "disabled" — lifecycle. Phase 1 doesn't run
    /// anything automatically, so this is informational only.
    #[serde(default = "default_status")]
    pub status: String,
    /// ms since epoch
    #[serde(default)]
    pub created_at: u64,
    /// ms since epoch — last successful run
    #[serde(default)]
    pub last_run_at: Option<u64>,
    /// short summary of last run for the card view ("z=2.34" etc)
    #[serde(default)]
    pub last_brief: Option<String>,
    /// Last error string (truncated). Set on failure, cleared on success.
    #[serde(default)]
    pub last_error: Option<String>,
}

fn default_description() -> String {
    String::new()
}
fn default_created_by() -> String {
    "user".into()
}
fn default_status() -> String {
    "draft".into()
}

/// Combined record returned to the frontend — meta + raw code.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeatureRecord {
    #[serde(flatten)]
    pub meta: FeatureMeta,
    pub code: String,
}
