#[cfg(target_os = "windows")]
use std::ffi::OsStr;
#[cfg(target_os = "windows")]
use std::os::windows::ffi::OsStrExt;

#[cfg(target_os = "windows")]
use windows::core::PCWSTR;
#[cfg(target_os = "windows")]
use windows::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE};
#[cfg(target_os = "windows")]
use windows::Win32::System::Threading::CreateMutexW;

pub(crate) const HOOK_SINGLE_INSTANCE_NAME: &str = "Local\\com.yamiyu.hook.SingleInstance";

/// Build the app-wide single-instance mutex name.
///
/// Hook installs a global low-level mouse hook and registers global hotkeys, so
/// running multiple test builds side-by-side is unsafe: they race on the same
/// pointer stream and can swallow each other's events. Keep the mutex global so
/// only one Hook process can own those system-wide hooks at a time.
#[cfg(target_os = "windows")]
pub(crate) fn single_instance_name() -> String {
    HOOK_SINGLE_INSTANCE_NAME.to_string()
}

#[cfg(target_os = "windows")]
pub(crate) struct SingleInstanceGuard {
    handle: HANDLE,
}

#[cfg(target_os = "windows")]
impl Drop for SingleInstanceGuard {
    fn drop(&mut self) {
        let _ = unsafe { CloseHandle(self.handle) };
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn try_acquire_single_instance(
    name: &str,
) -> Result<Option<SingleInstanceGuard>, String> {
    let wide_name: Vec<u16> = OsStr::new(name)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    let handle = unsafe { CreateMutexW(None, false, PCWSTR(wide_name.as_ptr())) }
        .map_err(|e| format!("CreateMutexW failed: {:?}", e))?;

    let already_exists = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
    if already_exists {
        let _ = unsafe { CloseHandle(handle) };
        return Ok(None);
    }

    Ok(Some(SingleInstanceGuard { handle }))
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn single_instance_name() -> String {
    HOOK_SINGLE_INSTANCE_NAME.to_string()
}

#[cfg(not(target_os = "windows"))]
pub(crate) struct SingleInstanceGuard;

#[cfg(not(target_os = "windows"))]
pub(crate) fn try_acquire_single_instance(
    _name: &str,
) -> Result<Option<SingleInstanceGuard>, String> {
    Ok(Some(SingleInstanceGuard))
}
