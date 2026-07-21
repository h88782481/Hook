use std::sync::{Arc, Mutex};

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub name: String, // Debug Label
}

impl Rect {
    pub fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x as f64
            && x <= (self.x + self.width) as f64
            && y >= self.y as f64
            && y <= (self.y + self.height) as f64
    }
}

// Thread-safe container for the list of interactive areas
#[derive(Clone)]
pub struct SharedHitMap {
    pub rectangles: Arc<Mutex<Vec<Rect>>>,
    // Flag to disable hit-testing (e.g. during Selection Mode)
    // If active = false, we effectively do nothing (or enforce a specific state)
    // Actually, for Selection Mode, we usually want full interactivity.
    // So if active = false, maybe we default to set_ignore_cursor_events(false)?
    pub active: Arc<Mutex<bool>>,
}

impl SharedHitMap {
    pub fn new() -> Self {
        Self {
            rectangles: Arc::new(Mutex::new(Vec::new())),
            active: Arc::new(Mutex::new(false)), // Default inactive
        }
    }
}
