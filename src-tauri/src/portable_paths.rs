use std::fs;
use std::path::PathBuf;

/// Directory containing the running executable.
pub fn exe_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(|parent| parent.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
}

/// Portable app data root: `{exe_dir}/data` (override with `HOOK_APPDATA_DIR`).
pub fn portable_app_data_dir() -> PathBuf {
    if let Some(override_dir) = std::env::var_os("HOOK_APPDATA_DIR")
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
    {
        return override_dir;
    }
    exe_dir().join("data")
}

/// Ensure the portable data directory exists and return it.
pub fn ensure_portable_app_data_dir() -> Result<PathBuf, String> {
    let dir = portable_app_data_dir();
    fs::create_dir_all(&dir).map_err(|error| format!("Failed to create data dir: {error}"))?;
    Ok(dir)
}

/// Screenshot / clipboard file cache under portable data (override with `HOOK_CLIPBOARD_CACHE_DIR`).
pub fn portable_clipboard_cache_dir() -> PathBuf {
    if let Some(override_dir) = std::env::var_os("HOOK_CLIPBOARD_CACHE_DIR")
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
    {
        return override_dir;
    }
    portable_app_data_dir().join("screenshots")
}

/// Runtime logs under portable data (override with `HOOK_LOG_DIR`).
pub fn portable_runtime_log_dir() -> PathBuf {
    if let Some(override_dir) = std::env::var_os("HOOK_LOG_DIR")
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
    {
        return override_dir;
    }
    portable_app_data_dir().join("logs")
}
