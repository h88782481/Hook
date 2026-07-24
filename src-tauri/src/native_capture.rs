//! Glance-style native freeze + select overlay.
//!
//! Region selection runs in a dedicated winit + softbuffer window (no WebView),
//! then hands the crop / rect back to the Solid sticker workspace.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use crate::encode_rgb_image_as_file_capture_response;
use crate::long_capture_session::SharedLongCaptureSessions;
use crate::overlay::{
    set_capture_input_runtime_active_with_hook, show_overlay_host_impl,
};
use crate::screenshot::{self, FreezeFrame};
use crate::{append_runtime_log_line, mouse_monitor::SharedHitMap};

static NATIVE_CAPTURE_BUSY: AtomicBool = AtomicBool::new(false);
static LONG_CAPTURE_UI_ACTIVE: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeCaptureMode {
    Region,
    Long,
}

#[tauri::command]
pub fn set_long_capture_ui_active(active: bool) {
    LONG_CAPTURE_UI_ACTIVE.store(active, Ordering::SeqCst);
    append_runtime_log_line(&format!("long_capture_ui_active :: {}", active));
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LogicalRectPayload {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct NativeRegionCapturePayload {
    width: u32,
    height: u32,
    file_path: String,
    rect: LogicalRectPayload,
}

pub(crate) fn begin_native_capture(app: AppHandle, mode: NativeCaptureMode) {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, mode);
        append_runtime_log_line("native_capture_unsupported_platform");
        return;
    }

    #[cfg(target_os = "windows")]
    {
        if mode == NativeCaptureMode::Long {
            let backend_active = app
                .try_state::<SharedLongCaptureSessions>()
                .map(|sessions| sessions.has_any_sessions())
                .unwrap_or(false);
            if backend_active || LONG_CAPTURE_UI_ACTIVE.load(Ordering::SeqCst) {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.emit("trigger-long-capture", ());
                }
                return;
            }
        }

        if NATIVE_CAPTURE_BUSY
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            append_runtime_log_line("native_capture_busy");
            return;
        }

        append_runtime_log_line(&format!("native_capture_begin :: mode={:?}", mode));
        set_capture_input_runtime_active_with_hook(false, false);

        if let Some(hit_map) = app.try_state::<SharedHitMap>() {
            crate::overlay::force_mouse_monitor_inactive(&hit_map);
        }

        if let Some(window) = app.get_webview_window("main") {
            // Keep Hook out of the freeze frame.
            let _ = window.set_content_protected(true);
            let _ = window.hide();
        }

        std::thread::Builder::new()
            .name("hook-native-capture".into())
            .spawn(move || {
                // Let DWM apply hide before BitBlt/WGC samples the desktop.
                std::thread::sleep(Duration::from_millis(40));

                let freeze = match screenshot::capture_freeze_frame() {
                    Ok(frame) => frame,
                    Err(error) => {
                        append_runtime_log_line(&format!(
                            "native_capture_freeze_failed :: {}",
                            error
                        ));
                        finish_native_capture_session(
                            &app,
                            NativeOverlayRestore::Show { click_through: true },
                        );
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.emit("native-capture-cancelled", ());
                        }
                        return;
                    }
                };

                let (event_tx, event_rx) = mpsc::channel::<CaptureUiEvent>();
                windows_impl::start_capture(freeze.clone(), event_tx);

                match event_rx.recv() {
                    Ok(CaptureUiEvent::Selection { x, y, w, h }) => {
                        handle_selection_finished(&app, mode, &freeze, x, y, w, h);
                    }
                    Ok(CaptureUiEvent::Cancelled) | Err(_) => {
                        append_runtime_log_line("native_capture_cancelled");
                        finish_native_capture_session(
                            &app,
                            NativeOverlayRestore::Show { click_through: true },
                        );
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.emit("native-capture-cancelled", ());
                        }
                    }
                }
            })
            .ok();
    }
}

fn handle_selection_finished(
    app: &AppHandle,
    mode: NativeCaptureMode,
    freeze: &FreezeFrame,
    x: u32,
    y: u32,
    w: u32,
    h: u32,
) {
    let scale = freeze.scale_factor.max(0.000_1);
    // Selection x/y are physical pixels inside the freeze monitor bitmap.
    // capture_area expects primary-relative logical coords, so convert via
    // global physical position (monitor origin + local offset).
    let global_phys_x = freeze.monitor_x as f64 + x as f64;
    let global_phys_y = freeze.monitor_y as f64 + y as f64;
    let logical = LogicalRectPayload {
        x: global_phys_x / scale,
        y: global_phys_y / scale,
        w: w as f64 / scale,
        h: h as f64 / scale,
    };

    match mode {
        NativeCaptureMode::Region => {
            let cropped = match crop_freeze_rgb(&freeze.rgb, x, y, w, h) {
                Ok(image) => image,
                Err(error) => {
                    append_runtime_log_line(&format!(
                        "native_capture_crop_failed :: {}",
                        error
                    ));
                    finish_native_capture_session(
                        app,
                        NativeOverlayRestore::Show { click_through: true },
                    );
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.emit("native-capture-cancelled", ());
                    }
                    return;
                }
            };

            match encode_rgb_image_as_file_capture_response(cropped) {
                Ok(response) => {
                    let payload = NativeRegionCapturePayload {
                        width: response.width,
                        height: response.height,
                        file_path: response.file_path,
                        rect: logical,
                    };
                    finish_native_capture_session(
                        app,
                        NativeOverlayRestore::Show { click_through: true },
                    );
                    if let Some(window) = app.get_webview_window("main") {
                        if let Err(error) = window.emit("native-capture-result", payload) {
                            append_runtime_log_line(&format!(
                                "native_capture_emit_result_failed :: {}",
                                error
                            ));
                        } else {
                            append_runtime_log_line("native_capture_emitted_result");
                        }
                    }
                }
                Err(error) => {
                    append_runtime_log_line(&format!(
                        "native_capture_encode_failed :: {}",
                        error
                    ));
                    finish_native_capture_session(
                        app,
                        NativeOverlayRestore::Show { click_through: true },
                    );
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.emit("native-capture-cancelled", ());
                    }
                }
            }
        }
        NativeCaptureMode::Long => {
            // Leave the host hidden; frontend shows click-through status overlay
            // without capture-exclusion (same as the old working long-capture path).
            finish_native_capture_session(app, NativeOverlayRestore::KeepHidden);
            if let Some(window) = app.get_webview_window("main") {
                if let Err(error) = window.emit("native-long-capture-rect", logical) {
                    append_runtime_log_line(&format!(
                        "native_capture_emit_long_rect_failed :: {}",
                        error
                    ));
                } else {
                    append_runtime_log_line("native_capture_emitted_long_rect");
                }
            }
        }
    }
}

#[derive(Debug, Clone, Copy)]
enum NativeOverlayRestore {
    /// Show the WebView host again (region done / cancelled).
    Show { click_through: bool },
    /// Leave host hidden — long-capture frontend will show status itself.
    KeepHidden,
}

fn finish_native_capture_session(app: &AppHandle, restore: NativeOverlayRestore) {
    NATIVE_CAPTURE_BUSY.store(false, Ordering::SeqCst);
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let _ = window.set_content_protected(false);
    match restore {
        NativeOverlayRestore::Show { click_through } => {
            show_overlay_host_impl(&window, click_through);
        }
        NativeOverlayRestore::KeepHidden => {
            let _ = window.hide();
        }
    }
}

fn crop_freeze_rgb(
    rgb: &image::RgbImage,
    x: u32,
    y: u32,
    w: u32,
    h: u32,
) -> Result<image::RgbImage, String> {
    if w < 5 || h < 5 {
        return Err("selection too small".into());
    }
    let max_w = rgb.width();
    let max_h = rgb.height();
    if x >= max_w || y >= max_h {
        return Err("selection out of bounds".into());
    }
    let w = w.min(max_w - x);
    let h = h.min(max_h - y);
    Ok(image::imageops::crop_imm(rgb, x, y, w, h).to_image())
}

#[derive(Debug)]
enum CaptureUiEvent {
    Selection { x: u32, y: u32, w: u32, h: u32 },
    Cancelled,
}

#[cfg(target_os = "windows")]
mod windows_impl {
    use super::*;
    use std::num::NonZeroU32;
    use std::sync::{mpsc, Arc, OnceLock};

    use softbuffer::{Context, Surface};
    use winit::application::ApplicationHandler;
    use winit::dpi::PhysicalPosition;
    use winit::event::{ElementState, MouseButton, WindowEvent};
    use winit::event_loop::{ActiveEventLoop, EventLoop, EventLoopProxy};
    use winit::keyboard::{KeyCode, PhysicalKey};
    use winit::platform::windows::EventLoopBuilderExtWindows;
            use winit::window::{CursorIcon, Fullscreen, Window, WindowId, WindowLevel};

    enum CaptureCommand {
        StartCapture {
            freeze: FreezeFrame,
            event_tx: mpsc::Sender<CaptureUiEvent>,
        },
    }

    static CAPTURE_PROXY: OnceLock<EventLoopProxy<CaptureCommand>> = OnceLock::new();

    pub(super) fn start_capture(freeze: FreezeFrame, event_tx: mpsc::Sender<CaptureUiEvent>) {
        let proxy = capture_proxy();
        let _ = proxy.send_event(CaptureCommand::StartCapture { freeze, event_tx });
    }

    fn capture_proxy() -> EventLoopProxy<CaptureCommand> {
        CAPTURE_PROXY
            .get_or_init(|| {
                let (proxy_tx, proxy_rx) = mpsc::sync_channel::<EventLoopProxy<CaptureCommand>>(1);
                std::thread::Builder::new()
                    .name("hook-capture-event-loop".into())
                    .spawn(move || {
                        let event_loop = EventLoop::<CaptureCommand>::with_user_event()
                            .with_any_thread(true)
                            .build()
                            .expect("failed to build native capture event loop");
                        let proxy = event_loop.create_proxy();
                        let _ = proxy_tx.send(proxy);
                        let mut handler = CaptureHandler::idle();
                        event_loop
                            .run_app(&mut handler)
                            .expect("native capture event loop crashed");
                    })
                    .expect("failed to spawn native capture event loop");
                proxy_rx
                    .recv()
                    .expect("native capture event loop died before sending proxy")
            })
            .clone()
    }

    enum HandlerState {
        Idle,
        Selecting(CaptureSession),
    }

    struct CaptureSession {
        img_w: u32,
        img_h: u32,
        original_pixels: Vec<u32>,
        darkened_pixels: Vec<u32>,
        event_tx: mpsc::Sender<CaptureUiEvent>,
        window: Arc<Window>,
        surface: Surface<Arc<Window>, Arc<Window>>,
        drag_start: Option<PhysicalPosition<f64>>,
        selection: Option<(u32, u32, u32, u32)>,
        is_dragging: bool,
        mouse_pos: PhysicalPosition<f64>,
        surface_ready: bool,
        shown: bool,
    }

    struct CaptureHandler {
        state: HandlerState,
        _ctx_storage: Option<Context<Arc<Window>>>,
    }

    impl CaptureHandler {
        fn idle() -> Self {
            Self {
                state: HandlerState::Idle,
                _ctx_storage: None,
            }
        }

        fn open_window(
            &mut self,
            event_loop: &ActiveEventLoop,
            freeze: FreezeFrame,
            event_tx: mpsc::Sender<CaptureUiEvent>,
        ) {
            let target_monitor = event_loop.available_monitors().find(|m| {
                let pos = m.position();
                pos.x == freeze.monitor_x && pos.y == freeze.monitor_y
            });
            let fullscreen = match target_monitor {
                Some(m) => Fullscreen::Borderless(Some(m)),
                None => Fullscreen::Borderless(None),
            };

            let attrs = Window::default_attributes()
                .with_title("Hook Capture")
                .with_decorations(false)
                .with_resizable(false)
                .with_fullscreen(Some(fullscreen))
                .with_window_level(WindowLevel::AlwaysOnTop)
                .with_cursor(CursorIcon::Crosshair)
                .with_visible(false);

            let window = match event_loop.create_window(attrs) {
                Ok(w) => {
                    w.set_cursor(CursorIcon::Crosshair);
                    Arc::new(w)
                }
                Err(error) => {
                    append_runtime_log_line(&format!(
                        "native_capture_window_create_failed :: {}",
                        error
                    ));
                    let _ = event_tx.send(CaptureUiEvent::Cancelled);
                    return;
                }
            };

            let ctx = match Context::new(window.clone()) {
                Ok(ctx) => ctx,
                Err(error) => {
                    append_runtime_log_line(&format!(
                        "native_capture_softbuffer_context_failed :: {:?}",
                        error
                    ));
                    let _ = event_tx.send(CaptureUiEvent::Cancelled);
                    return;
                }
            };
            let surface = match Surface::new(&ctx, window.clone()) {
                Ok(surface) => surface,
                Err(error) => {
                    append_runtime_log_line(&format!(
                        "native_capture_softbuffer_surface_failed :: {:?}",
                        error
                    ));
                    let _ = event_tx.send(CaptureUiEvent::Cancelled);
                    return;
                }
            };

            let original_pixels = rgb_to_softbuffer(&freeze.rgb);
            let darkened_pixels = darken_pixels(&original_pixels, 0.55);
            let img_w = freeze.img_w;
            let img_h = freeze.img_h;

            self._ctx_storage = Some(ctx);
            self.state = HandlerState::Selecting(CaptureSession {
                img_w,
                img_h,
                original_pixels,
                darkened_pixels,
                event_tx,
                window,
                surface,
                drag_start: None,
                selection: None,
                is_dragging: false,
                mouse_pos: PhysicalPosition::new(0.0, 0.0),
                surface_ready: false,
                shown: false,
            });

            if let HandlerState::Selecting(ref mut session) = self.state {
                if let (Some(nz_w), Some(nz_h)) = (NonZeroU32::new(img_w), NonZeroU32::new(img_h)) {
                    if session.surface.resize(nz_w, nz_h).is_ok() {
                        session.surface_ready = true;
                        if let Ok(mut buffer) = session.surface.buffer_mut() {
                            if buffer.len() == (img_w * img_h) as usize {
                                buffer.copy_from_slice(&session.darkened_pixels);
                                let _ = buffer.present();
                                session.shown = true;
                                session.window.set_cursor(CursorIcon::Crosshair);
                                session.window.set_visible(true);
                            }
                        }
                    }
                }
            }
        }

        fn close_window(&mut self) {
            self.state = HandlerState::Idle;
            self._ctx_storage = None;
        }
    }

    impl ApplicationHandler<CaptureCommand> for CaptureHandler {
        fn resumed(&mut self, _event_loop: &ActiveEventLoop) {}

        fn window_event(
            &mut self,
            _event_loop: &ActiveEventLoop,
            _window_id: WindowId,
            event: WindowEvent,
        ) {
            let session = match &mut self.state {
                HandlerState::Selecting(s) => s,
                HandlerState::Idle => return,
            };

            match event {
                WindowEvent::Resized(size) => {
                    if size.width > 0 && size.height > 0 {
                        let _ = session.surface.resize(
                            NonZeroU32::new(size.width).unwrap(),
                            NonZeroU32::new(size.height).unwrap(),
                        );
                        session.surface_ready = true;
                        session.window.request_redraw();
                    }
                }
                WindowEvent::RedrawRequested => redraw_session(session),
                WindowEvent::KeyboardInput {
                    event: key_event, ..
                } => {
                    if key_event.state == ElementState::Pressed {
                        if let PhysicalKey::Code(KeyCode::Escape) = key_event.physical_key {
                            let _ = session.event_tx.send(CaptureUiEvent::Cancelled);
                            self.close_window();
                        }
                    }
                }
                WindowEvent::MouseInput {
                    state,
                    button: MouseButton::Left,
                    ..
                } => {
                    let mut finished: Option<(u32, u32, u32, u32)> = None;
                    match state {
                        ElementState::Pressed => {
                            session.drag_start = Some(session.mouse_pos);
                            session.is_dragging = true;
                            session.selection = None;
                        }
                        ElementState::Released => {
                            if session.is_dragging {
                                if let Some(start) = session.drag_start {
                                    let rect = normalize_rect(start, session.mouse_pos);
                                    session.selection = Some(rect);
                                    if rect.2 > 4 && rect.3 > 4 {
                                        finished = Some(rect);
                                    }
                                }
                                session.is_dragging = false;
                                session.drag_start = None;
                            }
                        }
                    }
                    if let Some((x, y, w, h)) = finished {
                        let _ = session
                            .event_tx
                            .send(CaptureUiEvent::Selection { x, y, w, h });
                        self.close_window();
                    } else if let HandlerState::Selecting(session) = &self.state {
                        session.window.request_redraw();
                    }
                }
                WindowEvent::CursorMoved { position, .. } => {
                    session.mouse_pos = position;
                    if session.is_dragging {
                        session.window.request_redraw();
                    }
                }
                WindowEvent::MouseInput {
                    state: ElementState::Released,
                    button: MouseButton::Right,
                    ..
                } => {
                    let _ = session.event_tx.send(CaptureUiEvent::Cancelled);
                    self.close_window();
                }
                WindowEvent::CloseRequested => {
                    let _ = session.event_tx.send(CaptureUiEvent::Cancelled);
                    self.close_window();
                }
                _ => {}
            }
        }

        fn user_event(&mut self, event_loop: &ActiveEventLoop, event: CaptureCommand) {
            match event {
                CaptureCommand::StartCapture { freeze, event_tx } => {
                    self.close_window();
                    self.open_window(event_loop, freeze, event_tx);
                }
            }
        }
    }

    fn redraw_session(session: &mut CaptureSession) {
        if !session.surface_ready {
            return;
        }
        let mut buffer = match session.surface.buffer_mut() {
            Ok(b) => b,
            Err(_) => return,
        };
        let expected = (session.img_w * session.img_h) as usize;
        if buffer.len() != expected {
            buffer.fill(0);
            let _ = buffer.present();
            return;
        }

        buffer.copy_from_slice(&session.darkened_pixels);

        let sel = if session.is_dragging {
            session
                .drag_start
                .map(|start| normalize_rect(start, session.mouse_pos))
        } else {
            session.selection
        };

        if let Some((sx, sy, sw, sh)) = sel {
            if sw > 0 && sh > 0 {
                blit_pixels(
                    &mut buffer,
                    session.img_w,
                    &session.original_pixels,
                    session.img_w,
                    sx,
                    sy,
                    sx,
                    sy,
                    sw,
                    sh,
                );
                draw_border(
                    &mut buffer,
                    session.img_w,
                    session.img_h,
                    sx,
                    sy,
                    sw,
                    sh,
                    0x00D9FF38,
                    2,
                );
            }
        }

        let _ = buffer.present();
        if !session.shown {
            session.shown = true;
            session.window.set_visible(true);
        }
    }

    fn rgb_to_softbuffer(rgb: &image::RgbImage) -> Vec<u32> {
        rgb.pixels()
            .map(|px| {
                ((px[0] as u32) << 16) | ((px[1] as u32) << 8) | (px[2] as u32)
            })
            .collect()
    }

    fn darken_pixels(pixels: &[u32], factor: f32) -> Vec<u32> {
        pixels
            .iter()
            .map(|&p| {
                let r = ((((p >> 16) & 0xFF) as f32) * factor) as u32;
                let g = ((((p >> 8) & 0xFF) as f32) * factor) as u32;
                let b = (((p & 0xFF) as f32) * factor) as u32;
                (r << 16) | (g << 8) | b
            })
            .collect()
    }

    fn blit_pixels(
        dst: &mut [u32],
        dst_w: u32,
        src: &[u32],
        src_stride: u32,
        src_ox: u32,
        src_oy: u32,
        dx: u32,
        dy: u32,
        w: u32,
        h: u32,
    ) {
        let dst_w = dst_w as usize;
        let src_stride = src_stride as usize;
        let len = w as usize;
        for row in 0..(h as usize) {
            let dst_start = (dy as usize + row) * dst_w + dx as usize;
            let src_start = (src_oy as usize + row) * src_stride + src_ox as usize;
            if dst_start + len <= dst.len() && src_start + len <= src.len() {
                dst[dst_start..dst_start + len].copy_from_slice(&src[src_start..src_start + len]);
            }
        }
    }

    fn draw_border(
        buf: &mut [u32],
        buf_w: u32,
        buf_h: u32,
        x: u32,
        y: u32,
        w: u32,
        h: u32,
        color: u32,
        thickness: u32,
    ) {
        let bw = buf_w as usize;
        let x2 = (x + w).min(buf_w);
        let y2 = (y + h).min(buf_h);
        for t in 0..thickness {
            let top = (y + t) as usize;
            let bot = y2.saturating_sub(1).saturating_sub(t) as usize;
            for col in x..x2 {
                let c = col as usize;
                if top < buf_h as usize {
                    let i = top * bw + c;
                    if i < buf.len() {
                        buf[i] = color;
                    }
                }
                if bot != top && bot < buf_h as usize {
                    let i = bot * bw + c;
                    if i < buf.len() {
                        buf[i] = color;
                    }
                }
            }
            let left = (x + t) as usize;
            let right = x2.saturating_sub(1).saturating_sub(t) as usize;
            for row in y..y2 {
                let r = row as usize;
                if r < buf_h as usize {
                    let li = r * bw + left;
                    if li < buf.len() {
                        buf[li] = color;
                    }
                    if right != left {
                        let ri = r * bw + right;
                        if ri < buf.len() {
                            buf[ri] = color;
                        }
                    }
                }
            }
        }
    }

    fn normalize_rect(
        a: PhysicalPosition<f64>,
        b: PhysicalPosition<f64>,
    ) -> (u32, u32, u32, u32) {
        let x1 = a.x.min(b.x).max(0.0) as u32;
        let y1 = a.y.min(b.y).max(0.0) as u32;
        let x2 = a.x.max(b.x).max(0.0) as u32;
        let y2 = a.y.max(b.y).max(0.0) as u32;
        (x1, y1, x2.saturating_sub(x1), y2.saturating_sub(y1))
    }
}
