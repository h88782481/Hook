//! ShareX-style consecutive-frame line stitcher.
//! More reliable than feature-point matching for continuous manual scrolling:
//! match the previous full frame against the new frame, append only the new strip.

use crate::scroll_capture::ScrollDirection;
use image::{imageops, RgbaImage};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineStitchOutcome {
    Seeded,
    Merged { new_px: u32 },
    Duplicate,
    NoMatch,
}

pub struct LineScrollStitcher {
    direction: ScrollDirection,
    canvas: Option<RgbaImage>,
    last_frame: Option<RgbaImage>,
    frame_count: usize,
    min_overlap_px: u32,
    min_new_px: u32,
    max_scan_px: u32,
    max_mean_abs_diff: f32,
}

impl LineScrollStitcher {
    pub fn new(direction: ScrollDirection, frame_side: u32) -> Self {
        let side = frame_side.max(32);
        Self {
            direction,
            canvas: None,
            last_frame: None,
            frame_count: 0,
            // Keep overlap modest so faster scrolling still finds a seam.
            min_overlap_px: ((side as f32) * 0.12).round().clamp(16.0, 120.0) as u32,
            min_new_px: 2,
            max_scan_px: side.saturating_sub(1).max(32),
            max_mean_abs_diff: 26.0,
        }
    }

    pub fn frame_count(&self) -> usize {
        self.frame_count
    }

    pub fn direction(&self) -> ScrollDirection {
        self.direction
    }

    pub fn push_frame(&mut self, frame: RgbaImage) -> LineStitchOutcome {
        let width = frame.width();
        let height = frame.height();
        if width < 8 || height < 8 {
            return LineStitchOutcome::NoMatch;
        }

        if self.canvas.is_none() || self.last_frame.is_none() {
            self.canvas = Some(frame.clone());
            self.last_frame = Some(frame);
            self.frame_count = 1;
            return LineStitchOutcome::Seeded;
        }

        let last = self.last_frame.as_ref().unwrap();
        if last.width() != width || last.height() != height {
            return LineStitchOutcome::NoMatch;
        }

        match self.direction {
            ScrollDirection::Vertical => self.push_vertical(frame),
            ScrollDirection::Horizontal => self.push_horizontal(frame),
        }
    }

    pub fn export_rgba(&self) -> Option<RgbaImage> {
        self.canvas.clone()
    }

    fn push_vertical(&mut self, frame: RgbaImage) -> LineStitchOutcome {
        let last = self.last_frame.as_ref().unwrap();
        let height = frame.height();
        let width = frame.width();
        let max_offset = self
            .max_scan_px
            .min(height.saturating_sub(self.min_overlap_px))
            .max(self.min_new_px);

        let dup_score = vertical_band_mad(last, 0, &frame, 0, height, width);
        if dup_score <= self.max_mean_abs_diff * 0.5 {
            self.last_frame = Some(frame);
            return LineStitchOutcome::Duplicate;
        }

        let mut best_down = 0u32;
        let mut best_down_score = f32::MAX;
        for offset in self.min_new_px..=max_offset {
            let overlap = height - offset;
            if overlap < self.min_overlap_px {
                break;
            }
            let score = vertical_band_mad(last, offset, &frame, 0, overlap, width);
            if score < best_down_score {
                best_down_score = score;
                best_down = offset;
                if score < 2.0 {
                    break;
                }
            }
        }

        let mut best_up = 0u32;
        let mut best_up_score = f32::MAX;
        for offset in self.min_new_px..=max_offset {
            let overlap = height - offset;
            if overlap < self.min_overlap_px {
                break;
            }
            let score = vertical_band_mad(last, 0, &frame, offset, overlap, width);
            if score < best_up_score {
                best_up_score = score;
                best_up = offset;
                if score < 2.0 {
                    break;
                }
            }
        }

        let use_down = best_down_score <= best_up_score;
        let (best_offset, best_score) = if use_down {
            (best_down, best_down_score)
        } else {
            (best_up, best_up_score)
        };

        if best_offset < self.min_new_px || best_score > self.max_mean_abs_diff {
            // Advance anchor so a later frame can recover instead of comparing to stale content forever.
            self.last_frame = Some(frame);
            return LineStitchOutcome::NoMatch;
        }

        let ok = if use_down {
            let strip =
                imageops::crop_imm(&frame, 0, height - best_offset, width, best_offset).to_image();
            self.append_vertical_strip(&strip, false)
        } else {
            let strip = imageops::crop_imm(&frame, 0, 0, width, best_offset).to_image();
            self.append_vertical_strip(&strip, true)
        };
        if !ok {
            return LineStitchOutcome::NoMatch;
        }
        self.last_frame = Some(frame);
        self.frame_count = self.frame_count.saturating_add(1);
        LineStitchOutcome::Merged { new_px: best_offset }
    }

    fn push_horizontal(&mut self, frame: RgbaImage) -> LineStitchOutcome {
        let last = self.last_frame.as_ref().unwrap();
        let height = frame.height();
        let width = frame.width();
        let max_offset = self
            .max_scan_px
            .min(width.saturating_sub(self.min_overlap_px))
            .max(self.min_new_px);

        let dup_score = horizontal_band_mad(last, 0, &frame, 0, width, height);
        if dup_score <= self.max_mean_abs_diff * 0.5 {
            self.last_frame = Some(frame);
            return LineStitchOutcome::Duplicate;
        }

        let mut best_right = 0u32;
        let mut best_right_score = f32::MAX;
        for offset in self.min_new_px..=max_offset {
            let overlap = width - offset;
            if overlap < self.min_overlap_px {
                break;
            }
            let score = horizontal_band_mad(last, offset, &frame, 0, overlap, height);
            if score < best_right_score {
                best_right_score = score;
                best_right = offset;
                if score < 2.0 {
                    break;
                }
            }
        }

        let mut best_left = 0u32;
        let mut best_left_score = f32::MAX;
        for offset in self.min_new_px..=max_offset {
            let overlap = width - offset;
            if overlap < self.min_overlap_px {
                break;
            }
            let score = horizontal_band_mad(last, 0, &frame, offset, overlap, height);
            if score < best_left_score {
                best_left_score = score;
                best_left = offset;
                if score < 2.0 {
                    break;
                }
            }
        }

        let use_right = best_right_score <= best_left_score;
        let (best_offset, best_score) = if use_right {
            (best_right, best_right_score)
        } else {
            (best_left, best_left_score)
        };

        if best_offset < self.min_new_px || best_score > self.max_mean_abs_diff {
            // Advance anchor so a later frame can recover instead of comparing to stale content forever.
            self.last_frame = Some(frame);
            return LineStitchOutcome::NoMatch;
        }

        let ok = if use_right {
            let strip =
                imageops::crop_imm(&frame, width - best_offset, 0, best_offset, height).to_image();
            self.append_horizontal_strip(&strip, false)
        } else {
            let strip = imageops::crop_imm(&frame, 0, 0, best_offset, height).to_image();
            self.append_horizontal_strip(&strip, true)
        };
        if !ok {
            return LineStitchOutcome::NoMatch;
        }
        self.last_frame = Some(frame);
        self.frame_count = self.frame_count.saturating_add(1);
        LineStitchOutcome::Merged { new_px: best_offset }
    }

    fn append_vertical_strip(&mut self, strip: &RgbaImage, prepend: bool) -> bool {
        let Some(canvas) = self.canvas.as_ref() else {
            return false;
        };
        if canvas.width() != strip.width() {
            return false;
        }
        let new_h = canvas.height().saturating_add(strip.height());
        let mut next = RgbaImage::new(canvas.width(), new_h);
        if prepend {
            imageops::replace(&mut next, strip, 0, 0);
            imageops::replace(&mut next, canvas, 0, strip.height() as i64);
        } else {
            imageops::replace(&mut next, canvas, 0, 0);
            imageops::replace(&mut next, strip, 0, canvas.height() as i64);
        }
        self.canvas = Some(next);
        true
    }

    fn append_horizontal_strip(&mut self, strip: &RgbaImage, prepend: bool) -> bool {
        let Some(canvas) = self.canvas.as_ref() else {
            return false;
        };
        if canvas.height() != strip.height() {
            return false;
        }
        let new_w = canvas.width().saturating_add(strip.width());
        let mut next = RgbaImage::new(new_w, canvas.height());
        if prepend {
            imageops::replace(&mut next, strip, 0, 0);
            imageops::replace(&mut next, canvas, strip.width() as i64, 0);
        } else {
            imageops::replace(&mut next, canvas, 0, 0);
            imageops::replace(&mut next, strip, canvas.width() as i64, 0);
        }
        self.canvas = Some(next);
        true
    }
}

fn vertical_band_mad(
    a: &RgbaImage,
    a_y0: u32,
    b: &RgbaImage,
    b_y0: u32,
    rows: u32,
    width: u32,
) -> f32 {
    if rows == 0 || width == 0 {
        return f32::MAX;
    }
    let x_step = ((width / 48).max(1)).min(8);
    let y_step = ((rows / 64).max(1)).min(4);
    let mut sum = 0u64;
    let mut count = 0u64;
    let mut y = 0u32;
    while y < rows {
        let ay = a_y0 + y;
        let by = b_y0 + y;
        let mut x = 0u32;
        while x < width {
            let pa = a.get_pixel(x, ay).0;
            let pb = b.get_pixel(x, by).0;
            sum += (pa[0] as i16 - pb[0] as i16).unsigned_abs() as u64;
            sum += (pa[1] as i16 - pb[1] as i16).unsigned_abs() as u64;
            sum += (pa[2] as i16 - pb[2] as i16).unsigned_abs() as u64;
            count += 3;
            let next_x = x.saturating_add(x_step);
            if next_x == x {
                break;
            }
            x = next_x;
        }
        let next_y = y.saturating_add(y_step);
        if next_y == y {
            break;
        }
        y = next_y;
    }
    if count == 0 {
        f32::MAX
    } else {
        sum as f32 / count as f32
    }
}

fn horizontal_band_mad(
    a: &RgbaImage,
    a_x0: u32,
    b: &RgbaImage,
    b_x0: u32,
    cols: u32,
    height: u32,
) -> f32 {
    if cols == 0 || height == 0 {
        return f32::MAX;
    }
    let x_step = ((cols / 64).max(1)).min(4);
    let y_step = ((height / 48).max(1)).min(8);
    let mut sum = 0u64;
    let mut count = 0u64;
    let mut x = 0u32;
    while x < cols {
        let ax = a_x0 + x;
        let bx = b_x0 + x;
        let mut y = 0u32;
        while y < height {
            let pa = a.get_pixel(ax, y).0;
            let pb = b.get_pixel(bx, y).0;
            sum += (pa[0] as i16 - pb[0] as i16).unsigned_abs() as u64;
            sum += (pa[1] as i16 - pb[1] as i16).unsigned_abs() as u64;
            sum += (pa[2] as i16 - pb[2] as i16).unsigned_abs() as u64;
            count += 3;
            let next_y = y.saturating_add(y_step);
            if next_y == y {
                break;
            }
            y = next_y;
        }
        let next_x = x.saturating_add(x_step);
        if next_x == x {
            break;
        }
        x = next_x;
    }
    if count == 0 {
        f32::MAX
    } else {
        sum as f32 / count as f32
    }
}
