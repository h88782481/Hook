use anyhow::anyhow;
use image::RgbImage;
use std::sync::OnceLock;

use scap_targets::Display;

#[cfg(target_os = "windows")]
use scap_direct3d::{Capturer, Frame, PixelFormat, Settings, WindowsVersion};
#[cfg(target_os = "windows")]
use windows::Win32::Foundation::HMODULE;
#[cfg(target_os = "windows")]
use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_WARP};
#[cfg(target_os = "windows")]
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, D3D11_BOX, D3D11_SDK_VERSION,
};
#[cfg(target_os = "windows")]
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDC, ReleaseDC,
    SelectObject, BITMAPINFO, BITMAPINFOHEADER, CAPTUREBLT, DIB_RGB_COLORS, HDC, SRCCOPY,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CaptureWorkloadProfile {
    StandardRegion,
    LongCapture,
}

#[derive(Clone, Copy)]
enum ChannelOrder {
    Rgba,
    Bgra,
}

fn rgb_from_rgba(
    data: &[u8],
    width: usize,
    height: usize,
    bytes_per_row: usize,
    order: ChannelOrder,
) -> Option<RgbImage> {
    let row_bytes = width.checked_mul(4)?;
    if bytes_per_row < row_bytes {
        return None;
    }

    let required_len = height.checked_mul(bytes_per_row)?;
    if data.len() < required_len {
        return None;
    }

    let width_stride = width.checked_mul(3)?;
    let rgb_len = height.checked_mul(width_stride)?;
    let mut rgb = vec![0u8; rgb_len];

    for y in 0..height {
        let src_start = y.checked_mul(bytes_per_row)?;
        let src_end = src_start.checked_add(row_bytes)?;
        let dst_start = y.checked_mul(width_stride)?;
        let dst_end = dst_start.checked_add(width_stride)?;

        let src_row = data.get(src_start..src_end)?;
        let dst_row = rgb.get_mut(dst_start..dst_end)?;

        for (src, dst) in src_row.chunks_exact(4).zip(dst_row.chunks_exact_mut(3)) {
            let (r, b) = match order {
                ChannelOrder::Rgba => (src[0], src[2]),
                ChannelOrder::Bgra => (src[2], src[0]),
            };

            dst[0] = r;
            dst[1] = src[1];
            dst[2] = b;
        }
    }

    RgbImage::from_raw(width as u32, height as u32, rgb)
}

/// Shared D3D11 device: prefer hardware GPU, fall back to WARP for VMs / no-GPU hosts.
#[cfg(target_os = "windows")]
fn shared_d3d_device() -> anyhow::Result<&'static ID3D11Device> {
    static DEVICE: OnceLock<Option<(ID3D11Device, bool)>> = OnceLock::new();

    let device = DEVICE.get_or_init(|| {
        let mut device = None;
        let hw = unsafe {
            D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_HARDWARE,
                HMODULE::default(),
                Default::default(),
                None,
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                None,
            )
        };
        if hw.is_ok() {
            return device.map(|d| (d, false));
        }

        device = None;
        let warp = unsafe {
            D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_WARP,
                HMODULE::default(),
                Default::default(),
                None,
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                None,
            )
        };
        if warp.is_ok() {
            crate::append_runtime_log_line(
                "capture_area d3d_device :: using_WARP software_rasterizer (no GPU / VM)",
            );
            return device.map(|d| (d, true));
        }

        None
    });

    device
        .as_ref()
        .map(|(d, _)| d)
        .ok_or_else(|| anyhow!("D3D11 device unavailable (hardware and WARP both failed)"))
}

/// WGC needs Win10 1903+ (build 18362). Win11 features are enabled opportunistically.
#[cfg(target_os = "windows")]
fn graphics_capture_available() -> bool {
    static AVAILABLE: OnceLock<bool> = OnceLock::new();
    *AVAILABLE.get_or_init(|| {
        let version_ok = WindowsVersion::detect()
            .map(|version| version.meets_minimum_requirements())
            .unwrap_or(false);
        let api_ok = matches!(scap_direct3d::is_supported(), Ok(true));
        version_ok && api_ok && shared_d3d_device().is_ok()
    })
}

#[cfg(target_os = "windows")]
fn frame_to_rgb(frame: &Frame) -> anyhow::Result<RgbImage> {
    let buffer = frame
        .as_buffer()
        .map_err(|e| anyhow!("Failed to get buffer: {e:?}"))?;

    let order = match buffer.pixel_format() {
        PixelFormat::R8G8B8A8Unorm => ChannelOrder::Rgba,
        PixelFormat::B8G8R8A8Unorm => ChannelOrder::Bgra,
    };

    rgb_from_rgba(
        buffer.data(),
        buffer.width() as usize,
        buffer.height() as usize,
        buffer.stride() as usize,
        order,
    )
    .ok_or_else(|| anyhow!("Failed to create RgbImage"))
}

/// GraphicsCaptureSession settings. Border / MinUpdateInterval apply only when
/// the running OS exposes them (typically Win11).
#[cfg(target_os = "windows")]
fn windows_capture_settings() -> Settings {
    use std::time::Duration;

    let mut settings = Settings {
        is_cursor_capture_enabled: Some(false),
        pixel_format: PixelFormat::B8G8R8A8Unorm,
        ..Default::default()
    };

    if Settings::can_is_border_required().unwrap_or(false) {
        settings.is_border_required = Some(false);
    }
    if Settings::can_min_update_interval().unwrap_or(false) {
        settings.min_update_interval = Some(Duration::from_millis(16));
    }

    settings
}

#[cfg(target_os = "windows")]
fn frame_is_mostly_black(img: &RgbImage) -> bool {
    let (w, h) = (img.width(), img.height());
    if w == 0 || h == 0 {
        return true;
    }
    let step_x = (w / 64).max(1);
    let step_y = (h / 64).max(1);
    let mut sampled: u64 = 0;
    let mut black: u64 = 0;
    let mut y = 0;
    while y < h {
        let mut x = 0;
        while x < w {
            let p = img.get_pixel(x, y).0;
            sampled += 1;
            if p[0] <= 8 && p[1] <= 8 && p[2] <= 8 {
                black += 1;
            }
            x += step_x;
        }
        y += step_y;
    }
    sampled > 0 && black * 100 >= sampled * 99
}

#[cfg(target_os = "windows")]
fn crop_rgb(full: &RgbImage, crop: &D3D11_BOX) -> RgbImage {
    use image::imageops;

    let img_w = full.width();
    let img_h = full.height();
    let left = crop.left.min(img_w.saturating_sub(1));
    let top = crop.top.min(img_h.saturating_sub(1));
    let right = crop.right.min(img_w).max(left + 1);
    let bottom = crop.bottom.min(img_h).max(top + 1);
    imageops::crop_imm(full, left, top, right - left, bottom - top).to_image()
}

#[cfg(target_os = "windows")]
struct WgcShared {
    latest: std::sync::Mutex<Option<RgbImage>>,
    seq: std::sync::atomic::AtomicU64,
    target_display: std::sync::Mutex<scap_targets::DisplayId>,
    ready: std::sync::atomic::AtomicBool,
    /// Only map/convert frames while a capture is waiting. Continuous
    /// frame_to_rgb at ~60fps after capture is what made the whole PC laggy.
    capture_armed: std::sync::atomic::AtomicBool,
}

#[cfg(target_os = "windows")]
fn wgc_shared(display_id: &scap_targets::DisplayId) -> &'static std::sync::Arc<WgcShared> {
    static SHARED: OnceLock<std::sync::Arc<WgcShared>> = OnceLock::new();
    static WORKER_STARTED: OnceLock<()> = OnceLock::new();

    let shared = SHARED.get_or_init(|| {
        std::sync::Arc::new(WgcShared {
            latest: std::sync::Mutex::new(None),
            seq: std::sync::atomic::AtomicU64::new(0),
            target_display: std::sync::Mutex::new(display_id.clone()),
            ready: std::sync::atomic::AtomicBool::new(false),
            capture_armed: std::sync::atomic::AtomicBool::new(false),
        })
    });

    if let Ok(mut guard) = shared.target_display.lock() {
        *guard = display_id.clone();
    }

    WORKER_STARTED.get_or_init(|| {
        let thread_shared = shared.clone();
        let _ = std::thread::Builder::new()
            .name("hook-wgc-session".into())
            .spawn(move || wgc_session_loop(thread_shared));
    });

    shared
}

#[cfg(target_os = "windows")]
fn build_session_capturer(
    display_id: &scap_targets::DisplayId,
    shared: &std::sync::Arc<WgcShared>,
    closed: &std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> anyhow::Result<Capturer> {
    let display = scap_targets::Display::from_id(display_id)
        .ok_or_else(|| anyhow!("Display not found"))?;
    let item = display
        .raw_handle()
        .try_as_capture_item()
        .map_err(|e| anyhow!("GraphicsCaptureItem failed: {e:?}"))?;
    let device = shared_d3d_device()?.clone();
    let latest = shared.clone();
    let closed_flag = closed.clone();

    Capturer::new(
        item,
        windows_capture_settings(),
        move |frame| {
            // Idle: acknowledge frames but do NOT Map/convert (that is the lag source).
            if !latest
                .capture_armed
                .load(std::sync::atomic::Ordering::Acquire)
            {
                return Ok(());
            }
            if let Ok(img) = frame_to_rgb(&frame) {
                if let Ok(mut slot) = latest.latest.lock() {
                    *slot = Some(img);
                    latest
                        .seq
                        .fetch_add(1, std::sync::atomic::Ordering::Release);
                }
            }
            Ok(())
        },
        move || {
            closed_flag.store(true, std::sync::atomic::Ordering::SeqCst);
            Ok(())
        },
        Some(device),
    )
    .map_err(|e| anyhow!("Capturer::new failed: {e}"))
}

#[cfg(target_os = "windows")]
fn wgc_session_loop(shared: std::sync::Arc<WgcShared>) {
    use std::time::{Duration, Instant};

    const IDLE_STOP_AFTER: Duration = Duration::from_millis(1200);

    loop {
        // Stay parked until a capture actually needs the session.
        while !shared
            .capture_armed
            .load(std::sync::atomic::Ordering::Acquire)
        {
            std::thread::sleep(Duration::from_millis(50));
        }

        let display_id = match shared.target_display.lock() {
            Ok(guard) => guard.clone(),
            Err(_) => {
                std::thread::sleep(Duration::from_millis(200));
                continue;
            }
        };

        let closed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let mut capturer = match build_session_capturer(&display_id, &shared, &closed) {
            Ok(capturer) => capturer,
            Err(error) => {
                crate::append_runtime_log_line(&format!(
                    "capture_area wgc_session_fail :: {error}"
                ));
                shared
                    .ready
                    .store(false, std::sync::atomic::Ordering::SeqCst);
                shared
                    .capture_armed
                    .store(false, std::sync::atomic::Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(750));
                continue;
            }
        };

        if let Err(error) = capturer.start() {
            crate::append_runtime_log_line(&format!(
                "capture_area wgc_session_start_fail :: {error:?}"
            ));
            shared
                .ready
                .store(false, std::sync::atomic::Ordering::SeqCst);
            shared
                .capture_armed
                .store(false, std::sync::atomic::Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(750));
            continue;
        }

        shared.ready.store(true, std::sync::atomic::Ordering::SeqCst);
        if let Some(version) = WindowsVersion::detect() {
            crate::append_runtime_log_line(&format!(
                "capture_area wgc_session_started :: api=GraphicsCapture os={}",
                version.display_name()
            ));
        } else {
            crate::append_runtime_log_line(
                "capture_area wgc_session_started :: api=GraphicsCapture",
            );
        }

        let mut idle_since: Option<Instant> = None;
        while !closed.load(std::sync::atomic::Ordering::SeqCst) {
            let target_changed = shared
                .target_display
                .lock()
                .map(|guard| *guard != display_id)
                .unwrap_or(false);
            if target_changed {
                break;
            }

            let armed = shared
                .capture_armed
                .load(std::sync::atomic::Ordering::Acquire);
            if armed {
                idle_since = None;
            } else {
                let since = idle_since.get_or_insert_with(Instant::now);
                if since.elapsed() >= IDLE_STOP_AFTER {
                    crate::append_runtime_log_line(
                        "capture_area wgc_session_idle_stop :: reason=post_capture_idle",
                    );
                    break;
                }
            }
            std::thread::sleep(Duration::from_millis(50));
        }

        shared
            .ready
            .store(false, std::sync::atomic::Ordering::SeqCst);
        let _ = capturer.stop();
        if let Ok(mut slot) = shared.latest.lock() {
            *slot = None;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[cfg(target_os = "windows")]
fn capture_from_wgc_session(
    display_id: &scap_targets::DisplayId,
    crop: &D3D11_BOX,
) -> anyhow::Result<RgbImage> {
    use std::time::{Duration, Instant};

    let shared = wgc_shared(display_id);
    shared
        .capture_armed
        .store(true, std::sync::atomic::Ordering::Release);

    let result = (|| {
        let ready_deadline = Instant::now() + Duration::from_millis(800);
        while !shared.ready.load(std::sync::atomic::Ordering::SeqCst) {
            if Instant::now() >= ready_deadline {
                return Err(anyhow!("Graphics Capture session not ready"));
            }
            std::thread::sleep(Duration::from_millis(8));
        }

        // Drop any stale black warm-up frame; wait for a fresh converted frame.
        let mut seq_seen = shared.seq.load(std::sync::atomic::Ordering::Acquire);
        let deadline = Instant::now() + Duration::from_millis(900);
        let mut chosen: Option<RgbImage> = None;

        while chosen.is_none() && Instant::now() < deadline {
            let seq_now = shared.seq.load(std::sync::atomic::Ordering::Acquire);
            if seq_now != seq_seen {
                seq_seen = seq_now;
                if let Ok(slot) = shared.latest.lock() {
                    if let Some(img) = slot.as_ref() {
                        if !frame_is_mostly_black(img) {
                            chosen = Some(img.clone());
                            break;
                        }
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(8));
        }

        let full = chosen.ok_or_else(|| anyhow!("No usable Graphics Capture frame"))?;
        Ok(crop_rgb(&full, crop))
    })();

    shared
        .capture_armed
        .store(false, std::sync::atomic::Ordering::Release);
    if let Ok(mut slot) = shared.latest.lock() {
        *slot = None;
    }

    result
}

#[cfg(target_os = "windows")]
fn capture_bitmap_with(
    base_dc: HDC,
    width: i32,
    height: i32,
    mut fill: impl FnMut(HDC) -> anyhow::Result<()>,
) -> anyhow::Result<Vec<u8>> {
    if width <= 0 || height <= 0 || base_dc.is_invalid() {
        return Err(anyhow!("Invalid GDI capture parameters"));
    }

    let mem_dc = unsafe { CreateCompatibleDC(Some(base_dc)) };
    if mem_dc.is_invalid() {
        return Err(anyhow!("CreateCompatibleDC failed"));
    }

    let info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: -height,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: 0,
            biSizeImage: 0,
            biXPelsPerMeter: 0,
            biYPelsPerMeter: 0,
            biClrUsed: 0,
            biClrImportant: 0,
        },
        bmiColors: [Default::default(); 1],
    };

    let mut data = std::ptr::null_mut();
    let bitmap =
        unsafe { CreateDIBSection(Some(mem_dc), &info, DIB_RGB_COLORS, &mut data, None, 0) };

    let bitmap = match bitmap {
        Ok(b) if !b.is_invalid() && !data.is_null() => b,
        _ => {
            unsafe {
                let _ = DeleteDC(mem_dc);
            }
            return Err(anyhow!("CreateDIBSection failed"));
        }
    };

    let old_obj = unsafe { SelectObject(mem_dc, bitmap.into()) };
    let result = (|| {
        fill(mem_dc)?;
        let width = usize::try_from(width).map_err(|_| anyhow!("bad width"))?;
        let height = usize::try_from(height).map_err(|_| anyhow!("bad height"))?;
        let row_bytes = width.checked_mul(4).ok_or_else(|| anyhow!("row overflow"))?;
        let len = height
            .checked_mul(row_bytes)
            .ok_or_else(|| anyhow!("buffer overflow"))?;
        let slice = unsafe { std::slice::from_raw_parts(data as *const u8, len) };
        let mut buffer = vec![0u8; len];
        buffer.copy_from_slice(slice);
        Ok(buffer)
    })();

    unsafe {
        SelectObject(mem_dc, old_obj);
        let _ = DeleteObject(bitmap.into());
        let _ = DeleteDC(mem_dc);
    }

    result
}

/// GDI BitBlt path for Win10/VMs where Graphics Capture or D3D is unavailable.
#[cfg(target_os = "windows")]
fn capture_area_gdi(src_x: i32, src_y: i32, width: i32, height: i32) -> anyhow::Result<RgbImage> {
    let screen_dc = unsafe { GetDC(None) };
    let result = capture_bitmap_with(screen_dc, width, height, |mem_dc| {
        unsafe {
            BitBlt(
                mem_dc,
                0,
                0,
                width,
                height,
                Some(screen_dc),
                src_x,
                src_y,
                SRCCOPY | CAPTUREBLT,
            )
        }
        .map_err(|e| anyhow!("BitBlt failed: {e}"))
    });
    unsafe {
        ReleaseDC(None, screen_dc);
    }

    let buffer = result?;
    let width = usize::try_from(width).map_err(|_| anyhow!("bad width"))?;
    let height = usize::try_from(height).map_err(|_| anyhow!("bad height"))?;
    let stride = width.checked_mul(4).ok_or_else(|| anyhow!("stride overflow"))?;
    rgb_from_rgba(&buffer, width, height, stride, ChannelOrder::Bgra)
        .ok_or_else(|| anyhow!("Failed to decode GDI bitmap"))
}

fn capture_area_verbose_logging_enabled() -> bool {
    if cfg!(feature = "diag_capture") {
        return true;
    }

    matches!(
        std::env::var("HOOK_CAPTURE_AREA_VERBOSE_LOG")
            .ok()
            .map(|value| value.trim().to_ascii_lowercase()),
        Some(value) if matches!(value.as_str(), "1" | "true" | "yes" | "on")
    )
}

/// Capture a screen region.
///
/// Priority:
/// 1. Windows Graphics Capture (Win10 1903+ / Win11) — D3D hardware, or WARP in VMs
/// 2. GDI BitBlt — when WGC/D3D is unavailable (common in headless / locked-down VMs)
pub fn capture_area_with_profile(
    x: i32,
    y: i32,
    w: u32,
    h: u32,
    profile: CaptureWorkloadProfile,
) -> anyhow::Result<RgbImage> {
    #[cfg(target_os = "windows")]
    {
        let verbose_log = capture_area_verbose_logging_enabled();
        if verbose_log {
            crate::append_runtime_log_line(&format!(
                "capture_area enter :: x={} y={} w={} h={} profile={:?}",
                x, y, w, h, profile
            ));
        }

        let display = Display::primary();
        let display_id = display.id();

        let physical = display
            .physical_size()
            .ok_or_else(|| anyhow!("No physical size"))?;
        let logical = display
            .logical_size()
            .ok_or_else(|| anyhow!("No logical size"))?;

        if logical.width() <= 0.0 || physical.width() <= 0.0 {
            return Err(anyhow!("Invalid display dimensions"));
        }

        let scale = physical.width() / logical.width();
        if verbose_log {
            crate::append_runtime_log_line(&format!(
                "capture_area display :: logical={}x{} physical={}x{} scale={}",
                logical.width(),
                logical.height(),
                physical.width(),
                physical.height(),
                scale
            ));
        }

        let left = (x as f64 * scale).floor();
        let top = (y as f64 * scale).floor();
        let right = (left + w as f64 * scale).ceil();
        let bottom = (top + h as f64 * scale).ceil();

        let clamped_right = right.min(physical.width()).max(left);
        let clamped_bottom = bottom.min(physical.height()).max(top);

        let d3d_box = D3D11_BOX {
            left: left.max(0.0) as u32,
            top: top.max(0.0) as u32,
            right: clamped_right as u32,
            bottom: clamped_bottom as u32,
            front: 0,
            back: 1,
        };
        let crop_x = d3d_box.left as i32;
        let crop_y = d3d_box.top as i32;
        let crop_w = (d3d_box.right - d3d_box.left) as i32;
        let crop_h = (d3d_box.bottom - d3d_box.top) as i32;

        if verbose_log {
            crate::append_runtime_log_line(&format!(
                "capture_area crop :: left={} top={} right={} bottom={}",
                d3d_box.left, d3d_box.top, d3d_box.right, d3d_box.bottom
            ));
        }

        if graphics_capture_available() {
            let start = std::time::Instant::now();
            match capture_from_wgc_session(&display_id, &d3d_box) {
                Ok(image) => {
                    if verbose_log {
                        crate::append_runtime_log_line(&format!(
                            "capture_area success :: backend=wgc width={} height={} elapsed_ms={}",
                            image.width(),
                            image.height(),
                            start.elapsed().as_millis()
                        ));
                    }
                    return Ok(image);
                }
                Err(error) => {
                    crate::append_runtime_log_line(&format!(
                        "capture_area wgc_failed :: {error} :: falling_back_to_gdi"
                    ));
                }
            }
        } else if verbose_log {
            crate::append_runtime_log_line(
                "capture_area wgc_unavailable :: using_gdi (Win10 pre-1903, policy, or no D3D)",
            );
        }

        let start = std::time::Instant::now();
        let image = capture_area_gdi(crop_x, crop_y, crop_w, crop_h)?;
        if verbose_log {
            crate::append_runtime_log_line(&format!(
                "capture_area success :: backend=gdi width={} height={} elapsed_ms={}",
                image.width(),
                image.height(),
                start.elapsed().as_millis()
            ));
        }
        Ok(image)
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (x, y, w, h, profile);
        Err(anyhow!("Only Windows is supported"))
    }
}

/// Full-monitor freeze frame for the native selection overlay (Glance-style).
#[derive(Clone)]
pub struct FreezeFrame {
    pub rgb: RgbImage,
    pub img_w: u32,
    pub img_h: u32,
    pub scale_factor: f64,
    pub monitor_x: i32,
    pub monitor_y: i32,
}

/// Capture the monitor under the cursor (fallback: primary) at physical resolution.
pub fn capture_freeze_frame() -> anyhow::Result<FreezeFrame> {
    #[cfg(target_os = "windows")]
    {
        let display = Display::get_containing_cursor().unwrap_or_else(Display::primary);
        let physical = display
            .physical_size()
            .ok_or_else(|| anyhow!("No physical size"))?;
        let logical = display
            .logical_size()
            .ok_or_else(|| anyhow!("No logical size"))?;
        let position = display
            .physical_position()
            .ok_or_else(|| anyhow!("No physical position"))?;

        if logical.width() <= 0.0 || physical.width() <= 0.0 {
            return Err(anyhow!("Invalid display dimensions"));
        }

        let scale = physical.width() / logical.width();
        let img_w = physical.width().round().max(1.0) as u32;
        let img_h = physical.height().round().max(1.0) as u32;
        let monitor_x = position.x().round() as i32;
        let monitor_y = position.y().round() as i32;

        let d3d_box = D3D11_BOX {
            left: 0,
            top: 0,
            right: img_w,
            bottom: img_h,
            front: 0,
            back: 1,
        };

        let rgb = if graphics_capture_available() {
            match capture_from_wgc_session(&display.id(), &d3d_box) {
                Ok(image) => image,
                Err(error) => {
                    crate::append_runtime_log_line(&format!(
                        "capture_freeze_frame wgc_failed :: {error} :: falling_back_to_gdi"
                    ));
                    capture_area_gdi(monitor_x, monitor_y, img_w as i32, img_h as i32)?
                }
            }
        } else {
            capture_area_gdi(monitor_x, monitor_y, img_w as i32, img_h as i32)?
        };

        crate::append_runtime_log_line(&format!(
            "capture_freeze_frame success :: {}x{} scale={:.3} origin={},{}",
            rgb.width(),
            rgb.height(),
            scale,
            monitor_x,
            monitor_y
        ));

        Ok(FreezeFrame {
            img_w: rgb.width(),
            img_h: rgb.height(),
            rgb,
            scale_factor: scale,
            monitor_x,
            monitor_y,
        })
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err(anyhow!("Only Windows is supported"))
    }
}
