// Feature library — on-disk storage of user / LLM-authored Python factors.
//
// Layout (under app_data_dir):
//   features/
//     _meta.json              — {slug: {display_name, category, status, ...}}
//     funding_zscore.py       — one file per feature, snake_case slug
//     volume_breakout.py
//
// We keep code as plain .py files (not stuffed inside a JSON blob) so:
//   - Git/IDE-savvy users can manage them externally
//   - The "Reveal in Finder" affordance points somewhere meaningful
//   - Future tooling (linters, type-checkers) can be pointed at the dir
//
// Slug rules: [a-z0-9_]+, derived from display_name when LLM creates one.

pub mod store;
pub mod types;
