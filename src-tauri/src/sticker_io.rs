#[cfg(target_os = "windows")]
use crate::dialogs::select_sticker_save_path;
use crate::runtime::{
    append_runtime_log_line, cache_file_name_for_log, decode_base64_image_data,
    ensure_clipboard_cache_dir, file_timestamp_component, sanitize_drag_filename_hint,
    validate_image_data_limits, MAX_BASE64_IMAGE_ENCODED_BYTES,
};
use base64::Engine as _;
use std::fs;
use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};

#[cfg(target_os = "windows")]
use uiautomation::types::Point as UiaPoint;
#[cfg(target_os = "windows")]
use uiautomation::UIAutomation;
#[cfg(target_os = "windows")]
use windows::core::Interface;
#[cfg(target_os = "windows")]
use windows::Win32::Foundation::{HWND, POINT, RECT};
#[cfg(target_os = "windows")]
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_APARTMENTTHREADED,
};
#[cfg(target_os = "windows")]
use windows::Win32::System::Variant::{
    VARIANT, VARIANT_0, VARIANT_0_0, VARIANT_0_0_0, VT_I4,
};
#[cfg(target_os = "windows")]
use windows::Win32::UI::Shell::{IShellWindows, IWebBrowser2, ShellWindows};
#[cfg(target_os = "windows")]
use windows::Win32::UI::WindowsAndMessaging::{
    GetAncestor, GetClassNameW, GetWindowRect, WindowFromPoint, GA_ROOT,
};

#[cfg(not(target_os = "windows"))]
pub fn save_sticker_image(app: tauri::AppHandle, base64_image: String) -> Result<String, String> {
    let image_data = decode_base64_image_data(&base64_image)?;

    // 1. Resolve a user-writable destination. Writing next to the executable
    //    fails when Hook is installed under Program Files (read-only) and is
    //    poor practice; persist user data under the app data dir instead.
    let app_dir = effective_app_data_dir(&app)?;
    let saved_dir = app_dir.join("saved");
    fs::create_dir_all(&saved_dir).map_err(|e| format!("Failed to create save dir: {}", e))?;

    // 2. Generate Filename
    let timestamp = file_timestamp_component();
    let filename = format!("{}.png", timestamp);
    let file_path = saved_dir.join(&filename);

    // 3. Write File
    let mut file = File::create(&file_path).map_err(|e| format!("Failed to create file: {}", e))?;
    file.write_all(&image_data)
        .map_err(|e| format!("Failed to write file: {}", e))?;

    println!("Saved sticker to: {:?}", file_path);
    Ok(file_path.to_string_lossy().to_string())
}

#[cfg(target_os = "windows")]
#[tauri::command]
pub fn save_sticker_image_as(
    app: tauri::AppHandle,
    base64_image: String,
    dialog_center_x: f64,
    dialog_center_y: f64,
) -> Result<Option<String>, String> {
    let image_data = decode_base64_image_data(&base64_image)?;
    let Some(file_path) = select_sticker_save_path(&app, dialog_center_x, dialog_center_y)? else {
        return Ok(None);
    };

    let mut file = File::create(&file_path).map_err(|e| format!("Failed to create file: {}", e))?;
    file.write_all(&image_data)
        .map_err(|e| format!("Failed to write file: {}", e))?;

    let path_string = file_path.to_string_lossy().to_string();
    println!("Saved sticker via save-as dialog to: {}", path_string);
    Ok(Some(path_string))
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub fn save_sticker_image_as(
    app: tauri::AppHandle,
    base64_image: String,
    _dialog_center_x: f64,
    _dialog_center_y: f64,
) -> Result<Option<String>, String> {
    save_sticker_image(app, base64_image).map(Some)
}

#[cfg(target_os = "windows")]
fn variant_i4(value: i32) -> VARIANT {
    VARIANT {
        Anonymous: VARIANT_0 {
            Anonymous: std::mem::ManuallyDrop::new(VARIANT_0_0 {
                vt: VT_I4,
                wReserved1: 0,
                wReserved2: 0,
                wReserved3: 0,
                Anonymous: VARIANT_0_0_0 { lVal: value },
            }),
        },
    }
}

#[cfg(target_os = "windows")]
fn percent_decode_utf8(input: &str) -> String {
    let mut bytes = Vec::with_capacity(input.len());
    let raw = input.as_bytes();
    let mut index = 0;
    while index < raw.len() {
        if raw[index] == b'%' && index + 2 < raw.len() {
            if let Ok(hex) = u8::from_str_radix(&input[index + 1..index + 3], 16) {
                bytes.push(hex);
                index += 3;
                continue;
            }
        }
        bytes.push(raw[index]);
        index += 1;
    }
    String::from_utf8_lossy(&bytes).to_string()
}

#[cfg(target_os = "windows")]
fn path_from_file_url(url: &str) -> Option<PathBuf> {
    let rest = url.strip_prefix("file://")?;
    let (host, path_part) = if let Some((host, path)) = rest.split_once('/') {
        (host, format!("/{}", path))
    } else {
        ("", String::new())
    };
    let decoded_path = percent_decode_utf8(&path_part);
    let path = if host.is_empty() {
        let without_leading_slash = if decoded_path.len() >= 3
            && decoded_path.as_bytes().first() == Some(&b'/')
            && decoded_path.as_bytes().get(2) == Some(&b':')
        {
            &decoded_path[1..]
        } else {
            decoded_path.as_str()
        };
        without_leading_slash.replace('/', "\\")
    } else {
        format!(
            "\\\\{}{}",
            percent_decode_utf8(host),
            decoded_path.replace('/', "\\")
        )
    };
    if path.is_empty() {
        return None;
    }
    Some(PathBuf::from(path))
}

#[cfg(target_os = "windows")]
fn point_in_rect(x: i32, y: i32, rect: &RECT) -> bool {
    x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom
}

#[cfg(target_os = "windows")]
fn explorer_folder_candidates_at_point(x: i32, y: i32) -> Vec<(PathBuf, i64, bool)> {
    let mut candidates = Vec::new();
    let point = POINT { x, y };
    let point_root = unsafe {
        let hwnd = WindowFromPoint(point);
        if hwnd.0.is_null() {
            HWND(std::ptr::null_mut())
        } else {
            GetAncestor(hwnd, GA_ROOT)
        }
    };

    let com_initialized = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok() };
    let shell_windows = unsafe { CoCreateInstance::<_, IShellWindows>(&ShellWindows, None, CLSCTX_ALL) };
    let Ok(shell_windows) = shell_windows else {
        if com_initialized {
            unsafe { CoUninitialize() };
        }
        return candidates;
    };

    let count = unsafe { shell_windows.Count().unwrap_or(0) };
    for index in 0..count {
        let item_variant = variant_i4(index);
        let Ok(dispatch) = (unsafe { shell_windows.Item(&item_variant) }) else {
            continue;
        };
        let Ok(browser) = dispatch.cast::<IWebBrowser2>() else {
            continue;
        };
        let Ok(shell_hwnd) = (unsafe { browser.HWND() }) else {
            continue;
        };
        let hwnd = HWND(shell_hwnd.0 as *mut _);
        if hwnd.0.is_null() {
            continue;
        }
        let mut rect = RECT::default();
        if unsafe { GetWindowRect(hwnd, &mut rect) }.is_err() || !point_in_rect(x, y, &rect) {
            continue;
        }
        let Ok(location_url) = (unsafe { browser.LocationURL() }) else {
            continue;
        };
        let Some(folder_path) = path_from_file_url(&location_url.to_string()) else {
            continue;
        };
        if !folder_path.is_dir() {
            continue;
        }
        let area = i64::from(rect.right - rect.left) * i64::from(rect.bottom - rect.top);
        candidates.push((folder_path, area, !point_root.0.is_null() && point_root == hwnd));
    }

    if com_initialized {
        unsafe { CoUninitialize() };
    }
    candidates
}

#[cfg(target_os = "windows")]
fn window_class_name_at_point(x: i32, y: i32) -> Option<String> {
    let hwnd = unsafe { WindowFromPoint(POINT { x, y }) };
    if hwnd.0.is_null() {
        return None;
    }
    let root = unsafe { GetAncestor(hwnd, GA_ROOT) };
    let target = if root.0.is_null() { hwnd } else { root };
    let mut buffer = [0u16; 256];
    let len = unsafe { GetClassNameW(target, &mut buffer) };
    if len <= 0 {
        return None;
    }
    Some(String::from_utf16_lossy(&buffer[..len as usize]))
}

#[cfg(target_os = "windows")]
fn desktop_dir_for_drag_export() -> Option<PathBuf> {
    dirs::desktop_dir().filter(|path| path.is_dir())
}

#[cfg(target_os = "windows")]
fn explorer_child_folder_at_point(x: i32, y: i32, parent_dir: &Path) -> Option<PathBuf> {
    let automation = UIAutomation::new().ok()?;
    let element = automation.element_from_point(UiaPoint::new(x, y)).ok()?;
    let name = element.get_name().ok()?;
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.contains('\\') || trimmed.contains('/') {
        return None;
    }
    let candidate = parent_dir.join(trimmed);
    if candidate.is_dir() {
        Some(candidate)
    } else {
        None
    }
}

#[cfg(target_os = "windows")]
fn resolve_drag_export_target_dir(global_x: f64, global_y: f64) -> Result<PathBuf, String> {
    let x = global_x.round() as i32;
    let y = global_y.round() as i32;
    let mut candidates = explorer_folder_candidates_at_point(x, y);
    candidates.sort_by_key(|(_, area, root_match)| (!*root_match, *area));
    if let Some((path, _, root_match)) = candidates.into_iter().next() {
        if let Some(child_folder) = explorer_child_folder_at_point(x, y, &path) {
            append_runtime_log_line(&format!(
                "sticker_drag_export_target_explorer_child :: x={} y={} rootMatch={} parent={} path={}",
                x,
                y,
                root_match,
                path.to_string_lossy(),
                child_folder.to_string_lossy()
            ));
            return Ok(child_folder);
        }
        append_runtime_log_line(&format!(
            "sticker_drag_export_target_explorer :: x={} y={} rootMatch={} path={}",
            x,
            y,
            root_match,
            path.to_string_lossy()
        ));
        return Ok(path);
    }

    let class_name = window_class_name_at_point(x, y).unwrap_or_else(|| "unknown".to_string());
    if matches!(
        class_name.as_str(),
        "Progman" | "WorkerW" | "SHELLDLL_DefView" | "SysListView32"
    ) {
        if let Some(desktop) = desktop_dir_for_drag_export() {
            append_runtime_log_line(&format!(
                "sticker_drag_export_target_desktop :: x={} y={} class={} path={}",
                x,
                y,
                class_name,
                desktop.to_string_lossy()
            ));
            return Ok(desktop);
        }
    }

    append_runtime_log_line(&format!(
        "sticker_drag_export_target_missing :: x={} y={} class={}",
        x, y, class_name
    ));
    Err(format!(
        "No Explorer folder found under release cursor ({}, {})",
        x, y
    ))
}

#[cfg(target_os = "windows")]
fn drag_export_filename(filename_hint: Option<&str>, source_path: Option<&Path>) -> String {
    let stem = filename_hint
        .map(|hint| sanitize_drag_filename_hint(Some(hint)))
        .filter(|value| !value.is_empty())
        .or_else(|| {
            source_path
                .and_then(|path| path.file_stem())
                .and_then(|stem| stem.to_str())
                .map(|stem| sanitize_drag_filename_hint(Some(stem)))
        })
        .unwrap_or_else(|| "hook".to_string());
    let extension = source_path
        .and_then(|path| path.extension())
        .and_then(|extension| extension.to_str())
        .map(|extension| {
            extension
                .chars()
                .filter(|ch| ch.is_ascii_alphanumeric())
                .take(8)
                .collect::<String>()
                .to_ascii_lowercase()
        })
        .filter(|extension| !extension.is_empty())
        .unwrap_or_else(|| "png".to_string());
    format!("{}.{}", stem, extension)
}

#[cfg(target_os = "windows")]
fn unique_drag_export_path(target_dir: &Path, filename: &str) -> PathBuf {
    let candidate = target_dir.join(filename);
    if !candidate.exists() {
        return candidate;
    }

    let path = Path::new(filename);
    let stem = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .filter(|stem| !stem.is_empty())
        .unwrap_or("hook");
    let extension = path.extension().and_then(|extension| extension.to_str());
    for index in 2..10_000 {
        let next_name = if let Some(extension) = extension {
            format!("{}_{}.{}", stem, index, extension)
        } else {
            format!("{}_{}", stem, index)
        };
        let next = target_dir.join(next_name);
        if !next.exists() {
            return next;
        }
    }
    target_dir.join(format!("{}_{}.png", stem, file_timestamp_component()))
}

#[cfg(target_os = "windows")]
fn write_drag_export_bytes(
    image_data: &[u8],
    filename_hint: Option<String>,
    global_x: f64,
    global_y: f64,
) -> Result<String, String> {
    let target_dir = resolve_drag_export_target_dir(global_x, global_y)?;
    let filename = drag_export_filename(filename_hint.as_deref(), None);
    let target_path = unique_drag_export_path(&target_dir, &filename);
    let mut file = File::create(&target_path)
        .map_err(|e| format!("Failed to create drag export file: {}", e))?;
    file.write_all(image_data)
        .map_err(|e| format!("Failed to write drag export file: {}", e))?;
    let path_string = target_path.to_string_lossy().to_string();
    append_runtime_log_line(&format!("sticker_drag_export_saved :: path={}", path_string));
    Ok(path_string)
}

#[cfg(target_os = "windows")]
#[tauri::command]
pub fn save_sticker_drag_export(
    base64_image: String,
    filename_hint: Option<String>,
    global_x: f64,
    global_y: f64,
) -> Result<String, String> {
    let image_data = decode_base64_image_data(&base64_image)?;
    write_drag_export_bytes(&image_data, filename_hint, global_x, global_y)
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub fn save_sticker_drag_export(
    app: tauri::AppHandle,
    base64_image: String,
    filename_hint: Option<String>,
    _global_x: f64,
    _global_y: f64,
) -> Result<String, String> {
    let _ = filename_hint;
    save_sticker_image(app, base64_image)
}

#[cfg(target_os = "windows")]
#[tauri::command]
pub fn save_sticker_drag_export_from_path(
    path: String,
    filename_hint: Option<String>,
    global_x: f64,
    global_y: f64,
) -> Result<String, String> {
    let source_path = PathBuf::from(&path);
    if !source_path.is_file() {
        return Err(format!("Sticker drag export source is not a file: {}", path));
    }
    let target_dir = resolve_drag_export_target_dir(global_x, global_y)?;
    let filename = drag_export_filename(filename_hint.as_deref(), Some(&source_path));
    let target_path = unique_drag_export_path(&target_dir, &filename);
    fs::copy(&source_path, &target_path)
        .map_err(|e| format!("Failed to copy drag export file: {}", e))?;
    let path_string = target_path.to_string_lossy().to_string();
    append_runtime_log_line(&format!(
        "sticker_drag_export_copied :: source={} target={}",
        source_path.to_string_lossy(),
        path_string
    ));
    Ok(path_string)
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub fn save_sticker_drag_export_from_path(
    path: String,
    _filename_hint: Option<String>,
    _global_x: f64,
    _global_y: f64,
) -> Result<String, String> {
    Ok(path)
}

fn load_rgba_image_from_bytes(
    image_bytes: &[u8],
) -> Result<(usize, usize, Vec<u8>), String> {
    let img =
        image::load_from_memory(image_bytes).map_err(|e| format!("Image load failed: {}", e))?;
    let rgba = img.to_rgba8();
    let width = rgba.width() as usize;
    let height = rgba.height() as usize;
    Ok((width, height, rgba.into_raw()))
}

fn make_arboard_image_data(
    width: usize,
    height: usize,
    raw_bytes: Vec<u8>,
) -> arboard::ImageData<'static> {
    arboard::ImageData {
        width,
        height,
        bytes: std::borrow::Cow::Owned(raw_bytes),
    }
}

#[cfg(not(target_os = "windows"))]
fn write_rgba_image_to_clipboard(width: usize, height: usize, raw_bytes: Vec<u8>) -> Result<(), String> {
    let mut clipboard =
        arboard::Clipboard::new().map_err(|e| format!("Clipboard init failed: {}", e))?;
    clipboard
        .set_image(make_arboard_image_data(width, height, raw_bytes))
        .map_err(|e| format!("Clipboard write failed: {}", e))?;
    Ok(())
}

#[cfg(target_os = "windows")]
#[tauri::command]
pub fn copy_sticker_image_to_smart_clipboard(base64_image: String) -> Result<String, String> {
    // Publish both clipboard representations from one command:
    // browsers/rich editors read the image formats, Explorer reads CF_HDROP.
    let image_data = decode_base64_image_data(&base64_image)?;
    let (width, height, raw_bytes) = load_rgba_image_from_bytes(&image_data)?;

    let cache_dir = ensure_clipboard_cache_dir()?;
    let timestamp = file_timestamp_component();
    let file_path = cache_dir.join(format!("Hook_{}.png", timestamp));
    let mut file = File::create(&file_path).map_err(|e| format!("Failed to create file: {}", e))?;
    file.write_all(&image_data)
        .map_err(|e| format!("Failed to write file: {}", e))?;

    let mut clipboard =
        arboard::Clipboard::new().map_err(|e| format!("Clipboard init failed: {}", e))?;
    let clipboard_image = make_arboard_image_data(width, height, raw_bytes);

    clipboard
        .set()
        .image(clipboard_image)
        .map_err(|e| format!("Clipboard image write failed: {}", e))?;
    clipboard
        .set()
        .file_list(&[file_path.as_path()])
        .map_err(|e| format!("Clipboard file-list write failed: {}", e))?;

    let path_string = file_path.to_string_lossy().to_string();
    println!(
        "Copied smart image/file clipboard cache payload: {}",
        cache_file_name_for_log(&file_path)
    );
    Ok(path_string)
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub fn copy_sticker_image_to_smart_clipboard(base64_image: String) -> Result<String, String> {
    copy_to_clipboard(base64_image)?;
    Ok("image clipboard only; file-list paste is Windows-only".to_string())
}

#[cfg(not(target_os = "windows"))]
fn copy_to_clipboard(base64_image: String) -> Result<(), String> {
    let image_bytes = decode_base64_image_data(&base64_image)?;
    let (width, height, raw_bytes) = load_rgba_image_from_bytes(&image_bytes)?;
    write_rgba_image_to_clipboard(width, height, raw_bytes)?;
    println!("Image copied to system clipboard");
    Ok(())
}

fn mime_from_image_format(format: image::ImageFormat) -> Option<&'static str> {
    match format {
        image::ImageFormat::Png => Some("image/png"),
        image::ImageFormat::Jpeg => Some("image/jpeg"),
        image::ImageFormat::WebP => Some("image/webp"),
        image::ImageFormat::Bmp => Some("image/bmp"),
        image::ImageFormat::Gif => Some("image/gif"),
        _ => None,
    }
}

fn mime_from_image_path(path: &Path, bytes: &[u8]) -> &'static str {
    if let Some(mime) = image::guess_format(bytes)
        .ok()
        .and_then(mime_from_image_format)
    {
        return mime;
    }

    if let Some(mime) = image::ImageFormat::from_path(path)
        .ok()
        .and_then(mime_from_image_format)
    {
        return mime;
    }

    let lower = path.to_string_lossy().to_ascii_lowercase();
    if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "image/jpeg"
    } else if lower.ends_with(".webp") {
        "image/webp"
    } else if lower.ends_with(".bmp") {
        "image/bmp"
    } else if lower.ends_with(".gif") {
        "image/gif"
    } else {
        "image/png"
    }
}

#[tauri::command]
pub fn read_image_from_path(path: String) -> Result<String, String> {
    println!("Backend: Reading image from path: {}", path);

    // Bound the read: refuse files above the encoded-image limit before
    // loading them into memory. This keeps the command a bounded image reader
    // rather than an arbitrary file-read primitive.
    let metadata = fs::metadata(&path).map_err(|e| format!("Failed to stat file: {}", e))?;
    if !metadata.is_file() {
        return Err("Path is not a regular file".to_string());
    }
    if metadata.len() > MAX_BASE64_IMAGE_ENCODED_BYTES as u64 {
        return Err(format!(
            "Image file too large: {} bytes exceeds limit {}",
            metadata.len(),
            MAX_BASE64_IMAGE_ENCODED_BYTES
        ));
    }

    // 1. Read Bytes
    let bytes = fs::read(&path).map_err(|e| format!("Failed to read file: {}", e))?;

    // 2. Require the bytes to be a decodable image within pixel limits.
    //    Rejects non-image files so this cannot be used to exfiltrate
    //    arbitrary local content as base64.
    validate_image_data_limits(&bytes)?;

    // 3. Encode Base64
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);

    // 4. Determine MIME from the actual image bytes first, then fall back to the path.
    let mime = mime_from_image_path(Path::new(&path), &bytes);

    Ok(format!("data:{};base64,{}", mime, b64))
}
