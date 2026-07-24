use crate::capture::CaptureResponse;
use crate::long_capture;
use crate::runtime::{append_runtime_log_line, encode_rgb_image_as_file_capture_response};
use crate::screenshot;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

#[cfg(target_os = "windows")]
use windows::Win32::System::Threading::{
    GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_BELOW_NORMAL,
};

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LongCaptureWheelEvent {
    pub(crate) delta_x: i64,
    pub(crate) delta_y: i64,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LongCaptureSessionRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Clone, Debug)]
struct LongCaptureSessionState {
    rect: LongCaptureSessionRect,
    axis: Option<long_capture::LongCaptureAxis>,
    direction: Option<long_capture::LongCaptureDirection>,
    frames: Vec<image::RgbImage>,
    last_frame_fingerprint: Option<Arc<LongCaptureFrameFingerprint>>,
    pair_analyses: Vec<long_capture::LongCaptureOverlapAnalysis>,
    incremental_stitcher: Option<long_capture::LongCaptureIncrementalStitcher>,
    stitch_worker_active: bool,
    stitch_error: Option<String>,
    duplicate_count: usize,
    max_scan: u32,
    min_overlap_px: u32,
    created_at: Instant,
}

#[derive(Clone)]
pub(crate) struct SharedLongCaptureSessions {
    sessions: Arc<std::sync::Mutex<HashMap<String, LongCaptureSessionState>>>,
}

impl SharedLongCaptureSessions {
    pub(crate) fn new() -> Self {
        Self {
            sessions: Arc::new(std::sync::Mutex::new(HashMap::new())),
        }
    }

    pub(crate) fn has_any_sessions(&self) -> bool {
        self.sessions
            .lock()
            .ok()
            .map(|sessions| !sessions.is_empty())
            .unwrap_or(false)
    }
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LongCaptureSessionSampleStatus {
    Recorded,
    Duplicate,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LongCaptureSessionSampleResponse {
    pub status: LongCaptureSessionSampleStatus,
    pub frame_count: usize,
    pub duplicate_count: usize,
    pub recorded: bool,
    pub axis: Option<long_capture::LongCaptureAxis>,
    pub direction: Option<long_capture::LongCaptureDirection>,
}

#[derive(Clone)]
struct LongCaptureSessionSampleWork {
    rect: LongCaptureSessionRect,
    previous_fingerprint: Option<Arc<LongCaptureFrameFingerprint>>,
    expected_frame_count: usize,
    axis: Option<long_capture::LongCaptureAxis>,
    max_scan: u32,
    min_overlap_px: u32,
}

struct LongCaptureSessionSampleResult {
    frame: image::RgbImage,
    fingerprint: LongCaptureFrameFingerprint,
    status: LongCaptureSessionSampleStatus,
    analysis: Option<long_capture::LongCaptureOverlapAnalysis>,
    expected_frame_count: usize,
}

struct LongCaptureRecordingClassification {
    status: LongCaptureSessionSampleStatus,
    analysis: Option<long_capture::LongCaptureOverlapAnalysis>,
}

#[derive(Clone, Debug)]
struct LongCaptureFrameFingerprint {
    width: u32,
    height: u32,
    byte_len: usize,
    hash: u64,
    sampled_pixels: Vec<[u8; 3]>,
    motion: long_capture::LongCaptureMotionFingerprint,
}

impl PartialEq for LongCaptureFrameFingerprint {
    fn eq(&self, other: &Self) -> bool {
        self.width == other.width
            && self.height == other.height
            && self.byte_len == other.byte_len
            && self.hash == other.hash
            && self.sampled_pixels == other.sampled_pixels
    }
}

fn long_capture_frame_fingerprint(frame: &image::RgbImage) -> LongCaptureFrameFingerprint {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for &byte in frame.as_raw() {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(0x1000_0000_01b3);
    }
    LongCaptureFrameFingerprint {
        width: frame.width(),
        height: frame.height(),
        byte_len: frame.as_raw().len(),
        hash,
        sampled_pixels: long_capture_frame_fingerprint_samples(frame),
        motion: long_capture::long_capture_motion_fingerprint(frame),
    }
}

fn long_capture_sample_axis_offsets(len: u32) -> Vec<u32> {
    if len == 0 {
        return Vec::new();
    }
    let sample_count = len.min(32);
    (0..sample_count)
        .map(|index| (((index as u64 * 2 + 1) * len as u64) / (sample_count as u64 * 2)) as u32)
        .map(|index| index.min(len.saturating_sub(1)))
        .collect()
}

fn long_capture_frame_fingerprint_samples(frame: &image::RgbImage) -> Vec<[u8; 3]> {
    let x_offsets = long_capture_sample_axis_offsets(frame.width());
    let y_offsets = long_capture_sample_axis_offsets(frame.height());
    let mut sampled_pixels = Vec::with_capacity(x_offsets.len() * y_offsets.len());
    for y in y_offsets {
        for &x in &x_offsets {
            sampled_pixels.push(frame.get_pixel(x, y).0);
        }
    }
    sampled_pixels
}

fn long_capture_fingerprints_are_near_duplicate(
    previous: &LongCaptureFrameFingerprint,
    current: &LongCaptureFrameFingerprint,
) -> bool {
    if previous.width != current.width
        || previous.height != current.height
        || previous.byte_len != current.byte_len
        || previous.sampled_pixels.len() != current.sampled_pixels.len()
        || previous.sampled_pixels.is_empty()
    {
        return false;
    }

    let mut changed = 0usize;
    let mut diff_total = 0u64;
    for (previous, current) in previous
        .sampled_pixels
        .iter()
        .zip(current.sampled_pixels.iter())
    {
        let diff = previous[0].abs_diff(current[0]) as u32
            + previous[1].abs_diff(current[1]) as u32
            + previous[2].abs_diff(current[2]) as u32;
        if diff >= 48 {
            changed += 1;
        }
        diff_total += diff as u64;
    }

    let total = previous.sampled_pixels.len();
    let changed_ratio = changed as f64 / total as f64;
    let mean_diff = diff_total as f64 / total as f64;
    changed_ratio <= 0.015 && mean_diff <= 8.0
}

fn classify_long_capture_recording_fingerprint(
    previous: Option<&LongCaptureFrameFingerprint>,
    current: &LongCaptureFrameFingerprint,
    axis: Option<long_capture::LongCaptureAxis>,
    max_scan: u32,
    min_overlap_px: u32,
) -> LongCaptureRecordingClassification {
    match previous {
        Some(previous)
            if previous == current
                || long_capture_fingerprints_are_near_duplicate(previous, current) =>
        {
            LongCaptureRecordingClassification {
                status: LongCaptureSessionSampleStatus::Duplicate,
                analysis: None,
            }
        }
        Some(previous) => {
            let motion_analysis = long_capture::analyze_long_capture_motion_fingerprints(
                &previous.motion,
                &current.motion,
                long_capture::LongCaptureAnalyzeOptions {
                    axis,
                    direction: None,
                    max_scan: Some(max_scan),
                    min_overlap_px: Some(min_overlap_px),
                    min_new_content_px: Some(1),
                },
            );
            if motion_analysis.is_some() {
                LongCaptureRecordingClassification {
                    status: LongCaptureSessionSampleStatus::Recorded,
                    analysis: motion_analysis,
                }
            } else {
                LongCaptureRecordingClassification {
                    status: LongCaptureSessionSampleStatus::Duplicate,
                    analysis: None,
                }
            }
        }
        None => LongCaptureRecordingClassification {
            status: LongCaptureSessionSampleStatus::Recorded,
            analysis: None,
        },
    }
}

fn capture_and_classify_long_capture_sample(
    work: LongCaptureSessionSampleWork,
) -> Result<LongCaptureSessionSampleResult, String> {
    let (x, y, w, h) = logical_rect_to_capture_bounds(work.rect)?;
    let frame = screenshot::capture_area_with_profile(
        x,
        y,
        w,
        h,
        screenshot::CaptureWorkloadProfile::LongCapture,
    )
    .map_err(|error| error.to_string())?;
    let fingerprint = long_capture_frame_fingerprint(&frame);
    let classification = classify_long_capture_recording_fingerprint(
        work.previous_fingerprint.as_deref(),
        &fingerprint,
        work.axis,
        work.max_scan,
        work.min_overlap_px,
    );

    Ok(LongCaptureSessionSampleResult {
        frame,
        fingerprint,
        status: classification.status,
        analysis: classification.analysis,
        expected_frame_count: work.expected_frame_count,
    })
}

fn long_capture_stitch_worker_needed(session: &LongCaptureSessionState) -> bool {
    session.stitch_error.is_none()
        && !session.stitch_worker_active
        && session
            .incremental_stitcher
            .as_ref()
            .map(|stitcher| stitcher.frame_count() < session.frames.len())
            .unwrap_or(false)
}

fn record_long_capture_session_sample_result(
    session: &mut LongCaptureSessionState,
    result: LongCaptureSessionSampleResult,
) -> Result<(LongCaptureSessionSampleResponse, bool), String> {
    let status = result.status;
    let mut recorded = false;
    let mut should_spawn_worker = false;

    if matches!(status, LongCaptureSessionSampleStatus::Recorded) {
        if let Some(analysis) = result.analysis {
            session.axis = analysis.axis.or(session.axis);
            session.direction = analysis.direction;
            session.pair_analyses.push(analysis);
        }
        if session.incremental_stitcher.is_none() {
            let stitch_options = long_capture::LongCaptureStitchOptions {
                axis: session.axis,
                direction: None,
                max_scan: Some(session.max_scan),
                min_overlap_px: Some(session.min_overlap_px),
            };
            session.incremental_stitcher = Some(long_capture::LongCaptureIncrementalStitcher::new(
                result.frame.clone(),
                stitch_options,
            ));
        }
        session.frames.push(result.frame);
        session.last_frame_fingerprint = Some(Arc::new(result.fingerprint));
        recorded = true;

        if long_capture_stitch_worker_needed(session) {
            session.stitch_worker_active = true;
            should_spawn_worker = true;
        }
    } else {
        // Keep fingerprint on the last *recorded* frame so the next Recorded
        // sample stays adjacent to what the stitcher will merge against.
        session.duplicate_count += 1;
    }

    let response = LongCaptureSessionSampleResponse {
        status,
        frame_count: session.frames.len(),
        duplicate_count: session.duplicate_count,
        recorded,
        axis: session
            .incremental_stitcher
            .as_ref()
            .and_then(|stitcher| stitcher.axis())
            .or(session.axis),
        direction: session.direction,
    };

    Ok((response, should_spawn_worker))
}

const LONG_CAPTURE_SAMPLE_LOG_EVERY_EVENTS: usize = 20;
const LONG_CAPTURE_SAMPLE_SLOW_MS: u128 = 40;
const LONG_CAPTURE_STITCH_WORKER_IDLE_YIELD_MS: u64 = 1;
const LONG_CAPTURE_STITCH_WORKER_BURST_FRAME_LIMIT: usize = 8;
const LONG_CAPTURE_STITCH_WORKER_LOG_EVERY_FRAMES: usize = 20;
const LONG_CAPTURE_STITCH_WORKER_SLOW_FRAME_MS: u128 = 40;
const LONG_CAPTURE_FINISH_WAIT_SLEEP_MS: u64 = 5;

fn should_log_long_capture_sample(
    response: &LongCaptureSessionSampleResponse,
    elapsed_ms: u128,
) -> bool {
    elapsed_ms >= LONG_CAPTURE_SAMPLE_SLOW_MS
        || if response.recorded {
            response.frame_count <= 2
                || response.frame_count % LONG_CAPTURE_SAMPLE_LOG_EVERY_EVENTS == 0
        } else {
            response.duplicate_count <= 2
                || response.duplicate_count % LONG_CAPTURE_SAMPLE_LOG_EVERY_EVENTS == 0
        }
}

fn should_rest_long_capture_stitch_worker(
    remaining_frames: usize,
    frames_since_rest: usize,
    elapsed_ms: u128,
) -> bool {
    remaining_frames == 0
        || frames_since_rest >= LONG_CAPTURE_STITCH_WORKER_BURST_FRAME_LIMIT
        || elapsed_ms >= LONG_CAPTURE_STITCH_WORKER_SLOW_FRAME_MS
}

fn lower_long_capture_worker_thread_priority() {
    #[cfg(target_os = "windows")]
    unsafe {
        let _ = SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL);
    }
}

fn prepare_long_capture_stitch_worker(
    shared: &SharedLongCaptureSessions,
    session_id: &str,
) -> Result<bool, String> {
    let mut guard = shared
        .sessions
        .lock()
        .map_err(|_| "long capture session lock poisoned".to_string())?;
    let session = guard
        .get_mut(session_id)
        .ok_or_else(|| format!("Long capture session not found: {session_id}"))?;
    if let Some(error) = &session.stitch_error {
        return Err(error.clone());
    }
    if long_capture_stitch_worker_needed(session) {
        session.stitch_worker_active = true;
        Ok(true)
    } else {
        Ok(false)
    }
}

fn spawn_long_capture_stitch_worker(shared: SharedLongCaptureSessions, session_id: String) {
    tokio::spawn(async move {
        let shared_for_worker = shared.clone();
        let session_id_for_worker = session_id.clone();
        if let Err(error) = tokio::task::spawn_blocking(move || {
            run_long_capture_stitch_worker(shared_for_worker, session_id_for_worker)
        })
        .await
        {
            append_runtime_log_line(&format!(
                "long_capture stitch_worker_join_failed :: id={} error={}",
                session_id, error
            ));
            if let Ok(mut guard) = shared.sessions.lock() {
                if let Some(session) = guard.get_mut(&session_id) {
                    session.stitch_worker_active = false;
                    session.stitch_error = Some(error.to_string());
                }
            }
        }
    });
}

fn run_long_capture_stitch_worker(shared: SharedLongCaptureSessions, session_id: String) {
    lower_long_capture_worker_thread_priority();
    let mut frames_since_rest = 0usize;

    loop {
        let (mut stitcher, frame, frame_index, analysis_hint) = {
            let mut guard = match shared.sessions.lock() {
                Ok(guard) => guard,
                Err(_) => return,
            };
            let Some(session) = guard.get_mut(&session_id) else {
                return;
            };
            if session.stitch_error.is_some() {
                session.stitch_worker_active = false;
                return;
            }
            let Some(stitcher) = session.incremental_stitcher.take() else {
                session.stitch_worker_active = false;
                return;
            };
            let next_index = stitcher.frame_count();
            if next_index >= session.frames.len() {
                session.incremental_stitcher = Some(stitcher);
                session.stitch_worker_active = false;
                return;
            }
            let frame =
                std::mem::replace(&mut session.frames[next_index], image::RgbImage::new(0, 0));
            if frame.width() == 0 || frame.height() == 0 {
                session.incremental_stitcher = Some(stitcher);
                session.stitch_worker_active = false;
                append_runtime_log_line(&format!(
                    "long_capture stitch_worker_empty_frame :: id={} frame_index={}",
                    session_id, next_index
                ));
                return;
            }
            let analysis_hint = next_index
                .checked_sub(1)
                .and_then(|pair_index| session.pair_analyses.get(pair_index).copied());
            (stitcher, frame, next_index, analysis_hint)
        };

        let started_at = Instant::now();
        let push_result = match analysis_hint {
            Some(analysis) if analysis.append_px > 0 && analysis.direction.is_some() => stitcher
                .push_frame_owned_with_analysis(frame, analysis)
                .map_err(|error| error.to_string()),
            _ => stitcher
                .push_frame_owned(frame)
                .map_err(|error| error.to_string()),
        };
        let elapsed_ms = started_at.elapsed().as_millis();

        let mut guard = match shared.sessions.lock() {
            Ok(guard) => guard,
            Err(_) => return,
        };
        let Some(session) = guard.get_mut(&session_id) else {
            return;
        };
        let remaining_frames;
        match push_result {
            Ok(long_capture::LongCapturePushOutcome::Merged) => {
                session.axis = stitcher.axis().or(session.axis);
                remaining_frames = session.frames.len().saturating_sub(stitcher.frame_count());
                let fast_path_merges = stitcher.adjacent_fast_path_merges();
                let aggregate_searches = stitcher.aggregate_signature_searches();
                let aggregate_segments = stitcher.aggregate_segment_count();
                let expensive_adjacent_pair_analyses = stitcher.expensive_adjacent_pair_analyses();
                let should_log_frame = frame_index <= 2
                    || frame_index % LONG_CAPTURE_STITCH_WORKER_LOG_EVERY_FRAMES == 0
                    || elapsed_ms >= LONG_CAPTURE_STITCH_WORKER_SLOW_FRAME_MS
                    || remaining_frames == 0;
                session.incremental_stitcher = Some(stitcher);
                if should_log_frame {
                    append_runtime_log_line(&format!(
                        "long_capture stitch_worker_frame :: id={} frame_index={} merged=true remaining={} elapsed_ms={} fast_path={} aggregate_searches={} expensive_pair_analyses={} segments={} used_analysis={}",
                        session_id,
                        frame_index,
                        remaining_frames,
                        elapsed_ms,
                        fast_path_merges,
                        aggregate_searches,
                        expensive_adjacent_pair_analyses,
                        aggregate_segments,
                        analysis_hint.is_some()
                    ));
                }
            }
            Ok(long_capture::LongCapturePushOutcome::Skipped { frame }) => {
                // Keep pixels so finish can fall back to analysis-based stitch.
                session.frames[frame_index] = frame;
                session.axis = stitcher.axis().or(session.axis);
                remaining_frames = session.frames.len().saturating_sub(stitcher.frame_count());
                session.incremental_stitcher = Some(stitcher);
                append_runtime_log_line(&format!(
                    "long_capture stitch_worker_frame :: id={} frame_index={} merged=false remaining={} elapsed_ms={} used_analysis={}",
                    session_id,
                    frame_index,
                    remaining_frames,
                    elapsed_ms,
                    analysis_hint.is_some()
                ));
            }
            Err(error) => {
                session.incremental_stitcher = Some(stitcher);
                session.stitch_error = Some(error.clone());
                session.stitch_worker_active = false;
                append_runtime_log_line(&format!(
                    "long_capture stitch_worker_failed :: id={} frame_index={} error={}",
                    session_id, frame_index, error
                ));
                return;
            }
        }
        drop(guard);

        frames_since_rest += 1;
        std::thread::yield_now();
        if should_rest_long_capture_stitch_worker(remaining_frames, frames_since_rest, elapsed_ms) {
            frames_since_rest = 0;
            std::thread::sleep(Duration::from_millis(
                LONG_CAPTURE_STITCH_WORKER_IDLE_YIELD_MS,
            ));
        }
    }
}

async fn wait_for_long_capture_stitch_worker(
    shared: SharedLongCaptureSessions,
    session_id: &str,
) -> Result<(), String> {
    loop {
        let should_spawn = prepare_long_capture_stitch_worker(&shared, session_id)?;
        if should_spawn {
            spawn_long_capture_stitch_worker(shared.clone(), session_id.to_string());
        }

        let is_active = {
            let guard = shared
                .sessions
                .lock()
                .map_err(|_| "long capture session lock poisoned".to_string())?;
            let session = guard
                .get(session_id)
                .ok_or_else(|| format!("Long capture session not found: {session_id}"))?;
            if let Some(error) = &session.stitch_error {
                return Err(error.clone());
            }
            session.stitch_worker_active
        };
        if !is_active {
            return Ok(());
        }

        tokio::time::sleep(Duration::from_millis(LONG_CAPTURE_FINISH_WAIT_SLEEP_MS)).await;
    }
}

fn logical_rect_to_capture_bounds(
    rect: LongCaptureSessionRect,
) -> Result<(i32, i32, u32, u32), String> {
    let width = rect.w.round();
    let height = rect.h.round();
    if width < 1.0 || height < 1.0 {
        return Err("Long capture session rectangle must be at least 1x1".to_string());
    }

    Ok((
        rect.x.round() as i32,
        rect.y.round() as i32,
        width as u32,
        height as u32,
    ))
}

#[tauri::command]
pub fn start_long_capture_session(
    sessions: tauri::State<SharedLongCaptureSessions>,
    rect: LongCaptureSessionRect,
    axis: Option<long_capture::LongCaptureAxis>,
) -> Result<String, String> {
    let (_, _, width, height) = logical_rect_to_capture_bounds(rect)?;
    let max_dimension = width.max(height);
    let max_scan = max_dimension.saturating_sub(1).max(32);
    let min_overlap_px = ((max_dimension as f64) * 0.03).round().max(16.0) as u32;
    let session_id = uuid::Uuid::new_v4().to_string();
    let session = LongCaptureSessionState {
        rect,
        axis,
        direction: None,
        frames: Vec::new(),
        last_frame_fingerprint: None,
        pair_analyses: Vec::new(),
        incremental_stitcher: None,
        stitch_worker_active: false,
        stitch_error: None,
        duplicate_count: 0,
        max_scan,
        min_overlap_px,
        created_at: Instant::now(),
    };

    let mut guard = sessions
        .sessions
        .lock()
        .map_err(|_| "long capture session lock poisoned".to_string())?;
    guard.insert(session_id.clone(), session);
    append_runtime_log_line(&format!(
        "start_long_capture_session :: id={} x={} y={} w={} h={} axis={:?}",
        session_id, rect.x, rect.y, rect.w, rect.h, axis
    ));
    Ok(session_id)
}

#[tauri::command]
pub async fn sample_long_capture_session(
    sessions: tauri::State<'_, SharedLongCaptureSessions>,
    session_id: String,
) -> Result<LongCaptureSessionSampleResponse, String> {
    let started_at = Instant::now();
    let work = {
        let guard = sessions
            .sessions
            .lock()
            .map_err(|_| "long capture session lock poisoned".to_string())?;
        let session = guard
            .get(&session_id)
            .ok_or_else(|| format!("Long capture session not found: {session_id}"))?;
        LongCaptureSessionSampleWork {
            rect: session.rect,
            previous_fingerprint: session.last_frame_fingerprint.clone(),
            expected_frame_count: session.frames.len(),
            axis: session
                .incremental_stitcher
                .as_ref()
                .and_then(|stitcher| stitcher.axis())
                .or(session.axis),
            max_scan: session.max_scan,
            min_overlap_px: session.min_overlap_px,
        }
    };

    let result =
        tokio::task::spawn_blocking(move || capture_and_classify_long_capture_sample(work))
            .await
            .map_err(|error| error.to_string())??;

    let mut guard = sessions
        .sessions
        .lock()
        .map_err(|_| "long capture session lock poisoned".to_string())?;
    let session = guard
        .get_mut(&session_id)
        .ok_or_else(|| format!("Long capture session not found: {session_id}"))?;

    if session.frames.len() != result.expected_frame_count {
        return Err(format!(
            "Long capture session changed while sample was in flight: expected {} frames, found {}",
            result.expected_frame_count,
            session.frames.len()
        ));
    }

    let (response, should_spawn_worker) =
        record_long_capture_session_sample_result(session, result)?;
    drop(guard);

    if should_spawn_worker {
        spawn_long_capture_stitch_worker(sessions.inner().clone(), session_id.clone());
    }

    let elapsed_ms = started_at.elapsed().as_millis();
    if should_log_long_capture_sample(&response, elapsed_ms) {
        append_runtime_log_line(&format!(
            "sample_long_capture_session :: id={} frame_count={} duplicate_count={} recorded={} status={:?} elapsed_ms={}",
            session_id,
            response.frame_count,
            response.duplicate_count,
            response.recorded,
            response.status,
            elapsed_ms
        ));
    }
    Ok(response)
}

#[tauri::command]
pub async fn finish_long_capture_session(
    sessions: tauri::State<'_, SharedLongCaptureSessions>,
    session_id: String,
) -> Result<CaptureResponse, String> {
    let finish_started_at = Instant::now();
    let wait_started_at = Instant::now();
    wait_for_long_capture_stitch_worker(sessions.inner().clone(), &session_id).await?;
    let wait_ms = wait_started_at.elapsed().as_millis();

    let session = {
        let remove_started_at = Instant::now();
        let mut guard = sessions
            .sessions
            .lock()
            .map_err(|_| "long capture session lock poisoned".to_string())?;
        let session = guard
            .remove(&session_id)
            .ok_or_else(|| format!("Long capture session not found: {session_id}"))?;
        append_runtime_log_line(&format!(
            "finish_long_capture_session_remove :: id={} elapsed_ms={}",
            session_id,
            remove_started_at.elapsed().as_millis()
        ));
        session
    };

    append_runtime_log_line(&format!(
        "finish_long_capture_session :: id={} frame_count={} wait_ms={} elapsed_ms={}",
        session_id,
        session.frames.len(),
        wait_ms,
        session.created_at.elapsed().as_millis()
    ));

    if session.frames.is_empty() {
        return Err("Long capture session has no frames".to_string());
    }

    let blocking_session_id = session_id.clone();
    let response = tokio::task::spawn_blocking(move || -> Result<CaptureResponse, String> {
        let blocking_started_at = Instant::now();
        let LongCaptureSessionState {
            frames,
            pair_analyses,
            incremental_stitcher,
            axis,
            max_scan,
            min_overlap_px,
            ..
        } = session;
        let stitch_started_at = Instant::now();
        let frames_have_pixels = frames
            .iter()
            .all(|frame| frame.width() > 0 && frame.height() > 0);
        let stitched = if let Some(stitcher) = incremental_stitcher {
            let flatten_started_at = Instant::now();
            let frame_count = stitcher.frame_count();
            let merged_frames = stitcher.merged_frames();
            let skipped_frames = stitcher.skipped_frames();
            let stitcher_axis = stitcher.axis();
            let adjacent_fast_path_merges = stitcher.adjacent_fast_path_merges();
            let aggregate_signature_searches = stitcher.aggregate_signature_searches();
            let expensive_adjacent_pair_analyses = stitcher.expensive_adjacent_pair_analyses();
            let aggregate_segment_count = stitcher.aggregate_segment_count();
            let image = stitcher.into_image();
            append_runtime_log_line(&format!(
                "finish_long_capture_session_incremental :: frame_count={} merged_frames={} skipped_frames={} axis={:?} fast_path={} aggregate_searches={} expensive_pair_analyses={} segments={} flatten_ms={} width={} height={}",
                frame_count,
                merged_frames,
                skipped_frames,
                stitcher_axis,
                adjacent_fast_path_merges,
                aggregate_signature_searches,
                expensive_adjacent_pair_analyses,
                aggregate_segment_count,
                flatten_started_at.elapsed().as_millis(),
                image.width(),
                image.height()
            ));

            // Incremental stitcher can "succeed" with only the first frame if later
            // seams were skipped. Prefer analysis-guided / full stitch when pixels remain.
            if merged_frames > 1 || frames.len() <= 1 || !frames_have_pixels {
                image
            } else if pair_analyses.len() + 1 == frames.len() {
                append_runtime_log_line(&format!(
                    "finish_long_capture_session_fallback_analyses :: frames={} analyses={}",
                    frames.len(),
                    pair_analyses.len()
                ));
                long_capture::stitch_long_capture_frames_with_analyses(&frames, &pair_analyses)
                    .map_err(|error| error.to_string())?
            } else {
                append_runtime_log_line(&format!(
                    "finish_long_capture_session_fallback_restitch :: frames={}",
                    frames.len()
                ));
                long_capture::stitch_long_capture_frames(
                    &frames,
                    long_capture::LongCaptureStitchOptions {
                        axis,
                        direction: None,
                        max_scan: Some(max_scan),
                        min_overlap_px: Some(min_overlap_px),
                    },
                )
                .map_err(|error| error.to_string())?
            }
        } else if frames.len() == 1 {
            frames[0].clone()
        } else if pair_analyses.len() + 1 == frames.len() {
            long_capture::stitch_long_capture_frames_with_analyses(
                &frames,
                &pair_analyses,
            )
            .map_err(|error| error.to_string())?
        } else {
            long_capture::stitch_long_capture_frames(
                &frames,
                long_capture::LongCaptureStitchOptions {
                    axis,
                    direction: None,
                    max_scan: Some(max_scan),
                    min_overlap_px: Some(min_overlap_px),
                },
            )
            .map_err(|error| error.to_string())?
        };

        let stitch_ms = stitch_started_at.elapsed().as_millis();
        let encode_started_at = Instant::now();
        let response = encode_rgb_image_as_file_capture_response(stitched)?;
        append_runtime_log_line(&format!(
            "finish_long_capture_session_blocking :: id={} stitch_ms={} encode_ms={} total_ms={}",
            blocking_session_id,
            stitch_ms,
            encode_started_at.elapsed().as_millis(),
            blocking_started_at.elapsed().as_millis()
        ));
        Ok(response)
    })
    .await
    .map_err(|error| error.to_string())??;
    append_runtime_log_line(&format!(
        "finish_long_capture_session_total :: id={} wait_ms={} total_ms={}",
        session_id,
        wait_ms,
        finish_started_at.elapsed().as_millis()
    ));
    Ok(response)
}

#[tauri::command]
pub fn cancel_long_capture_session(
    sessions: tauri::State<SharedLongCaptureSessions>,
    session_id: String,
) -> Result<(), String> {
    let mut guard = sessions
        .sessions
        .lock()
        .map_err(|_| "long capture session lock poisoned".to_string())?;
    let removed = guard.remove(&session_id);
    append_runtime_log_line(&format!(
        "cancel_long_capture_session :: id={} existed={}",
        session_id,
        removed.is_some()
    ));
    Ok(())
}
