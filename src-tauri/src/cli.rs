use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BootProfile {
    pub(crate) startup_mode: String,
    pub(crate) initial_ui_mode: String,
    pub(crate) auto_start_capture: bool,
}

fn read_env_bool(key: &str, default: bool) -> bool {
    std::env::var(key)
        .ok()
        .map(|value| {
            let normalized = value.trim().to_ascii_lowercase();
            matches!(normalized.as_str(), "1" | "true" | "yes" | "on")
        })
        .unwrap_or(default)
}

pub(crate) fn boot_profile_from_env() -> BootProfile {
    let startup_mode = match std::env::var("HOOK_STARTUP_MODE") {
        Ok(value) if value.trim().eq_ignore_ascii_case("visible") => "visible".to_string(),
        _ => "silent".to_string(),
    };

    let initial_ui_mode = match std::env::var("HOOK_INITIAL_UI_MODE") {
        Ok(value) if value.trim().eq_ignore_ascii_case("overlay") => "overlay".to_string(),
        Ok(value) if value.trim().eq_ignore_ascii_case("canvas") => "canvas".to_string(),
        Ok(value) if value.trim().eq_ignore_ascii_case("tray") => "tray".to_string(),
        _ if startup_mode == "visible" => "overlay".to_string(),
        _ => "overlay".to_string(),
    };


    BootProfile {
        startup_mode,
        initial_ui_mode,
        auto_start_capture: read_env_bool("HOOK_AUTOSTART_CAPTURE", false),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelfCheckCapabilities {
    desktop: bool,
    capture: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelfCheckReport {
    app: &'static str,
    binary: &'static str,
    version: &'static str,
    status: &'static str,
    capabilities: SelfCheckCapabilities,
}

pub fn self_check_report() -> SelfCheckReport {
    SelfCheckReport {
        app: "Hook",
        binary: "hook.exe",
        version: env!("CARGO_PKG_VERSION"),
        status: "ok",
        capabilities: SelfCheckCapabilities {
            desktop: true,
            capture: true,
        },
    }
}

pub fn self_check_report_json() -> Result<String, serde_json::Error> {
    serde_json::to_string_pretty(&self_check_report())
}


pub fn hook_help_text() -> &'static str {
    concat!(
        "Usage: hook [OPTIONS]\n",
        "\n",
        "Options:\n",
        "  --self-check              Print a no-GUI JSON self-check report and exit\n",
        "  -h, --help                Print help\n",
        "  -V, --version             Print version\n",
        "\n",
        "Environment:\n",
        "  HOOK_SELF_CHECK_OUTPUT          Optional file path for --self-check JSON output\n",
        "  HOOK_CLI_OUTPUT                 Optional file path for --help/--version text output\n",
    )
}

pub fn hook_version_text() -> String {
    format!("hook {}", env!("CARGO_PKG_VERSION"))
}

pub fn write_optional_cli_output(env_name: &str, text: &str) -> std::io::Result<()> {
    if let Ok(path) = std::env::var(env_name) {
        if !path.trim().is_empty() {
            std::fs::write(path, text)?;
        }
    }
    Ok(())
}


#[tauri::command]
pub fn get_boot_profile() -> BootProfile {
    boot_profile_from_env()
}

