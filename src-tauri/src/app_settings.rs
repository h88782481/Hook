use serde::{Deserialize, Serialize};
use std::fs;
use std::fs::File;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};

use crate::portable_paths::ensure_portable_app_data_dir;

pub const SETTINGS_FILE_NAME: &str = "app-settings.json";
pub const AUTOSTART_VALUE_NAME: &str = "Hook";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutBinding {
    pub key: String,
    pub modifiers: Vec<String>,
}

impl ShortcutBinding {
    pub fn new(key: &str, modifiers: &[&str]) -> Self {
        Self {
            key: key.to_string(),
            modifiers: modifiers.iter().map(|value| (*value).to_string()).collect(),
        }
    }

    pub fn unbound() -> Self {
        Self {
            key: String::new(),
            modifiers: Vec::new(),
        }
    }

    pub fn is_unbound(&self) -> bool {
        self.key.trim().is_empty()
    }

    pub fn to_shortcut(&self) -> Result<Shortcut, String> {
        if self.is_unbound() {
            return Err("Shortcut is unbound".to_string());
        }
        let modifiers = parse_modifiers(&self.modifiers)?;
        let code = parse_code(&self.key)?;
        Ok(Shortcut::new(Some(modifiers), code))
    }

    pub fn display_label(&self) -> String {
        if self.is_unbound() {
            return "未绑定".to_string();
        }
        let mut parts: Vec<String> = self
            .modifiers
            .iter()
            .map(|modifier| match modifier.to_ascii_lowercase().as_str() {
                "ctrl" | "control" => "Ctrl".to_string(),
                "alt" => "Alt".to_string(),
                "shift" => "Shift".to_string(),
                "meta" | "super" | "win" => "Win".to_string(),
                other => other.to_string(),
            })
            .collect();
        parts.push(display_key(&self.key));
        parts.join("+")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutSettings {
    pub capture: ShortcutBinding,
    pub long_capture: ShortcutBinding,
    pub toggle_toolbar: ShortcutBinding,
    pub open_image: ShortcutBinding,
}

impl Default for ShortcutSettings {
    fn default() -> Self {
        Self {
            capture: ShortcutBinding::new("Digit1", &["Control"]),
            long_capture: ShortcutBinding::new("Digit3", &["Control"]),
            toggle_toolbar: ShortcutBinding::new("KeyE", &["Control"]),
            open_image: ShortcutBinding::new("KeyO", &["Control"]),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub auto_start: bool,
    /// After capture, automatically open the sticker toolbar for the new sticker.
    pub sticker_toolbar_default_visible: bool,
    /// ShareX-style: skip global capture hotkeys while a non-shell window is fullscreen.
    /// Default true so remote/fullscreen sessions do not steal local capture hotkeys.
    #[serde(default = "default_disable_hotkeys_on_fullscreen")]
    pub disable_hotkeys_on_fullscreen: bool,
    pub shortcuts: ShortcutSettings,
}

fn default_disable_hotkeys_on_fullscreen() -> bool {
    true
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            auto_start: false,
            sticker_toolbar_default_visible: false,
            disable_hotkeys_on_fullscreen: true,
            shortcuts: ShortcutSettings::default(),
        }
    }
}

#[derive(Clone)]
pub struct SharedAppSettings {
    inner: Arc<Mutex<AppSettings>>,
}

impl SharedAppSettings {
    pub fn new(settings: AppSettings) -> Self {
        Self {
            inner: Arc::new(Mutex::new(settings)),
        }
    }

    pub fn get(&self) -> AppSettings {
        self.inner
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default()
    }

    pub fn set(&self, settings: AppSettings) {
        if let Ok(mut guard) = self.inner.lock() {
            *guard = settings;
        }
    }
}

fn settings_file_path() -> Result<PathBuf, String> {
    Ok(ensure_portable_app_data_dir()?.join(SETTINGS_FILE_NAME))
}

pub fn load_app_settings_from_disk() -> AppSettings {
    let Ok(path) = settings_file_path() else {
        return AppSettings::default();
    };
    if !path.exists() {
        return AppSettings::default();
    }
    match fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str::<AppSettings>(&content)
            .map(normalize_app_settings)
            .unwrap_or_default(),
        Err(_) => AppSettings::default(),
    }
}

pub fn save_app_settings_to_disk(settings: &AppSettings) -> Result<(), String> {
    let path = settings_file_path()?;
    let normalized = normalize_app_settings(settings.clone());
    let json = serde_json::to_string_pretty(&normalized).map_err(|error| error.to_string())?;
    let mut file = File::create(&path).map_err(|error| error.to_string())?;
    file.write_all(json.as_bytes())
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn normalize_app_settings(mut settings: AppSettings) -> AppSettings {
    normalize_binding(&mut settings.shortcuts.capture);
    normalize_binding(&mut settings.shortcuts.long_capture);
    normalize_binding(&mut settings.shortcuts.toggle_toolbar);
    normalize_binding(&mut settings.shortcuts.open_image);
    settings
}

fn normalize_binding(binding: &mut ShortcutBinding) {
    if binding.key.trim().is_empty() {
        *binding = ShortcutBinding::unbound();
        return;
    }
    // PrtSc is handled by rdev as a bare key; strip accidental modifiers from recording.
    if matches!(
        binding.key.as_str(),
        "PrintScreen" | "PrtSc" | "PrtScn" | "Snapshot"
    ) {
        binding.key = "PrintScreen".to_string();
        binding.modifiers.clear();
    }
}

pub fn parse_modifiers(modifiers: &[String]) -> Result<Modifiers, String> {
    let mut result = Modifiers::empty();
    for modifier in modifiers {
        match modifier.to_ascii_lowercase().as_str() {
            "ctrl" | "control" => result |= Modifiers::CONTROL,
            "alt" => result |= Modifiers::ALT,
            "shift" => result |= Modifiers::SHIFT,
            "meta" | "super" | "win" => result |= Modifiers::SUPER,
            other => return Err(format!("Unknown modifier: {other}")),
        }
    }
    Ok(result)
}

pub fn parse_code(key: &str) -> Result<Code, String> {
    match key {
        "Digit0" | "0" => Ok(Code::Digit0),
        "Digit1" | "1" => Ok(Code::Digit1),
        "Digit2" | "2" => Ok(Code::Digit2),
        "Digit3" | "3" => Ok(Code::Digit3),
        "Digit4" | "4" => Ok(Code::Digit4),
        "Digit5" | "5" => Ok(Code::Digit5),
        "Digit6" | "6" => Ok(Code::Digit6),
        "Digit7" | "7" => Ok(Code::Digit7),
        "Digit8" | "8" => Ok(Code::Digit8),
        "Digit9" | "9" => Ok(Code::Digit9),
        "KeyA" | "a" | "A" => Ok(Code::KeyA),
        "KeyB" | "b" | "B" => Ok(Code::KeyB),
        "KeyC" | "c" | "C" => Ok(Code::KeyC),
        "KeyD" | "d" | "D" => Ok(Code::KeyD),
        "KeyE" | "e" | "E" => Ok(Code::KeyE),
        "KeyF" | "f" | "F" => Ok(Code::KeyF),
        "KeyG" | "g" | "G" => Ok(Code::KeyG),
        "KeyH" | "h" | "H" => Ok(Code::KeyH),
        "KeyI" | "i" | "I" => Ok(Code::KeyI),
        "KeyJ" | "j" | "J" => Ok(Code::KeyJ),
        "KeyK" | "k" | "K" => Ok(Code::KeyK),
        "KeyL" | "l" | "L" => Ok(Code::KeyL),
        "KeyM" | "m" | "M" => Ok(Code::KeyM),
        "KeyN" | "n" | "N" => Ok(Code::KeyN),
        "KeyO" | "o" | "O" => Ok(Code::KeyO),
        "KeyP" | "p" | "P" => Ok(Code::KeyP),
        "KeyQ" | "q" | "Q" => Ok(Code::KeyQ),
        "KeyR" | "r" | "R" => Ok(Code::KeyR),
        "KeyS" | "s" | "S" => Ok(Code::KeyS),
        "KeyT" | "t" | "T" => Ok(Code::KeyT),
        "KeyU" | "u" | "U" => Ok(Code::KeyU),
        "KeyV" | "v" | "V" => Ok(Code::KeyV),
        "KeyW" | "w" | "W" => Ok(Code::KeyW),
        "KeyX" | "x" | "X" => Ok(Code::KeyX),
        "KeyY" | "y" | "Y" => Ok(Code::KeyY),
        "KeyZ" | "z" | "Z" => Ok(Code::KeyZ),
        "F1" => Ok(Code::F1),
        "F2" => Ok(Code::F2),
        "F3" => Ok(Code::F3),
        "F4" => Ok(Code::F4),
        "F5" => Ok(Code::F5),
        "F6" => Ok(Code::F6),
        "F7" => Ok(Code::F7),
        "F8" => Ok(Code::F8),
        "F9" => Ok(Code::F9),
        "F10" => Ok(Code::F10),
        "F11" => Ok(Code::F11),
        "F12" => Ok(Code::F12),
        "Space" | " " => Ok(Code::Space),
        "Tab" => Ok(Code::Tab),
        "Enter" | "Return" => Ok(Code::Enter),
        "Escape" | "Esc" => Ok(Code::Escape),
        "Delete" | "Del" => Ok(Code::Delete),
        "Backspace" => Ok(Code::Backspace),
        "Insert" => Ok(Code::Insert),
        "Home" => Ok(Code::Home),
        "End" => Ok(Code::End),
        "PageUp" => Ok(Code::PageUp),
        "PageDown" => Ok(Code::PageDown),
        "ArrowUp" | "Up" => Ok(Code::ArrowUp),
        "ArrowDown" | "Down" => Ok(Code::ArrowDown),
        "ArrowLeft" | "Left" => Ok(Code::ArrowLeft),
        "ArrowRight" | "Right" => Ok(Code::ArrowRight),
        "PrintScreen" | "PrtSc" | "PrtScn" | "Snapshot" => Ok(Code::PrintScreen),
        other => Err(format!("Unsupported shortcut key: {other}")),
    }
}

fn display_key(key: &str) -> String {
    match key {
        "Digit0" => "0".into(),
        "Digit1" => "1".into(),
        "Digit2" => "2".into(),
        "Digit3" => "3".into(),
        "Digit4" => "4".into(),
        "Digit5" => "5".into(),
        "Digit6" => "6".into(),
        "Digit7" => "7".into(),
        "Digit8" => "8".into(),
        "Digit9" => "9".into(),
        "PrintScreen" | "PrtSc" | "PrtScn" | "Snapshot" => "PrtSc".into(),
        k if k.starts_with("Key") && k.len() == 4 => k[3..].to_string(),
        other => other.to_string(),
    }
}

pub fn shortcut_action_for(shortcut: &Shortcut, settings: &AppSettings) -> Option<&'static str> {
    let bindings = [
        ("capture", &settings.shortcuts.capture),
        ("long_capture", &settings.shortcuts.long_capture),
        ("toggle_toolbar", &settings.shortcuts.toggle_toolbar),
        ("open_image", &settings.shortcuts.open_image),
    ];
    for (action, binding) in bindings {
        let Ok(modifiers) = parse_modifiers(&binding.modifiers) else {
            continue;
        };
        let Ok(code) = parse_code(&binding.key) else {
            continue;
        };
        if shortcut.matches(modifiers, code) {
            return Some(action);
        }
    }
    None
}

#[cfg(target_os = "windows")]
pub fn set_auto_start_enabled(enabled: bool) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    let exe_quoted = format!("\"{}\"", exe.to_string_lossy());
    let run_key = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";

    if enabled {
        let status = std::process::Command::new("reg")
            .args([
                "add",
                run_key,
                "/v",
                AUTOSTART_VALUE_NAME,
                "/t",
                "REG_SZ",
                "/d",
                &exe_quoted,
                "/f",
            ])
            .status()
            .map_err(|error| format!("Failed to enable autostart: {error}"))?;
        if !status.success() {
            return Err("Failed to enable autostart via registry".to_string());
        }
    } else {
        let _ = std::process::Command::new("reg")
            .args(["delete", run_key, "/v", AUTOSTART_VALUE_NAME, "/f"])
            .status();
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn set_auto_start_enabled(_enabled: bool) -> Result<(), String> {
    Err("Autostart is only supported on Windows".to_string())
}

#[cfg(target_os = "windows")]
pub fn is_auto_start_enabled() -> bool {
    let output = std::process::Command::new("reg")
        .args([
            "query",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
            "/v",
            AUTOSTART_VALUE_NAME,
        ])
        .output();
    matches!(output, Ok(result) if result.status.success())
}

#[cfg(not(target_os = "windows"))]
pub fn is_auto_start_enabled() -> bool {
    false
}

pub fn binding_is_print_screen(binding: &ShortcutBinding) -> bool {
    // Canonical key after normalize_binding; modifiers are always cleared for PrtSc.
    binding.key == "PrintScreen" && binding.modifiers.is_empty()
}
