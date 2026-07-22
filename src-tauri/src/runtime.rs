use crate::capture::CaptureResponse;
use crate::portable_paths;
use base64::Engine as _;
use std::fs;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, OnceLock};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

fn runtime_log_dir() -> PathBuf {
    portable_paths::portable_runtime_log_dir()
}

pub(crate) fn effective_app_data_dir(_app: &tauri::AppHandle) -> Result<PathBuf, String> {
    portable_paths::ensure_portable_app_data_dir()
}

const RUNTIME_LOG_QUEUE_CAPACITY: usize = 512;
static RUNTIME_LOG_SENDER: OnceLock<mpsc::SyncSender<String>> = OnceLock::new();

fn append_runtime_log_line_sync(line: &str) {
    let dir = runtime_log_dir();
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }

    let path = dir.join("hook-runtime.log");
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = writeln!(file, "{}", line);
    }
}

fn runtime_log_sender() -> &'static mpsc::SyncSender<String> {
    RUNTIME_LOG_SENDER.get_or_init(|| {
        let (sender, receiver) = mpsc::sync_channel::<String>(RUNTIME_LOG_QUEUE_CAPACITY);
        let _ = std::thread::Builder::new()
            .name("hook-runtime-log".to_string())
            .spawn(move || {
                while let Ok(line) = receiver.recv() {
                    append_runtime_log_line_sync(&line);
                }
            });
        sender
    })
}

pub(crate) fn append_runtime_log_line(message: &str) {
    let timestamp = runtime_log_timestamp();
    let line = format!("[{}] {}", timestamp, message);
    let _ = runtime_log_sender().try_send(line);
}

#[tauri::command]
pub fn append_runtime_log(_app: tauri::AppHandle, event: String, detail: Option<String>) {
    let suffix = detail
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| format!(" :: {}", value))
        .unwrap_or_default();
    append_runtime_log_line(&format!("{}{}", event, suffix));
}

pub(crate) fn unix_timestamp_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn runtime_log_timestamp() -> String {
    unix_timestamp_millis().to_string()
}

pub(crate) fn file_timestamp_component() -> String {
    unix_timestamp_millis().to_string()
}

pub(crate) fn sanitize_drag_filename_hint(hint: Option<&str>) -> String {
    let sanitized: String = hint
        .unwrap_or("hook")
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect();

    let collapsed = sanitized.trim_matches('_');
    if collapsed.is_empty() {
        "hook".to_string()
    } else {
        collapsed.chars().take(48).collect()
    }
}

pub(crate) const MAX_BASE64_IMAGE_ENCODED_BYTES: usize = 64 * 1024 * 1024;
pub(crate) const MAX_IMAGE_PIXELS: u64 = 100_000_000;
// Per-image limits above bound a single frame, but a stitch call takes a whole
// Vec of frames that are each decoded to a full bitmap. Without an aggregate cap
// a caller can submit thousands of max-size frames and exhaust memory. This caps
// the frame count; combined with the per-frame pixel limit it bounds peak memory.
const CLIPBOARD_CACHE_MAX_AGE_SECS: u64 = 7 * 24 * 60 * 60;
const CLIPBOARD_CACHE_MAX_BYTES: u64 = 256 * 1024 * 1024;
const CLIPBOARD_CACHE_TARGET_BYTES: u64 = 128 * 1024 * 1024;

pub(crate) fn decode_base64_image_data(base64_image: &str) -> Result<Vec<u8>, String> {
    let base64_data = base64_image.split(",").last().unwrap_or(base64_image);
    if base64_data.len() > MAX_BASE64_IMAGE_ENCODED_BYTES {
        return Err(format!(
            "Image payload too large: {} encoded bytes exceeds limit {}",
            base64_data.len(),
            MAX_BASE64_IMAGE_ENCODED_BYTES
        ));
    }

    let image_data = base64::engine::general_purpose::STANDARD
        .decode(base64_data)
        .map_err(|e| format!("Base64 decode failed: {}", e))?;
    validate_image_data_limits(&image_data)?;
    Ok(image_data)
}

pub(crate) fn validate_image_data_limits(image_data: &[u8]) -> Result<(), String> {
    let image =
        image::load_from_memory(image_data).map_err(|e| format!("Image load failed: {}", e))?;
    let pixels = u64::from(image.width()) * u64::from(image.height());
    if pixels > MAX_IMAGE_PIXELS {
        return Err(format!(
            "Image dimensions too large: {}x{} exceeds {} pixels",
            image.width(),
            image.height(),
            MAX_IMAGE_PIXELS
        ));
    }
    Ok(())
}

fn clipboard_cache_dir() -> PathBuf {
    portable_paths::portable_clipboard_cache_dir()
}

pub(crate) fn cleanup_clipboard_cache() -> Result<(), String> {
    let dir = clipboard_cache_dir();
    cleanup_clipboard_cache_dir(
        &dir,
        SystemTime::now(),
        CLIPBOARD_CACHE_MAX_BYTES,
        CLIPBOARD_CACHE_TARGET_BYTES,
    )
}

fn cleanup_clipboard_cache_dir(
    dir: &Path,
    now: SystemTime,
    max_total_bytes: u64,
    target_total_bytes: u64,
) -> Result<(), String> {
    if !dir.exists() {
        return Ok(());
    }

    let max_age = std::time::Duration::from_secs(CLIPBOARD_CACHE_MAX_AGE_SECS);
    let mut entries = Vec::new();
    for entry in fs::read_dir(dir).map_err(|e| format!("Failed to read clipboard cache: {}", e))? {
        let entry = entry.map_err(|e| format!("Failed to inspect clipboard cache: {}", e))?;
        let metadata = match entry.metadata() {
            Ok(metadata) if metadata.is_file() => metadata,
            _ => continue,
        };
        let modified = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        if now.duration_since(modified).unwrap_or_default() > max_age {
            let _ = fs::remove_file(entry.path());
            continue;
        }
        entries.push((entry.path(), modified, metadata.len()));
    }

    let mut total_bytes: u64 = entries.iter().map(|(_, _, len)| *len).sum();
    if total_bytes < max_total_bytes {
        return Ok(());
    }

    entries.sort_by_key(|(_, modified, _)| *modified);
    for (path, _, len) in entries {
        if total_bytes <= target_total_bytes {
            break;
        }
        if fs::remove_file(&path).is_ok() {
            total_bytes = total_bytes.saturating_sub(len);
        }
    }

    Ok(())
}

pub(crate) fn ensure_clipboard_cache_dir() -> Result<PathBuf, String> {
    let cache_dir = clipboard_cache_dir();
    fs::create_dir_all(&cache_dir).map_err(|e| format!("Failed to create cache dir: {}", e))?;
    let _ = cleanup_clipboard_cache_dir(
        &cache_dir,
        SystemTime::now(),
        CLIPBOARD_CACHE_MAX_BYTES,
        CLIPBOARD_CACHE_TARGET_BYTES,
    );
    Ok(cache_dir)
}

pub(crate) fn cache_file_name_for_log(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "<unknown>".to_string())
}


pub(crate) fn encode_rgb_image_as_file_capture_response(
    rgb_image: image::RgbImage,
) -> Result<CaptureResponse, String> {
    let started_at = Instant::now();
    let width = rgb_image.width();
    let height = rgb_image.height();
    let cache_dir = ensure_clipboard_cache_dir()?;
    let file_path = cache_dir.join(format!(
        "Hook_long_capture_{}.png",
        file_timestamp_component()
    ));

    let file_write_started_at = Instant::now();
    {
        use image::codecs::png::{CompressionType, FilterType, PngEncoder};
        use image::{ColorType, ImageEncoder};

        let file =
            File::create(&file_path).map_err(|error| format!("Failed to create PNG: {error}"))?;
        let mut writer = BufWriter::new(file);
        let encoder =
            PngEncoder::new_with_quality(&mut writer, CompressionType::Fast, FilterType::NoFilter);
        encoder
            .write_image(rgb_image.as_raw(), width, height, ColorType::Rgb8.into())
            .map_err(|error| error.to_string())?;
        writer
            .flush()
            .map_err(|error| format!("Failed to flush PNG: {error}"))?;
    }
    let file_write_ms = file_write_started_at.elapsed().as_millis();
    let png_bytes = fs::metadata(&file_path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    let file_path_string = file_path.to_string_lossy().to_string();
    append_runtime_log_line(&format!(
        "encode_rgb_image_as_file_capture_response :: width={} height={} png_bytes={} file_write_ms={} total_ms={} path={}",
        width,
        height,
        png_bytes,
        file_write_ms,
        started_at.elapsed().as_millis(),
        cache_file_name_for_log(&file_path)
    ));

    Ok(CaptureResponse {
        width,
        height,
        file_path: file_path_string,
    })
}

