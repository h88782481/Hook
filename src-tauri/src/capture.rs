use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::Window;

use crate::screenshot;

static REGION_CAPTURE_IN_FLIGHT: AtomicBool = AtomicBool::new(false);
const REGION_CAPTURE_TIMEOUT: Duration = Duration::from_secs(6);

struct RegionCaptureInFlightGuard;

impl Drop for RegionCaptureInFlightGuard {
    fn drop(&mut self) {
        REGION_CAPTURE_IN_FLIGHT.store(false, Ordering::SeqCst);
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureResponse {
    pub base64: String,
    pub width: u32,
    pub height: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_url: Option<String>,
}

#[tauri::command]
pub async fn capture_region(
    _window: Window,
    x: i32,
    y: i32,
    w: u32,
    h: u32,
) -> Result<CaptureResponse, String> {
    crate::append_runtime_log_line(&format!(
        "capture_region request :: x={} y={} w={} h={}",
        x, y, w, h
    ));

    if REGION_CAPTURE_IN_FLIGHT
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        crate::append_runtime_log_line("capture_region busy");
        return Err("Capture is already in progress; please try again".to_string());
    }

    let handle = tokio::task::spawn_blocking(move || -> Result<CaptureResponse, String> {
        let _in_flight_guard = RegionCaptureInFlightGuard;
        // Capture Region with proper DPI Scaling via Scap.
        // Note: We pass logical coords (x,y,w,h) as received from frontend.
        // The backend `capture_area` handles conversion to physical pixels.
        let rgb_image = match screenshot::capture_area_with_profile(
            x,
            y,
            w,
            h,
            screenshot::CaptureWorkloadProfile::StandardRegion,
        ) {
            Ok(image) => image,
            Err(error) => {
                crate::append_runtime_log_line(&format!("capture_region failure :: {}", error));
                return Err(error.to_string());
            }
        };

        let width = rgb_image.width();
        let height = rgb_image.height();
        crate::append_runtime_log_line(&format!(
            "capture_region success :: width={} height={} mode=file-backed",
            width, height
        ));
        crate::encode_rgb_image_as_file_capture_response(rgb_image)
    });

    match tokio::time::timeout(REGION_CAPTURE_TIMEOUT, handle).await {
        Ok(join_result) => join_result.map_err(|error| {
            crate::append_runtime_log_line(&format!("capture_region worker_join_failure :: {}", error));
            error.to_string()
        })?,
        Err(_) => {
            crate::append_runtime_log_line("capture_region timeout");
            Err("Capture timed out; please try again".to_string())
        }
    }
}
