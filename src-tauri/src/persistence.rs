use crate::runtime::effective_app_data_dir;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::fs;
use std::fs::File;
use std::io::Write;

// --- Persistence ---

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")] // Match frontend naming convention
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
    pub src: String, // Can be Base64 or File Path
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
    pub preview_src: Option<String>, // Processed / derived image preview
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

    let mut processed_stickers = stickers.clone();

    for sticker in &mut processed_stickers {
        if sticker.src.starts_with("data:image") {
            let base64_data = sticker.src.split(",").last().unwrap_or(&sticker.src);
            let image_data = base64::engine::general_purpose::STANDARD
                .decode(base64_data)
                .map_err(|e| format!("Base64 decode failed for {}: {}", sticker.id, e))?;

            let filename = format!("{}.png", sticker.id);
            let file_path = images_dir.join(&filename);

            let mut file = File::create(&file_path).map_err(|e| e.to_string())?;
            file.write_all(&image_data).map_err(|e| e.to_string())?;

            sticker.src = file_path.to_string_lossy().to_string();
        }

        // Save Preview Image
        if let Some(ref mut p_src) = sticker.preview_src {
            if p_src.starts_with("data:image") {
                let base64_data = p_src.split(",").last().unwrap_or(p_src);
                // Safe decode?
                if let Ok(image_data) =
                    base64::engine::general_purpose::STANDARD.decode(base64_data)
                {
                    let filename = format!("{}_preview.png", sticker.id);
                    let file_path = images_dir.join(&filename);

                    if let Ok(mut file) = File::create(&file_path) {
                        let _ = file.write_all(&image_data);
                        *p_src = file_path.to_string_lossy().to_string();
                    }
                }
            }
        }
    }

    let session_data = SessionData {
        stickers: processed_stickers,
        links,
        groups,
        recycle_bin,
        reference_library,
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

fn restore_loaded_session_stickers(stickers: &mut [StickerData]) {
    for sticker in stickers {
        if sticker.src.starts_with("data:image") {
            continue;
        }

        let path = std::path::Path::new(&sticker.src);
        if !path.exists() {
            println!(
                "Warning: Image file not found for sticker {}: {}",
                sticker.id, sticker.src
            );
        }
    }
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
    let mut session_data: SessionData =
        serde_json::from_str(&content).map_err(|e| e.to_string())?;

    restore_loaded_session_stickers(&mut session_data.stickers);

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
    let mut history: HistoryData = serde_json::from_str(&content).unwrap_or_default();
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
    let payload: ToolSettingsData = serde_json::from_str(&content).unwrap_or_default();
    Ok(payload)
}
