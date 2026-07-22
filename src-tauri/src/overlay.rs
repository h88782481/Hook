use crate::app_settings;
use crate::capture_coords::{normalize_global_physical_to_local_logical, CaptureWindowMetrics};
use crate::long_capture_session::{LongCaptureWheelEvent, SharedLongCaptureSessions};
use crate::mouse_monitor::{self, SharedHitMap};
use crate::runtime::append_runtime_log_line;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{Emitter, LogicalSize, Manager, PhysicalPosition, Size};
#[cfg(target_os = "windows")]
use windows::core::{BOOL, PCWSTR};
#[cfg(target_os = "windows")]
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
#[cfg(target_os = "windows")]
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
#[cfg(target_os = "windows")]
use windows::Win32::Graphics::Gdi::{
    CombineRgn, CreateRectRgn, DeleteObject, SetWindowRgn, RGN_OR,
};
#[cfg(target_os = "windows")]
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, VK_BACK, VK_CONTROL, VK_DELETE, VK_ESCAPE, VK_LSHIFT, VK_MENU, VK_RSHIFT,
    VK_SHIFT,
};
#[cfg(target_os = "windows")]
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, CallWindowProcW, CreateWindowExW, DefWindowProcW, DispatchMessageW,
    EnumWindows, GetCursorPos, GetMessageW, GetWindowLongPtrW, GetWindowRect,
    GetWindowThreadProcessId, IsWindowVisible, SetLayeredWindowAttributes, SetWindowLongPtrW,
    SetWindowPos, SetWindowsHookExW, ShowWindow, SystemParametersInfoW, TranslateMessage,
    UnhookWindowsHookEx, GWLP_WNDPROC, GWL_EXSTYLE, HC_ACTION, HWND_TOPMOST, LWA_ALPHA,
    MA_NOACTIVATE, MSG, MSLLHOOKSTRUCT, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
    SWP_NOZORDER, SWP_SHOWWINDOW, KBDLLHOOKSTRUCT, SW_HIDE, SW_SHOWNA, SPI_SETCURSORS,
    WH_KEYBOARD_LL, WH_MOUSE_LL, WM_KEYDOWN, WM_KEYUP, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MBUTTONDOWN,
    WM_MBUTTONUP, WM_MOUSEACTIVATE, WM_MOUSEMOVE, WM_MOUSEWHEEL, WM_RBUTTONDOWN, WM_RBUTTONUP,
    WM_XBUTTONDOWN, WM_XBUTTONUP, WNDPROC, WS_EX_LAYERED, WM_SYSKEYDOWN, WM_SYSKEYUP,
    WS_EX_TRANSPARENT, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_POPUP,
};

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ScreenColorSample {
    hex: String,
    rgb: ScreenColorRgb,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ScreenColorRgb {
    r: u8,
    g: u8,
    b: u8,
}

#[cfg(target_os = "windows")]
fn sample_screen_color_physical(x: i32, y: i32) -> Result<ScreenColorSample, String> {
    use windows::Win32::Graphics::Gdi::{GetDC, GetPixel, ReleaseDC};

    let screen_dc = unsafe { GetDC(None) };
    if screen_dc.is_invalid() {
        return Err("Screen DC unavailable".to_string());
    }

    let color = unsafe { GetPixel(screen_dc, x, y) };
    unsafe {
        ReleaseDC(None, screen_dc);
    }

    if color.0 == u32::MAX {
        return Err("Screen pixel unavailable".to_string());
    }

    let raw = color.0;
    let r = (raw & 0x0000_00ff) as u8;
    let g = ((raw & 0x0000_ff00) >> 8) as u8;
    let b = ((raw & 0x00ff_0000) >> 16) as u8;

    Ok(ScreenColorSample {
        hex: format!("#{r:02x}{g:02x}{b:02x}"),
        rgb: ScreenColorRgb { r, g, b },
    })
}

#[cfg(not(target_os = "windows"))]
fn sample_screen_color_physical(_x: i32, _y: i32) -> Result<ScreenColorSample, String> {
    Err("Screen color picking is only supported on Windows".to_string())
}

fn capture_window_metrics(window: &tauri::WebviewWindow) -> Option<CaptureWindowMetrics> {
    // current_monitor() is relatively expensive; cache briefly so capture mouse-move
    // IPC stays cheap enough that Windows won't silently unload the LL hook.
    static CACHE: OnceLock<Mutex<Option<(Instant, CaptureWindowMetrics)>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(None));
    if let Ok(guard) = cache.lock() {
        if let Some((fetched_at, metrics)) = guard.as_ref() {
            if fetched_at.elapsed() < Duration::from_millis(250) {
                return Some(*metrics);
            }
        }
    }

    let monitor = window.current_monitor().ok().flatten()?;
    let position = monitor.position();
    let physical_size = monitor.size();
    let scale_factor = monitor.scale_factor();
    let metrics = CaptureWindowMetrics {
        physical_origin_x: position.x as f64,
        physical_origin_y: position.y as f64,
        scale_factor,
        logical_width: physical_size.width as f64 / scale_factor,
        logical_height: physical_size.height as f64 / scale_factor,
    };
    if let Ok(mut guard) = cache.lock() {
        *guard = Some((Instant::now(), metrics));
    }
    Some(metrics)
}

#[derive(Debug, Clone, Copy)]
struct ModifierSnapshot {
    ctrl_pressed: bool,
    alt_pressed: bool,
    shift_pressed: bool,
}

fn emit_capture_mouse_event(
    window: &tauri::WebviewWindow,
    event_name: &str,
    global_x: f64,
    global_y: f64,
    modifiers: ModifierSnapshot,
    native_drag_preflight: bool,
) {
    // GetPixel on every mouse move stalls the LL hook consumer on physical machines
    // (high poll rate / multi-monitor). Only sample when the color picker asks for it.
    #[cfg(target_os = "windows")]
    let sample = if CAPTURE_COLOR_SAMPLE_ACTIVE.load(Ordering::SeqCst) {
        sample_screen_color_physical(global_x.round() as i32, global_y.round() as i32).ok()
    } else {
        None
    };
    #[cfg(not(target_os = "windows"))]
    let sample: Option<ScreenColorSample> = None;

    if let Some(metrics) = capture_window_metrics(window) {
        let local = normalize_global_physical_to_local_logical(global_x, global_y, metrics);
        let payload = match sample {
            Some(sample) => serde_json::json!({
                "x": local.x,
                "y": local.y,
                "globalX": global_x,
                "globalY": global_y,
                "scaleFactor": metrics.scale_factor,
                "physicalOriginX": metrics.physical_origin_x,
                "physicalOriginY": metrics.physical_origin_y,
                "ctrlKey": modifiers.ctrl_pressed,
                "altKey": modifiers.alt_pressed,
                "shiftKey": modifiers.shift_pressed,
                "nativeDragPreflight": native_drag_preflight,
                "hex": sample.hex,
                "rgb": sample.rgb,
            }),
            None => serde_json::json!({
                "x": local.x,
                "y": local.y,
                "globalX": global_x,
                "globalY": global_y,
                "scaleFactor": metrics.scale_factor,
                "physicalOriginX": metrics.physical_origin_x,
                "physicalOriginY": metrics.physical_origin_y,
                "ctrlKey": modifiers.ctrl_pressed,
                "altKey": modifiers.alt_pressed,
                "shiftKey": modifiers.shift_pressed,
                "nativeDragPreflight": native_drag_preflight,
            }),
        };
        let _ = window.emit(event_name, payload);
    } else {
        let payload = match sample {
            Some(sample) => serde_json::json!({
                "x": global_x,
                "y": global_y,
                "globalX": global_x,
                "globalY": global_y,
                "ctrlKey": modifiers.ctrl_pressed,
                "altKey": modifiers.alt_pressed,
                "shiftKey": modifiers.shift_pressed,
                "nativeDragPreflight": native_drag_preflight,
                "hex": sample.hex,
                "rgb": sample.rgb,
            }),
            None => serde_json::json!({
                "x": global_x,
                "y": global_y,
                "globalX": global_x,
                "globalY": global_y,
                "ctrlKey": modifiers.ctrl_pressed,
                "altKey": modifiers.alt_pressed,
                "shiftKey": modifiers.shift_pressed,
                "nativeDragPreflight": native_drag_preflight,
            }),
        };
        let _ = window.emit(event_name, payload);
    }
}

#[cfg(target_os = "windows")]
fn current_modifier_snapshot() -> ModifierSnapshot {
    ModifierSnapshot {
        ctrl_pressed: unsafe { GetAsyncKeyState(VK_CONTROL.0 as i32) } < 0,
        alt_pressed: unsafe { GetAsyncKeyState(VK_MENU.0 as i32) } < 0,
        shift_pressed: unsafe { GetAsyncKeyState(VK_SHIFT.0 as i32) } < 0
            || OVERLAY_SHIFT_KEY_DOWN.load(Ordering::SeqCst),
    }
}

#[cfg(not(target_os = "windows"))]
fn current_modifier_snapshot() -> ModifierSnapshot {
    ModifierSnapshot {
        ctrl_pressed: false,
        alt_pressed: false,
        shift_pressed: false,
    }
}

fn emit_overlay_wheel_event(
    window: &tauri::WebviewWindow,
    event_name: &str,
    global_x: f64,
    global_y: f64,
    delta_y: f64,
    modifiers: ModifierSnapshot,
) {
    if let Some(metrics) = capture_window_metrics(window) {
        let local = normalize_global_physical_to_local_logical(global_x, global_y, metrics);
        let payload = serde_json::json!({
            "x": local.x,
            "y": local.y,
            "globalX": global_x,
            "globalY": global_y,
            "scaleFactor": metrics.scale_factor,
            "physicalOriginX": metrics.physical_origin_x,
            "physicalOriginY": metrics.physical_origin_y,
            "ctrlKey": modifiers.ctrl_pressed,
            "altKey": modifiers.alt_pressed,
            "shiftKey": modifiers.shift_pressed,
            "deltaY": -delta_y,
        });
        let _ = window.emit(event_name, payload);
    } else {
        let payload = serde_json::json!({
            "x": global_x,
            "y": global_y,
            "globalX": global_x,
            "globalY": global_y,
            "ctrlKey": modifiers.ctrl_pressed,
            "altKey": modifiers.alt_pressed,
            "shiftKey": modifiers.shift_pressed,
            "deltaY": -delta_y,
        });
        let _ = window.emit(event_name, payload);
    }
}

#[cfg(target_os = "windows")]
#[derive(Debug, Clone, Copy)]
enum CaptureMouseHookEvent {
    Move { x: f64, y: f64, modifiers: ModifierSnapshot },
    Down { x: f64, y: f64, modifiers: ModifierSnapshot },
    Up { x: f64, y: f64, modifiers: ModifierSnapshot },
    Wheel { x: f64, y: f64, modifiers: ModifierSnapshot },
    OverlayDown {
        x: f64,
        y: f64,
        modifiers: ModifierSnapshot,
        native_drag_preflight: bool,
    },
    OverlayMove {
        x: f64,
        y: f64,
        modifiers: ModifierSnapshot,
        native_drag_preflight: bool,
    },
    OverlayUp {
        x: f64,
        y: f64,
        modifiers: ModifierSnapshot,
        native_drag_preflight: bool,
    },
    OverlayWheel { x: f64, y: f64, delta_y: f64, modifiers: ModifierSnapshot },
    OverlayContextMenu { x: f64, y: f64, modifiers: ModifierSnapshot },
}

#[cfg(target_os = "windows")]
#[derive(Debug, Clone, Copy)]
enum OverlayKeyboardHookEvent {
    Escape,
    Delete,
    Copy,
    Paste,
}

#[cfg(target_os = "windows")]
const CAPTURE_MOUSE_EVENT_QUEUE_CAPACITY: usize = 2048;

#[cfg(target_os = "windows")]
static CAPTURE_MOUSE_EVENT_SENDER: OnceLock<mpsc::SyncSender<CaptureMouseHookEvent>> =
    OnceLock::new();
#[cfg(target_os = "windows")]
static OVERLAY_KEYBOARD_EVENT_SENDER: OnceLock<mpsc::SyncSender<OverlayKeyboardHookEvent>> =
    OnceLock::new();
#[cfg(target_os = "windows")]
static CAPTURE_MOUSE_HOOK_ACTIVE: AtomicBool = AtomicBool::new(false);
#[cfg(target_os = "windows")]
static CAPTURE_COLOR_SAMPLE_ACTIVE: AtomicBool = AtomicBool::new(false);
#[cfg(target_os = "windows")]
static OVERLAY_KEYBOARD_CAPTURE_ACTIVE: AtomicBool = AtomicBool::new(false);
#[cfg(target_os = "windows")]
static OVERLAY_SHIFT_KEY_DOWN: AtomicBool = AtomicBool::new(false);
#[cfg(target_os = "windows")]
static OVERLAY_MOUSE_HIT_MAP: OnceLock<Arc<std::sync::Mutex<Vec<mouse_monitor::Rect>>>> =
    OnceLock::new();
#[cfg(target_os = "windows")]
static OVERLAY_MOUSE_HIT_MAP_ACTIVE: AtomicBool = AtomicBool::new(false);
#[cfg(target_os = "windows")]
static OVERLAY_MOUSE_HOOK_DRAG_ACTIVE: AtomicBool = AtomicBool::new(false);
#[cfg(target_os = "windows")]
static OVERLAY_MOUSE_HOOK_SYNTHETIC_DRAG_ACTIVE: AtomicBool = AtomicBool::new(false);
#[cfg(target_os = "windows")]
static OVERLAY_MOUSE_HOOK_NATIVE_DRAG_PREFLIGHT_ACTIVE: AtomicBool = AtomicBool::new(false);
#[cfg(target_os = "windows")]
static OVERLAY_MOUSE_HOOK_HOVER_ACTIVE: AtomicBool = AtomicBool::new(false);
#[cfg(target_os = "windows")]
static OVERLAY_CLICK_THROUGH_ACTIVE: AtomicBool = AtomicBool::new(true);
#[cfg(target_os = "windows")]
static OVERLAY_MOUSE_ACTIVATE_WNDPROC_INSTALLED: AtomicBool = AtomicBool::new(false);
#[cfg(target_os = "windows")]
static OVERLAY_MOUSE_ACTIVATE_WNDPROC_PREVIOUS: OnceLock<isize> = OnceLock::new();
#[cfg(target_os = "windows")]
static OVERLAY_INPUT_SHIELD_HWND: OnceLock<isize> = OnceLock::new();
#[cfg(target_os = "windows")]
static OVERLAY_INPUT_SHIELD_WNDPROC_PREVIOUS: OnceLock<isize> = OnceLock::new();
#[cfg(target_os = "windows")]
static OVERLAY_INPUT_SHIELD_DIRECT_DRAG_ACTIVE: AtomicBool = AtomicBool::new(false);
#[cfg(target_os = "windows")]
static OVERLAY_MAIN_HWND: OnceLock<isize> = OnceLock::new();
#[cfg(target_os = "windows")]
static OVERLAY_TOPMOST_MAINTENANCE_STARTED: AtomicBool = AtomicBool::new(false);
#[cfg(target_os = "windows")]
const OVERLAY_TOPMOST_MAINTENANCE_INTERVAL_MS: u64 = 250;
#[cfg(target_os = "windows")]
static OVERLAY_HWND_RETRY_THREAD_STARTED: AtomicBool = AtomicBool::new(false);
#[cfg(target_os = "windows")]
const OVERLAY_HWND_RETRY_INTERVAL_MS: u64 = 250;
#[cfg(target_os = "windows")]
const OVERLAY_HWND_RETRY_ATTEMPTS: usize = 80;

#[cfg(target_os = "windows")]
fn queue_capture_mouse_hook_event(event: CaptureMouseHookEvent) {
    if let Some(sender) = CAPTURE_MOUSE_EVENT_SENDER.get() {
        let _ = sender.try_send(event);
    }
}

#[cfg(target_os = "windows")]
fn queue_overlay_keyboard_hook_event(event: OverlayKeyboardHookEvent) {
    if let Some(sender) = OVERLAY_KEYBOARD_EVENT_SENDER.get() {
        let _ = sender.try_send(event);
    }
}

#[cfg(target_os = "windows")]
fn overlay_mouse_hit_map() -> &'static Arc<std::sync::Mutex<Vec<mouse_monitor::Rect>>> {
    OVERLAY_MOUSE_HIT_MAP.get_or_init(|| Arc::new(std::sync::Mutex::new(Vec::new())))
}

#[cfg(target_os = "windows")]
fn is_sticker_body_synthetic_rect(rect: &mouse_monitor::Rect) -> bool {
    rect.name == "MINI" || rect.name == "FULL"
}

#[cfg(target_os = "windows")]
fn is_overlay_ui_synthetic_rect(rect: &mouse_monitor::Rect) -> bool {
    matches!(
        rect.name.as_str(),
        "STICKER_TOP_STRIP"
            | "STICKER_TOP_STRIP_MENU"
            | "STICKER_CONTEXT_MENU_ROOT"
            | "ACTIONS_MENU"
            | "PARAMS_PANEL"
            | "TEXT_EDITOR"
            | "EXEC_SETTINGS"
            | "COLOR_PICKER"
    ) || rect.name.starts_with("PORT_IN_")
        || rect.name.starts_with("PORT_OUT_")
}

#[cfg(target_os = "windows")]
fn is_synthetic_overlay_rect(rect: &mouse_monitor::Rect) -> bool {
    is_sticker_body_synthetic_rect(rect) || is_overlay_ui_synthetic_rect(rect)
}

#[cfg(target_os = "windows")]
pub(crate) fn should_overlay_window_ignore_cursor_events(
    rects: &[mouse_monitor::Rect],
    x: f64,
    y: f64,
) -> bool {
    !rects
        .iter()
        .any(|rect| !is_synthetic_overlay_rect(rect) && rect.contains(x, y))
}

#[cfg(target_os = "windows")]
fn should_route_overlay_mouse_events(x: f64, y: f64) -> bool {
    if OVERLAY_MOUSE_HOOK_DRAG_ACTIVE.load(Ordering::SeqCst) {
        return true;
    }
    if !OVERLAY_MOUSE_HIT_MAP_ACTIVE.load(Ordering::SeqCst) {
        return false;
    }
    overlay_mouse_hit_map()
        .lock()
        .ok()
        .map(|rects| {
            rects
                .iter()
                .any(|rect| is_synthetic_overlay_rect(rect) && rect.contains(x, y))
        })
        .unwrap_or(false)
}

#[cfg(target_os = "windows")]
fn is_pointer_over_sticker_body_synthetic_rect(x: f64, y: f64) -> bool {
    if !OVERLAY_MOUSE_HIT_MAP_ACTIVE.load(Ordering::SeqCst) {
        return false;
    }
    overlay_mouse_hit_map()
        .lock()
        .ok()
        .map(|rects| {
            rects
                .iter()
                .any(|rect| is_sticker_body_synthetic_rect(rect) && rect.contains(x, y))
        })
        .unwrap_or(false)
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn capture_mouse_hook_proc(
    code: i32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if code != HC_ACTION as i32 {
        return unsafe { CallNextHookEx(None, code, wparam, lparam) };
    }

    if lparam.0 == 0 {
        return unsafe { CallNextHookEx(None, code, wparam, lparam) };
    }

    let mouse = unsafe { *(lparam.0 as *const MSLLHOOKSTRUCT) };
    let x = mouse.pt.x as f64;
    let y = mouse.pt.y as f64;
    let modifiers = current_modifier_snapshot();
    let capture_active = CAPTURE_MOUSE_HOOK_ACTIVE.load(Ordering::SeqCst);
    let should_route_overlay_mouse = should_route_overlay_mouse_events(x, y);
    let overlay_hover_active = OVERLAY_MOUSE_HOOK_HOVER_ACTIVE.load(Ordering::SeqCst);
    let native_drag_preflight_active =
        OVERLAY_MOUSE_HOOK_NATIVE_DRAG_PREFLIGHT_ACTIVE.load(Ordering::SeqCst);
    if !capture_active
        && !should_route_overlay_mouse
        && !overlay_hover_active
        && !native_drag_preflight_active
    {
        return unsafe { CallNextHookEx(None, code, wparam, lparam) };
    }

    match wparam.0 as u32 {
        WM_MOUSEMOVE => {
            if capture_active {
                queue_capture_mouse_hook_event(CaptureMouseHookEvent::Move { x, y, modifiers });
            }
            if !capture_active && (should_route_overlay_mouse || native_drag_preflight_active) {
                OVERLAY_MOUSE_HOOK_HOVER_ACTIVE.store(true, Ordering::SeqCst);
                queue_capture_mouse_hook_event(CaptureMouseHookEvent::OverlayMove {
                    x,
                    y,
                    modifiers,
                    native_drag_preflight: native_drag_preflight_active,
                });
            }
            if !capture_active && overlay_hover_active {
                OVERLAY_MOUSE_HOOK_HOVER_ACTIVE.store(false, Ordering::SeqCst);
                queue_capture_mouse_hook_event(CaptureMouseHookEvent::OverlayMove {
                    x,
                    y,
                    modifiers,
                    native_drag_preflight: native_drag_preflight_active,
                });
            }
        }
        WM_LBUTTONDOWN => {
            if capture_active {
                queue_capture_mouse_hook_event(CaptureMouseHookEvent::Down { x, y, modifiers });
                return LRESULT(1);
            }
            if should_route_overlay_mouse {
                let shift_sticker_native_drag_preflight =
                    modifiers.shift_pressed && is_pointer_over_sticker_body_synthetic_rect(x, y);
                if shift_sticker_native_drag_preflight {
                    OVERLAY_MOUSE_HOOK_DRAG_ACTIVE.store(false, Ordering::SeqCst);
                    OVERLAY_MOUSE_HOOK_SYNTHETIC_DRAG_ACTIVE.store(false, Ordering::SeqCst);
                    OVERLAY_MOUSE_HOOK_NATIVE_DRAG_PREFLIGHT_ACTIVE
                        .store(true, Ordering::SeqCst);
                    OVERLAY_MOUSE_HOOK_HOVER_ACTIVE.store(true, Ordering::SeqCst);
                    append_runtime_log_line(&format!(
                        "overlay_native_drag_preflight_start :: x={} y={}",
                        x, y
                    ));
                    queue_capture_mouse_hook_event(CaptureMouseHookEvent::OverlayDown {
                        x,
                        y,
                        modifiers,
                        native_drag_preflight: true,
                    });
                    return LRESULT(1);
                }
                OVERLAY_MOUSE_HOOK_DRAG_ACTIVE.store(true, Ordering::SeqCst);
                OVERLAY_MOUSE_HOOK_SYNTHETIC_DRAG_ACTIVE.store(true, Ordering::SeqCst);
                OVERLAY_MOUSE_HOOK_NATIVE_DRAG_PREFLIGHT_ACTIVE.store(false, Ordering::SeqCst);
                OVERLAY_MOUSE_HOOK_HOVER_ACTIVE.store(true, Ordering::SeqCst);
                promote_overlay_input_shield_to_fullscreen();
                append_runtime_log_line(&format!(
                    "overlay_drag_start :: synthetic={} x={} y={}",
                    true, x, y
                ));
                queue_capture_mouse_hook_event(CaptureMouseHookEvent::OverlayDown {
                    x,
                    y,
                    modifiers,
                    native_drag_preflight: false,
                });
                return LRESULT(1);
            }
        }
        WM_LBUTTONUP => {
            if capture_active {
                queue_capture_mouse_hook_event(CaptureMouseHookEvent::Up { x, y, modifiers });
                return LRESULT(1);
            }
            let drag_active = OVERLAY_MOUSE_HOOK_DRAG_ACTIVE.swap(false, Ordering::SeqCst);
            let synthetic_drag_active =
                OVERLAY_MOUSE_HOOK_SYNTHETIC_DRAG_ACTIVE.swap(false, Ordering::SeqCst);
            let native_drag_preflight_active =
                OVERLAY_MOUSE_HOOK_NATIVE_DRAG_PREFLIGHT_ACTIVE.swap(false, Ordering::SeqCst);
            if drag_active
                || synthetic_drag_active
                || native_drag_preflight_active
                || should_route_overlay_mouse
            {
                append_runtime_log_line(&format!(
                    "overlay_drag_end :: synthetic={} x={} y={}",
                    synthetic_drag_active, x, y
                ));
            }
            if drag_active
                || synthetic_drag_active
                || native_drag_preflight_active
                || should_route_overlay_mouse
            {
                OVERLAY_MOUSE_HOOK_HOVER_ACTIVE.store(should_route_overlay_mouse, Ordering::SeqCst);
                queue_capture_mouse_hook_event(CaptureMouseHookEvent::OverlayUp {
                    x,
                    y,
                    modifiers,
                    native_drag_preflight: native_drag_preflight_active,
                });
                return LRESULT(1);
            }
        }
        WM_MOUSEWHEEL => {
            if capture_active {
                queue_capture_mouse_hook_event(CaptureMouseHookEvent::Wheel { x, y, modifiers });
                return LRESULT(1);
            }
            if should_route_overlay_mouse {
                let delta_y = (((mouse.mouseData >> 16) & 0xffff) as i16) as f64;
                queue_capture_mouse_hook_event(CaptureMouseHookEvent::OverlayWheel {
                    x,
                    y,
                    delta_y,
                    modifiers,
                });
                OVERLAY_MOUSE_HOOK_HOVER_ACTIVE.store(true, Ordering::SeqCst);
                return LRESULT(1);
            }
        }
        WM_RBUTTONDOWN | WM_RBUTTONUP | WM_MBUTTONDOWN | WM_MBUTTONUP | WM_XBUTTONDOWN
        | WM_XBUTTONUP => {
            if capture_active {
                return LRESULT(1);
            }
            if should_route_overlay_mouse {
                OVERLAY_MOUSE_HOOK_HOVER_ACTIVE.store(true, Ordering::SeqCst);
                if wparam.0 as u32 == WM_RBUTTONUP {
                    queue_capture_mouse_hook_event(CaptureMouseHookEvent::OverlayContextMenu {
                        x,
                        y,
                        modifiers,
                    });
                }
                return LRESULT(1);
            }
        }
        _ => {}
    }

    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

#[cfg(target_os = "windows")]
pub(crate) fn install_capture_mouse_hook_thread(window: tauri::WebviewWindow) {
    let (sender, receiver) =
        mpsc::sync_channel::<CaptureMouseHookEvent>(CAPTURE_MOUSE_EVENT_QUEUE_CAPACITY);
    if CAPTURE_MOUSE_EVENT_SENDER.set(sender).is_err() {
        append_runtime_log_line("capture_mouse_hook_sender_already_initialized");
        return;
    }

    let emit_window = window.clone();
    let _ = std::thread::Builder::new()
        .name("hook-capture-mouse-events".to_string())
        .spawn(move || {
            let mut deferred_event: Option<CaptureMouseHookEvent> = None;
            loop {
                let event = match deferred_event.take() {
                    Some(event) => event,
                    None => match receiver.recv() {
                        Ok(event) => event,
                        Err(_) => break,
                    },
                };

                match event {
                    CaptureMouseHookEvent::Move {
                        mut x,
                        mut y,
                        mut modifiers,
                    } => {
                        loop {
                            match receiver.try_recv() {
                                Ok(CaptureMouseHookEvent::Move {
                                    x: next_x,
                                    y: next_y,
                                    modifiers: next_modifiers,
                                }) => {
                                    x = next_x;
                                    y = next_y;
                                    modifiers = next_modifiers;
                                }
                                Ok(other_event) => {
                                    deferred_event = Some(other_event);
                                    break;
                                }
                                Err(mpsc::TryRecvError::Empty) => break,
                                Err(mpsc::TryRecvError::Disconnected) => return,
                            }
                        }
                        emit_capture_mouse_event(
                            &emit_window,
                            "capture/global_mouse_move",
                            x,
                            y,
                            modifiers,
                            false,
                        );
                    }
                    CaptureMouseHookEvent::Down { x, y, modifiers } => {
                        emit_capture_mouse_event(
                            &emit_window,
                            "capture/global_mouse_down",
                            x,
                            y,
                            modifiers,
                            false,
                        );
                    }
                    CaptureMouseHookEvent::OverlayDown {
                        x,
                        y,
                        modifiers,
                        native_drag_preflight,
                    } => {
                        sync_overlay_input_shield_from_runtime_state(&emit_window);
                        emit_capture_mouse_event(
                            &emit_window,
                            "overlay/global_mouse_down",
                            x,
                            y,
                            modifiers,
                            native_drag_preflight,
                        );
                    }
                    CaptureMouseHookEvent::OverlayMove {
                        mut x,
                        mut y,
                        mut modifiers,
                        native_drag_preflight,
                    } => {
                        loop {
                            match receiver.try_recv() {
                                Ok(CaptureMouseHookEvent::OverlayMove {
                                    x: next_x,
                                    y: next_y,
                                    modifiers: next_modifiers,
                                    native_drag_preflight: next_native_drag_preflight,
                                }) => {
                                    if next_native_drag_preflight != native_drag_preflight {
                                        deferred_event = Some(CaptureMouseHookEvent::OverlayMove {
                                            x: next_x,
                                            y: next_y,
                                            modifiers: next_modifiers,
                                            native_drag_preflight: next_native_drag_preflight,
                                        });
                                        break;
                                    }
                                    x = next_x;
                                    y = next_y;
                                    modifiers = next_modifiers;
                                }
                                Ok(other_event) => {
                                    deferred_event = Some(other_event);
                                    break;
                                }
                                Err(mpsc::TryRecvError::Empty) => break,
                                Err(mpsc::TryRecvError::Disconnected) => return,
                            }
                        }
                        emit_capture_mouse_event(
                            &emit_window,
                            "overlay/global_mouse_move",
                            x,
                            y,
                            modifiers,
                            native_drag_preflight,
                        );
                    }
                    CaptureMouseHookEvent::Up { x, y, modifiers } => {
                        emit_capture_mouse_event(
                            &emit_window,
                            "capture/global_mouse_up",
                            x,
                            y,
                            modifiers,
                            false,
                        );
                    }
                    CaptureMouseHookEvent::OverlayUp {
                        x,
                        y,
                        modifiers,
                        native_drag_preflight,
                    } => {
                        sync_overlay_input_shield_from_runtime_state(&emit_window);
                        emit_capture_mouse_event(
                            &emit_window,
                            "overlay/global_mouse_up",
                            x,
                            y,
                            modifiers,
                            native_drag_preflight,
                        );
                    }
                    CaptureMouseHookEvent::Wheel { x, y, modifiers } => {
                        let _ = (x, y, modifiers);
                    }
                    CaptureMouseHookEvent::OverlayWheel {
                        x,
                        y,
                        delta_y,
                        modifiers,
                    } => {
                        emit_overlay_wheel_event(
                            &emit_window,
                            "overlay/global_mouse_wheel",
                            x,
                            y,
                            delta_y,
                            modifiers,
                        );
                    }
                    CaptureMouseHookEvent::OverlayContextMenu { x, y, modifiers } => {
                        emit_capture_mouse_event(
                            &emit_window,
                            "overlay/global_context_menu",
                            x,
                            y,
                            modifiers,
                            false,
                        );
                    }
                }
            }
        });

    let _ = std::thread::Builder::new()
        .name("hook-capture-mouse-hook".to_string())
        .spawn(move || {
            let hook = match unsafe {
                SetWindowsHookExW(WH_MOUSE_LL, Some(capture_mouse_hook_proc), None, 0)
            } {
                Ok(hook) => {
                    append_runtime_log_line("capture_mouse_hook_install_success");
                    hook
                }
                Err(error) => {
                    append_runtime_log_line(&format!(
                        "capture_mouse_hook_install_failed :: {}",
                        error
                    ));
                    return;
                }
            };

            let mut msg = MSG::default();
            while unsafe { GetMessageW(&mut msg, None, 0, 0) }.as_bool() {
                let _ = unsafe { TranslateMessage(&msg) };
                unsafe { DispatchMessageW(&msg) };
            }
            let _ = unsafe { UnhookWindowsHookEx(hook) };
            append_runtime_log_line("capture_mouse_hook_thread_exited");
        });
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn install_capture_mouse_hook_thread(_window: tauri::WebviewWindow) {}

#[cfg(target_os = "windows")]
const VK_KEY_C: u32 = b'C' as u32;
#[cfg(target_os = "windows")]
const VK_KEY_V: u32 = b'V' as u32;

#[cfg(target_os = "windows")]
fn update_overlay_modifier_key_state(vk_code: u32, pressed: bool) {
    if vk_code == VK_SHIFT.0 as u32
        || vk_code == VK_LSHIFT.0 as u32
        || vk_code == VK_RSHIFT.0 as u32
    {
        OVERLAY_SHIFT_KEY_DOWN.store(pressed, Ordering::SeqCst);
    }
}

#[cfg(target_os = "windows")]
fn overlay_keyboard_hook_event_for_keydown(
    vk_code: u32,
    modifiers: ModifierSnapshot,
) -> Option<OverlayKeyboardHookEvent> {
    if vk_code == VK_ESCAPE.0 as u32 {
        return Some(OverlayKeyboardHookEvent::Escape);
    }
    if vk_code == VK_DELETE.0 as u32 || vk_code == VK_BACK.0 as u32 {
        return Some(OverlayKeyboardHookEvent::Delete);
    }
    if modifiers.ctrl_pressed && vk_code == VK_KEY_C {
        return Some(OverlayKeyboardHookEvent::Copy);
    }
    if modifiers.ctrl_pressed && vk_code == VK_KEY_V {
        return Some(OverlayKeyboardHookEvent::Paste);
    }
    None
}

#[cfg(target_os = "windows")]
fn overlay_keyboard_hook_should_consume_keyup(
    vk_code: u32,
    modifiers: ModifierSnapshot,
) -> bool {
    vk_code == VK_ESCAPE.0 as u32
        || vk_code == VK_DELETE.0 as u32
        || vk_code == VK_BACK.0 as u32
        || (modifiers.ctrl_pressed && (vk_code == VK_KEY_C || vk_code == VK_KEY_V))
}

#[cfg(target_os = "windows")]
pub(crate) fn overlay_keyboard_capture_should_handle_current_cursor() -> bool {
    if !OVERLAY_KEYBOARD_CAPTURE_ACTIVE.load(Ordering::SeqCst) {
        return false;
    }

    let Some((x, y)) = current_cursor_position_physical() else {
        return false;
    };

    should_route_overlay_mouse_events(x, y)
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn overlay_keyboard_hook_proc(
    code: i32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if code != HC_ACTION as i32 {
        return unsafe { CallNextHookEx(None, code, wparam, lparam) };
    }
    if lparam.0 == 0 {
        return unsafe { CallNextHookEx(None, code, wparam, lparam) };
    }

    let keyboard = unsafe { *(lparam.0 as *const KBDLLHOOKSTRUCT) };
    let vk_code = keyboard.vkCode;
    match wparam.0 as u32 {
        WM_KEYDOWN | WM_SYSKEYDOWN => {
            update_overlay_modifier_key_state(vk_code, true);
        }
        WM_KEYUP | WM_SYSKEYUP => {
            update_overlay_modifier_key_state(vk_code, false);
        }
        _ => {}
    }

    if !overlay_keyboard_capture_should_handle_current_cursor() {
        return unsafe { CallNextHookEx(None, code, wparam, lparam) };
    }

    let modifiers = current_modifier_snapshot();
    match wparam.0 as u32 {
        WM_KEYDOWN | WM_SYSKEYDOWN => {
            if let Some(event) = overlay_keyboard_hook_event_for_keydown(vk_code, modifiers) {
                queue_overlay_keyboard_hook_event(event);
                return LRESULT(1);
            }
        }
        WM_KEYUP | WM_SYSKEYUP => {
            if overlay_keyboard_hook_should_consume_keyup(vk_code, modifiers) {
                return LRESULT(1);
            }
        }
        _ => {}
    }

    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

#[cfg(target_os = "windows")]
pub(crate) fn install_overlay_keyboard_hook_thread(window: tauri::WebviewWindow) {
    let (sender, receiver) = mpsc::sync_channel::<OverlayKeyboardHookEvent>(256);
    if OVERLAY_KEYBOARD_EVENT_SENDER.set(sender).is_err() {
        append_runtime_log_line("overlay_keyboard_hook_sender_already_initialized");
        return;
    }

    let emit_window = window.clone();
    let _ = std::thread::Builder::new()
        .name("hook-overlay-keyboard-events".to_string())
        .spawn(move || {
            while let Ok(event) = receiver.recv() {
                let event_name = match event {
                    OverlayKeyboardHookEvent::Escape => "trigger-escape",
                    OverlayKeyboardHookEvent::Delete => "trigger-delete",
                    OverlayKeyboardHookEvent::Copy => "trigger-copy",
                    OverlayKeyboardHookEvent::Paste => "trigger-paste",
                };
                append_runtime_log_line(&format!("overlay_keyboard_hook_emit :: {}", event_name));
                let _ = emit_window.emit(event_name, ());
            }
        });

    let _ = std::thread::Builder::new()
        .name("hook-overlay-keyboard-hook".to_string())
        .spawn(move || {
            let hook = unsafe {
                SetWindowsHookExW(WH_KEYBOARD_LL, Some(overlay_keyboard_hook_proc), None, 0)
            };
            let Ok(hook) = hook else {
                append_runtime_log_line("overlay_keyboard_hook_install_failed");
                return;
            };

            append_runtime_log_line("overlay_keyboard_hook_installed");
            let mut msg = MSG::default();
            while unsafe { GetMessageW(&mut msg, None, 0, 0) }.as_bool() {
                let _ = unsafe { TranslateMessage(&msg) };
                unsafe { DispatchMessageW(&msg) };
            }
            let _ = unsafe { UnhookWindowsHookEx(hook) };
            append_runtime_log_line("overlay_keyboard_hook_thread_exited");
        });
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn install_overlay_keyboard_hook_thread(_window: tauri::WebviewWindow) {}

fn refresh_overlay_interactivity_for_current_cursor(
    window: &tauri::WebviewWindow,
    hit_map: &SharedHitMap,
) {
    let active = match hit_map.active.lock() {
        Ok(guard) => *guard,
        Err(_) => return,
    };

    if !active {
        return;
    }

    let (cursor_x, cursor_y) = match current_cursor_position_physical() {
        Some(position) => position,
        None => return,
    };

    let rects = match hit_map.rectangles.lock() {
        Ok(guard) => guard.clone(),
        Err(_) => return,
    };

    let should_ignore = should_overlay_window_ignore_cursor_events(&rects, cursor_x, cursor_y);

    if window.set_ignore_cursor_events(should_ignore).is_err() {
        return;
    }
    set_overlay_transparent_style(window, should_ignore);
    OVERLAY_CLICK_THROUGH_ACTIVE.store(should_ignore, Ordering::SeqCst);
    apply_overlay_no_activate(window);
    append_runtime_log_line(&format!(
        "refresh_overlay_interactivity :: cursor_x={} cursor_y={} should_ignore={}",
        cursor_x, cursor_y, should_ignore
    ));
}

#[cfg(target_os = "windows")]
fn current_cursor_position_physical() -> Option<(f64, f64)> {
    let mut point = POINT::default();
    if unsafe { GetCursorPos(&mut point) }.is_ok() {
        Some((point.x as f64, point.y as f64))
    } else {
        None
    }
}

#[cfg(not(target_os = "windows"))]
fn current_cursor_position_physical() -> Option<(f64, f64)> {
    None
}

#[cfg(target_os = "windows")]
pub(crate) fn force_restore_system_cursors() {
    // Always try to reload default cursors. Older builds used SetSystemCursor and
    // could leave IDC_CROSS stuck across virtual desktops even after Hook exited.
    for attempt in 0..3 {
        if unsafe { SystemParametersInfoW(SPI_SETCURSORS, 0, None, Default::default()) }.is_ok() {
            append_runtime_log_line(&format!(
                "system_cursors_restored :: attempt={}",
                attempt + 1
            ));
            return;
        }
        std::thread::sleep(Duration::from_millis(16));
    }
    append_runtime_log_line("system_cursors_restore_failed");
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn force_restore_system_cursors() {}

pub(crate) fn set_capture_input_runtime_active(active: bool) {
    set_capture_input_runtime_active_with_hook(active, active);
}

/// `enable_mouse_hook` is only for color-picker (needs desktop pixel sampling under
/// click-through). Region capture uses the overlay window's own mouse events.
pub(crate) fn set_capture_input_runtime_active_with_hook(active: bool, enable_mouse_hook: bool) {
    #[cfg(target_os = "windows")]
    {
        let hook_on = active && enable_mouse_hook;
        CAPTURE_MOUSE_HOOK_ACTIVE.store(hook_on, Ordering::SeqCst);
        append_runtime_log_line(&format!(
            "capture_mouse_hook_active :: active={} hook={}",
            active, hook_on
        ));
        if !active {
            CAPTURE_COLOR_SAMPLE_ACTIVE.store(false, Ordering::SeqCst);
            force_restore_system_cursors();
        }
    }
}



#[tauri::command]
pub fn update_pin_rects(
    app: tauri::AppHandle,
    state: tauri::State<SharedHitMap>,
    rects: Vec<mouse_monitor::Rect>,
) {
    let active = state.active.lock().map(|guard| *guard).unwrap_or(false);
    if let Ok(mut rectangles) = state.rectangles.lock() {
        *rectangles = rects.clone();
    } else {
        append_runtime_log_line("update_pin_rects_lock_failed");
        return;
    }
    if let Ok(mut overlay_rectangles) = overlay_mouse_hit_map().lock() {
        *overlay_rectangles = rects.clone();
    }

    if let Some(window) = app.get_webview_window("main") {
        sync_overlay_input_shield_region(&window, &rects, active);
        refresh_overlay_interactivity_for_current_cursor(&window, &state);
    }
}

#[tauri::command]
pub fn set_mouse_monitor_active(
    app: tauri::AppHandle,
    state: tauri::State<SharedHitMap>,
    active: bool,
) {
    if let Ok(mut state_active) = state.active.lock() {
        *state_active = active;
    } else {
        append_runtime_log_line("set_mouse_monitor_active_lock_failed");
        return;
    }
    OVERLAY_MOUSE_HIT_MAP_ACTIVE.store(active, Ordering::SeqCst);
    if !active {
        OVERLAY_MOUSE_HOOK_DRAG_ACTIVE.store(false, Ordering::SeqCst);
        OVERLAY_MOUSE_HOOK_SYNTHETIC_DRAG_ACTIVE.store(false, Ordering::SeqCst);
        OVERLAY_MOUSE_HOOK_NATIVE_DRAG_PREFLIGHT_ACTIVE.store(false, Ordering::SeqCst);
        OVERLAY_INPUT_SHIELD_DIRECT_DRAG_ACTIVE.store(false, Ordering::SeqCst);
    }

    // Capture selection is driven by the backend global input hook. Keep the
    // caller in charge of hit-testing so capture mode can remain click-through
    // and avoid placing an interactive transparent WebView over video surfaces.
    if let Some(window) = app.get_webview_window("main") {
        let rects = state
            .rectangles
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default();
        sync_overlay_input_shield_region(&window, &rects, active);
        if active {
            refresh_overlay_interactivity_for_current_cursor(&window, &state);
        }
    }
}

#[tauri::command]
pub fn get_cursor_position(app: tauri::AppHandle) -> Result<PhysicalPosition<f64>, String> {
    if let Some(window) = app.get_webview_window("main") {
        window.cursor_position().map_err(|e| e.to_string())
    } else {
        Err("Window not found".to_string())
    }
}






#[cfg(target_os = "windows")]
fn set_overlay_no_activate_flag(window: &tauri::WebviewWindow, enabled: bool) {
    let Some(hwnd) = resolve_overlay_main_hwnd(window) else {
        append_runtime_log_line("overlay_no_activate_hwnd_failed");
        return;
    };

    unsafe {
        let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let flag = WS_EX_NOACTIVATE.0 as isize;
        let next_style = if enabled { style | flag } else { style & !flag };
        if next_style != style {
            let _ = SetWindowLongPtrW(hwnd, GWL_EXSTYLE, next_style);
        }
        let _ = SetWindowPos(
            hwnd,
            None,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
        );
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn set_overlay_transparent_style(window: &tauri::WebviewWindow, enabled: bool) {
    let Some(hwnd) = resolve_overlay_main_hwnd(window) else {
        append_runtime_log_line("overlay_transparent_hwnd_failed");
        return;
    };

    unsafe {
        let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let flag = WS_EX_TRANSPARENT.0 as isize;
        let next_style = if enabled { style | flag } else { style & !flag };
        if next_style != style {
            let _ = SetWindowLongPtrW(hwnd, GWL_EXSTYLE, next_style);
        }
        let _ = SetWindowPos(
            hwnd,
            None,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
        );
    }
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn set_overlay_transparent_style(_window: &tauri::WebviewWindow, _enabled: bool) {}

#[cfg(target_os = "windows")]
pub(crate) fn apply_overlay_no_activate(window: &tauri::WebviewWindow) {
    set_overlay_no_activate_flag(window, true);
    append_runtime_log_line("overlay_no_activate_applied");
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn apply_overlay_no_activate(_window: &tauri::WebviewWindow) {}

#[cfg(target_os = "windows")]
fn clear_overlay_no_activate(window: &tauri::WebviewWindow) {
    set_overlay_no_activate_flag(window, false);
    append_runtime_log_line("overlay_no_activate_cleared");
}

#[cfg(not(target_os = "windows"))]
fn clear_overlay_no_activate(_window: &tauri::WebviewWindow) {}

#[cfg(target_os = "windows")]
unsafe extern "system" fn overlay_mouse_activate_wndproc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if message == WM_MOUSEACTIVATE {
        return LRESULT(MA_NOACTIVATE as isize);
    }

    if let Some(previous) = OVERLAY_MOUSE_ACTIVATE_WNDPROC_PREVIOUS.get().copied() {
        let previous_wndproc: WNDPROC = Some(std::mem::transmute(previous));
        return unsafe { CallWindowProcW(previous_wndproc, hwnd, message, wparam, lparam) };
    }

    unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
}

#[cfg(target_os = "windows")]
fn install_overlay_mouse_activate_no_activate(window: &tauri::WebviewWindow) {
    if OVERLAY_MOUSE_ACTIVATE_WNDPROC_INSTALLED.load(Ordering::SeqCst) {
        return;
    }

    let Some(hwnd) = resolve_overlay_main_hwnd(window) else {
        append_runtime_log_line("overlay_mouse_activate_install_hwnd_failed");
        return;
    };

    let previous = unsafe {
        SetWindowLongPtrW(
            hwnd,
            GWLP_WNDPROC,
            overlay_mouse_activate_wndproc as *const () as usize as isize,
        )
    };
    if previous == 0 {
        append_runtime_log_line("overlay_mouse_activate_install_failed");
        return;
    }

    let _ = OVERLAY_MOUSE_ACTIVATE_WNDPROC_PREVIOUS.set(previous);
    OVERLAY_MOUSE_ACTIVATE_WNDPROC_INSTALLED.store(true, Ordering::SeqCst);
    append_runtime_log_line("overlay_mouse_activate_install_success");
}

#[cfg(not(target_os = "windows"))]
fn install_overlay_mouse_activate_no_activate(_window: &tauri::WebviewWindow) {}

#[cfg(target_os = "windows")]
fn overlay_input_shield_hwnd() -> Option<HWND> {
    OVERLAY_INPUT_SHIELD_HWND
        .get()
        .copied()
        .map(|value| HWND(value as *mut core::ffi::c_void))
}

#[cfg(target_os = "windows")]
struct OverlayMainWindowSearchState {
    target_pid: u32,
    hwnd: Option<HWND>,
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn find_overlay_main_window_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let state = &mut *(lparam.0 as *mut OverlayMainWindowSearchState);
    let mut pid = 0;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    if pid == state.target_pid && unsafe { IsWindowVisible(hwnd) }.as_bool() {
        state.hwnd = Some(hwnd);
        return BOOL(0);
    }

    BOOL(1)
}

#[cfg(target_os = "windows")]
fn resolve_overlay_main_hwnd(window: &tauri::WebviewWindow) -> Option<HWND> {
    if let Ok(hwnd) = window.hwnd() {
        return Some(HWND(hwnd.0));
    }

    let mut state = OverlayMainWindowSearchState {
        target_pid: std::process::id(),
        hwnd: None,
    };
    let state_ptr = &mut state as *mut OverlayMainWindowSearchState;
    let _ = unsafe {
        EnumWindows(
            Some(find_overlay_main_window_proc),
            LPARAM(state_ptr as isize),
        )
    };
    state.hwnd
}

#[cfg(target_os = "windows")]
pub(crate) fn promote_overlay_input_shield_to_fullscreen() {
    let Some(hwnd) = overlay_input_shield_hwnd() else {
        return;
    };

    let mut rect = RECT::default();
    if unsafe { GetWindowRect(hwnd, &mut rect) }.is_err() {
        append_runtime_log_line("overlay_input_shield_drag_rect_failed");
        return;
    }

    let width = (rect.right - rect.left).max(1);
    let height = (rect.bottom - rect.top).max(1);
    let full_region = unsafe { CreateRectRgn(0, 0, width, height) };
    let _ = unsafe { SetWindowRgn(hwnd, Some(full_region), true) };
    let _ = unsafe { ShowWindow(hwnd, SW_SHOWNA) };
    append_runtime_log_line("overlay_input_shield_drag_fullscreen");
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn promote_overlay_input_shield_to_fullscreen() {}

#[cfg(target_os = "windows")]
fn route_overlay_input_shield_mouse_message(message: u32, wparam: WPARAM) -> Option<LRESULT> {
    let (x, y) = current_cursor_position_physical()?;
    let modifiers = current_modifier_snapshot();
    let should_route_overlay_mouse = should_route_overlay_mouse_events(x, y);
    let hook_hover_active = OVERLAY_MOUSE_HOOK_HOVER_ACTIVE.load(Ordering::SeqCst);
    let direct_drag_active = OVERLAY_INPUT_SHIELD_DIRECT_DRAG_ACTIVE.load(Ordering::SeqCst);
    let native_drag_preflight_active =
        OVERLAY_MOUSE_HOOK_NATIVE_DRAG_PREFLIGHT_ACTIVE.load(Ordering::SeqCst);

    match message {
        WM_MOUSEMOVE => {
            if direct_drag_active || native_drag_preflight_active {
                queue_capture_mouse_hook_event(CaptureMouseHookEvent::OverlayMove {
                    x,
                    y,
                    modifiers,
                    native_drag_preflight: native_drag_preflight_active,
                });
                return Some(LRESULT(1));
            }

            if should_route_overlay_mouse && !hook_hover_active {
                queue_capture_mouse_hook_event(CaptureMouseHookEvent::OverlayMove {
                    x,
                    y,
                    modifiers,
                    native_drag_preflight: false,
                });
                return Some(LRESULT(1));
            }
        }
        WM_LBUTTONDOWN => {
            if should_route_overlay_mouse {
                let shift_sticker_native_drag_preflight =
                    modifiers.shift_pressed && is_pointer_over_sticker_body_synthetic_rect(x, y);
                if shift_sticker_native_drag_preflight {
                    OVERLAY_INPUT_SHIELD_DIRECT_DRAG_ACTIVE.store(false, Ordering::SeqCst);
                    OVERLAY_MOUSE_HOOK_NATIVE_DRAG_PREFLIGHT_ACTIVE.store(true, Ordering::SeqCst);
                    append_runtime_log_line(&format!(
                        "overlay_input_shield_native_drag_preflight_start :: x={} y={}",
                        x, y
                    ));
                    queue_capture_mouse_hook_event(CaptureMouseHookEvent::OverlayDown {
                        x,
                        y,
                        modifiers,
                        native_drag_preflight: true,
                    });
                    return Some(LRESULT(1));
                }

                OVERLAY_INPUT_SHIELD_DIRECT_DRAG_ACTIVE.store(true, Ordering::SeqCst);
                OVERLAY_MOUSE_HOOK_NATIVE_DRAG_PREFLIGHT_ACTIVE.store(false, Ordering::SeqCst);
                promote_overlay_input_shield_to_fullscreen();
                append_runtime_log_line(&format!(
                    "overlay_input_shield_drag_start :: x={} y={}",
                    x, y
                ));
                queue_capture_mouse_hook_event(CaptureMouseHookEvent::OverlayDown {
                    x,
                    y,
                    modifiers,
                    native_drag_preflight: false,
                });
                return Some(LRESULT(1));
            }
        }
        WM_LBUTTONUP => {
            let direct_drag_was_active =
                OVERLAY_INPUT_SHIELD_DIRECT_DRAG_ACTIVE.swap(false, Ordering::SeqCst);
            let native_drag_preflight_was_active =
                OVERLAY_MOUSE_HOOK_NATIVE_DRAG_PREFLIGHT_ACTIVE.swap(false, Ordering::SeqCst);
            if direct_drag_was_active
                || native_drag_preflight_was_active
                || should_route_overlay_mouse
            {
                append_runtime_log_line(&format!(
                    "overlay_input_shield_drag_end :: direct={} x={} y={}",
                    direct_drag_was_active, x, y
                ));
                queue_capture_mouse_hook_event(CaptureMouseHookEvent::OverlayUp {
                    x,
                    y,
                    modifiers,
                    native_drag_preflight: native_drag_preflight_was_active,
                });
                return Some(LRESULT(1));
            }
        }
        WM_MOUSEWHEEL => {
            if should_route_overlay_mouse && !hook_hover_active {
                let delta_y = (((wparam.0 >> 16) & 0xffff) as i16) as f64;
                queue_capture_mouse_hook_event(CaptureMouseHookEvent::OverlayWheel {
                    x,
                    y,
                    delta_y,
                    modifiers,
                });
                return Some(LRESULT(1));
            }
        }
        WM_RBUTTONDOWN | WM_MBUTTONDOWN | WM_MBUTTONUP | WM_XBUTTONDOWN | WM_XBUTTONUP => {
            if should_route_overlay_mouse {
                return Some(LRESULT(1));
            }
        }
        WM_RBUTTONUP => {
            if should_route_overlay_mouse {
                queue_capture_mouse_hook_event(CaptureMouseHookEvent::OverlayContextMenu {
                    x,
                    y,
                    modifiers,
                });
                return Some(LRESULT(1));
            }
        }
        _ => {}
    }

    None
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn overlay_input_shield_wndproc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if let Some(result) = route_overlay_input_shield_mouse_message(message, wparam) {
        return result;
    }

    if let Some(previous) = OVERLAY_INPUT_SHIELD_WNDPROC_PREVIOUS.get().copied() {
        let previous_wndproc: WNDPROC = Some(std::mem::transmute(previous));
        return unsafe { CallWindowProcW(previous_wndproc, hwnd, message, wparam, lparam) };
    }

    unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
}

#[cfg(target_os = "windows")]
fn ensure_overlay_input_shield_window(window: &tauri::WebviewWindow) -> Option<HWND> {
    if let Some(hwnd) = overlay_input_shield_hwnd() {
        return Some(hwnd);
    }

    let Some(main_hwnd) = resolve_overlay_main_hwnd(window) else {
        append_runtime_log_line("overlay_input_shield_hwnd_failed");
        return None;
    };
    let mut main_rect = RECT::default();
    if unsafe { GetWindowRect(main_hwnd, &mut main_rect) }.is_err() {
        append_runtime_log_line("overlay_input_shield_main_rect_failed");
        return None;
    }

    let class_name: Vec<u16> = "STATIC".encode_utf16().chain(std::iter::once(0)).collect();
    let window_name: Vec<u16> = "HookOverlayInputShield"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let width = (main_rect.right - main_rect.left).max(1);
    let height = (main_rect.bottom - main_rect.top).max(1);

    let hwnd = unsafe {
        CreateWindowExW(
            WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
            PCWSTR(class_name.as_ptr()),
            PCWSTR(window_name.as_ptr()),
            WS_POPUP,
            main_rect.left,
            main_rect.top,
            width,
            height,
            None,
            None,
            None,
            None,
        )
    };
    let Ok(hwnd) = hwnd else {
        append_runtime_log_line("overlay_input_shield_create_failed");
        return None;
    };

    let previous = unsafe {
        SetWindowLongPtrW(
            hwnd,
            GWLP_WNDPROC,
            overlay_input_shield_wndproc as *const () as usize as isize,
        )
    };
    if previous == 0 {
        append_runtime_log_line("overlay_input_shield_wndproc_install_failed");
    } else {
        let _ = OVERLAY_INPUT_SHIELD_WNDPROC_PREVIOUS.set(previous);
        append_runtime_log_line("overlay_input_shield_wndproc_install_success");
    }

    let _ = unsafe { SetLayeredWindowAttributes(hwnd, Default::default(), 1, LWA_ALPHA) };
    let _ = unsafe {
        SetWindowPos(
            hwnd,
            Some(HWND_TOPMOST),
            main_rect.left,
            main_rect.top,
            width,
            height,
            SWP_NOACTIVATE | SWP_SHOWWINDOW,
        )
    };
    let _ = unsafe { ShowWindow(hwnd, SW_SHOWNA) };
    let _ = OVERLAY_INPUT_SHIELD_HWND.set(hwnd.0 as isize);
    append_runtime_log_line("overlay_input_shield_create_success");
    Some(hwnd)
}

#[cfg(target_os = "windows")]
fn sync_overlay_input_shield_region(
    window: &tauri::WebviewWindow,
    rects: &[mouse_monitor::Rect],
    active: bool,
) {
    let Some(hwnd) = ensure_overlay_input_shield_window(window) else {
        return;
    };
    let Some(main_hwnd) = resolve_overlay_main_hwnd(window) else {
        append_runtime_log_line("overlay_input_shield_main_hwnd_failed");
        return;
    };
    let mut main_rect = RECT::default();
    if unsafe { GetWindowRect(main_hwnd, &mut main_rect) }.is_err() {
        append_runtime_log_line("overlay_input_shield_main_rect_failed");
        return;
    }

    let width = (main_rect.right - main_rect.left).max(1);
    let height = (main_rect.bottom - main_rect.top).max(1);
    let capture_active = CAPTURE_MOUSE_HOOK_ACTIVE.load(Ordering::SeqCst);
    let overlay_drag_active = OVERLAY_MOUSE_HOOK_DRAG_ACTIVE.load(Ordering::SeqCst)
        || OVERLAY_INPUT_SHIELD_DIRECT_DRAG_ACTIVE.load(Ordering::SeqCst);
    let _ = unsafe {
        SetWindowPos(
            hwnd,
            Some(HWND_TOPMOST),
            main_rect.left,
            main_rect.top,
            width,
            height,
            SWP_NOACTIVATE | SWP_SHOWWINDOW,
        )
    };

    if capture_active || overlay_drag_active {
        let full_region = unsafe { CreateRectRgn(0, 0, width, height) };
        let _ = unsafe { SetWindowRgn(hwnd, Some(full_region), true) };
        let _ = unsafe { ShowWindow(hwnd, SW_SHOWNA) };
        append_runtime_log_line(if capture_active {
            "overlay_input_shield_capture_fullscreen"
        } else {
            "overlay_input_shield_drag_fullscreen_synced"
        });
        return;
    }

    let shield_rects: Vec<&mouse_monitor::Rect> = if active {
        rects
            .iter()
            .filter(|rect| {
                rect.width > 0 && rect.height > 0 && is_synthetic_overlay_rect(rect)
            })
            .collect()
    } else {
        Vec::new()
    };
    let empty_region = unsafe { CreateRectRgn(0, 0, 0, 0) };
    if shield_rects.is_empty() {
        let _ = unsafe { SetWindowRgn(hwnd, Some(empty_region), true) };
        let _ = unsafe { ShowWindow(hwnd, SW_HIDE) };
        append_runtime_log_line("overlay_input_shield_hidden");
        return;
    }

    let union_region = empty_region;
    for rect in shield_rects {
        let next_region =
            unsafe { CreateRectRgn(rect.x, rect.y, rect.x + rect.width, rect.y + rect.height) };
        let _ = unsafe {
            CombineRgn(
                Some(union_region),
                Some(union_region),
                Some(next_region),
                RGN_OR,
            )
        };
        let _ = unsafe { DeleteObject(next_region.into()) };
    }
    let _ = unsafe { SetWindowRgn(hwnd, Some(union_region), true) };
    let _ = unsafe { ShowWindow(hwnd, SW_SHOWNA) };
    append_runtime_log_line("overlay_input_shield_region_synced");
}

#[cfg(not(target_os = "windows"))]
fn sync_overlay_input_shield_region(
    _window: &tauri::WebviewWindow,
    _rects: &[mouse_monitor::Rect],
    _active: bool,
) {
}

#[cfg(target_os = "windows")]
fn sync_overlay_input_shield_from_runtime_state(window: &tauri::WebviewWindow) {
    let rects = overlay_mouse_hit_map()
        .lock()
        .map(|guard| guard.clone())
        .unwrap_or_default();
    let active = OVERLAY_MOUSE_HIT_MAP_ACTIVE.load(Ordering::SeqCst);
    sync_overlay_input_shield_region(window, &rects, active);
}

#[cfg(not(target_os = "windows"))]
fn sync_overlay_input_shield_from_runtime_state(_window: &tauri::WebviewWindow) {}

#[cfg(target_os = "windows")]
fn is_window_dwm_cloaked(hwnd: HWND) -> bool {
    let mut cloaked: u32 = 0;
    let ok = unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED,
            &mut cloaked as *mut u32 as *mut core::ffi::c_void,
            std::mem::size_of::<u32>() as u32,
        )
    }
    .is_ok();
    ok && cloaked != 0
}

#[cfg(target_os = "windows")]
fn abort_capture_if_virtual_desktop_cloaked(app: &tauri::AppHandle, hwnd: HWND) {
    if !CAPTURE_MOUSE_HOOK_ACTIVE.load(Ordering::SeqCst) {
        return;
    }
    if !is_window_dwm_cloaked(hwnd) {
        return;
    }
    // Virtual-desktop switch cloaks the overlay on the previous desktop, but
    // SetSystemCursor is system-wide — leave capture without teardown and the
    // crosshair sticks on every desktop.
    append_runtime_log_line("capture_aborted_virtual_desktop_switch");
    set_capture_input_runtime_active(false);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit("trigger-escape", ());
    }
}

#[cfg(target_os = "windows")]
fn reassert_overlay_topmost_window(hwnd: HWND) {
    if !unsafe { IsWindowVisible(hwnd) }.as_bool() {
        return;
    }
    // Cloaked windows (other virtual desktop) should not fight Z-order.
    if is_window_dwm_cloaked(hwnd) {
        return;
    }

    let _ = unsafe {
        SetWindowPos(
            hwnd,
            Some(HWND_TOPMOST),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        )
    };
}

#[cfg(target_os = "windows")]
fn install_overlay_hwnd_retry_thread(window: &tauri::WebviewWindow) {
    if OVERLAY_HWND_RETRY_THREAD_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }

    let app_handle = window.app_handle().clone();
    let _ = std::thread::Builder::new()
        .name("hook-overlay-hwnd-retry".to_string())
        .spawn(move || {
            for _attempt in 0..OVERLAY_HWND_RETRY_ATTEMPTS {
                let Some(window) = app_handle.get_webview_window("main") else {
                    std::thread::sleep(Duration::from_millis(OVERLAY_HWND_RETRY_INTERVAL_MS));
                    continue;
                };

                if let Some(hwnd) = resolve_overlay_main_hwnd(&window) {
                    let _ = OVERLAY_MAIN_HWND.set(hwnd.0 as isize);
                    apply_overlay_no_activate(&window);
                    install_overlay_mouse_activate_no_activate(&window);
                    set_overlay_transparent_style(
                        &window,
                        OVERLAY_CLICK_THROUGH_ACTIVE.load(Ordering::SeqCst),
                    );
                    install_overlay_topmost_maintenance_thread(&window);
                    append_runtime_log_line("overlay_hwnd_retry_completed");
                    return;
                }

                std::thread::sleep(Duration::from_millis(OVERLAY_HWND_RETRY_INTERVAL_MS));
            }

            append_runtime_log_line("overlay_hwnd_retry_exhausted");
        });
}

#[cfg(not(target_os = "windows"))]
fn install_overlay_hwnd_retry_thread(_window: &tauri::WebviewWindow) {}

#[cfg(target_os = "windows")]
fn install_overlay_topmost_maintenance_thread(window: &tauri::WebviewWindow) {
    let Some(hwnd) = resolve_overlay_main_hwnd(window) else {
        append_runtime_log_line("overlay_topmost_maintenance_hwnd_failed");
        return;
    };
    let _ = OVERLAY_MAIN_HWND.set(hwnd.0 as isize);

    if OVERLAY_TOPMOST_MAINTENANCE_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }

    let app_handle = window.app_handle().clone();
    let _ = std::thread::Builder::new()
        .name("hook-overlay-topmost-maintenance".to_string())
        .spawn(move || loop {
            std::thread::sleep(Duration::from_millis(
                OVERLAY_TOPMOST_MAINTENANCE_INTERVAL_MS,
            ));

            let capture_active = CAPTURE_MOUSE_HOOK_ACTIVE.load(Ordering::SeqCst);
            let needs_topmost_maintenance = OVERLAY_MOUSE_HIT_MAP_ACTIVE.load(Ordering::SeqCst)
                || capture_active
                || OVERLAY_MOUSE_HOOK_DRAG_ACTIVE.load(Ordering::SeqCst)
                || OVERLAY_INPUT_SHIELD_DIRECT_DRAG_ACTIVE.load(Ordering::SeqCst);
            if !needs_topmost_maintenance {
                continue;
            }

            if let Some(main_hwnd) = OVERLAY_MAIN_HWND
                .get()
                .copied()
                .map(|value| HWND(value as *mut core::ffi::c_void))
            {
                if capture_active {
                    abort_capture_if_virtual_desktop_cloaked(&app_handle, main_hwnd);
                }
                reassert_overlay_topmost_window(main_hwnd);
            }
            if let Some(shield_hwnd) = overlay_input_shield_hwnd() {
                reassert_overlay_topmost_window(shield_hwnd);
            }
        });

    append_runtime_log_line("overlay_topmost_maintenance_started");
}

#[cfg(not(target_os = "windows"))]
fn install_overlay_topmost_maintenance_thread(_window: &tauri::WebviewWindow) {}

fn apply_overlay_window_bounds(window: &tauri::WebviewWindow) {
    if let Ok(Some(monitor)) = window.current_monitor() {
        let size = monitor.size();
        let position = monitor.position();

        let _ = window.set_decorations(false);
        let _ = window.set_position(tauri::Position::Physical(*position));
        let _ = window.set_size(tauri::Size::Physical(*size));
    } else {
        let _ = window.set_fullscreen(true);
    }
}

pub(crate) fn setup_overlay_window(window: &tauri::WebviewWindow) {
    install_overlay_hwnd_retry_thread(window);
    let _ = window.set_content_protected(false);
    apply_overlay_no_activate(window);
    install_overlay_mouse_activate_no_activate(window);
    let _ = window.set_decorations(false);
    let _ = window.set_title("");
    let _ = window.set_skip_taskbar(true);
    let _ = window.set_always_on_top(true);
    let _ = window.set_resizable(false);
    let _ = window.set_shadow(false);
    apply_overlay_window_bounds(window);

    if let Err(e) = window.show() {
        println!("Failed to show window: {}", e);
    }
    apply_overlay_no_activate(window);
    install_overlay_mouse_activate_no_activate(window);
    install_overlay_topmost_maintenance_thread(window);
}

#[derive(Clone)]
pub(crate) struct SharedCaptureInputState {
    pub(crate) active: Arc<std::sync::Mutex<bool>>,
}

impl SharedCaptureInputState {
    pub(crate) fn new() -> Self {
        Self {
            active: Arc::new(std::sync::Mutex::new(false)),
        }
    }
}


#[tauri::command]
pub fn set_capture_input_active(
    app: tauri::AppHandle,
    state: tauri::State<SharedCaptureInputState>,
    hit_map: tauri::State<SharedHitMap>,
    active: bool,
    sample_color: Option<bool>,
) {
    let wants_color_sample = sample_color.unwrap_or(false);
    if let Ok(mut guard) = state.active.lock() {
        *guard = active;
        append_runtime_log_line(&format!(
            "set_capture_input_active :: active={} sample_color={}",
            active, wants_color_sample
        ));
        #[cfg(target_os = "windows")]
        {
            CAPTURE_COLOR_SAMPLE_ACTIVE.store(active && wants_color_sample, Ordering::SeqCst);
        }
        // LL hook + click-through only for color picker. Region selection uses the
        // overlay webview's native mouse path (no SetSystemCursor, no move IPC).
        set_capture_input_runtime_active_with_hook(active, active && wants_color_sample);
    }

    if let Some(window) = app.get_webview_window("main") {
        let rects = hit_map
            .rectangles
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default();
        let overlay_active = hit_map.active.lock().map(|guard| *guard).unwrap_or(false);
        sync_overlay_input_shield_region(&window, &rects, overlay_active);
    }
}

pub(crate) fn show_canvas_window_impl(window: &tauri::WebviewWindow) {
    let _ = window.set_content_protected(false);
    clear_overlay_no_activate(window);
    let _ = window.set_ignore_cursor_events(false);
    set_overlay_transparent_style(window, false);
    OVERLAY_CLICK_THROUGH_ACTIVE.store(false, Ordering::SeqCst);
    let _ = window.set_title("Hook");
    let _ = window.set_skip_taskbar(false);
    let _ = window.set_always_on_top(false);
    let _ = window.set_decorations(true);
    let _ = window.set_resizable(true);
    let _ = window.set_shadow(true);
    let _ = window.set_fullscreen(false);
    let _ = window.unmaximize();
    let _ = window.set_size(Size::Logical(LogicalSize::new(1280.0, 820.0)));
    let _ = window.center();

    if let Err(e) = window.show() {
        println!("Failed to show canvas window: {}", e);
    }

    if let Err(e) = window.set_focus() {
        println!("Failed to focus canvas window: {}", e);
    }
}

pub(crate) fn show_overlay_host_impl(window: &tauri::WebviewWindow, click_through: bool) {
    setup_overlay_window(window);
    let _ = window.set_ignore_cursor_events(click_through);
    set_overlay_transparent_style(window, click_through);
    OVERLAY_CLICK_THROUGH_ACTIVE.store(click_through, Ordering::SeqCst);
}

fn set_overlay_click_through_impl(window: &tauri::WebviewWindow, click_through: bool) {
    let _ = window.set_ignore_cursor_events(click_through);
    set_overlay_transparent_style(window, click_through);
    OVERLAY_CLICK_THROUGH_ACTIVE.store(click_through, Ordering::SeqCst);
    apply_overlay_no_activate(window);
}

fn set_overlay_capture_exclusion_impl(window: &tauri::WebviewWindow, enabled: bool) {
    if let Err(error) = window.set_content_protected(enabled) {
        append_runtime_log_line(&format!(
            "set_overlay_capture_exclusion_failed :: enabled={} error={}",
            enabled, error
        ));
    }
}

pub(crate) fn hide_to_tray_impl(window: &tauri::WebviewWindow) {
    let _ = window.set_ignore_cursor_events(false);
    set_overlay_transparent_style(window, false);
    OVERLAY_CLICK_THROUGH_ACTIVE.store(false, Ordering::SeqCst);
    if let Err(e) = window.hide() {
        println!("Failed to hide window to tray: {}", e);
    }
}

pub(crate) fn enter_capture_mode(window: &tauri::WebviewWindow) {
    append_runtime_log_line("enter_capture_mode");
    #[cfg(target_os = "windows")]
    CAPTURE_COLOR_SAMPLE_ACTIVE.store(false, Ordering::SeqCst);
    force_restore_system_cursors();
    // Region capture owns the overlay mouse stream — do not arm the LL hook or
    // rewrite the system cursor (both fail badly with multiple virtual desktops).
    set_capture_input_runtime_active_with_hook(false, false);
    show_overlay_host_impl(window, false);

    println!("Overlay setup done. Emitting trigger-capture...");
    if let Err(e) = window.emit("trigger-capture", ()) {
        println!("Failed to emit trigger-capture: {}", e);
        append_runtime_log_line(&format!("enter_capture_mode emit_failed :: {}", e));
    } else {
        append_runtime_log_line("enter_capture_mode emitted_trigger_capture");
    }
}

pub(crate) fn enter_long_capture_mode(window: &tauri::WebviewWindow) {
    append_runtime_log_line("enter_long_capture_mode");
    #[cfg(target_os = "windows")]
    CAPTURE_COLOR_SAMPLE_ACTIVE.store(false, Ordering::SeqCst);
    force_restore_system_cursors();
    set_capture_input_runtime_active_with_hook(false, false);
    show_overlay_host_impl(window, false);

    if let Err(e) = window.emit("trigger-long-capture", ()) {
        println!("Failed to emit trigger-long-capture: {}", e);
        append_runtime_log_line(&format!("enter_long_capture_mode emit_failed :: {}", e));
    } else {
        append_runtime_log_line("enter_long_capture_mode emitted_trigger_long_capture");
    }
}


pub(crate) fn trigger_toggle_sticker_toolbar(window: &tauri::WebviewWindow) {
    append_runtime_log_line("trigger_toggle_sticker_toolbar");

    if let Err(e) = window.set_focus() {
        println!("Failed to set focus: {}", e);
        append_runtime_log_line(&format!(
            "trigger_toggle_sticker_toolbar focus_failed :: {}",
            e
        ));
    }

    if let Err(e) = window.emit("trigger-toggle-sticker-toolbar", ()) {
        println!("Failed to emit trigger-toggle-sticker-toolbar: {}", e);
        append_runtime_log_line(&format!(
            "trigger_toggle_sticker_toolbar emit_failed :: {}",
            e
        ));
    } else {
        append_runtime_log_line("trigger_toggle_sticker_toolbar emitted");
    }
}


#[tauri::command]
pub fn show_canvas_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        show_canvas_window_impl(&window);
        return Ok(());
    }

    Err("Window not found".to_string())
}

#[tauri::command]
pub fn show_overlay_host(app: tauri::AppHandle, click_through: Option<bool>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        show_overlay_host_impl(&window, click_through.unwrap_or(true));
        return Ok(());
    }

    Err("Window not found".to_string())
}

#[tauri::command]
pub fn set_overlay_click_through(app: tauri::AppHandle, click_through: bool) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        set_overlay_click_through_impl(&window, click_through);
        append_runtime_log_line(&format!(
            "set_overlay_click_through :: click_through={}",
            click_through
        ));
        return Ok(());
    }

    Err("Window not found".to_string())
}

#[cfg(target_os = "windows")]
#[tauri::command]
pub fn set_native_drag_preflight_active(active: bool) -> Result<(), String> {
    OVERLAY_MOUSE_HOOK_NATIVE_DRAG_PREFLIGHT_ACTIVE.store(active, Ordering::SeqCst);
    Ok(())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub fn set_native_drag_preflight_active(_active: bool) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "windows")]
#[tauri::command]
pub fn set_overlay_keyboard_capture_active(_app: tauri::AppHandle, active: bool) -> Result<(), String> {
    OVERLAY_KEYBOARD_CAPTURE_ACTIVE.store(active, Ordering::SeqCst);
    Ok(())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub fn set_overlay_keyboard_capture_active(_app: tauri::AppHandle, _active: bool) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub fn focus_overlay_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        clear_overlay_no_activate(&window);
        if let Err(error) = window.set_focus() {
            apply_overlay_no_activate(&window);
            return Err(format!("Failed to focus overlay window: {}", error));
        }
        apply_overlay_no_activate(&window);
        append_runtime_log_line("focus_overlay_window");
        return Ok(());
    }

    Err("Window not found".to_string())
}

#[tauri::command]
pub fn set_overlay_capture_exclusion(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        set_overlay_capture_exclusion_impl(&window, enabled);
        append_runtime_log_line(&format!(
            "set_overlay_capture_exclusion :: enabled={}",
            enabled
        ));
        return Ok(());
    }

    Err("Window not found".to_string())
}

#[tauri::command]
pub fn hide_to_tray(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        hide_to_tray_impl(&window);
        return Ok(());
    }

    Err("Window not found".to_string())
}

#[tauri::command]
pub fn trigger_capture_mode(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        enter_capture_mode(&window);
        return Ok(());
    }

    Err("Window not found".to_string())
}


pub(crate) fn install_rdev_input_listener(
    window: tauri::WebviewWindow,
    hit_map: SharedHitMap,
    capture_input_state: SharedCaptureInputState,
    long_capture_sessions: SharedLongCaptureSessions,
    capture_global_registered: Arc<AtomicBool>,
    long_capture_global_registered: Arc<AtomicBool>,
    shared_app_settings: app_settings::SharedAppSettings,
) {
    std::thread::spawn(move || {
        struct RdevInputRuntimeState {
            last_esc: Instant,
            is_ignoring_events: bool,
            ctrl_pressed: bool,
            last_capture_trigger: Instant,
        }

        let input_runtime_state = Mutex::new(RdevInputRuntimeState {
            last_esc: Instant::now() - Duration::from_secs(1),
            is_ignoring_events: false,
            ctrl_pressed: false,
            last_capture_trigger: Instant::now() - Duration::from_secs(2),
        });

        if let Err(error) = rdev::listen(move |event| {
            let mut input_state = match input_runtime_state.lock() {
                Ok(guard) => guard,
                Err(_) => return,
            };

            match &event.event_type {
                rdev::EventType::KeyPress(rdev::Key::ControlLeft)
                | rdev::EventType::KeyPress(rdev::Key::ControlRight) => {
                    input_state.ctrl_pressed = true;
                }
                rdev::EventType::KeyRelease(rdev::Key::ControlLeft)
                | rdev::EventType::KeyRelease(rdev::Key::ControlRight) => {
                    input_state.ctrl_pressed = false;
                }
                rdev::EventType::KeyPress(key) => {
                    let settings = shared_app_settings.get();
                    let digit = match key {
                        rdev::Key::Num0 => Some(0),
                        rdev::Key::Num1 => Some(1),
                        rdev::Key::Num2 => Some(2),
                        rdev::Key::Num3 => Some(3),
                        rdev::Key::Num4 => Some(4),
                        rdev::Key::Num5 => Some(5),
                        rdev::Key::Num6 => Some(6),
                        rdev::Key::Num7 => Some(7),
                        rdev::Key::Num8 => Some(8),
                        rdev::Key::Num9 => Some(9),
                        _ => None,
                    };

                    if let Some(digit) = digit {
                        if input_state.ctrl_pressed
                            && input_state.last_capture_trigger.elapsed() > Duration::from_millis(500)
                        {
                            let capture_digit =
                                app_settings::binding_digit(&settings.shortcuts.capture);
                            let long_digit =
                                app_settings::binding_digit(&settings.shortcuts.long_capture);
                            let capture_ctrl =
                                app_settings::binding_uses_ctrl(&settings.shortcuts.capture);
                            let long_ctrl =
                                app_settings::binding_uses_ctrl(&settings.shortcuts.long_capture);

                            if capture_ctrl
                                && capture_digit == Some(digit)
                                && !capture_global_registered.load(Ordering::Relaxed)
                            {
                                input_state.last_capture_trigger = Instant::now();
                                append_runtime_log_line("rdev_capture_triggered");
                                enter_capture_mode(&window);
                                return;
                            }
                            if long_ctrl
                                && long_digit == Some(digit)
                                && !long_capture_global_registered.load(Ordering::Relaxed)
                            {
                                input_state.last_capture_trigger = Instant::now();
                                append_runtime_log_line("rdev_long_capture_triggered");
                                enter_long_capture_mode(&window);
                                return;
                            }
                        }
                    }

                    if matches!(key, rdev::Key::PrintScreen)
                        && input_state.last_capture_trigger.elapsed() > Duration::from_millis(500)
                    {
                        if app_settings::binding_is_print_screen(&settings.shortcuts.capture) {
                            input_state.last_capture_trigger = Instant::now();
                            append_runtime_log_line("rdev_printscreen_capture_triggered");
                            enter_capture_mode(&window);
                            return;
                        }
                        if app_settings::binding_is_print_screen(&settings.shortcuts.long_capture) {
                            input_state.last_capture_trigger = Instant::now();
                            append_runtime_log_line("rdev_printscreen_long_capture_triggered");
                            enter_long_capture_mode(&window);
                            return;
                        }
                    }

                    match key {
                        rdev::Key::Escape => {
                            if overlay_keyboard_capture_should_handle_current_cursor() {
                                append_runtime_log_line(
                                    "rdev_escape_skipped_overlay_keyboard_capture",
                                );
                                return;
                            }
                            if input_state.last_esc.elapsed() < Duration::from_millis(400) {
                                println!("Double ESC detected - Emergency Exit.");
                                set_capture_input_runtime_active(false);
                                std::process::exit(0);
                            }
                            input_state.last_esc = Instant::now();
                            append_runtime_log_line("rdev_escape_triggered");
                            set_capture_input_runtime_active(false);
                            let _ = window.emit("trigger-escape", ());
                        }
                        rdev::Key::Delete | rdev::Key::Backspace => {
                            if overlay_keyboard_capture_should_handle_current_cursor() {
                                append_runtime_log_line(
                                    "rdev_delete_skipped_overlay_keyboard_capture",
                                );
                                return;
                            }
                            append_runtime_log_line("rdev_delete_triggered");
                            let _ = window.emit("trigger-delete", ());
                        }
                        rdev::Key::Return => {
                            append_runtime_log_line("rdev_enter_triggered");
                            let _ = window.emit("trigger-long-capture-finish", ());
                        }
                        _ => {}
                    }
                }
                rdev::EventType::Wheel { delta_x, delta_y } => {
                    let capture_active = capture_input_state
                        .active
                        .lock()
                        .map(|guard| *guard)
                        .unwrap_or(false);
                    if capture_active {
                        return;
                    }

                    if long_capture_sessions.has_any_sessions() {
                        append_runtime_log_line(&format!(
                            "rdev_long_capture_wheel :: delta_x={} delta_y={}",
                            delta_x, delta_y
                        ));
                        let _ = window.emit(
                            "trigger-long-capture-wheel",
                            LongCaptureWheelEvent {
                                delta_x: *delta_x,
                                delta_y: *delta_y,
                            },
                        );
                    }
                }
                rdev::EventType::MouseMove { x, y } => {
                    let _ = (x, y);
                    let capture_active = capture_input_state
                        .active
                        .lock()
                        .map(|guard| *guard)
                        .unwrap_or(false);
                    if capture_active {
                        return;
                    }

                    let active = hit_map
                        .active
                        .lock()
                        .map(|guard| *guard)
                        .unwrap_or(false);
                    if active {
                        let should_ignore = hit_map
                            .rectangles
                            .lock()
                            .map(|rects| should_overlay_window_ignore_cursor_events(&rects, *x, *y))
                            .unwrap_or(true);
                        if should_ignore != input_state.is_ignoring_events {
                            let _ = window.set_ignore_cursor_events(should_ignore);
                            set_overlay_transparent_style(&window, should_ignore);
                            OVERLAY_CLICK_THROUGH_ACTIVE.store(should_ignore, Ordering::SeqCst);
                            apply_overlay_no_activate(&window);
                            input_state.is_ignoring_events = should_ignore;
                        }
                    } else {
                        input_state.is_ignoring_events = false;
                    }
                }
                _ => {}
            }
        }) {
            println!("Error: {:?}", error);
            append_runtime_log_line(&format!("rdev_listen_failed :: {:?}", error));
        }
    });
}
