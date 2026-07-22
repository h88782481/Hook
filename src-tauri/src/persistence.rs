use crate::runtime::effective_app_data_dir;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::fs;
use std::fs::File;
use std::io::Write;
use std::path::Path;

// --- Persistence ---

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SimpleRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SimplePoint {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StickerData {
    pub id: String,
    /// Disk path after save. In-memory data URLs are materialized before write.
    pub src: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub minified: Option<bool>,
    pub saved_rect: Option<SimpleRect>,
    pub crop_offset: Option<SimplePoint>,
    pub opacity_normal: Option<f64>,
    pub opacity_mini: Option<f64>,
    #[serde(rename = "filePath")]
    pub file_path: Option<String>,
    #[serde(rename = "previewSrc")]
    pub preview_src: Option<String>,
    #[serde(rename = "rasterizedAnnotationLayerSrc")]
    pub rasterized_annotation_layer_src: Option<String>,
    #[serde(rename = "annotationState")]
    pub annotation_state: Option<serde_json::Value>,
    #[serde(rename = "imageEditState")]
    pub image_edit_state: Option<serde_json::Value>,
    #[serde(rename = "groupId")]
    pub group_id: Option<String>,
    #[serde(rename = "captureMeta")]
    pub capture_meta: Option<serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LinkData {
    pub id: String,
    pub from_sticker_id: String,
    pub from_port_id: String,
    pub to_sticker_id: String,
    pub to_port_id: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FrozenStickerEntry {
    pub entry_id: String,
    pub source_sticker_id: String,
    pub created_at: String,
    pub snapshot: serde_json::Value,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionData {
    pub stickers: Vec<StickerData>,
    pub links: Vec<LinkData>,
    pub groups: Vec<serde_json::Value>,
    pub recycle_bin: Vec<FrozenStickerEntry>,
    pub reference_library: Vec<FrozenStickerEntry>,
}

fn is_data_image_url(value: &str) -> bool {
    value.starts_with("data:image")
}

fn materialize_data_url_image(
    data_url: &str,
    images_dir: &Path,
    filename: &str,
) -> Result<String, String> {
    let base64_data = data_url.split(',').last().unwrap_or(data_url);
    let image_data = base64::engine::general_purpose::STANDARD
        .decode(base64_data)
        .map_err(|e| e.to_string())?;
    let file_path = images_dir.join(filename);
    let mut file = File::create(&file_path).map_err(|e| e.to_string())?;
    file.write_all(&image_data).map_err(|e| e.to_string())?;
    Ok(file_path.to_string_lossy().to_string())
}

fn materialize_optional_data_url(
    value: &mut Option<String>,
    images_dir: &Path,
    filename: &str,
) -> Result<(), String> {
    let Some(src) = value.as_mut() else {
        return Ok(());
    };
    if !is_data_image_url(src) {
        return Ok(());
    }
    *src = materialize_data_url_image(src, images_dir, filename)?;
    Ok(())
}

fn materialize_sticker_images(sticker: &mut StickerData, images_dir: &Path) -> Result<(), String> {
    if is_data_image_url(&sticker.src) {
        sticker.src = materialize_data_url_image(
            &sticker.src,
            images_dir,
            &format!("{}.png", sticker.id),
        )
        .map_err(|e| format!("Failed to materialize src for {}: {}", sticker.id, e))?;
        sticker.file_path = Some(sticker.src.clone());
    }

    materialize_optional_data_url(
        &mut sticker.preview_src,
        images_dir,
        &format!("{}_preview.png", sticker.id),
    )
    .map_err(|e| format!("Failed to materialize previewSrc for {}: {}", sticker.id, e))?;

    materialize_optional_data_url(
        &mut sticker.rasterized_annotation_layer_src,
        images_dir,
        &format!("{}_annotation.png", sticker.id),
    )
    .map_err(|e| {
        format!(
            "Failed to materialize rasterizedAnnotationLayerSrc for {}: {}",
            sticker.id, e
        )
    })?;

    Ok(())
}

fn materialize_snapshot_image_field(
    snapshot: &mut serde_json::Value,
    field: &str,
    images_dir: &Path,
    filename: &str,
) -> Result<(), String> {
    let Some(value) = snapshot.get_mut(field) else {
        return Ok(());
    };
    let Some(src) = value.as_str() else {
        return Ok(());
    };
    if !is_data_image_url(src) {
        return Ok(());
    }
    let path = materialize_data_url_image(src, images_dir, filename)?;
    *value = serde_json::Value::String(path.clone());
    if field == "src" {
        snapshot
            .as_object_mut()
            .map(|object| object.insert("filePath".to_string(), serde_json::Value::String(path)));
    }
    Ok(())
}

fn materialize_frozen_entry(
    entry: &mut FrozenStickerEntry,
    images_dir: &Path,
) -> Result<(), String> {
    let prefix = entry.entry_id.as_str();
    materialize_snapshot_image_field(
        &mut entry.snapshot,
        "src",
        images_dir,
        &format!("{}_frozen.png", prefix),
    )?;
    materialize_snapshot_image_field(
        &mut entry.snapshot,
        "previewSrc",
        images_dir,
        &format!("{}_frozen_preview.png", prefix),
    )?;
    materialize_snapshot_image_field(
        &mut entry.snapshot,
        "rasterizedAnnotationLayerSrc",
        images_dir,
        &format!("{}_frozen_annotation.png", prefix),
    )?;
    Ok(())
}

fn ensure_path_backed_src(sticker: &StickerData) -> Result<(), String> {
    if is_data_image_url(&sticker.src) {
        return Err(format!(
            "Session sticker {} has an in-memory data URL src; expected a disk path",
            sticker.id
        ));
    }
    Ok(())
}

#[tauri::command]
pub fn save_session(
    app: tauri::AppHandle,
    stickers: Vec<StickerData>,
    links: Vec<LinkData>,
    groups: Vec<serde_json::Value>,
    recycle_bin: Vec<FrozenStickerEntry>,
    reference_library: Vec<FrozenStickerEntry>,
) -> Result<(), String> {
    let app_dir = effective_app_data_dir(&app)?;
    if !app_dir.exists() {
        fs::create_dir_all(&app_dir).map_err(|e| e.to_string())?;
    }

    let images_dir = app_dir.join("images");
    if !images_dir.exists() {
        fs::create_dir_all(&images_dir).map_err(|e| e.to_string())?;
    }

    let mut processed_stickers = stickers;
    for sticker in &mut processed_stickers {
        materialize_sticker_images(sticker, &images_dir)?;
    }

    let mut processed_recycle_bin = recycle_bin;
    for entry in &mut processed_recycle_bin {
        materialize_frozen_entry(entry, &images_dir)?;
    }

    let mut processed_reference_library = reference_library;
    for entry in &mut processed_reference_library {
        materialize_frozen_entry(entry, &images_dir)?;
    }

    let session_data = SessionData {
        stickers: processed_stickers,
        links,
        groups,
        recycle_bin: processed_recycle_bin,
        reference_library: processed_reference_library,
    };

    let session_file = app_dir.join("session.json");
    let json = serde_json::to_string_pretty(&session_data).map_err(|e| e.to_string())?;

    let mut file = File::create(session_file).map_err(|e| e.to_string())?;
    file.write_all(json.as_bytes()).map_err(|e| e.to_string())?;

    println!(
        "Session saved with {} stickers and {} links.",
        session_data.stickers.len(),
        session_data.links.len()
    );
    Ok(())
}

#[tauri::command]
pub fn load_session(app: tauri::AppHandle) -> Result<SessionData, String> {
    let app_dir = effective_app_data_dir(&app)?;
    let session_file = app_dir.join("session.json");

    if !session_file.exists() {
        return Ok(SessionData {
            stickers: Vec::new(),
            links: Vec::new(),
            groups: Vec::new(),
            recycle_bin: Vec::new(),
            reference_library: Vec::new(),
        });
    }

    let content = fs::read_to_string(&session_file).map_err(|e| e.to_string())?;
    let session_data: SessionData = serde_json::from_str(&content).map_err(|e| e.to_string())?;

    for sticker in &session_data.stickers {
        ensure_path_backed_src(sticker)?;
    }

    println!(
        "Session loaded with {} stickers and {} links.",
        session_data.stickers.len(),
        session_data.links.len()
    );
    Ok(session_data)
}

const HISTORY_MAX_COLORS: usize = 64;
const HISTORY_MAX_SCREENSHOTS: usize = 64;

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct HistoryData {
    #[serde(default)]
    pub colors: Vec<serde_json::Value>,
    #[serde(default)]
    pub screenshots: Vec<serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ToolSettingsData {
    #[serde(default)]
    pub sticker_tool_settings: Option<serde_json::Value>,
}

/// Persist the color/screenshot history to app_data_dir/history.json.
/// Entries are capped on write so a runaway caller cannot grow the file
/// unbounded; the most recent entries (front of the list) are kept.
#[tauri::command]
pub fn save_history(
    app: tauri::AppHandle,
    colors: Vec<serde_json::Value>,
    screenshots: Vec<serde_json::Value>,
) -> Result<(), String> {
    let app_dir = effective_app_data_dir(&app)?;
    if !app_dir.exists() {
        fs::create_dir_all(&app_dir).map_err(|e| e.to_string())?;
    }

    let mut bounded_colors = colors;
    bounded_colors.truncate(HISTORY_MAX_COLORS);
    let mut bounded_screenshots = screenshots;
    bounded_screenshots.truncate(HISTORY_MAX_SCREENSHOTS);

    let history = HistoryData {
        colors: bounded_colors,
        screenshots: bounded_screenshots,
    };

    let history_file = app_dir.join("history.json");
    let json = serde_json::to_string_pretty(&history).map_err(|e| e.to_string())?;
    let mut file = File::create(history_file).map_err(|e| e.to_string())?;
    file.write_all(json.as_bytes()).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn load_history(app: tauri::AppHandle) -> Result<HistoryData, String> {
    let app_dir = effective_app_data_dir(&app)?;
    let history_file = app_dir.join("history.json");
    if !history_file.exists() {
        return Ok(HistoryData::default());
    }

    let content = fs::read_to_string(&history_file).map_err(|e| e.to_string())?;
    let mut history: HistoryData = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    history.colors.truncate(HISTORY_MAX_COLORS);
    history.screenshots.truncate(HISTORY_MAX_SCREENSHOTS);
    Ok(history)
}

#[tauri::command]
pub fn save_tool_settings(
    app: tauri::AppHandle,
    sticker_tool_settings: serde_json::Value,
) -> Result<(), String> {
    let app_dir = effective_app_data_dir(&app)?;
    if !app_dir.exists() {
        fs::create_dir_all(&app_dir).map_err(|e| e.to_string())?;
    }

    let payload = ToolSettingsData {
        sticker_tool_settings: Some(sticker_tool_settings),
    };

    let tool_settings_file = app_dir.join("tool-settings.json");
    let json = serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?;
    let mut file = File::create(tool_settings_file).map_err(|e| e.to_string())?;
    file.write_all(json.as_bytes()).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn load_tool_settings(app: tauri::AppHandle) -> Result<ToolSettingsData, String> {
    let app_dir = effective_app_data_dir(&app)?;
    let tool_settings_file = app_dir.join("tool-settings.json");
    if !tool_settings_file.exists() {
        return Ok(ToolSettingsData::default());
    }

    let content = fs::read_to_string(&tool_settings_file).map_err(|e| e.to_string())?;
    serde_json::from_str(&content).map_err(|e| e.to_string())
}
