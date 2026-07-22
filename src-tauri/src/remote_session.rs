//! Global capture-hotkey gate, aligned with ShareX's approach.
//!
//! Reference: ShareX `CaptureHelpers.IsActiveWindowFullscreen()`
//!   https://github.com/ShareX/ShareX/blob/master/ShareX.HelpersLib/Helpers/CaptureHelpers.cs
//!
//! ShareX trigger gate (Hook defaults the option to on):
//!   `!DisableHotkeysOnFullscreen || !IsActiveWindowFullscreen()`
//! Fullscreen test: window rect **contains** the monitor rect; ignore Progman / WorkerW.

#[cfg(target_os = "windows")]
use windows::Win32::Foundation::{HWND, RECT};
#[cfg(target_os = "windows")]
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
};
#[cfg(target_os = "windows")]
use windows::Win32::UI::WindowsAndMessaging::{
    GetClassNameW, GetForegroundWindow, GetWindowRect, GetWindowThreadProcessId,
};

use crate::app_settings::AppSettings;

/// Desktop shell windows that report as "fullscreen" but must never suppress
/// hotkeys (same ignore list as ShareX).
#[cfg(target_os = "windows")]
const DESKTOP_SHELL_CLASSES: &[&str] = &["Progman", "WorkerW"];

/// Returns true when a global capture / long-capture hotkey should not run.
pub(crate) fn should_ignore_global_capture_hotkey(settings: &AppSettings) -> bool {
    if !settings.disable_hotkeys_on_fullscreen {
        return false;
    }
    #[cfg(target_os = "windows")]
    {
        if is_active_window_fullscreen() {
            crate::append_runtime_log_line(
                "global_capture_hotkey_suppressed :: reason=active_window_fullscreen",
            );
            return true;
        }
        false
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

/// ShareX-compatible fullscreen probe:
/// foreground window rectangle contains its monitor's bounds.
#[cfg(target_os = "windows")]
fn is_active_window_fullscreen() -> bool {
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.0.is_null() {
        return false;
    }

    // Never treat Hook's own overlay / settings as an exclusive session.
    if window_belongs_to_current_process(hwnd) {
        return false;
    }

    let class_name = match window_class_name(hwnd) {
        Some(name) => name,
        None => return false,
    };
    if DESKTOP_SHELL_CLASSES
        .iter()
        .any(|ignore| class_name.eq_ignore_ascii_case(ignore))
    {
        return false;
    }

    let window = match window_rect(hwnd) {
        Some(rect) => rect,
        None => return false,
    };
    let monitor = match monitor_rect(hwnd) {
        Some(rect) => rect,
        None => return false,
    };

    // ShareX: `windowRectangle.Contains(monitorRectangle)`
    rect_contains(&window, &monitor)
}

#[cfg(target_os = "windows")]
fn window_belongs_to_current_process(hwnd: HWND) -> bool {
    let mut process_id = 0u32;
    let _ = unsafe { GetWindowThreadProcessId(hwnd, Some(&mut process_id)) };
    process_id != 0 && process_id == std::process::id()
}

#[cfg(target_os = "windows")]
fn window_class_name(hwnd: HWND) -> Option<String> {
    let mut buffer = [0u16; 256];
    let len = unsafe { GetClassNameW(hwnd, &mut buffer) };
    if len <= 0 {
        return None;
    }
    Some(String::from_utf16_lossy(&buffer[..len as usize]))
}

#[cfg(target_os = "windows")]
fn window_rect(hwnd: HWND) -> Option<RECT> {
    let mut rect = RECT::default();
    unsafe { GetWindowRect(hwnd, &mut rect) }.ok()?;
    if rect.right <= rect.left || rect.bottom <= rect.top {
        return None;
    }
    Some(rect)
}

#[cfg(target_os = "windows")]
fn monitor_rect(hwnd: HWND) -> Option<RECT> {
    let monitor = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
    let mut info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    unsafe { GetMonitorInfoW(monitor, &mut info) }.ok()?;
    if info.rcMonitor.right <= info.rcMonitor.left || info.rcMonitor.bottom <= info.rcMonitor.top {
        return None;
    }
    Some(info.rcMonitor)
}

#[cfg(target_os = "windows")]
fn rect_contains(outer: &RECT, inner: &RECT) -> bool {
    outer.left <= inner.left
        && outer.top <= inner.top
        && outer.right >= inner.right
        && outer.bottom >= inner.bottom
}
