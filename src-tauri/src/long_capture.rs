use anyhow::{anyhow, Result};
use image::{imageops, RgbImage};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LongCaptureAxis {
    Vertical,
    Horizontal,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LongCaptureDirection {
    Down,
    Up,
    Right,
    Left,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LongCaptureOverlapStatus {
    Duplicate,
    TooSmallMotion,
    Good,
    Weak,
    NoOverlap,
}

#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LongCaptureAnalyzeOptions {
    pub axis: Option<LongCaptureAxis>,
    pub direction: Option<LongCaptureDirection>,
    pub max_scan: Option<u32>,
    pub min_overlap_px: Option<u32>,
    pub min_new_content_px: Option<u32>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LongCaptureStitchOptions {
    pub axis: Option<LongCaptureAxis>,
    pub direction: Option<LongCaptureDirection>,
    pub max_scan: Option<u32>,
    pub min_overlap_px: Option<u32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LongCaptureOverlapAnalysis {
    pub status: LongCaptureOverlapStatus,
    pub axis: Option<LongCaptureAxis>,
    pub direction: Option<LongCaptureDirection>,
    pub overlap_px: u32,
    pub crop_start_px: u32,
    pub append_px: u32,
    pub confidence: f64,
    pub seam_px: u32,
}

#[derive(Clone, Copy, Debug)]
struct CandidateAnalysis {
    direction: LongCaptureDirection,
    overlap_px: u32,
    crop_start_px: u32,
    append_px: u32,
    confidence: f64,
    mean_diff: f64,
    texture_score: f64,
    content_ratio: f64,
}


fn direction_is_forward(direction: LongCaptureDirection) -> bool {
    matches!(
        direction,
        LongCaptureDirection::Down | LongCaptureDirection::Right
    )
}

fn forward_direction_for_axis(axis: LongCaptureAxis) -> LongCaptureDirection {
    match axis {
        LongCaptureAxis::Vertical => LongCaptureDirection::Down,
        LongCaptureAxis::Horizontal => LongCaptureDirection::Right,
    }
}

fn reverse_direction_for_axis(axis: LongCaptureAxis) -> LongCaptureDirection {
    match axis {
        LongCaptureAxis::Vertical => LongCaptureDirection::Up,
        LongCaptureAxis::Horizontal => LongCaptureDirection::Left,
    }
}

fn image_axis_len(image: &RgbImage, axis: LongCaptureAxis) -> u32 {
    match axis {
        LongCaptureAxis::Vertical => image.height(),
        LongCaptureAxis::Horizontal => image.width(),
    }
}

fn image_cross_len(image: &RgbImage, axis: LongCaptureAxis) -> u32 {
    match axis {
        LongCaptureAxis::Vertical => image.width(),
        LongCaptureAxis::Horizontal => image.height(),
    }
}

/// Map (along-axis, cross-axis) sample coordinates to image (x, y).
fn axis_xy(axis: LongCaptureAxis, along: u32, cross: u32) -> (u32, u32) {
    match axis {
        LongCaptureAxis::Vertical => (cross, along),
        LongCaptureAxis::Horizontal => (along, cross),
    }
}

fn aggregate_signature_edge_ignore(cross_len: u32) -> u32 {
    if cross_len >= 160 {
        default_edge_ignore(cross_len).max(24).min(cross_len / 4)
    } else {
        default_edge_ignore(cross_len)
    }
}

fn aggregate_min_match_windows(
    min_overlap_px: i64,
    current_informative_windows: u32,
    previous_informative_windows: u32,
) -> u32 {
    (min_overlap_px / 3)
        .max(1)
        .min(24)
        .min(current_informative_windows.min(previous_informative_windows) as i64)
        .max(1) as u32
}

fn default_edge_ignore(cross_len: u32) -> u32 {
    if cross_len < 120 {
        0
    } else {
        (cross_len / 20).clamp(4, cross_len / 4)
    }
}

fn pixel_diff_sum(a: [u8; 3], b: [u8; 3]) -> u32 {
    (a[0] as i32 - b[0] as i32).unsigned_abs()
        + (a[1] as i32 - b[1] as i32).unsigned_abs()
        + (a[2] as i32 - b[2] as i32).unsigned_abs()
}

fn sample_count(axis_len: u32) -> u32 {
    axis_len.min(128).max(1)
}

const MAX_CROSS_AXIS_SAMPLES: u32 = 192;

fn sampled_offset(index: u32, count: u32, len: u32) -> u32 {
    if count <= 1 || len <= 1 {
        0
    } else {
        index.saturating_mul(len - 1) / (count - 1)
    }
}

fn sampled_axis_offsets(axis_len: u32, edge_ignore: u32, max_samples: u32) -> Vec<u32> {
    let start = edge_ignore.min(axis_len);
    let end = axis_len.saturating_sub(edge_ignore).max(start);
    if end <= start {
        return Vec::new();
    }

    let len = end - start;
    let count = len.min(max_samples.max(1));
    let mut offsets = Vec::with_capacity(count as usize);
    for index in 0..count {
        let offset = start + sampled_offset(index, count, len);
        if offsets.last().copied() != Some(offset) {
            offsets.push(offset);
        }
    }
    offsets
}

fn sampled_cross_axis_offsets(axis_len: u32, edge_ignore: u32) -> Vec<u32> {
    sampled_axis_offsets(axis_len, edge_ignore, MAX_CROSS_AXIS_SAMPLES)
}

const LINE_SIGNATURE_WINDOW: u32 = 10;

#[derive(Clone, Copy, Debug, Default, Eq, Hash, PartialEq)]
struct RollingLineSignature {
    r: u64,
    g: u64,
    b: u64,
    texture: u64,
    content: u32,
}

impl RollingLineSignature {
    fn add_along(
        &mut self,
        image: &RgbImage,
        axis: LongCaptureAxis,
        along: u32,
        cross_axis_offsets: &[u32],
    ) {
        for &cross in cross_axis_offsets {
            let (x, y) = axis_xy(axis, along, cross);
            let pixel = image.get_pixel(x, y).0;
            self.r += pixel[0] as u64;
            self.g += pixel[1] as u64;
            self.b += pixel[2] as u64;
            self.texture += local_texture_strength(image, x, y) as u64;
            if is_content_pixel(pixel) {
                self.content += 1;
            }
        }
    }

    fn remove_along(
        &mut self,
        image: &RgbImage,
        axis: LongCaptureAxis,
        along: u32,
        cross_axis_offsets: &[u32],
    ) {
        for &cross in cross_axis_offsets {
            let (x, y) = axis_xy(axis, along, cross);
            let pixel = image.get_pixel(x, y).0;
            self.r -= pixel[0] as u64;
            self.g -= pixel[1] as u64;
            self.b -= pixel[2] as u64;
            self.texture -= local_texture_strength(image, x, y) as u64;
            if is_content_pixel(pixel) {
                self.content -= 1;
            }
        }
    }
}

#[derive(Clone, Copy, Debug, Default)]
struct SignatureDeltaHint {#[derive(Clone, Copy, Debug, Default)]
struct SignatureDeltaHint {
    match_count: usize,
    min_current_line: u32,
}

fn choose_signature_cross_axis_offsets(
    cross_axis_weights: &[f64],
    cross_axis_offsets: &[u32],
) -> Vec<u32> {
    let mut weighted_offsets = cross_axis_offsets
        .iter()
        .copied()
        .filter(|&offset| {
            cross_axis_weights
                .get(offset as usize)
                .copied()
                .unwrap_or(0.0)
                >= 0.35
        })
        .collect::<Vec<_>>();

    if weighted_offsets.len() >= 12 {
        return weighted_offsets;
    }

    if cross_axis_offsets.len() <= 48 {
        return cross_axis_offsets.to_vec();
    }

    let step = (cross_axis_offsets.len() / 48).max(1);
    weighted_offsets = cross_axis_offsets
        .iter()
        .copied()
        .step_by(step)
        .collect::<Vec<_>>();
    if weighted_offsets.last().copied() != cross_axis_offsets.last().copied() {
        if let Some(last) = cross_axis_offsets.last().copied() {
            weighted_offsets.push(last);
        }
    }
    weighted_offsets
}

fn rolling_axis_signatures(
    image: &RgbImage,
    axis: LongCaptureAxis,
    cross_axis_offsets: &[u32],
    window: u32,
) -> Vec<Option<RollingLineSignature>> {
    let axis_len = image_axis_len(image, axis);
    if cross_axis_offsets.is_empty() || axis_len < window || window == 0 {
        return Vec::new();
    }

    let mut signatures = vec![None; axis_len as usize];
    let mut rolling = RollingLineSignature::default();

    for along in 0..window {
        rolling.add_along(image, axis, along, cross_axis_offsets);
    }

    let min_texture = (cross_axis_offsets.len() as u64 * window as u64).max(24);
    let min_content = ((cross_axis_offsets.len() as u32 * window) / 20).max(4);
    let last_start = axis_len - window;
    for start in 0..=last_start {
        if rolling.texture >= min_texture && rolling.content >= min_content {
            signatures[start as usize] = Some(rolling);
        }

        if start < last_start {
            rolling.remove_along(image, axis, start, cross_axis_offsets);
            rolling.add_along(image, axis, start + window, cross_axis_offsets);
        }
    }

    signatures
}

fn find_fixed_chrome_candidate(
    previous: &RgbImage,
    current: &RgbImage,
    axis: LongCaptureAxis,
    direction: LongCaptureDirection,
    max_scan: u32,
    min_overlap_px: u32,
    min_new_content_px: u32,
    cross_axis_weights: &[f64],
    cross_axis_offsets: &[u32],
) -> Option<CandidateAnalysis> {
    if !direction_matches_axis(direction, axis) {
        return None;
    }

    let axis_len = image_axis_len(previous, axis);
    let signature_window = LINE_SIGNATURE_WINDOW.min(axis_len).max(1);
    let signature_offsets =
        choose_signature_cross_axis_offsets(cross_axis_weights, cross_axis_offsets);
    let previous_signatures =
        rolling_axis_signatures(previous, axis, &signature_offsets, signature_window);
    let current_signatures =
        rolling_axis_signatures(current, axis, &signature_offsets, signature_window);
    if previous_signatures.is_empty() || current_signatures.is_empty() {
        return None;
    }

    let mut current_signature_starts = HashMap::<RollingLineSignature, Vec<u32>>::new();
    let current_last_start = axis_len - signature_window;
    for start in 0..=current_last_start {
        if let Some(signature) = current_signatures[start as usize] {
            current_signature_starts
                .entry(signature)
                .or_default()
                .push(start);
        }
    }

    let forward = direction_is_forward(direction);
    let mut delta_hints = HashMap::<u32, SignatureDeltaHint>::new();
    let previous_last_start = axis_len - signature_window;
    for prev_start in 0..=previous_last_start {
        let Some(signature) = previous_signatures[prev_start as usize] else {
            continue;
        };
        let Some(current_starts) = current_signature_starts.get(&signature) else {
            continue;
        };
        for &curr_start in current_starts {
            let append_px = if forward {
                if prev_start <= curr_start {
                    continue;
                }
                prev_start - curr_start
            } else {
                if curr_start <= prev_start {
                    continue;
                }
                curr_start - prev_start
            };
            if append_px < min_new_content_px || append_px > max_scan {
                continue;
            }

            if forward {
                let crop_start_px = axis_len.saturating_sub(append_px);
                if crop_start_px <= curr_start {
                    continue;
                }
                let overlap_px = crop_start_px - curr_start;
                if overlap_px < min_overlap_px {
                    continue;
                }
            } else {
                let overlap_px = axis_len.saturating_sub(append_px);
                if overlap_px < min_overlap_px {
                    continue;
                }
            }

            delta_hints
                .entry(append_px)
                .and_modify(|hint| {
                    hint.match_count += 1;
                    hint.min_current_line = hint.min_current_line.min(curr_start);
                })
                .or_insert(SignatureDeltaHint {
                    match_count: 1,
                    min_current_line: curr_start,
                });
        }
    }

    let mut best: Option<CandidateAnalysis> = None;
    for (append_px, hint) in delta_hints {
        if hint.match_count < 2 {
            continue;
        }

        let (overlap_px, prev_start, curr_start, crop_start_px) = if forward {
            let crop_start_px = axis_len.saturating_sub(append_px);
            if crop_start_px <= hint.min_current_line {
                continue;
            }
            let overlap_px = crop_start_px - hint.min_current_line;
            if overlap_px < min_overlap_px {
                continue;
            }
            let prev_start = axis_len.saturating_sub(overlap_px);
            (overlap_px, prev_start, hint.min_current_line, crop_start_px)
        } else {
            let overlap_px = axis_len.saturating_sub(append_px);
            if overlap_px < min_overlap_px {
                continue;
            }
            (overlap_px, 0, append_px, append_px)
        };

        let (ratio, mean_diff, texture_score, content_ratio) = overlap_score(
            previous,
            current,
            axis,
            prev_start,
            curr_start,
            overlap_px,
            cross_axis_weights,
            cross_axis_offsets,
        );
        let confidence = score_confidence(ratio, mean_diff);
        let candidate = CandidateAnalysis {
            direction,
            overlap_px,
            crop_start_px,
            append_px,
            confidence: (confidence + (hint.match_count as f64 * 0.015)).clamp(0.0, 1.0),
            mean_diff,
            texture_score,
            content_ratio,
        };
        if best
            .map(|item| candidate_is_better(candidate, item, axis_len, min_new_content_px))
            .unwrap_or(true)
        {
            best = Some(candidate);
        }
    }

    best
}

pub(crate) fn is_near_duplicate_image(pub(crate) fn is_near_duplicate_image(previous: &RgbImage, current: &RgbImage) -> bool {
    if previous.width() != current.width() || previous.height() != current.height() {
        return false;
    }

    let x_offsets = sampled_axis_offsets(previous.width(), 0, 64);
    let y_offsets = sampled_axis_offsets(previous.height(), 0, 64);
    if x_offsets.is_empty() || y_offsets.is_empty() {
        return false;
    }

    let mut total = 0u64;
    let mut changed = 0u64;
    let mut diff_total = 0u64;
    let mut max_diff = 0u32;

    for &y in &y_offsets {
        for &x in &x_offsets {
            let diff = pixel_diff_sum(previous.get_pixel(x, y).0, current.get_pixel(x, y).0);
            if diff >= 18 {
                changed += 1;
            }
            max_diff = max_diff.max(diff);
            diff_total += diff as u64;
            total += 1;
        }
    }

    if total == 0 {
        return false;
    }

    let changed_ratio = changed as f64 / total as f64;
    let mean_diff = diff_total as f64 / total as f64;
    changed_ratio <= 0.01 && mean_diff <= 3.0 && max_diff <= 48
}

fn fallback_uniform_weights(weights: &mut [f64], start: u32, end: u32) {
    for index in start..end {
        weights[index as usize] = 1.0;
    }
}

fn dynamic_column_or_row_weight(significant_count: u32, max_diff: u32, sample_count: u32) -> f64 {
    let significant_ratio = significant_count as f64 / sample_count.max(1) as f64;
    let peak_score = (max_diff as f64 / 160.0).clamp(0.0, 1.0);
    (significant_ratio * 1.8 + peak_score * 0.2).clamp(0.0, 1.0)
}

fn candidate_priority(candidate: CandidateAnalysis, axis_len: u32) -> f64 {
    let overlap_ratio = (candidate.overlap_px as f64 / axis_len.max(1) as f64).clamp(0.0, 1.0);
    let diff_score = (1.0 - (candidate.mean_diff / 64.0)).clamp(0.0, 1.0);
    (candidate.confidence * 0.65 + diff_score * 0.25 + overlap_ratio * 0.10).clamp(0.0, 1.0)
}

fn candidate_is_fast_recording_match(
    candidate: CandidateAnalysis,
    min_new_content_px: u32,
    axis_len: u32,
) -> bool {
    let max_fast_append_px = axis_len.saturating_sub(1).min(24).max(min_new_content_px);
    candidate.append_px >= min_new_content_px
        && candidate.append_px <= max_fast_append_px
        && candidate.texture_score >= 24.0
        && candidate.content_ratio >= 0.01
        && candidate.confidence >= 0.88
        && candidate.mean_diff <= 12.0
}

fn cross_axis_weights(
    previous: &RgbImage,
    current: &RgbImage,
    axis: LongCaptureAxis,
    edge_ignore: u32,
) -> Vec<f64> {
    let cross_len = image_cross_len(previous, axis);
    let along_len = image_axis_len(previous, axis);
    let start = edge_ignore.min(cross_len);
    let end = cross_len.saturating_sub(edge_ignore).max(start);
    let along_samples = sample_count(along_len);
    let mut weights = vec![0.0; cross_len as usize];
    let mut total_weight = 0.0;

    for cross in start..end {
        let mut significant_count = 0;
        let mut max_diff = 0;
        for along_index in 0..along_samples {
            let along = sampled_offset(along_index, along_samples, along_len);
            let (x, y) = axis_xy(axis, along, cross);
            let diff = pixel_diff_sum(previous.get_pixel(x, y).0, current.get_pixel(x, y).0);
            if diff >= 45 {
                significant_count += 1;
            }
            max_diff = max_diff.max(diff);
        }
        let weight = dynamic_column_or_row_weight(significant_count, max_diff, along_samples);
        weights[cross as usize] = weight;
        total_weight += weight;
    }

    if total_weight < 1.0 {
        fallback_uniform_weights(&mut weights, start, end);
    }

    weights
}

fn local_texture_strength(fn local_texture_strength(image: &RgbImage, x: u32, y: u32) -> u32 {
    let pixel = image.get_pixel(x, y).0;
    let mut strength = 0;

    if x > 0 {
        strength = strength.max(pixel_diff_sum(pixel, image.get_pixel(x - 1, y).0));
    }
    if x + 1 < image.width() {
        strength = strength.max(pixel_diff_sum(pixel, image.get_pixel(x + 1, y).0));
    }
    if y > 0 {
        strength = strength.max(pixel_diff_sum(pixel, image.get_pixel(x, y - 1).0));
    }
    if y + 1 < image.height() {
        strength = strength.max(pixel_diff_sum(pixel, image.get_pixel(x, y + 1).0));
    }

    strength
}

fn color_content_strength(pixel: [u8; 3]) -> u32 {
    let min_channel = pixel[0].min(pixel[1]).min(pixel[2]);
    let max_channel = pixel[0].max(pixel[1]).max(pixel[2]);
    let saturation = (max_channel as i32 - min_channel as i32).unsigned_abs();
    let darkness = 255u32.saturating_sub(max_channel as u32);
    saturation.max(darkness)
}

fn is_content_pixel(pixel: [u8; 3]) -> bool {
    color_content_strength(pixel) >= 18
}

fn pixel_texture_weight(
    previous: &RgbImage,
    current: &RgbImage,
    prev_x: u32,
    prev_y: u32,
    curr_x: u32,
    curr_y: u32,
) -> f64 {
    let strength = local_texture_strength(previous, prev_x, prev_y)
        .max(local_texture_strength(current, curr_x, curr_y))
        .max(color_content_strength(previous.get_pixel(prev_x, prev_y).0))
        .max(color_content_strength(current.get_pixel(curr_x, curr_y).0));
    0.03 + 0.97 * (strength as f64 / 96.0).clamp(0.0, 1.0)
}

fn motion_weight(diff: u32) -> f64 {
    0.02 + 0.98 * (diff as f64 / 96.0).clamp(0.0, 1.0)
}

fn overlap_score(
    previous: &RgbImage,
    current: &RgbImage,
    axis: LongCaptureAxis,
    prev_along: u32,
    curr_along: u32,
    overlap_len: u32,
    cross_axis_weights: &[f64],
    cross_axis_offsets: &[u32],
) -> (f64, f64, f64, f64) {
    let along_samples = sample_count(overlap_len);
    let mut matched = 0.0;
    let mut total = 0.0;
    let mut diff_total = 0.0;
    let mut texture_total = 0.0;
    let mut texture_count = 0.0f64;
    let mut content_total = 0.0;
    let same_viewport_limit = image_axis_len(previous, axis);

    for along_index in 0..along_samples {
        let along_offset = sampled_offset(along_index, along_samples, overlap_len);
        for &cross in cross_axis_offsets {
            let weight = cross_axis_weights.get(cross as usize).copied().unwrap_or(1.0);
            if weight <= 0.0 {
                continue;
            }
            let (prev_x, prev_y) = axis_xy(axis, prev_along + along_offset, cross);
            let (curr_x, curr_y) = axis_xy(axis, curr_along + along_offset, cross);
            let diff = pixel_diff_sum(
                previous.get_pixel(prev_x, prev_y).0,
                current.get_pixel(curr_x, curr_y).0,
            );
            let same_viewport_along = curr_along + along_offset;
            let same_viewport_diff = if same_viewport_along < same_viewport_limit {
                let (same_x, same_y) = axis_xy(axis, same_viewport_along, cross);
                pixel_diff_sum(
                    previous.get_pixel(same_x, same_y).0,
                    current.get_pixel(same_x, same_y).0,
                )
            } else {
                diff
            };
            let weight = weight
                * pixel_texture_weight(previous, current, prev_x, prev_y, curr_x, curr_y)
                * motion_weight(same_viewport_diff);
            texture_total += local_texture_strength(previous, prev_x, prev_y)
                .max(local_texture_strength(current, curr_x, curr_y))
                .max(color_content_strength(previous.get_pixel(prev_x, prev_y).0))
                .max(color_content_strength(current.get_pixel(curr_x, curr_y).0))
                as f64
                * weight;
            texture_count += weight;
            if is_content_pixel(previous.get_pixel(prev_x, prev_y).0)
                || is_content_pixel(current.get_pixel(curr_x, curr_y).0)
            {
                content_total += weight;
            }
            if diff <= 30 {
                matched += weight;
            }
            diff_total += diff as f64 * weight;
            total += weight;
        }
    }

    if total <= 0.0 {
        return (0.0, 255.0, 0.0, 0.0);
    }

    (
        matched / total,
        diff_total / total,
        texture_total / texture_count.max(1.0),
        content_total / total,
    )
}

fn score_confidence(fn score_confidence(match_ratio: f64, mean_diff: f64) -> f64 {
    let diff_score = (1.0 - (mean_diff / 64.0)).clamp(0.0, 1.0);
    (0.70 * match_ratio + 0.30 * diff_score).clamp(0.0, 1.0)
}

fn default_min_overlap_px(axis_len: u32, max_scan: u32) -> u32 {
    if axis_len <= 12 {
        1
    } else {
        ((axis_len as f64) * 0.03)
            .round()
            .max(16.0)
            .min(max_scan as f64)
            .max(1.0) as u32
    }
}

fn candidate_is_better(
    candidate: CandidateAnalysis,
    current: CandidateAnalysis,
    axis_len: u32,
    min_new_content_px: u32,
) -> bool {
    let candidate_actionable = candidate.append_px >= min_new_content_px;
    let current_actionable = current.append_px >= min_new_content_px;
    match (candidate_actionable, current_actionable) {
        (true, false) => return true,
        (false, true) => return false,
        _ => {}
    }

    let candidate_good = candidate.confidence >= 0.88 && candidate.mean_diff <= 12.0;
    let current_good = current.confidence >= 0.88 && current.mean_diff <= 12.0;
    let candidate_rank = candidate_priority(candidate, axis_len);
    let current_rank = candidate_priority(current, axis_len);

    match (candidate_good, current_good) {
        (true, false) => true,
        (false, true) => false,
        _ => {
            candidate_rank > current_rank + 0.01
                || ((candidate_rank - current_rank).abs() <= 0.01
                    && candidate.overlap_px > current.overlap_px)
        }
    }
}

fn analyze_direction(
    previous: &RgbImage,
    current: &RgbImage,
    axis: LongCaptureAxis,
    direction: LongCaptureDirection,
    max_scan: u32,
    min_overlap_px: u32,
    min_new_content_px: u32,
) -> Option<CandidateAnalysis> {
    if previous.width() != current.width()
        || previous.height() != current.height()
        || !direction_matches_axis(direction, axis)
    {
        return None;
    }

    let axis_len = image_axis_len(previous, axis);
    if axis_len == 0 {
        return None;
    }

    let limit = max_scan.min(axis_len.saturating_sub(1)).max(1);
    let min_overlap = min_overlap_px.min(limit).max(1);
    let cross_len = image_cross_len(previous, axis);
    let edge_ignore = default_edge_ignore(cross_len);
    let cross_axis_weights = cross_axis_weights(previous, current, axis, edge_ignore);
    let cross_axis_offsets = sampled_cross_axis_offsets(cross_len, edge_ignore);
    let mut best: Option<CandidateAnalysis> = None;

    if let Some(candidate) = find_fixed_chrome_candidate(
        previous,
        current,
        axis,
        direction,
        max_scan,
        min_overlap,
        min_new_content_px,
        &cross_axis_weights,
        &cross_axis_offsets,
    ) {
        if candidate_is_fast_recording_match(candidate, min_new_content_px, axis_len) {
            return Some(candidate);
        }
        best = Some(candidate);
    }

    if direction_is_forward(direction) {
        for overlap_px in min_overlap..=limit {
            let prev_start = axis_len.saturating_sub(overlap_px);
            let (ratio, mean_diff, texture_score, content_ratio) = overlap_score(
                previous,
                current,
                axis,
                prev_start,
                0,
                overlap_px,
                &cross_axis_weights,
                &cross_axis_offsets,
            );
            let confidence = score_confidence(ratio, mean_diff);
            let append_px = axis_len.saturating_sub(overlap_px);
            let candidate = CandidateAnalysis {
                direction,
                overlap_px,
                crop_start_px: overlap_px,
                append_px,
                confidence,
                mean_diff,
                texture_score,
                content_ratio,
            };
            if best
                .map(|item| candidate_is_better(candidate, item, axis_len, min_new_content_px))
                .unwrap_or(true)
            {
                best = Some(candidate);
            }
        }
    } else {
        let search_start = axis_len.saturating_sub(limit);
        let search_end = axis_len.saturating_sub(min_overlap);
        for curr_start in search_start..=search_end {
            let overlap_px = axis_len.saturating_sub(curr_start);
            let (ratio, mean_diff, texture_score, content_ratio) = overlap_score(
                previous,
                current,
                axis,
                0,
                curr_start,
                overlap_px,
                &cross_axis_weights,
                &cross_axis_offsets,
            );
            let confidence = score_confidence(ratio, mean_diff);
            let append_px = curr_start;
            let candidate = CandidateAnalysis {
                direction,
                overlap_px,
                crop_start_px: curr_start,
                append_px,
                confidence,
                mean_diff,
                texture_score,
                content_ratio,
            };
            if best
                .map(|item| candidate_is_better(candidate, item, axis_len, min_new_content_px))
                .unwrap_or(true)
            {
                best = Some(candidate);
            }
        }
    }

    best
}

fn direction_axis(fn direction_axis(direction: LongCaptureDirection) -> LongCaptureAxis {
    match direction {
        LongCaptureDirection::Down | LongCaptureDirection::Up => LongCaptureAxis::Vertical,
        LongCaptureDirection::Right | LongCaptureDirection::Left => LongCaptureAxis::Horizontal,
    }
}

fn direction_matches_axis(direction: LongCaptureDirection, axis: LongCaptureAxis) -> bool {
    direction_axis(direction) == axis
}


fn candidate_directions(
    axis: Option<LongCaptureAxis>,
    direction: Option<LongCaptureDirection>,
) -> Vec<LongCaptureDirection> {
    if let Some(direction) = direction {
        return vec![direction];
    }

    match axis {
        Some(axis) => vec![
            forward_direction_for_axis(axis),
            reverse_direction_for_axis(axis),
        ],
        None => vec![
            LongCaptureDirection::Down,
            LongCaptureDirection::Up,
            LongCaptureDirection::Right,
            LongCaptureDirection::Left,
        ],
    }
}

fn classify_candidate(
    candidate: CandidateAnalysis,
    axis: LongCaptureAxis,
    min_new_content_px: u32,
) -> LongCaptureOverlapAnalysis {
    let has_texture_signal = candidate.texture_score >= 24.0 && candidate.content_ratio >= 0.01;
    let status =
        if has_texture_signal && candidate.confidence >= 0.88 && candidate.mean_diff <= 12.0 {
            if candidate.append_px < min_new_content_px {
                LongCaptureOverlapStatus::TooSmallMotion
            } else {
                LongCaptureOverlapStatus::Good
            }
        } else if has_texture_signal && candidate.confidence >= 0.65 {
            if candidate.append_px < min_new_content_px {
                LongCaptureOverlapStatus::TooSmallMotion
            } else {
                LongCaptureOverlapStatus::Weak
            }
        } else {
            LongCaptureOverlapStatus::NoOverlap
        };

    LongCaptureOverlapAnalysis {
        status,
        axis: Some(axis),
        direction: Some(candidate.direction),
        overlap_px: candidate.overlap_px,
        crop_start_px: candidate.crop_start_px,
        append_px: candidate.append_px,
        confidence: candidate.confidence,
        seam_px: candidate.crop_start_px,
    }
}

fn analyze_axis_candidate(
    previous: &RgbImage,
    current: &RgbImage,
    axis: LongCaptureAxis,
    directions: &[LongCaptureDirection],
    max_scan: u32,
    min_overlap_px: Option<u32>,
    min_new_content_px: u32,
) -> Option<CandidateAnalysis> {
    let axis_len = image_axis_len(previous, axis);
    let min_overlap_px =
        min_overlap_px.unwrap_or_else(|| default_min_overlap_px(axis_len, max_scan));
    let mut best: Option<CandidateAnalysis> = None;

    for &direction in directions {
        let candidate = analyze_direction(
            previous,
            current,
            axis,
            direction,
            max_scan,
            min_overlap_px,
            min_new_content_px,
        );

        if let Some(candidate) = candidate {
            if best
                .map(|item| candidate_is_better(candidate, item, axis_len, min_new_content_px))
                .unwrap_or(true)
            {
                best = Some(candidate);
            }
        }
    }

    best
}

fn analysis_confirms_axis(analysis: &LongCaptureOverlapAnalysis, axis_len: u32) -> bool {
    matches!(
        analysis.status,
        LongCaptureOverlapStatus::Good | LongCaptureOverlapStatus::TooSmallMotion
    ) && analysis.overlap_px.saturating_mul(2) >= axis_len
}

fn analyze_auto_axis_by_image_content(
    previous: &RgbImage,
    current: &RgbImage,
    max_scan: u32,
    min_overlap_px: Option<u32>,
    min_new_content_px: u32,
) -> Option<LongCaptureOverlapAnalysis> {
    const VERTICAL_DIRECTIONS: [LongCaptureDirection; 2] =
        [LongCaptureDirection::Down, LongCaptureDirection::Up];
    const HORIZONTAL_DIRECTIONS: [LongCaptureDirection; 2] =
        [LongCaptureDirection::Right, LongCaptureDirection::Left];

    if let Some(candidate) = analyze_axis_candidate(
        previous,
        current,
        LongCaptureAxis::Vertical,
        &VERTICAL_DIRECTIONS,
        max_scan,
        min_overlap_px,
        min_new_content_px,
    ) {
        let analysis = classify_candidate(candidate, LongCaptureAxis::Vertical, min_new_content_px);
        if analysis_confirms_axis(&analysis, previous.height()) {
            return Some(analysis);
        }
    }

    if let Some(candidate) = analyze_axis_candidate(
        previous,
        current,
        LongCaptureAxis::Horizontal,
        &HORIZONTAL_DIRECTIONS,
        max_scan,
        min_overlap_px,
        min_new_content_px,
    ) {
        let analysis =
            classify_candidate(candidate, LongCaptureAxis::Horizontal, min_new_content_px);
        if analysis_confirms_axis(&analysis, previous.width()) {
            return Some(analysis);
        }
    }

    None
}

pub fn analyze_long_capture_pair_images(
    previous: &RgbImage,
    current: &RgbImage,
    options: LongCaptureAnalyzeOptions,
) -> LongCaptureOverlapAnalysis {
    if previous.width() != current.width() || previous.height() != current.height() {
        return LongCaptureOverlapAnalysis {
            status: LongCaptureOverlapStatus::NoOverlap,
            axis: options.axis,
            direction: options.direction,
            overlap_px: 0,
            crop_start_px: 0,
            append_px: 0,
            confidence: 0.0,
            seam_px: 0,
        };
    }

    if previous.as_raw() == current.as_raw() {
        return LongCaptureOverlapAnalysis {
            status: LongCaptureOverlapStatus::Duplicate,
            axis: options.axis,
            direction: options.direction,
            overlap_px: previous.height().max(previous.width()),
            crop_start_px: 0,
            append_px: 0,
            confidence: 1.0,
            seam_px: 0,
        };
    }
    if is_near_duplicate_image(previous, current) {
        return LongCaptureOverlapAnalysis {
            status: LongCaptureOverlapStatus::Duplicate,
            axis: options.axis,
            direction: options.direction,
            overlap_px: previous.height().max(previous.width()),
            crop_start_px: 0,
            append_px: 0,
            confidence: 0.99,
            seam_px: 0,
        };
    }

    let max_dimension = previous.height().max(previous.width());
    let max_scan = options
        .max_scan
        .unwrap_or_else(|| max_dimension.saturating_sub(1).max(1))
        .clamp(1, max_dimension.saturating_sub(1).max(1));
    let min_new_content_px = options.min_new_content_px.unwrap_or(8);

    if options.axis.is_none() && options.direction.is_none() {
        return analyze_auto_axis_by_image_content(
            previous,
            current,
            max_scan,
            options.min_overlap_px,
            min_new_content_px,
        )
        .unwrap_or(LongCaptureOverlapAnalysis {
            status: LongCaptureOverlapStatus::NoOverlap,
            axis: None,
            direction: None,
            overlap_px: 0,
            crop_start_px: 0,
            append_px: 0,
            confidence: 0.0,
            seam_px: 0,
        });
    }

    let mut best: Option<(LongCaptureAxis, CandidateAnalysis)> = None;
    for direction in candidate_directions(options.axis, options.direction) {
        let candidate_axis = direction_axis(direction);
        let axis_len = image_axis_len(previous, candidate_axis);
        let min_overlap_px = options
            .min_overlap_px
            .unwrap_or_else(|| default_min_overlap_px(axis_len, max_scan));
        let candidate = analyze_direction(
            previous,
            current,
            candidate_axis,
            direction,
            max_scan,
            min_overlap_px,
            min_new_content_px,
        );

        if let Some(candidate) = candidate {
            let axis = direction_axis(candidate.direction);
            if best
                .map(|(_, item)| candidate_is_better(candidate, item, axis_len, min_new_content_px))
                .unwrap_or(true)
            {
                best = Some((axis, candidate));
            }
        }
    }

    best.map(|(axis, candidate)| classify_candidate(candidate, axis, min_new_content_px))
        .unwrap_or(LongCaptureOverlapAnalysis {
            status: LongCaptureOverlapStatus::NoOverlap,
            axis: options.axis,
            direction: options.direction,
            overlap_px: 0,
            crop_start_px: 0,
            append_px: 0,
            confidence: 0.0,
            seam_px: 0,
        })
}

fn frame_axis_len(frame: &RgbImage, axis: LongCaptureAxis) -> i64 {
    match axis {
        LongCaptureAxis::Vertical => frame.height() as i64,
        LongCaptureAxis::Horizontal => frame.width() as i64,
    }
}

fn crop_axis_segment(
    image: &RgbImage,
    axis: LongCaptureAxis,
    local_start: i64,
    len: i64,
) -> Result<RgbImage> {
    if local_start < 0 || len <= 0 {
        return Err(anyhow!("Invalid long-capture crop segment"));
    }
    match axis {
        LongCaptureAxis::Vertical => {
            let y = local_start as u32;
            let height = len as u32;
            if y.saturating_add(height) > image.height() {
                return Err(anyhow!("Vertical long-capture crop is out of bounds"));
            }
            Ok(imageops::crop_imm(image, 0, y, image.width(), height).to_image())
        }
        LongCaptureAxis::Horizontal => {
            let x = local_start as u32;
            let width = len as u32;
            if x.saturating_add(width) > image.width() {
                return Err(anyhow!("Horizontal long-capture crop is out of bounds"));
            }
            Ok(imageops::crop_imm(image, x, 0, width, image.height()).to_image())
        }
    }
}

fn axis_segment_cross_len(image: &RgbImage, axis: LongCaptureAxis) -> u32 {
    match axis {
        LongCaptureAxis::Vertical => image.width(),
        LongCaptureAxis::Horizontal => image.height(),
    }
}

fn axis_segment_len(image: &RgbImage, axis: LongCaptureAxis) -> u32 {
    match axis {
        LongCaptureAxis::Vertical => image.height(),
        LongCaptureAxis::Horizontal => image.width(),
    }
}

fn concatenate_axis_segments(segments: &VecDeque<RgbImage>, axis: LongCaptureAxis) -> RgbImage {
    let Some(first) = segments.front() else {
        return RgbImage::new(0, 0);
    };
    match axis {
        LongCaptureAxis::Vertical => {
            let width = first.width();
            let height = segments.iter().map(RgbImage::height).sum();
            let mut image = RgbImage::new(width, height);
            let mut y = 0i64;
            for segment in segments {
                imageops::replace(&mut image, segment, 0, y);
                y += segment.height() as i64;
            }
            image
        }
        LongCaptureAxis::Horizontal => {
            let width = segments.iter().map(RgbImage::width).sum();
            let height = first.height();
            let mut image = RgbImage::new(width, height);
            let mut x = 0i64;
            for segment in segments {
                imageops::replace(&mut image, segment, x, 0);
                x += segment.width() as i64;
            }
            image
        }
    }
}

fn aggregate_to_image(aggregate: &LongCaptureAggregate, axis: LongCaptureAxis) -> RgbImage {
    if aggregate.segments.len() == 1 {
        return aggregate
            .segments
            .front()
            .cloned()
            .unwrap_or_else(|| RgbImage::new(0, 0));
    }
    concatenate_axis_segments(&aggregate.segments, axis)
}

fn aggregate_into_image(mut aggregate: LongCaptureAggregate) -> RgbImage {
    if let Some(axis) = aggregate.axis {
        return concatenate_axis_segments(&aggregate.segments, axis);
    }
    aggregate
        .segments
        .pop_front()
        .unwrap_or_else(|| RgbImage::new(0, 0))
}

fn aggregate_axis_len(aggregate: &LongCaptureAggregate, axis: LongCaptureAxis) -> u32 {
    aggregate
        .signatures
        .as_ref()
        .filter(|signatures| {
            signatures.cross_len
                == aggregate
                    .segments
                    .front()
                    .map(|segment| axis_segment_cross_len(segment, axis))
                    .unwrap_or(0)
        })
        .map(|signatures| signatures.axis_len)
        .unwrap_or_else(|| {
            aggregate
                .segments
                .iter()
                .map(|segment| axis_segment_len(segment, axis))
                .sum()
        })
}

fn push_aggregate_segment(
    aggregate: &mut LongCaptureAggregate,
    segment: RgbImage,
    axis: LongCaptureAxis,
    prepend: bool,
) -> Result<()> {
    if segment.width() == 0 || segment.height() == 0 {
        return Ok(());
    }
    if let Some(first) = aggregate.segments.front() {
        let expected_cross = axis_segment_cross_len(first, axis);
        let actual_cross = axis_segment_cross_len(&segment, axis);
        if expected_cross != actual_cross {
            return Err(anyhow!("Long-capture aggregate segment size mismatch"));
        }
    }
    if prepend {
        aggregate.segments.push_front(segment);
    } else {
        aggregate.segments.push_back(segment);
    }
    Ok(())
}

fn crop_aggregate_boundary(
    aggregate: &LongCaptureAggregate,
    axis: LongCaptureAxis,
    direction: LongCaptureDirection,
    len: u32,
) -> Option<RgbImage> {
    if len == 0 || len > aggregate_axis_len(aggregate, axis) {
        return None;
    }

    let first = aggregate.segments.front()?;
    match axis {
        LongCaptureAxis::Vertical => {
            let width = first.width();
            let mut output = RgbImage::new(width, len);
            if direction == LongCaptureDirection::Down {
                let mut remaining = len;
                let mut output_y = len;
                for segment in aggregate.segments.iter().rev() {
                    if remaining == 0 {
                        break;
                    }
                    let take = remaining.min(segment.height());
                    output_y -= take;
                    let crop = imageops::crop_imm(
                        segment,
                        0,
                        segment.height().saturating_sub(take),
                        width,
                        take,
                    )
                    .to_image();
                    imageops::replace(&mut output, &crop, 0, output_y as i64);
                    remaining -= take;
                }
            } else {
                let mut remaining = len;
                let mut output_y = 0u32;
                for segment in &aggregate.segments {
                    if remaining == 0 {
                        break;
                    }
                    let take = remaining.min(segment.height());
                    let crop = imageops::crop_imm(segment, 0, 0, width, take).to_image();
                    imageops::replace(&mut output, &crop, 0, output_y as i64);
                    output_y += take;
                    remaining -= take;
                }
            }
            Some(output)
        }
        LongCaptureAxis::Horizontal => {
            let height = first.height();
            let mut output = RgbImage::new(len, height);
            if direction == LongCaptureDirection::Right {
                let mut remaining = len;
                let mut output_x = len;
                for segment in aggregate.segments.iter().rev() {
                    if remaining == 0 {
                        break;
                    }
                    let take = remaining.min(segment.width());
                    output_x -= take;
                    let crop = imageops::crop_imm(
                        segment,
                        segment.width().saturating_sub(take),
                        0,
                        take,
                        height,
                    )
                    .to_image();
                    imageops::replace(&mut output, &crop, output_x as i64, 0);
                    remaining -= take;
                }
            } else {
                let mut remaining = len;
                let mut output_x = 0u32;
                for segment in &aggregate.segments {
                    if remaining == 0 {
                        break;
                    }
                    let take = remaining.min(segment.width());
                    let crop = imageops::crop_imm(segment, 0, 0, take, height).to_image();
                    imageops::replace(&mut output, &crop, output_x as i64, 0);
                    output_x += take;
                    remaining -= take;
                }
            }
            Some(output)
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
struct AxisLineSignature {
    r: u64,
    g: u64,
    b: u64,
    hash: u64,
    texture: u64,
    content: u32,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
struct AxisWindowSignature {
    r: u64,
    g: u64,
    b: u64,
    hash: u64,
    texture: u64,
    content: u32,
}

#[derive(Clone, Debug)]
struct AxisSignatureList {
    axis_len: u32,
    cross_len: u32,
    window_size: u32,
    windows: Vec<AxisWindowSignature>,
    informative_positions: HashMap<AxisWindowSignature, Vec<u32>>,
}

#[derive(Clone, Copy, Debug)]
struct AggregateMatch {
    origin: i64,
    overlap_px: i64,
    prepend_px: i64,
    append_px: i64,
    match_windows: u32,
    overlap_windows: u32,
}

#[derive(Clone, Debug)]
struct AggregateMatchCandidate {
    matched: AggregateMatch,
    current_signatures: AxisSignatureList,
}

#[derive(Clone, Debug)]
struct LongCaptureAggregate {
    axis: Option<LongCaptureAxis>,
    origin: i64,
    segments: VecDeque<RgbImage>,
    signatures: Option<AxisSignatureList>,
}

#[derive(Clone, Debug)]
struct LongCaptureAggregateResult {
    image: RgbImage,
    axis: Option<LongCaptureAxis>,
    merged_frames: usize,
    skipped_frames: usize,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DirectionReferenceSource {
    Merged,
    CoveredSkip,
}

#[derive(Clone, Debug)]
pub struct LongCaptureIncrementalStitcher {
    options: LongCaptureStitchOptions,
    aggregate: LongCaptureAggregate,
    frame_count: usize,
    merged_frames: usize,
    skipped_frames: usize,
    adjacent_fast_path_merges: usize,
    aggregate_signature_searches: usize,
    expensive_adjacent_pair_analyses: usize,
    last_direction_reference_signatures:
        Option<(LongCaptureAxis, AxisSignatureList, DirectionReferenceSource)>,
}

#[derive(Clone, Debug)]
pub(crate) struct LongCaptureMotionFingerprint {
    width: u32,
    height: u32,
    vertical: AxisSignatureList,
    horizontal: AxisSignatureList,
}

const AGGREGATE_SIGNATURE_WINDOW: u32 = 10;

fn signature_hash_mix(mut hash: u64, value: u64) -> u64 {
    hash ^= value.wrapping_add(0x9e37_79b9_7f4a_7c15);
    hash = hash.wrapping_mul(0x1000_0000_01b3);
    hash.rotate_left(13)
}

fn aggregate_signature_cross_axis_offsets(image: &RgbImage, axis: LongCaptureAxis) -> Vec<u32> {
    let cross_len = image_cross_len(image, axis);
    let edge_ignore = aggregate_signature_edge_ignore(cross_len);
    let offsets = sampled_cross_axis_offsets(cross_len, edge_ignore);
    if offsets.is_empty() {
        sampled_cross_axis_offsets(cross_len, 0)
    } else {
        offsets
    }
}

fn axis_line_signature(
    image: &RgbImage,
    axis: LongCaptureAxis,
    index: u32,
    cross_axis_offsets: &[u32],
) -> AxisLineSignature {
    let mut r = 0u64;
    let mut g = 0u64;
    let mut b = 0u64;
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    let mut texture = 0u64;
    let mut content = 0u32;

    for &cross in cross_axis_offsets {
        let (x, y) = axis_xy(axis, index, cross);
        let pixel = image.get_pixel(x, y).0;
        r += pixel[0] as u64;
        g += pixel[1] as u64;
        b += pixel[2] as u64;
        texture += local_texture_strength(image, x, y) as u64;
        if is_content_pixel(pixel) {
            content += 1;
        }
        let packed = ((pixel[0] as u64) << 16) | ((pixel[1] as u64) << 8) | pixel[2] as u64;
        hash = signature_hash_mix(hash, packed ^ cross as u64);
    }

    AxisLineSignature {
        r,
        g,
        b,
        hash,
        texture,
        content,
    }
}

fn aggregate_window_signature_is_informative(signature: &AxisWindowSignature) -> bool {
    signature.content > 0 || signature.texture >= 24
}

fn axis_signature_list(image: &RgbImage, axis: LongCaptureAxis) -> AxisSignatureList {
    let axis_len = match axis {
        LongCaptureAxis::Vertical => image.height(),
        LongCaptureAxis::Horizontal => image.width(),
    };
    let cross_len = match axis {
        LongCaptureAxis::Vertical => image.width(),
        LongCaptureAxis::Horizontal => image.height(),
    };
    let window_size = AGGREGATE_SIGNATURE_WINDOW.min((axis_len / 2).max(1)).max(1);
    let cross_axis_offsets = aggregate_signature_cross_axis_offsets(image, axis);
    let mut lines = Vec::with_capacity(axis_len as usize);
    for index in 0..axis_len {
        lines.push(axis_line_signature(image, axis, index, &cross_axis_offsets));
    }

    let mut windows = Vec::new();
    let mut informative_positions = HashMap::<AxisWindowSignature, Vec<u32>>::new();
    if axis_len >= window_size {
        windows.reserve((axis_len - window_size + 1) as usize);
        for start in 0..=axis_len - window_size {
            let mut r = 0u64;
            let mut g = 0u64;
            let mut b = 0u64;
            let mut hash = 0xcbf2_9ce4_8422_2325u64;
            let mut texture = 0u64;
            let mut content = 0u32;
            for offset in 0..window_size {
                let line = lines[(start + offset) as usize];
                r += line.r;
                g += line.g;
                b += line.b;
                texture += line.texture;
                content += line.content;
                hash = signature_hash_mix(hash, line.hash ^ offset as u64);
            }
            windows.push(AxisWindowSignature {
                r,
                g,
                b,
                hash,
                texture,
                content,
            });
            let signature = *windows
                .last()
                .expect("signature was just appended to the windows list");
            if aggregate_window_signature_is_informative(&signature) {
                informative_positions
                    .entry(signature)
                    .or_default()
                    .push(start);
            }
        }
    }

    AxisSignatureList {
        axis_len,
        cross_len,
        window_size,
        windows,
        informative_positions,
    }
}

pub(crate) fn long_capture_motion_fingerprint(image: &RgbImage) -> LongCaptureMotionFingerprint {
    LongCaptureMotionFingerprint {
        width: image.width(),
        height: image.height(),
        vertical: axis_signature_list(image, LongCaptureAxis::Vertical),
        horizontal: axis_signature_list(image, LongCaptureAxis::Horizontal),
    }
}

fn motion_signature_candidate_for_direction(
    previous: &AxisSignatureList,
    current: &AxisSignatureList,
    axis: LongCaptureAxis,
    direction: LongCaptureDirection,
    max_scan: u32,
    min_overlap_px: u32,
    min_new_content_px: u32,
) -> Option<AggregateMatch> {
    if previous.cross_len != current.cross_len
        || previous.window_size != current.window_size
        || previous.windows.is_empty()
        || current.windows.is_empty()
        || !direction_matches_axis(direction, axis)
    {
        return None;
    }

    let current_informative_windows = current
        .windows
        .iter()
        .filter(|signature| aggregate_window_signature_is_informative(signature))
        .count() as u32;
    let previous_informative_windows = previous
        .windows
        .iter()
        .filter(|signature| aggregate_window_signature_is_informative(signature))
        .count() as u32;
    if current_informative_windows == 0 || previous_informative_windows == 0 {
        return None;
    }

    let previous_axis_len = previous.axis_len as i64;
    let current_axis_len = current.axis_len as i64;
    let max_new_px = max_scan.min(current.axis_len.saturating_sub(1)).max(1) as i64;
    let min_new_content_px = min_new_content_px.max(1) as i64;
    let min_overlap_px = min_overlap_px
        .min(current.axis_len.saturating_sub(1).max(1))
        .max(1) as i64;
    let max_overlap_px = previous_axis_len.min(current_axis_len);
    if max_overlap_px < min_overlap_px {
        return None;
    }

    let min_match_windows = aggregate_min_match_windows(
        min_overlap_px,
        current_informative_windows,
        previous_informative_windows,
    );
    let mut best: Option<AggregateMatch> = None;

    for overlap_px in min_overlap_px..=max_overlap_px {
        let new_px = current_axis_len - overlap_px;
        if new_px < min_new_content_px || new_px > max_new_px {
            continue;
        }

        let (previous_window_start, current_window_start, prepend_px, append_px, origin) =
            if direction_is_forward(direction) {
                (previous_axis_len - overlap_px, 0, 0, new_px, new_px)
            } else {
                (0, current_axis_len - overlap_px, new_px, 0, -new_px)
            };

        let Some((match_windows, overlap_windows)) = aligned_signature_match_counts(
            previous,
            current,
            previous_window_start,
            current_window_start,
            overlap_px,
        ) else {
            continue;
        };
        let required_match_windows =
            aggregate_match_required_windows(min_match_windows, overlap_windows);
        if match_windows < required_match_windows {
            continue;
        }

        let candidate = AggregateMatch {
            origin,
            overlap_px,
            prepend_px,
            append_px,
            match_windows,
            overlap_windows,
        };
        if best
            .map(|current| aggregate_match_is_better(candidate, current))
            .unwrap_or(true)
        {
            best = Some(candidate);
        }
    }

    best
}

fn motion_signature_analysis_for_axis(
    previous: &AxisSignatureList,
    current: &AxisSignatureList,
    axis: LongCaptureAxis,
    options: LongCaptureAnalyzeOptions,
) -> Option<LongCaptureOverlapAnalysis> {
    let max_scan = options
        .max_scan
        .unwrap_or_else(|| current.axis_len.saturating_sub(1).max(1));
    let min_overlap_px = options
        .min_overlap_px
        .unwrap_or_else(|| default_min_overlap_px(current.axis_len, max_scan));
    let min_new_content_px = options.min_new_content_px.unwrap_or(1).max(1);
    let directions: Vec<LongCaptureDirection> = candidate_directions(Some(axis), options.direction)
        .into_iter()
        .filter(|direction| direction_matches_axis(*direction, axis))
        .collect();
    let mut best: Option<(LongCaptureDirection, AggregateMatch)> = None;

    for direction in directions {
        let Some(candidate) = motion_signature_candidate_for_direction(
            previous,
            current,
            axis,
            direction,
            max_scan,
            min_overlap_px,
            min_new_content_px,
        ) else {
            continue;
        };
        if best
            .map(|(_, current)| aggregate_match_is_better(candidate, current))
            .unwrap_or(true)
        {
            best = Some((direction, candidate));
        }
    }

    best.map(|(direction, candidate)| {
        let append_px = (candidate.prepend_px + candidate.append_px).max(0) as u32;
        let crop_start_px = if direction_is_forward(direction) {
            candidate.overlap_px
        } else {
            append_px as i64
        }
        .max(0) as u32;
        LongCaptureOverlapAnalysis {
            status: LongCaptureOverlapStatus::Good,
            axis: Some(axis),
            direction: Some(direction),
            overlap_px: candidate.overlap_px.max(0) as u32,
            crop_start_px,
            append_px,
            confidence: candidate.match_windows as f64 / candidate.overlap_windows.max(1) as f64,
            seam_px: crop_start_px,
        }
    })
}

fn analysis_to_aggregate_match(analysis: &LongCaptureOverlapAnalysis) -> AggregateMatch {
    let forward = analysis
        .direction
        .map(direction_is_forward)
        .unwrap_or(true);
    AggregateMatch {
        origin: if forward {
            analysis.append_px as i64
        } else {
            -(analysis.append_px as i64)
        },
        overlap_px: analysis.overlap_px as i64,
        prepend_px: if forward {
            0
        } else {
            analysis.append_px as i64
        },
        append_px: if forward {
            analysis.append_px as i64
        } else {
            0
        },
        match_windows: (analysis.confidence * analysis.overlap_px.max(1) as f64).round() as u32,
        overlap_windows: analysis.overlap_px.max(1),
    }
}

pub(crate) fn analyze_long_capture_motion_fingerprints(
    previous: &LongCaptureMotionFingerprint,
    current: &LongCaptureMotionFingerprint,
    options: LongCaptureAnalyzeOptions,
) -> Option<LongCaptureOverlapAnalysis> {
    if previous.width != current.width || previous.height != current.height {
        return None;
    }

    let candidate_axes: &[LongCaptureAxis] = match options.axis {
        Some(LongCaptureAxis::Vertical) => &[LongCaptureAxis::Vertical],
        Some(LongCaptureAxis::Horizontal) => &[LongCaptureAxis::Horizontal],
        None => &[LongCaptureAxis::Vertical, LongCaptureAxis::Horizontal],
    };

    let mut best: Option<LongCaptureOverlapAnalysis> = None;
    for axis in candidate_axes {
        let analysis = match axis {
            LongCaptureAxis::Vertical => motion_signature_analysis_for_axis(
                &previous.vertical,
                &current.vertical,
                LongCaptureAxis::Vertical,
                options,
            ),
            LongCaptureAxis::Horizontal => motion_signature_analysis_for_axis(
                &previous.horizontal,
                &current.horizontal,
                LongCaptureAxis::Horizontal,
                options,
            ),
        };
        let Some(analysis) = analysis else {
            continue;
        };
        if options.axis.is_none() {
            let axis_len = match axis {
                LongCaptureAxis::Vertical => previous.height,
                LongCaptureAxis::Horizontal => previous.width,
            };
            if !analysis_confirms_axis(&analysis, axis_len) {
                continue;
            }
        }
        if best
            .map(|current| {
                aggregate_match_is_better(
                    analysis_to_aggregate_match(&analysis),
                    analysis_to_aggregate_match(&current),
                )
            })
            .unwrap_or(true)
        {
            best = Some(analysis);
        }
    }

    best
}

fn aggregate_candidate_direction(
    axis: LongCaptureAxis,
    origin: i64,
) -> Option<LongCaptureDirection> {
    if origin > 0 {
        Some(forward_direction_for_axis(axis))
    } else if origin < 0 {
        Some(reverse_direction_for_axis(axis))
    } else {
        None
    }
}

fn aggregate_direction_allowed(
    axis: LongCaptureAxis,
    origin: i64,
    requested: Option<LongCaptureDirection>,
) -> bool {
    let Some(requested) = requested else {
        return true;
    };
    if !direction_matches_axis(requested, axis) {
        return false;
    }
    aggregate_candidate_direction(axis, origin)
        .map(|candidate| candidate == requested)
        .unwrap_or(false)
}

fn aggregate_match_is_better(candidate: AggregateMatch, current: AggregateMatch) -> bool {
    let candidate_new = candidate.prepend_px + candidate.append_px;
    let current_new = current.prepend_px + current.append_px;
    let candidate_density = candidate.match_windows as u64 * current.overlap_windows.max(1) as u64;
    let current_density = current.match_windows as u64 * candidate.overlap_windows.max(1) as u64;

    candidate_density > current_density
        || (candidate_density == current_density && candidate.match_windows > current.match_windows)
        || (candidate_density == current_density
            && candidate.match_windows == current.match_windows
            && candidate.overlap_px > current.overlap_px)
        || (candidate_density == current_density
            && candidate.match_windows == current.match_windows
            && candidate.overlap_px == current.overlap_px
            && candidate_new < current_new)
        || (candidate_density == current_density
            && candidate.match_windows == current.match_windows
            && candidate.overlap_px == current.overlap_px
            && candidate_new == current_new
            && candidate.origin.abs() < current.origin.abs())
}

fn aligned_signature_match_counts_with(
    aggregate_signatures: &AxisSignatureList,
    current_signatures: &AxisSignatureList,
    aggregate_window_start: i64,
    current_window_start: i64,
    overlap_px: i64,
    fuzzy: bool,
) -> Option<(u32, u32)> {
    let window_size = aggregate_signatures.window_size as i64;
    if overlap_px < window_size
        || aggregate_signatures.window_size != current_signatures.window_size
    {
        return None;
    }
    if fuzzy && aggregate_signatures.cross_len != current_signatures.cross_len {
        return None;
    }

    let sample_count = if fuzzy {
        aggregate_signature_cross_axis_offset_count(aggregate_signatures.cross_len)
    } else {
        0
    };
    let overlap_windows = overlap_px - window_size + 1;
    let mut match_windows = 0u32;
    let mut informative_windows = 0u32;
    for offset in 0..overlap_windows {
        let aggregate_index = aggregate_window_start + offset;
        let current_index = current_window_start + offset;
        if aggregate_index < 0
            || current_index < 0
            || aggregate_index as usize >= aggregate_signatures.windows.len()
            || current_index as usize >= current_signatures.windows.len()
        {
            return None;
        }

        let aggregate_signature = aggregate_signatures.windows[aggregate_index as usize];
        let current_signature = current_signatures.windows[current_index as usize];
        if !aggregate_window_signature_is_informative(&aggregate_signature)
            && !aggregate_window_signature_is_informative(&current_signature)
        {
            continue;
        }

        informative_windows += 1;
        let matched = if fuzzy {
            axis_window_signature_fuzzy_matches(
                aggregate_signature,
                current_signature,
                sample_count,
                aggregate_signatures.window_size,
            )
        } else {
            aggregate_signature == current_signature
        };
        if matched {
            match_windows += 1;
        }
    }

    if informative_windows == 0 {
        None
    } else {
        Some((match_windows, informative_windows))
    }
}

fn aligned_signature_match_counts(
    aggregate_signatures: &AxisSignatureList,
    current_signatures: &AxisSignatureList,
    aggregate_window_start: i64,
    current_window_start: i64,
    overlap_px: i64,
) -> Option<(u32, u32)> {
    aligned_signature_match_counts_with(
        aggregate_signatures,
        current_signatures,
        aggregate_window_start,
        current_window_start,
        overlap_px,
        false,
    )
}
fn aggregate_signature_cross_axis_offset_count(fn aggregate_signature_cross_axis_offset_count(cross_len: u32) -> u64 {
    let edge_ignore = aggregate_signature_edge_ignore(cross_len);
    let offsets = sampled_cross_axis_offsets(cross_len, edge_ignore);
    if offsets.is_empty() {
        sampled_cross_axis_offsets(cross_len, 0).len() as u64
    } else {
        offsets.len() as u64
    }
}

fn axis_window_signature_fuzzy_matches(
    left: AxisWindowSignature,
    right: AxisWindowSignature,
    sample_count: u64,
    window_size: u32,
) -> bool {
    if left == right {
        return true;
    }
    if !aggregate_window_signature_is_informative(&left)
        && !aggregate_window_signature_is_informative(&right)
    {
        return false;
    }

    let sample_window = sample_count
        .saturating_mul(window_size.max(1) as u64)
        .max(1);
    let color_tolerance = sample_window.saturating_mul(8);
    let texture_tolerance = sample_window.saturating_mul(20);
    let content_tolerance = ((sample_window as f64) * 0.10).ceil().max(2.0) as u32;

    left.r.abs_diff(right.r) <= color_tolerance
        && left.g.abs_diff(right.g) <= color_tolerance
        && left.b.abs_diff(right.b) <= color_tolerance
        && left.texture.abs_diff(right.texture) <= texture_tolerance
        && left.content.abs_diff(right.content) <= content_tolerance
}

fn aligned_signature_fuzzy_match_counts(
    aggregate_signatures: &AxisSignatureList,
    current_signatures: &AxisSignatureList,
    aggregate_window_start: i64,
    current_window_start: i64,
    overlap_px: i64,
) -> Option<(u32, u32)> {
    aligned_signature_match_counts_with(
        aggregate_signatures,
        current_signatures,
        aggregate_window_start,
        current_window_start,
        overlap_px,
        true,
    )
}

fn aggregate_match_required_windows(fn aggregate_match_required_windows(min_match_windows: u32, overlap_windows: u32) -> u32 {
    min_match_windows.max(((overlap_windows as f64) * 0.65).ceil().max(1.0) as u32)
}

fn aggregate_fuzzy_match_required_windows(min_match_windows: u32, overlap_windows: u32) -> u32 {
    min_match_windows.max(((overlap_windows as f64) * 0.88).ceil().max(1.0) as u32)
}

fn aggregate_frame_is_already_covered(
    aggregate_signatures: &AxisSignatureList,
    current_signatures: &AxisSignatureList,
    frame_len: i64,
    min_match_windows: u32,
) -> bool {
    if frame_len <= 0 || frame_len > aggregate_signatures.axis_len as i64 {
        return false;
    }
    if current_signatures.windows.is_empty()
        || aggregate_signatures.informative_positions.is_empty()
    {
        return false;
    }

    let mut anchors = current_signatures
        .windows
        .iter()
        .enumerate()
        .filter_map(|(current_position, signature)| {
            if !aggregate_window_signature_is_informative(signature) {
                return None;
            }
            let positions = aggregate_signatures.informative_positions.get(signature)?;
            Some((positions.len(), current_position as i64, *signature))
        })
        .collect::<Vec<_>>();
    anchors.sort_by_key(|(position_count, _, _)| *position_count);

    let mut origin_votes = HashMap::<i64, u32>::new();
    for (_, current_position, signature) in anchors.into_iter().take(12) {
        let Some(aggregate_positions) = aggregate_signatures.informative_positions.get(&signature)
        else {
            continue;
        };
        for &aggregate_position in aggregate_positions {
            let origin_delta = aggregate_position as i64 - current_position;
            if origin_delta >= 0 && origin_delta + frame_len <= aggregate_signatures.axis_len as i64
            {
                *origin_votes.entry(origin_delta).or_insert(0) += 1;
            }
        }
    }

    let mut origins = origin_votes.into_iter().collect::<Vec<_>>();
    origins.sort_by(|(left_origin, left_votes), (right_origin, right_votes)| {
        right_votes
            .cmp(left_votes)
            .then_with(|| left_origin.abs().cmp(&right_origin.abs()))
    });

    origins.into_iter().take(64).any(|(origin_delta, _)| {
        let Some((match_windows, overlap_windows)) = aligned_signature_match_counts(
            aggregate_signatures,
            current_signatures,
            origin_delta,
            0,
            frame_len,
        ) else {
            return false;
        };
        let required =
            min_match_windows.max(((overlap_windows as f64) * 0.85).ceil().max(1.0) as u32);
        match_windows >= required
    })
}

fn aggregate_candidate_new_slice_is_already_covered(
    aggregate_signatures: &AxisSignatureList,
    current_signatures: &AxisSignatureList,
    matched: AggregateMatch,
) -> bool {
    if aggregate_signatures.window_size != current_signatures.window_size
        || aggregate_signatures.cross_len != current_signatures.cross_len
        || aggregate_signatures.informative_positions.is_empty()
    {
        return false;
    }

    let frame_len = current_signatures.axis_len as i64;
    let window_size = current_signatures.window_size as i64;
    let (new_start, new_len) = if matched.append_px > 0 && matched.prepend_px == 0 {
        (frame_len - matched.append_px, matched.append_px)
    } else if matched.prepend_px > 0 && matched.append_px == 0 {
        (0, matched.prepend_px)
    } else {
        return false;
    };
    if new_start < 0 || new_len < window_size.max(16) {
        return false;
    }

    let new_window_end = new_start + new_len - window_size + 1;
    if new_window_end <= new_start || new_window_end as usize > current_signatures.windows.len() {
        return false;
    }

    let mut anchors = current_signatures.windows[new_start as usize..new_window_end as usize]
        .iter()
        .enumerate()
        .filter_map(|(offset, signature)| {
            if !aggregate_window_signature_is_informative(signature) {
                return None;
            }
            let positions = aggregate_signatures.informative_positions.get(signature)?;
            Some((positions.len(), new_start + offset as i64, *signature))
        })
        .collect::<Vec<_>>();
    if anchors.len() < 4 {
        return false;
    }
    anchors.sort_by_key(|(position_count, _, _)| *position_count);

    let mut origin_votes = HashMap::<i64, u32>::new();
    for (_, current_position, signature) in anchors.into_iter().take(24) {
        let Some(aggregate_positions) = aggregate_signatures.informative_positions.get(&signature)
        else {
            continue;
        };
        for &aggregate_position in aggregate_positions {
            let origin_delta = aggregate_position as i64 - current_position;
            let aggregate_new_start = origin_delta + new_start;
            if aggregate_new_start >= 0
                && aggregate_new_start + new_len <= aggregate_signatures.axis_len as i64
            {
                *origin_votes.entry(origin_delta).or_insert(0) += 1;
            }
        }
    }

    let mut origins = origin_votes.into_iter().collect::<Vec<_>>();
    origins.sort_by(|(left_origin, left_votes), (right_origin, right_votes)| {
        right_votes
            .cmp(left_votes)
            .then_with(|| left_origin.abs().cmp(&right_origin.abs()))
    });

    origins.into_iter().take(64).any(|(origin_delta, _)| {
        let aggregate_new_start = origin_delta + new_start;
        let Some((match_windows, overlap_windows)) = aligned_signature_match_counts(
            aggregate_signatures,
            current_signatures,
            aggregate_new_start,
            new_start,
            new_len,
        ) else {
            return false;
        };
        let required = ((overlap_windows as f64) * 0.92).ceil().max(4.0) as u32;
        match_windows >= required
    })
}

fn rebuild_informative_positions(
    windows: &[AxisWindowSignature],
) -> HashMap<AxisWindowSignature, Vec<u32>> {
    let mut informative_positions = HashMap::<AxisWindowSignature, Vec<u32>>::new();
    for (position, signature) in windows.iter().enumerate() {
        if aggregate_window_signature_is_informative(signature) {
            informative_positions
                .entry(*signature)
                .or_default()
                .push(position as u32);
        }
    }
    informative_positions
}

fn axis_signature_list_from_windows(
    axis_len: u32,
    cross_len: u32,
    window_size: u32,
    windows: Vec<AxisWindowSignature>,
) -> AxisSignatureList {
    let informative_positions = rebuild_informative_positions(&windows);
    AxisSignatureList {
        axis_len,
        cross_len,
        window_size,
        windows,
        informative_positions,
    }
}

fn merge_axis_signature_lists(
    aggregate_signatures: &AxisSignatureList,
    current_signatures: &AxisSignatureList,
    matched: AggregateMatch,
) -> Option<AxisSignatureList> {
    if aggregate_signatures.window_size != current_signatures.window_size
        || aggregate_signatures.cross_len != current_signatures.cross_len
    {
        return None;
    }

    let new_axis_len =
        (aggregate_signatures.axis_len as i64 + matched.prepend_px + matched.append_px) as u32;
    let mut windows = Vec::new();
    if matched.prepend_px > 0 {
        let prepend_count = matched.prepend_px as usize;
        if prepend_count > current_signatures.windows.len() {
            return None;
        }
        windows.reserve(current_signatures.windows.len() + aggregate_signatures.windows.len());
        windows.extend_from_slice(&current_signatures.windows[..prepend_count]);
        windows.extend_from_slice(&aggregate_signatures.windows);
    } else if matched.append_px > 0 {
        let append_count = matched.append_px as usize;
        if append_count > current_signatures.windows.len() {
            return None;
        }
        let append_start = current_signatures.windows.len() - append_count;
        windows.reserve(aggregate_signatures.windows.len() + append_count);
        windows.extend_from_slice(&aggregate_signatures.windows);
        windows.extend_from_slice(&current_signatures.windows[append_start..]);
    } else {
        windows.extend_from_slice(&aggregate_signatures.windows);
    }

    Some(axis_signature_list_from_windows(
        new_axis_len,
        aggregate_signatures.cross_len,
        aggregate_signatures.window_size,
        windows,
    ))
}

fn aggregate_boundary_fuzzy_match_confirms(
    aggregate: &LongCaptureAggregate,
    current: &RgbImage,
    axis: LongCaptureAxis,
    direction: LongCaptureDirection,
    overlap_px: u32,
) -> bool {
    if !direction_matches_axis(direction, axis) {
        return false;
    }
    let boundary = match crop_aggregate_boundary(aggregate, axis, direction, overlap_px) {
        Some(boundary) => boundary,
        None => return false,
    };

    let axis_len = image_axis_len(current, axis);
    let cross_len = image_cross_len(current, axis);
    if image_cross_len(&boundary, axis) != cross_len || overlap_px == 0 || overlap_px > axis_len {
        return false;
    }

    let edge_ignore = default_edge_ignore(cross_len);
    let offsets = sampled_cross_axis_offsets(cross_len, edge_ignore);
    let weights = vec![1.0; cross_len as usize];
    let curr_start = if direction_is_forward(direction) {
        0
    } else {
        axis_len - overlap_px
    };
    let (ratio, mean_diff, texture_score, content_ratio) = overlap_score(
        &boundary, current, axis, 0, curr_start, overlap_px, &weights, &offsets,
    );
    score_confidence(ratio, mean_diff) >= 0.65
        && (texture_score >= 12.0 || content_ratio >= 0.01)
}

fn aggregate_match_from_adjacent_signatures(fn aggregate_match_from_adjacent_signatures(
    aggregate: &LongCaptureAggregate,
    previous_signatures: &AxisSignatureList,
    current: &RgbImage,
    axis: LongCaptureAxis,
    options: LongCaptureStitchOptions,
) -> Option<AggregateMatchCandidate> {
    let aggregate_signatures = aggregate.signatures.as_ref()?;
    let current_signatures = axis_signature_list(current, axis);
    if aggregate_signatures.cross_len != current_signatures.cross_len
        || aggregate_signatures.window_size != current_signatures.window_size
        || previous_signatures.cross_len != current_signatures.cross_len
        || previous_signatures.window_size != current_signatures.window_size
        || current_signatures.windows.is_empty()
        || previous_signatures.windows.is_empty()
    {
        return None;
    }

    let current_informative_windows = current_signatures
        .windows
        .iter()
        .filter(|signature| aggregate_window_signature_is_informative(signature))
        .count() as u32;
    if current_informative_windows == 0 {
        return None;
    }

    let previous_axis_len = previous_signatures.axis_len as i64;
    let aggregate_axis_len = aggregate_axis_len(aggregate, axis) as i64;
    let frame_len = current_signatures.axis_len as i64;
    let min_overlap_px = options.min_overlap_px.unwrap_or_else(|| {
        default_min_overlap_px(
            current_signatures.axis_len,
            options
                .max_scan
                .unwrap_or_else(|| current_signatures.axis_len.saturating_sub(1).max(1)),
        )
    }) as i64;
    let max_new_px = options
        .max_scan
        .unwrap_or_else(|| current_signatures.axis_len.saturating_sub(1).max(1))
        as i64;
    let max_overlap_px = previous_axis_len.min(frame_len);
    if max_overlap_px < min_overlap_px {
        return None;
    }
    let min_match_windows = (min_overlap_px / 3)
        .max(1)
        .min(24)
        .min(current_informative_windows as i64)
        .max(1) as u32;

    let mut best: Option<AggregateMatch> = None;
    for overlap_px in min_overlap_px..=max_overlap_px {
        let new_px = frame_len - overlap_px;
        if new_px <= 0 || new_px > max_new_px {
            continue;
        }

        let direction = forward_direction_for_axis(axis);
        if aggregate_direction_allowed(axis, aggregate_axis_len - overlap_px, options.direction) {
            if let Some((match_windows, overlap_windows)) = aligned_signature_match_counts(
                previous_signatures,
                &current_signatures,
                previous_axis_len - overlap_px,
                0,
                overlap_px,
            ) {
                let required_match_windows =
                    aggregate_match_required_windows(min_match_windows, overlap_windows);
                if match_windows >= required_match_windows
                    && aggregate_boundary_fuzzy_match_confirms(
                        aggregate,
                        current,
                        axis,
                        direction,
                        overlap_px as u32,
                    )
                {
                    let candidate = AggregateMatch {
                        origin: aggregate.origin + aggregate_axis_len - overlap_px,
                        overlap_px,
                        prepend_px: 0,
                        append_px: new_px,
                        match_windows,
                        overlap_windows,
                    };
                    if best
                        .map(|current| aggregate_match_is_better(candidate, current))
                        .unwrap_or(true)
                    {
                        best = Some(candidate);
                    }
                }
            }
        }

        let direction = reverse_direction_for_axis(axis);
        if aggregate_direction_allowed(axis, -new_px, options.direction) {
            if let Some((match_windows, overlap_windows)) = aligned_signature_match_counts(
                previous_signatures,
                &current_signatures,
                0,
                frame_len - overlap_px,
                overlap_px,
            ) {
                let required_match_windows =
                    aggregate_match_required_windows(min_match_windows, overlap_windows);
                if match_windows >= required_match_windows
                    && aggregate_boundary_fuzzy_match_confirms(
                        aggregate,
                        current,
                        axis,
                        direction,
                        overlap_px as u32,
                    )
                {
                    let candidate = AggregateMatch {
                        origin: aggregate.origin - new_px,
                        overlap_px,
                        prepend_px: new_px,
                        append_px: 0,
                        match_windows,
                        overlap_windows,
                    };
                    if best
                        .map(|current| aggregate_match_is_better(candidate, current))
                        .unwrap_or(true)
                    {
                        best = Some(candidate);
                    }
                }
            }
        }
    }

    best.map(|matched| AggregateMatchCandidate {
        matched,
        current_signatures,
    })
}

fn aggregate_match_direction(
    matched: AggregateMatch,
    axis: LongCaptureAxis,
) -> Option<LongCaptureDirection> {
    if matched.append_px > 0 && matched.prepend_px == 0 {
        Some(forward_direction_for_axis(axis))
    } else if matched.prepend_px > 0 && matched.append_px == 0 {
        Some(reverse_direction_for_axis(axis))
    } else {
        None
    }
}

fn choose_aggregate_match_candidate(
    exact: Option<AggregateMatchCandidate>,
    directed: Option<AggregateMatchCandidate>,
    axis: LongCaptureAxis,
) -> Option<AggregateMatchCandidate> {
    match (exact, directed) {
        (Some(exact), Some(directed)) => {
            let exact_direction = aggregate_match_direction(exact.matched, axis);
            let directed_direction = aggregate_match_direction(directed.matched, axis);
            if exact_direction.is_some()
                && directed_direction.is_some()
                && exact_direction != directed_direction
            {
                return Some(directed);
            }
            if aggregate_match_is_better(directed.matched, exact.matched) {
                Some(directed)
            } else {
                Some(exact)
            }
        }
        (Some(exact), None) => Some(exact),
        (None, Some(directed)) => Some(directed),
        (None, None) => None,
    }
}

fn aggregate_contains_current_frame(
    aggregate: &LongCaptureAggregate,
    current: &RgbImage,
    axis: LongCaptureAxis,
    options: LongCaptureStitchOptions,
) -> bool {
    let Some(aggregate_signatures) = aggregate.signatures.as_ref() else {
        return false;
    };
    if aggregate_signatures.cross_len
        != match axis {
            LongCaptureAxis::Vertical => current.width(),
            LongCaptureAxis::Horizontal => current.height(),
        }
    {
        return false;
    }

    let current_signatures = axis_signature_list(current, axis);
    if aggregate_signatures.window_size != current_signatures.window_size
        || aggregate_signatures.windows.is_empty()
        || current_signatures.windows.is_empty()
    {
        return false;
    }

    let current_informative_windows = current_signatures
        .windows
        .iter()
        .filter(|signature| aggregate_window_signature_is_informative(signature))
        .count() as u32;
    if current_informative_windows == 0 {
        return false;
    }

    let min_overlap_px = options.min_overlap_px.unwrap_or_else(|| {
        default_min_overlap_px(
            current_signatures.axis_len,
            options
                .max_scan
                .unwrap_or_else(|| current_signatures.axis_len.saturating_sub(1).max(1)),
        )
    }) as i64;
    let min_match_windows = (min_overlap_px / 3)
        .max(1)
        .min(24)
        .min(current_informative_windows as i64)
        .max(1) as u32;

    aggregate_frame_is_already_covered(
        aggregate_signatures,
        &current_signatures,
        current_signatures.axis_len as i64,
        min_match_windows,
    )
}

fn find_aggregate_signature_match(
    aggregate: &LongCaptureAggregate,
    current: &RgbImage,
    axis: LongCaptureAxis,
    options: LongCaptureStitchOptions,
) -> Option<AggregateMatchCandidate> {
    let aggregate_signatures = aggregate.signatures.as_ref()?;
    if aggregate_signatures.cross_len
        != match axis {
            LongCaptureAxis::Vertical => current.width(),
            LongCaptureAxis::Horizontal => current.height(),
        }
    {
        return None;
    }

    let current_signatures = axis_signature_list(current, axis);
    if aggregate_signatures.window_size != current_signatures.window_size
        || aggregate_signatures.windows.is_empty()
        || current_signatures.windows.is_empty()
    {
        return None;
    }

    if aggregate_signatures.informative_positions.is_empty() {
        return None;
    }

    let mut current_informative_windows = 0u32;
    for signature in &current_signatures.windows {
        if aggregate_window_signature_is_informative(signature) {
            current_informative_windows += 1;
        }
    }
    if current_informative_windows == 0 {
        return None;
    }

    let aggregate_axis_len = aggregate_signatures.axis_len as i64;
    let frame_len = current_signatures.axis_len as i64;
    let min_overlap_px = options.min_overlap_px.unwrap_or_else(|| {
        default_min_overlap_px(
            current_signatures.axis_len,
            options
                .max_scan
                .unwrap_or_else(|| current_signatures.axis_len.saturating_sub(1).max(1)),
        )
    }) as i64;
    let min_match_windows = (min_overlap_px / 3)
        .max(1)
        .min(24)
        .min(current_informative_windows as i64)
        .max(1) as u32;

    if aggregate_frame_is_already_covered(
        aggregate_signatures,
        &current_signatures,
        frame_len,
        min_match_windows,
    ) {
        return None;
    }

    let max_overlap_px = aggregate_axis_len.min(frame_len);
    if max_overlap_px < min_overlap_px {
        return None;
    }
    let max_new_px = options
        .max_scan
        .unwrap_or_else(|| current_signatures.axis_len.saturating_sub(1).max(1))
        as i64;

    let mut best: Option<AggregateMatch> = None;
    for overlap_px in min_overlap_px..=max_overlap_px {
        let append_px = frame_len - overlap_px;
        if append_px > 0 && append_px <= max_new_px {
            let origin = aggregate.origin + aggregate_axis_len - overlap_px;
            if aggregate_direction_allowed(axis, origin - aggregate.origin, options.direction) {
                let mut accepted_counts = None;
                if let Some((match_windows, overlap_windows)) = aligned_signature_match_counts(
                    aggregate_signatures,
                    &current_signatures,
                    aggregate_axis_len - overlap_px,
                    0,
                    overlap_px,
                ) {
                    let required_match_windows =
                        aggregate_match_required_windows(min_match_windows, overlap_windows);
                    if match_windows >= required_match_windows {
                        accepted_counts = Some((match_windows, overlap_windows));
                    }
                }
                if accepted_counts.is_none() {
                    if let Some((match_windows, overlap_windows)) =
                        aligned_signature_fuzzy_match_counts(
                            aggregate_signatures,
                            &current_signatures,
                            aggregate_axis_len - overlap_px,
                            0,
                            overlap_px,
                        )
                    {
                        let required_match_windows = aggregate_fuzzy_match_required_windows(
                            min_match_windows,
                            overlap_windows,
                        );
                        let direction = forward_direction_for_axis(axis);
                        if match_windows >= required_match_windows
                            && aggregate_boundary_fuzzy_match_confirms(
                                aggregate,
                                current,
                                axis,
                                direction,
                                overlap_px as u32,
                            )
                        {
                            accepted_counts = Some((match_windows, overlap_windows));
                        }
                    }
                }
                if let Some((match_windows, overlap_windows)) = accepted_counts {
                    let candidate = AggregateMatch {
                        origin,
                        overlap_px,
                        prepend_px: 0,
                        append_px,
                        match_windows,
                        overlap_windows,
                    };
                    if best
                        .map(|current| aggregate_match_is_better(candidate, current))
                        .unwrap_or(true)
                    {
                        best = Some(candidate);
                    }
                }
            }
        }

        let prepend_px = frame_len - overlap_px;
        if prepend_px > 0 && prepend_px <= max_new_px {
            let origin = aggregate.origin - prepend_px;
            if aggregate_direction_allowed(axis, origin - aggregate.origin, options.direction) {
                let mut accepted_counts = None;
                if let Some((match_windows, overlap_windows)) = aligned_signature_match_counts(
                    aggregate_signatures,
                    &current_signatures,
                    0,
                    frame_len - overlap_px,
                    overlap_px,
                ) {
                    let required_match_windows =
                        aggregate_match_required_windows(min_match_windows, overlap_windows);
                    if match_windows >= required_match_windows {
                        accepted_counts = Some((match_windows, overlap_windows));
                    }
                }
                if accepted_counts.is_none() {
                    if let Some((match_windows, overlap_windows)) =
                        aligned_signature_fuzzy_match_counts(
                            aggregate_signatures,
                            &current_signatures,
                            0,
                            frame_len - overlap_px,
                            overlap_px,
                        )
                    {
                        let required_match_windows = aggregate_fuzzy_match_required_windows(
                            min_match_windows,
                            overlap_windows,
                        );
                        let direction = reverse_direction_for_axis(axis);
                        if match_windows >= required_match_windows
                            && aggregate_boundary_fuzzy_match_confirms(
                                aggregate,
                                current,
                                axis,
                                direction,
                                overlap_px as u32,
                            )
                        {
                            accepted_counts = Some((match_windows, overlap_windows));
                        }
                    }
                }
                if let Some((match_windows, overlap_windows)) = accepted_counts {
                    let candidate = AggregateMatch {
                        origin,
                        overlap_px,
                        prepend_px,
                        append_px: 0,
                        match_windows,
                        overlap_windows,
                    };
                    if best
                        .map(|current| aggregate_match_is_better(candidate, current))
                        .unwrap_or(true)
                    {
                        best = Some(candidate);
                    }
                }
            }
        }
    }

    best.map(|matched| AggregateMatchCandidate {
        matched,
        current_signatures,
    })
}

fn aggregate_crop_axis_segment(
    image: &RgbImage,
    axis: LongCaptureAxis,
    start: i64,
    len: i64,
) -> Result<RgbImage> {
    crop_axis_segment(image, axis, start, len)
}

fn merge_frame_into_aggregate(
    aggregate: &mut LongCaptureAggregate,
    current: &RgbImage,
    axis: LongCaptureAxis,
    candidate: AggregateMatchCandidate,
) -> Result<()> {
    let matched = candidate.matched;
    let previous_signatures = aggregate.signatures.take();
    if matched.prepend_px > 0 {
        let crop = aggregate_crop_axis_segment(current, axis, 0, matched.prepend_px)?;
        push_aggregate_segment(aggregate, crop, axis, true)?;
        aggregate.origin -= matched.prepend_px;
    }

    if matched.append_px > 0 {
        let current_axis_len = frame_axis_len(current, axis);
        let crop_start = current_axis_len - matched.append_px;
        let crop = aggregate_crop_axis_segment(current, axis, crop_start, matched.append_px)?;
        push_aggregate_segment(aggregate, crop, axis, false)?;
    }

    aggregate.signatures = previous_signatures
        .as_ref()
        .and_then(|signatures| {
            merge_axis_signature_lists(signatures, &candidate.current_signatures, matched)
        })
        .or_else(|| {
            let aggregate_image = aggregate_to_image(aggregate, axis);
            Some(axis_signature_list(&aggregate_image, axis))
        });
    Ok(())
}

fn aggregate_axes_to_try(axis: Option<LongCaptureAxis>) -> &'static [LongCaptureAxis] {
    match axis {
        Some(LongCaptureAxis::Vertical) => &[LongCaptureAxis::Vertical],
        Some(LongCaptureAxis::Horizontal) => &[LongCaptureAxis::Horizontal],
        None => &[LongCaptureAxis::Vertical, LongCaptureAxis::Horizontal],
    }
}

fn infer_axis_from_adjacent_frames(
    frames: &[RgbImage],
    options: LongCaptureStitchOptions,
) -> Option<LongCaptureAxis> {
    if let Some(axis) = options.axis {
        return Some(axis);
    }

    let mut vertical_score = 0.0f64;
    let mut horizontal_score = 0.0f64;
    let mut inspected_pairs = 0usize;

    for pair in frames.windows(2) {
        if inspected_pairs >= 8 {
            break;
        }
        inspected_pairs += 1;

        let analysis = analyze_long_capture_pair_images(
            &pair[0],
            &pair[1],
            LongCaptureAnalyzeOptions {
                axis: None,
                direction: None,
                max_scan: options.max_scan,
                min_overlap_px: options.min_overlap_px,
                min_new_content_px: Some(2),
            },
        );

        if !matches!(
            analysis.status,
            LongCaptureOverlapStatus::Good | LongCaptureOverlapStatus::TooSmallMotion
        ) {
            continue;
        }

        let weight = 1.0 + analysis.confidence + (analysis.append_px as f64 / 24.0).min(1.0);
        match analysis.axis {
            Some(LongCaptureAxis::Vertical) => vertical_score += weight,
            Some(LongCaptureAxis::Horizontal) => horizontal_score += weight,
            None => {}
        }

        if vertical_score > 0.0 && vertical_score >= horizontal_score {
            return Some(LongCaptureAxis::Vertical);
        }
    }

    if vertical_score > 0.0 && vertical_score >= horizontal_score {
        Some(LongCaptureAxis::Vertical)
    } else if horizontal_score > 0.0 && horizontal_score > vertical_score * 1.25 {
        Some(LongCaptureAxis::Horizontal)
    } else {
        None
    }
}

impl LongCaptureIncrementalStitcher {
    fn new_with_axis(
        first_frame: RgbImage,
        options: LongCaptureStitchOptions,
        axis: Option<LongCaptureAxis>,
    ) -> Self {
        let signatures = axis.map(|axis| axis_signature_list(&first_frame, axis));
        let mut segments = VecDeque::new();
        segments.push_back(first_frame.clone());
        let last_direction_reference_signatures = axis.and_then(|axis| {
            signatures
                .clone()
                .map(|signatures| (axis, signatures, DirectionReferenceSource::Merged))
        });
        Self {
            options,
            aggregate: LongCaptureAggregate {
                axis,
                origin: 0,
                segments,
                signatures,
            },
            frame_count: 1,
            merged_frames: 1,
            skipped_frames: 0,
            adjacent_fast_path_merges: 0,
            aggregate_signature_searches: 0,
            expensive_adjacent_pair_analyses: 0,
            last_direction_reference_signatures,
        }
    }

    pub fn new(first_frame: RgbImage, options: LongCaptureStitchOptions) -> Self {
        Self::new_with_axis(first_frame, options, options.axis)
    }

    pub fn push_frame(&mut self, current: &RgbImage) -> Result<bool> {
        self.push_frame_owned(current.clone())
    }

    pub fn push_frame_owned(&mut self, current: RgbImage) -> Result<bool> {
        let frame_index = self.frame_count;
        self.frame_count += 1;

        let mut best: Option<(LongCaptureAxis, AggregateMatchCandidate)> = None;
        for &axis in aggregate_axes_to_try(self.aggregate.axis) {
            if self.aggregate.axis.is_none() {
                let aggregate_image = aggregate_to_image(&self.aggregate, axis);
                self.aggregate.signatures = Some(axis_signature_list(&aggregate_image, axis));
            }
            let mut rejected_covered_skip_fast_path = false;
            let lightweight_directed_candidate = self
                .last_direction_reference_signatures
                .as_ref()
                .and_then(|(signature_axis, previous_signatures, source)| {
                    if *signature_axis != axis {
                        return None;
                    }
                    let candidate = aggregate_match_from_adjacent_signatures(
                        &self.aggregate,
                        previous_signatures,
                        &current,
                        axis,
                        self.options,
                    )?;
                    if *source == DirectionReferenceSource::CoveredSkip {
                        let Some(aggregate_signatures) = self.aggregate.signatures.as_ref() else {
                            return None;
                        };
                        if aggregate_candidate_new_slice_is_already_covered(
                            aggregate_signatures,
                            &candidate.current_signatures,
                            candidate.matched,
                        ) {
                            rejected_covered_skip_fast_path = true;
                            return None;
                        }
                    }
                    Some(candidate)
                });
            let (candidate, used_adjacent_fast_path) = if rejected_covered_skip_fast_path {
                (None, true)
            } else if self.aggregate.axis == Some(axis) && lightweight_directed_candidate.is_some()
            {
                (lightweight_directed_candidate, true)
            } else {
                self.aggregate_signature_searches += 1;
                let exact_candidate =
                    find_aggregate_signature_match(&self.aggregate, &current, axis, self.options);
                (
                    choose_aggregate_match_candidate(exact_candidate, None, axis),
                    false,
                )
            };
            let Some(candidate) = candidate else {
                continue;
            };

            if best
                .as_ref()
                .map(|(_, current)| aggregate_match_is_better(candidate.matched, current.matched))
                .unwrap_or(true)
            {
                best = Some((axis, candidate));
                if used_adjacent_fast_path {
                    self.adjacent_fast_path_merges += 1;
                }
            }

            if self.aggregate.axis.is_none()
                && best.as_ref().map(|(best_axis, _)| *best_axis) == Some(axis)
            {
                break;
            }
        }

        let Some((axis, candidate)) = best else {
            if let Some(axis) = self.aggregate.axis {
                if aggregate_contains_current_frame(&self.aggregate, &current, axis, self.options) {
                    self.last_direction_reference_signatures = Some((
                        axis,
                        axis_signature_list(&current, axis),
                        DirectionReferenceSource::CoveredSkip,
                    ));
                }
            }
            self.skipped_frames += 1;
            crate::append_runtime_log_line(&format!(
                "long_capture aggregate_skip_no_overlap :: frame_index={} merged_frames={} locked_axis={:?}",
                frame_index, self.merged_frames, self.aggregate.axis
            ));
            return Ok(false);
        };

        if self.aggregate.axis.is_none() {
            self.aggregate.axis = Some(axis);
            let aggregate_image = aggregate_to_image(&self.aggregate, axis);
            self.aggregate.signatures = Some(axis_signature_list(&aggregate_image, axis));
        }

        let current_reference_signatures = candidate.current_signatures.clone();
        merge_frame_into_aggregate(&mut self.aggregate, &current, axis, candidate)?;
        self.merged_frames += 1;
        self.last_direction_reference_signatures = Some((
            axis,
            current_reference_signatures,
            DirectionReferenceSource::Merged,
        ));
        Ok(true)
    }

    fn finish_result(self) -> LongCaptureAggregateResult {
        let axis = self.aggregate.axis;
        LongCaptureAggregateResult {
            image: aggregate_into_image(self.aggregate),
            axis,
            merged_frames: self.merged_frames,
            skipped_frames: self.skipped_frames,
        }
    }

    pub fn into_image(self) -> RgbImage {
        aggregate_into_image(self.aggregate)
    }

    pub fn axis(&self) -> Option<LongCaptureAxis> {
        self.aggregate.axis
    }

    pub fn frame_count(&self) -> usize {
        self.frame_count
    }

    pub fn merged_frames(&self) -> usize {
        self.merged_frames
    }

    pub fn skipped_frames(&self) -> usize {
        self.skipped_frames
    }

    pub fn adjacent_fast_path_merges(&self) -> usize {
        self.adjacent_fast_path_merges
    }

    pub fn aggregate_signature_searches(&self) -> usize {
        self.aggregate_signature_searches
    }

    pub fn expensive_adjacent_pair_analyses(&self) -> usize {
        self.expensive_adjacent_pair_analyses
    }

    pub fn aggregate_segment_count(&self) -> usize {
        self.aggregate.segments.len()
    }
}

fn stitch_long_capture_frames_with_aggregate_signatures(
    frames: &[RgbImage],
    options: LongCaptureStitchOptions,
) -> Result<LongCaptureAggregateResult> {
    if frames.is_empty() {
        return Err(anyhow!("No frames to stitch"));
    }
    let inferred_axis = infer_axis_from_adjacent_frames(frames, options);
    let mut stitcher =
        LongCaptureIncrementalStitcher::new_with_axis(frames[0].clone(), options, inferred_axis);
    for current in frames.iter().skip(1) {
        stitcher.push_frame(current)?;
    }
    Ok(stitcher.finish_result())
}

pub fn stitch_long_capture_frames(
    frames: &[RgbImage],
    options: LongCaptureStitchOptions,
) -> Result<RgbImage> {
    let started_at = std::time::Instant::now();
    let result = stitch_long_capture_frames_with_aggregate_signatures(frames, options)?;
    crate::append_runtime_log_line(&format!(
        "long_capture stitch_complete :: input_frames={} merged_frames={} skipped_frames={} axis={:?} elapsed_ms={} width={} height={}",
        frames.len(),
        result.merged_frames,
        result.skipped_frames,
        result.axis,
        started_at.elapsed().as_millis(),
        result.image.width(),
        result.image.height()
    ));
    if result.skipped_frames > 0 {
        crate::append_runtime_log_line(&format!(
            "long_capture stitch_tolerant_complete :: input_frames={} skipped_frames={}",
            frames.len(),
            result.skipped_frames
        ));
    }
    Ok(result.image)
}

pub fn stitch_long_capture_frames_with_analyses(
    frames: &[RgbImage],
    analyses: &[LongCaptureOverlapAnalysis],
) -> Result<RgbImage> {
    if frames.is_empty() {
        return Err(anyhow!("No frames to stitch"));
    }
    if analyses.len() + 1 != frames.len() {
        return Err(anyhow!(
            "Long-capture analyses must line up with consecutive frame pairs"
        ));
    }
    if analyses.is_empty() {
        return Ok(frames[0].clone());
    }

    let mut stitched = frames[0].clone();
    let first_direction = analyses[0]
        .direction
        .ok_or_else(|| anyhow!("Long-capture direction is missing"))?;
    let stitch_axis = analyses[0]
        .axis
        .unwrap_or_else(|| direction_axis(first_direction));
    let mut previous_origin = 0i64;
    let mut min_origin = 0i64;
    let mut max_extent = match stitch_axis {
        LongCaptureAxis::Vertical => frames[0].height() as i64,
        LongCaptureAxis::Horizontal => frames[0].width() as i64,
    };

    for (index, analysis) in analyses.iter().enumerate() {
        let direction = analysis
            .direction
            .ok_or_else(|| anyhow!("Long-capture direction is missing"))?;
        let axis = analysis.axis.unwrap_or_else(|| direction_axis(direction));
        if axis != stitch_axis || direction_axis(direction) != stitch_axis {
            return Err(anyhow!(
                "Long-capture mixed-axis stitching is not supported"
            ));
        }

        let current = &frames[index + 1];
        let append_px = analysis.append_px as i64;
        if append_px <= 0 {
            continue;
        }

        match direction {
            LongCaptureDirection::Down => {
                if stitched.width() != current.width() {
                    return Err(anyhow!(
                        "Vertical long-capture frames must have the same width"
                    ));
                }
                let current_origin = previous_origin + append_px;
                let segment_start = current_origin + analysis.crop_start_px as i64;
                let segment_end = current_origin + current.height() as i64;
                let extension_start = segment_start.max(max_extent);
                if extension_start < segment_end {
                    let crop_y =
                        (analysis.crop_start_px as i64 + extension_start - segment_start) as u32;
                    let crop_h = (segment_end - extension_start) as u32;
                    let cropped =
                        imageops::crop_imm(current, 0, crop_y, current.width(), crop_h).to_image();
                    let mut next =
                        RgbImage::new(stitched.width(), stitched.height() + cropped.height());
                    imageops::replace(&mut next, &stitched, 0, 0);
                    imageops::replace(&mut next, &cropped, 0, stitched.height() as i64);
                    stitched = next;
                    max_extent = max_extent.max(segment_end);
                }
                previous_origin = current_origin;
            }
            LongCaptureDirection::Up => {
                if stitched.width() != current.width() {
                    return Err(anyhow!(
                        "Vertical long-capture frames must have the same width"
                    ));
                }
                let current_origin = previous_origin - append_px;
                let segment_start = current_origin;
                let segment_end = current_origin + append_px;
                let extension_end = segment_end.min(min_origin);
                if segment_start < extension_end {
                    let crop_h = (extension_end - segment_start) as u32;
                    let cropped =
                        imageops::crop_imm(current, 0, 0, current.width(), crop_h).to_image();
                    let mut next =
                        RgbImage::new(stitched.width(), stitched.height() + cropped.height());
                    imageops::replace(&mut next, &cropped, 0, 0);
                    imageops::replace(&mut next, &stitched, 0, cropped.height() as i64);
                    stitched = next;
                    min_origin = min_origin.min(segment_start);
                }
                previous_origin = current_origin;
            }
            LongCaptureDirection::Right => {
                if stitched.height() != current.height() {
                    return Err(anyhow!(
                        "Horizontal long-capture frames must have the same height"
                    ));
                }
                let current_origin = previous_origin + append_px;
                let segment_start = current_origin + analysis.crop_start_px as i64;
                let segment_end = current_origin + current.width() as i64;
                let extension_start = segment_start.max(max_extent);
                if extension_start < segment_end {
                    let crop_x =
                        (analysis.crop_start_px as i64 + extension_start - segment_start) as u32;
                    let crop_w = (segment_end - extension_start) as u32;
                    let cropped =
                        imageops::crop_imm(current, crop_x, 0, crop_w, current.height()).to_image();
                    let mut next =
                        RgbImage::new(stitched.width() + cropped.width(), stitched.height());
                    imageops::replace(&mut next, &stitched, 0, 0);
                    imageops::replace(&mut next, &cropped, stitched.width() as i64, 0);
                    stitched = next;
                    max_extent = max_extent.max(segment_end);
                }
                previous_origin = current_origin;
            }
            LongCaptureDirection::Left => {
                if stitched.height() != current.height() {
                    return Err(anyhow!(
                        "Horizontal long-capture frames must have the same height"
                    ));
                }
                let current_origin = previous_origin - append_px;
                let segment_start = current_origin;
                let segment_end = current_origin + append_px;
                let extension_end = segment_end.min(min_origin);
                if segment_start < extension_end {
                    let crop_w = (extension_end - segment_start) as u32;
                    let cropped =
                        imageops::crop_imm(current, 0, 0, crop_w, current.height()).to_image();
                    let mut next =
                        RgbImage::new(stitched.width() + cropped.width(), stitched.height());
                    imageops::replace(&mut next, &cropped, 0, 0);
                    imageops::replace(&mut next, &stitched, cropped.width() as i64, 0);
                    stitched = next;
                    min_origin = min_origin.min(segment_start);
                }
                previous_origin = current_origin;
            }
        }
    }
    Ok(stitched)
}
