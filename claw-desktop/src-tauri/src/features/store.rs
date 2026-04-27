// File-system layer for the feature library. All operations are atomic at
// the file level (write to temp + rename) so a crash mid-write can't leave
// a partial .py on disk.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager};

use super::types::{FeatureMeta, FeatureRecord};

const META_FILE: &str = "_meta.json";

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Validates and normalizes a feature slug. Lowercased, only [a-z0-9_],
/// no leading underscore (reserved for `_meta.json` and friends).
fn validate_slug(slug: &str) -> Result<String, String> {
    let s = slug.trim().to_lowercase();
    if s.is_empty() {
        return Err("slug 不能为空".into());
    }
    if s.starts_with('_') {
        return Err("slug 不能以下划线开头（保留前缀）".into());
    }
    if !s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err(format!("slug \"{}\" 只能包含小写字母 / 数字 / 下划线", s));
    }
    if s.len() > 64 {
        return Err("slug 太长（>64）".into());
    }
    Ok(s)
}

fn features_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("拿不到 app_data_dir: {}", e))?;
    let dir = base.join("features");
    fs::create_dir_all(&dir).map_err(|e| format!("创建 features 目录失败: {}", e))?;
    Ok(dir)
}

fn meta_path(dir: &Path) -> PathBuf {
    dir.join(META_FILE)
}

fn code_path(dir: &Path, slug: &str) -> PathBuf {
    dir.join(format!("{}.py", slug))
}

fn load_meta_index(dir: &Path) -> HashMap<String, FeatureMeta> {
    let path = meta_path(dir);
    let Ok(s) = fs::read_to_string(&path) else {
        return HashMap::new();
    };
    serde_json::from_str(&s).unwrap_or_default()
}

fn save_meta_index(dir: &Path, idx: &HashMap<String, FeatureMeta>) -> Result<(), String> {
    let path = meta_path(dir);
    let tmp = path.with_extension("json.tmp");
    let body = serde_json::to_string_pretty(idx)
        .map_err(|e| format!("meta 序列化失败: {}", e))?;
    fs::write(&tmp, body).map_err(|e| format!("写入 meta tmp 失败: {}", e))?;
    fs::rename(&tmp, &path).map_err(|e| format!("rename meta 失败: {}", e))?;
    Ok(())
}

fn write_code_atomic(dir: &Path, slug: &str, code: &str) -> Result<(), String> {
    let path = code_path(dir, slug);
    let tmp = path.with_extension("py.tmp");
    fs::write(&tmp, code).map_err(|e| format!("写入 code tmp 失败: {}", e))?;
    fs::rename(&tmp, &path).map_err(|e| format!("rename code 失败: {}", e))?;
    Ok(())
}

/// List all features. Code is loaded for each — small per-file size makes
/// this cheap and lets the UI render the card list + detail view from a
/// single round-trip.
pub fn list(app: &AppHandle) -> Result<Vec<FeatureRecord>, String> {
    let dir = features_dir(app)?;
    let idx = load_meta_index(&dir);
    let mut out = Vec::with_capacity(idx.len());
    for (slug, meta) in idx {
        let code = fs::read_to_string(code_path(&dir, &slug)).unwrap_or_default();
        out.push(FeatureRecord { meta, code });
    }
    // Newest first — created_at descending; ties broken by slug for stability.
    out.sort_by(|a, b| {
        b.meta
            .created_at
            .cmp(&a.meta.created_at)
            .then_with(|| a.meta.slug.cmp(&b.meta.slug))
    });
    Ok(out)
}

pub fn read(app: &AppHandle, slug: &str) -> Result<FeatureRecord, String> {
    let slug = validate_slug(slug)?;
    let dir = features_dir(app)?;
    let idx = load_meta_index(&dir);
    let meta = idx
        .get(&slug)
        .cloned()
        .ok_or_else(|| format!("feature \"{}\" 不存在", slug))?;
    let code = fs::read_to_string(code_path(&dir, &slug))
        .map_err(|e| format!("读取 code 失败: {}", e))?;
    Ok(FeatureRecord { meta, code })
}

/// Upsert. If `meta.created_at` is 0 (new), stamp with current time.
pub fn write(app: &AppHandle, mut record: FeatureRecord) -> Result<FeatureRecord, String> {
    let slug = validate_slug(&record.meta.slug)?;
    record.meta.slug = slug.clone();
    let dir = features_dir(app)?;
    let mut idx = load_meta_index(&dir);

    if record.meta.created_at == 0 {
        record.meta.created_at = idx
            .get(&slug)
            .map(|m| m.created_at)
            .filter(|t| *t > 0)
            .unwrap_or_else(now_ms);
    }
    if record.meta.display_name.trim().is_empty() {
        record.meta.display_name = slug.clone();
    }

    write_code_atomic(&dir, &slug, &record.code)?;
    idx.insert(slug.clone(), record.meta.clone());
    save_meta_index(&dir, &idx)?;
    Ok(record)
}

pub fn delete(app: &AppHandle, slug: &str) -> Result<(), String> {
    let slug = validate_slug(slug)?;
    let dir = features_dir(app)?;
    let mut idx = load_meta_index(&dir);
    idx.remove(&slug);
    save_meta_index(&dir, &idx)?;
    let p = code_path(&dir, &slug);
    if p.exists() {
        fs::remove_file(&p).map_err(|e| format!("删除 code 文件失败: {}", e))?;
    }
    Ok(())
}

/// Path string for "Reveal in Finder/Explorer" UX.
pub fn dir_path(app: &AppHandle) -> Result<String, String> {
    let dir = features_dir(app)?;
    Ok(dir.to_string_lossy().into_owned())
}

/// Update just the run-result fields after an execution. Cheaper than a
/// full upsert because it doesn't touch the .py file.
pub fn record_run(
    app: &AppHandle,
    slug: &str,
    brief: Option<String>,
    error: Option<String>,
) -> Result<(), String> {
    let slug = validate_slug(slug)?;
    let dir = features_dir(app)?;
    let mut idx = load_meta_index(&dir);
    if let Some(meta) = idx.get_mut(&slug) {
        meta.last_run_at = Some(now_ms());
        meta.last_brief = brief;
        meta.last_error = error;
        save_meta_index(&dir, &idx)?;
    }
    Ok(())
}
