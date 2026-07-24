use crate::capture::CaptureResponse;
use crate::runtime::{append_runtime_log_line, encode_rgb_image_as_file_capture_response};
use crate::screenshot::{self, CaptureWorkloadProfile};
use crate::scroll_capture::{
    ScrollDirection, ScrollImageList, ScrollScreenshotService,
};
use image::DynamicImage;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::Manager;

const SCROLL_CAPTURE_PRE_CAPTURE_HIDE_MS: u64 = 17;

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrollCaptureSessionRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrollCaptureWheelEvent {
    pub delta_x: i64,
    pub delta_y: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScrollCaptureSampleStatus {
    Success,
    NoChange,
    NoImage,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrollCaptureSampleResponse {
    pub status: ScrollCaptureSampleStatus,
    pub frame_count: usize,
    pub no_change_count: usize,
    pub edge_position: Option<i32>,
    pub direction: Option<ScrollDirection>,
    pub image_list: Option<ScrollImageList>,
}

struct ScrollCaptureSessionState {
    rect: ScrollCaptureSessionRect,
    service: ScrollScreenshotService,
    frame_count: usize,
    no_change_count: usize,
}

#[derive(Clone)]
pub struct SharedScrollCaptureSessions {
    sessions: Arc<Mutex<HashMap<String, ScrollCaptureSessionState>>>,
}

impl SharedScrollCaptureSessions {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn has_any_sessions(&self) -> bool {
        self.sessions
            .lock()
            .map(|guard| !guard.is_empty())
            .unwrap_or(false)
    }
}

fn logical_rect_to_capture_bounds(
    rect: ScrollCaptureSessionRect,
) -> Result<(i32, i32, u32, u32), String> {
    let width = rect.w.round();
    let height = rect.h.round();
    if width < 1.0 || height < 1.0 {
        return Err("Scroll capture session rectangle must be at least 1x1".to_string());
    }

    Ok((
        rect.x.round() as i32,
        rect.y.round() as i32,
        width as u32,
        height as u32,
    ))
}

fn default_scroll_direction(axis: Option<String>) -> ScrollDirection {
    match axis.as_deref() {
        Some("horizontal") => ScrollDirection::Horizontal,
        _ => ScrollDirection::Vertical,
    }
}

fn init_service_for_rect(
    direction: ScrollDirection,
    rect: ScrollCaptureSessionRect,
) -> ScrollScreenshotService {
    let (_, _, width, height) = logical_rect_to_capture_bounds(rect).unwrap_or((0, 0, 1, 1));
    let side = if direction == ScrollDirection::Horizontal {
        width
    } else {
        height
    };
    let mut service = ScrollScreenshotService::new();
    // Defaults aligned with snow-shot scroll settings.
    service.init(
        direction,
        0.5,
        256,
        1024,
        64,
        9,
        ((side as f32) * 0.8).ceil() as i32,
        true,
    );
    service
}

fn capture_scroll_region(rect: ScrollCaptureSessionRect) -> Result<DynamicImage, String> {
    let (x, y, width, height) = logical_rect_to_capture_bounds(rect)?;
    let rgb = screenshot::capture_area_with_profile(
        x,
        y,
        width,
        height,
        CaptureWorkloadProfile::LongCapture,
    )
    .map_err(|error| error.to_string())?;
    Ok(DynamicImage::ImageRgb8(rgb))
}

fn apply_handle_result(
    session: &mut ScrollCaptureSessionState,
    scroll_image_list: ScrollImageList,
    image: DynamicImage,
) -> ScrollCaptureSampleResponse {
    let (handle_result, is_origin, result_list) =
        session.service.handle_image(image, scroll_image_list);

    if is_origin {
        session.no_change_count = session.no_change_count.saturating_add(1);
        return ScrollCaptureSampleResponse {
            status: ScrollCaptureSampleStatus::NoChange,
            frame_count: session.frame_count,
            no_change_count: session.no_change_count,
            edge_position: Some(0),
            direction: Some(session.service.current_direction),
            image_list: Some(result_list),
        };
    }

    match handle_result {
        Some((edge_position, Some(image_list))) => {
            session.frame_count = session.frame_count.saturating_add(1);
            ScrollCaptureSampleResponse {
                status: ScrollCaptureSampleStatus::Success,
                frame_count: session.frame_count,
                no_change_count: session.no_change_count,
                edge_position: Some(edge_position),
                direction: Some(session.service.current_direction),
                image_list: Some(image_list),
            }
        }
        Some((edge_position, None)) if session.frame_count == 0 => {
            session.frame_count = 1;
            ScrollCaptureSampleResponse {
                status: ScrollCaptureSampleStatus::Success,
                frame_count: session.frame_count,
                no_change_count: session.no_change_count,
                edge_position: Some(edge_position),
                direction: Some(session.service.current_direction),
                image_list: Some(result_list),
            }
        }
        Some((edge_position, None)) => {
            session.no_change_count = session.no_change_count.saturating_add(1);
            ScrollCaptureSampleResponse {
                status: ScrollCaptureSampleStatus::NoChange,
                frame_count: session.frame_count,
                no_change_count: session.no_change_count,
                edge_position: Some(edge_position),
                direction: Some(session.service.current_direction),
                image_list: Some(result_list),
            }
        }
        None => {
            session.no_change_count = session.no_change_count.saturating_add(1);
            ScrollCaptureSampleResponse {
                status: ScrollCaptureSampleStatus::NoImage,
                frame_count: session.frame_count,
                no_change_count: session.no_change_count,
                edge_position: None,
                direction: Some(session.service.current_direction),
                image_list: Some(result_list),
            }
        }
    }
}

#[tauri::command]
pub fn start_scroll_capture_session(
    sessions: tauri::State<SharedScrollCaptureSessions>,
    rect: ScrollCaptureSessionRect,
    axis: Option<String>,
) -> Result<String, String> {
    let _ = logical_rect_to_capture_bounds(rect)?;
    let direction = default_scroll_direction(axis);
    let session_id = uuid::Uuid::new_v4().to_string();
    let session = ScrollCaptureSessionState {
        rect,
        service: init_service_for_rect(direction, rect),
        frame_count: 0,
        no_change_count: 0,
    };

    let mut guard = sessions
        .sessions
        .lock()
        .map_err(|_| "scroll capture session lock poisoned".to_string())?;
    guard.insert(session_id.clone(), session);
    append_runtime_log_line(&format!(
        "start_scroll_capture_session :: id={} x={} y={} w={} h={} direction={:?}",
        session_id, rect.x, rect.y, rect.w, rect.h, direction
    ));
    Ok(session_id)
}

#[tauri::command]
pub async fn sample_scroll_capture_session(
    app: tauri::AppHandle,
    sessions: tauri::State<'_, SharedScrollCaptureSessions>,
    session_id: String,
    scroll_image_list: Option<ScrollImageList>,
    hide_overlay_before_capture: Option<bool>,
) -> Result<ScrollCaptureSampleResponse, String> {
    let scroll_image_list = scroll_image_list.unwrap_or(ScrollImageList::Bottom);
    let hide_overlay = hide_overlay_before_capture.unwrap_or(true);

    let rect = {
        let guard = sessions
            .sessions
            .lock()
            .map_err(|_| "scroll capture session lock poisoned".to_string())?;
        let session = guard
            .get(&session_id)
            .ok_or_else(|| format!("Scroll capture session not found: {session_id}"))?;
        session.rect
    };

    if hide_overlay {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.hide();
        }
        tokio::time::sleep(Duration::from_millis(SCROLL_CAPTURE_PRE_CAPTURE_HIDE_MS)).await;
    }

    let image = tokio::task::spawn_blocking(move || capture_scroll_region(rect))
        .await
        .map_err(|error| error.to_string())??;

    if hide_overlay {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            // Keep mouse ownership on Hook; frontend sets click-through policy.
            let _ = window.set_ignore_cursor_events(false);
        }
    }

    let mut guard = sessions
        .sessions
        .lock()
        .map_err(|_| "scroll capture session lock poisoned".to_string())?;
    let session = guard
        .get_mut(&session_id)
        .ok_or_else(|| format!("Scroll capture session not found: {session_id}"))?;

    let response = apply_handle_result(session, scroll_image_list, image);
    append_runtime_log_line(&format!(
        "sample_scroll_capture_session :: id={} status={:?} frames={} no_change={} edge={:?}",
        session_id,
        response.status,
        response.frame_count,
        response.no_change_count,
        response.edge_position
    ));
    Ok(response)
}

#[tauri::command]
pub async fn scroll_through(
    window: tauri::Window,
    length: i32,
    axis: Option<String>,
) -> Result<(), String> {
    let _ = window.set_ignore_cursor_events(true);
    tokio::time::sleep(Duration::from_millis(10)).await;

    let scroll_axis = axis.unwrap_or_else(|| "vertical".to_string());
    let scroll_result = tokio::task::spawn_blocking(move || -> Result<(), String> {
        use enigo::{Axis, Enigo, Mouse, Settings};
        let mut enigo = Enigo::new(&Settings::default())
            .map_err(|error| format!("[scroll_through] enigo init failed: {error}"))?;
        let axis = match scroll_axis.as_str() {
            "horizontal" => Axis::Horizontal,
            _ => Axis::Vertical,
        };
        enigo
            .scroll(length, axis)
            .map_err(|error| format!("[scroll_through] scroll failed: {error}"))?;
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?;

    if let Err(error) = scroll_result {
        append_runtime_log_line(&format!("scroll_through :: {error}"));
    }

    tokio::time::sleep(Duration::from_millis(128)).await;
    // Leave ignore=true; frontend restores click-through policy for the session.
    Ok(())
}

#[tauri::command]
pub async fn finish_scroll_capture_session(
    sessions: tauri::State<'_, SharedScrollCaptureSessions>,
    session_id: String,
) -> Result<CaptureResponse, String> {
    let mut service = {
        let mut guard = sessions
            .sessions
            .lock()
            .map_err(|_| "scroll capture session lock poisoned".to_string())?;
        let session = guard
            .remove(&session_id)
            .ok_or_else(|| format!("Scroll capture session not found: {session_id}"))?;
        append_runtime_log_line(&format!(
            "finish_scroll_capture_session :: id={} frames={} no_change={}",
            session_id, session.frame_count, session.no_change_count
        ));
        session.service
    };

    let response = tokio::task::spawn_blocking(move || -> Result<CaptureResponse, String> {
        let image = service
            .export()
            .ok_or_else(|| "Scroll capture produced no image".to_string())?;
        let rgb = image.to_rgb8();
        encode_rgb_image_as_file_capture_response(rgb)
    })
    .await
    .map_err(|error| error.to_string())??;

    Ok(response)
}

#[tauri::command]
pub fn cancel_scroll_capture_session(
    sessions: tauri::State<SharedScrollCaptureSessions>,
    session_id: String,
) -> Result<(), String> {
    let mut guard = sessions
        .sessions
        .lock()
        .map_err(|_| "scroll capture session lock poisoned".to_string())?;
    guard.remove(&session_id);
    append_runtime_log_line(&format!("cancel_scroll_capture_session :: id={session_id}"));
    Ok(())
}
