// Tauri commands exposing the feature store to the frontend.

use tauri::AppHandle;

use crate::features::store;
use crate::features::types::FeatureRecord;

#[tauri::command]
pub fn list_features(app: AppHandle) -> Result<Vec<FeatureRecord>, String> {
    store::list(&app)
}

#[tauri::command]
pub fn read_feature(app: AppHandle, slug: String) -> Result<FeatureRecord, String> {
    store::read(&app, &slug)
}

#[tauri::command]
pub fn write_feature(app: AppHandle, record: FeatureRecord) -> Result<FeatureRecord, String> {
    store::write(&app, record)
}

#[tauri::command]
pub fn delete_feature(app: AppHandle, slug: String) -> Result<(), String> {
    store::delete(&app, &slug)
}

#[tauri::command]
pub fn features_dir_path(app: AppHandle) -> Result<String, String> {
    store::dir_path(&app)
}

#[tauri::command]
pub fn record_feature_run(
    app: AppHandle,
    slug: String,
    brief: Option<String>,
    error: Option<String>,
) -> Result<(), String> {
    store::record_run(&app, &slug, brief, error)
}
