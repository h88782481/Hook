#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct CaptureWindowMetrics {
    pub physical_origin_x: f64,
    pub physical_origin_y: f64,
    pub scale_factor: f64,
    pub logical_width: f64,
    pub logical_height: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct CapturePoint {
    pub x: f64,
    pub y: f64,
}

pub(crate) fn normalize_global_physical_to_local_logical(
    global_x: f64,
    global_y: f64,
    metrics: CaptureWindowMetrics,
) -> CapturePoint {
    let scale = if metrics.scale_factor.is_finite() && metrics.scale_factor > 0.0 {
        metrics.scale_factor
    } else {
        1.0
    };

    let x = (global_x - metrics.physical_origin_x) / scale;
    let y = (global_y - metrics.physical_origin_y) / scale;

    CapturePoint {
        x: x.clamp(0.0, metrics.logical_width),
        y: y.clamp(0.0, metrics.logical_height),
    }
}
