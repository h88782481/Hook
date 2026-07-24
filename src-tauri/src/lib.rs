mod app_settings;
mod capture;
mod capture_coords;
mod cli;
mod dialogs;
mod fonts;
mod long_capture;
mod long_capture_session;
mod mouse_monitor;
mod native_capture;
mod overlay;
mod persistence;
mod portable_paths;
mod precise_selection;
mod remote_session;
mod runtime;
mod screenshot;
mod single_instance;
mod sticker_io;

pub use cli::{
    hook_help_text, hook_version_text, self_check_report, self_check_report_json,
    write_optional_cli_output,
};
pub(crate) use runtime::{
    append_runtime_log_line, encode_rgb_image_as_file_capture_response,
};

use crate::cli::boot_profile_from_env;
use crate::long_capture_session::SharedLongCaptureSessions;
use crate::mouse_monitor::SharedHitMap;
use crate::overlay::{
    enter_capture_mode, enter_long_capture_mode, force_restore_system_cursors, hide_to_tray_impl,
    install_capture_mouse_hook_thread, install_overlay_keyboard_hook_thread,
    install_rdev_input_listener, show_canvas_window_impl, show_overlay_host_impl,
    trigger_toggle_sticker_toolbar, SharedCaptureInputState,
};
use crate::runtime::{cleanup_clipboard_cache, effective_app_data_dir};
use crate::portable_paths::portable_clipboard_cache_dir;
use single_instance::{single_instance_name, try_acquire_single_instance};

use std::sync::Arc;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};


fn should_accept_tauri_shortcut_trigger(
    last_trigger: &Arc<std::sync::Mutex<std::time::Instant>>,
    duplicate_log_event: &str,
) -> bool {
    let mut guard = match last_trigger.lock() {
        Ok(guard) => guard,
        Err(_) => return false,
    };

    if guard.elapsed() <= std::time::Duration::from_millis(500) {
        append_runtime_log_line(duplicate_log_event);
        return false;
    }

    *guard = std::time::Instant::now();
    true
}

fn allow_portable_asset_scopes(app: &tauri::AppHandle) {
    if let Ok(data_dir) = effective_app_data_dir(app) {
        if let Err(error) = app.asset_protocol_scope().allow_directory(&data_dir, true) {
            append_runtime_log_line(&format!(
                "asset_scope_allow_data_failed :: {}",
                error
            ));
        }
    }
    let screenshots_dir = portable_clipboard_cache_dir();
    if let Err(error) = app
        .asset_protocol_scope()
        .allow_directory(&screenshots_dir, true)
    {
        append_runtime_log_line(&format!(
            "asset_scope_allow_screenshots_failed :: {}",
            error
        ));
    }
}

fn build_tray_menu(
    app: &tauri::AppHandle,
    settings: &app_settings::AppSettings,
) -> tauri::Result<Menu<tauri::Wry>> {
    let capture_label = format!("截图 ({})", settings.shortcuts.capture.display_label());
    let long_capture_label = format!(
        "长截图 ({})",
        settings.shortcuts.long_capture.display_label()
    );
    let open_image_label = format!(
        "编辑已有图片… ({})",
        settings.shortcuts.open_image.display_label()
    );

    let capture_item = MenuItem::with_id(app, "capture", capture_label, true, None::<&str>)?;
    let long_capture_item =
        MenuItem::with_id(app, "long_capture", long_capture_label, true, None::<&str>)?;
    let open_image_item =
        MenuItem::with_id(app, "open_image", open_image_label, true, None::<&str>)?;
    let settings_item = MenuItem::with_id(app, "settings", "设置…", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    Menu::with_items(
        app,
        &[
            &capture_item,
            &long_capture_item,
            &open_image_item,
            &settings_item,
            &quit_item,
        ],
    )
}

fn open_settings_window(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }

    WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("index.html".into()))
        .title("Hook 设置")
        .inner_size(560.0, 720.0)
        .min_inner_size(480.0, 560.0)
        .resizable(true)
        .decorations(true)
        .transparent(false)
        .always_on_top(false)
        .center()
        .build()
        .map_err(|error| format!("Failed to open settings window: {error}"))?;
    Ok(())
}

fn register_configured_global_shortcuts(
    app: &tauri::AppHandle,
    settings: &app_settings::AppSettings,
) {
    let _ = app.global_shortcut().unregister_all();

    let bindings = [
        ("capture", &settings.shortcuts.capture),
        ("long_capture", &settings.shortcuts.long_capture),
        ("toggle_toolbar", &settings.shortcuts.toggle_toolbar),
        ("open_image", &settings.shortcuts.open_image),
    ];

    for (name, binding) in bindings {
        if binding.is_unbound() {
            append_runtime_log_line(&format!("register_shortcut_skipped_unbound :: name={}", name));
            continue;
        }
        // PrintScreen is unreliable via RegisterHotKey on Windows (often "succeeds"
        // but never delivers). Handled by rdev instead.
        if app_settings::binding_is_print_screen(binding) {
            append_runtime_log_line(&format!(
                "register_shortcut_skipped_printscreen_use_rdev :: name={}",
                name
            ));
            continue;
        }
        match binding.to_shortcut() {
            Ok(shortcut) => {
                if let Err(error) = app.global_shortcut().register(shortcut) {
                    append_runtime_log_line(&format!(
                        "register_shortcut_failed :: name={} error={}",
                        name, error
                    ));
                } else {
                    append_runtime_log_line(&format!("register_shortcut_success :: name={}", name));
                }
            }
            Err(error) => {
                append_runtime_log_line(&format!(
                    "register_shortcut_invalid :: name={} error={}",
                    name, error
                ));
            }
        }
    }
}

fn refresh_tray_menu(app: &tauri::AppHandle, settings: &app_settings::AppSettings) {
    match build_tray_menu(app, settings) {
        Ok(menu) => {
            if let Some(tray) = app.try_state::<tauri::tray::TrayIcon>() {
                if let Err(error) = tray.set_menu(Some(menu)) {
                    append_runtime_log_line(&format!("tray_set_menu_failed :: {}", error));
                }
            }
        }
        Err(error) => {
            append_runtime_log_line(&format!("tray_rebuild_failed :: {}", error));
        }
    }
}

#[tauri::command]
fn load_app_settings(app: tauri::AppHandle) -> Result<app_settings::AppSettings, String> {
    let mut settings = if let Some(shared) = app.try_state::<app_settings::SharedAppSettings>() {
        shared.get()
    } else {
        app_settings::load_app_settings_from_disk()
    };
    settings.auto_start = app_settings::is_auto_start_enabled();
    Ok(settings)
}

#[tauri::command]
fn save_app_settings(
    app: tauri::AppHandle,
    settings: app_settings::AppSettings,
) -> Result<app_settings::AppSettings, String> {
    app_settings::save_app_settings_to_disk(&settings)?;
    app_settings::set_auto_start_enabled(settings.auto_start)?;

    if let Some(shared) = app.try_state::<app_settings::SharedAppSettings>() {
        shared.set(settings.clone());
    }

    register_configured_global_shortcuts(&app, &settings);

    refresh_tray_menu(&app, &settings);

    let mut persisted = settings.clone();
    persisted.auto_start = app_settings::is_auto_start_enabled();
    let _ = app.emit("app-settings-updated", &persisted);
    Ok(persisted)
}

#[cfg(target_os = "windows")]
fn configure_webview2_video_safe_composition() {
    // Disabling GPU makes the transparent overlay unusably laggy on physical PCs
    // (multi-monitor / virtual-desktop especially). Keep it opt-in for the rare
    // machines that still need software composition workarounds.
    const ENV_NAME: &str = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS";
    const ENABLE_FLAG: &str = "HOOK_WEBVIEW_DISABLE_GPU";
    let enabled = std::env::var(ENABLE_FLAG)
        .ok()
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false);
    if !enabled {
        append_runtime_log_line("webview2_gpu_disable_skipped");
        return;
    }

    const VIDEO_SAFE_ARGS: &[&str] = &[
        "--disable-gpu",
        "--disable-gpu-compositing",
        "--disable-gpu-rasterization",
        "--disable-zero-copy",
        "--disable-features=UseSkiaRenderer,CanvasOopRasterization",
    ];

    let existing_args = std::env::var(ENV_NAME).unwrap_or_default();
    let mut combined_args = existing_args.clone();
    for arg in VIDEO_SAFE_ARGS {
        if existing_args.contains(arg) || combined_args.contains(arg) {
            continue;
        }
        if !combined_args.trim().is_empty() {
            combined_args.push(' ');
        }
        combined_args.push_str(arg);
    }

    std::env::set_var(ENV_NAME, combined_args);
    append_runtime_log_line("webview2_video_safe_composition_args_applied");
}

#[cfg(not(target_os = "windows"))]
fn configure_webview2_video_safe_composition() {}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    configure_webview2_video_safe_composition();

    let shared_app_settings =
        app_settings::SharedAppSettings::new(app_settings::load_app_settings_from_disk());
    let tauri_capture_last_trigger = Arc::new(std::sync::Mutex::new(
        std::time::Instant::now() - std::time::Duration::from_secs(2),
    ));
    let tauri_long_capture_last_trigger = Arc::new(std::sync::Mutex::new(
        std::time::Instant::now() - std::time::Duration::from_secs(2),
    ));

    tauri::Builder::default()
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler({
                    let shared_app_settings = shared_app_settings.clone();
                    let tauri_capture_last_trigger = tauri_capture_last_trigger.clone();
                    let tauri_long_capture_last_trigger = tauri_long_capture_last_trigger.clone();
                    move |app, shortcut, event| {
                        if event.state != ShortcutState::Pressed {
                            return;
                        }
                        let settings = shared_app_settings.get();
                        let Some(action) = app_settings::shortcut_action_for(&shortcut, &settings)
                        else {
                            return;
                        };
                        match action {
                            "capture" => {
                                if remote_session::should_ignore_global_capture_hotkey(&settings) {
                                    return;
                                }
                                if !should_accept_tauri_shortcut_trigger(
                                    &tauri_capture_last_trigger,
                                    "tauri_capture_duplicate_ignored",
                                ) {
                                    return;
                                }
                                if let Some(window) = app.get_webview_window("main") {
                                    enter_capture_mode(&window);
                                }
                            }
                            "long_capture" => {
                                if remote_session::should_ignore_global_capture_hotkey(&settings) {
                                    return;
                                }
                                if !should_accept_tauri_shortcut_trigger(
                                    &tauri_long_capture_last_trigger,
                                    "tauri_long_capture_duplicate_ignored",
                                ) {
                                    return;
                                }
                                if let Some(window) = app.get_webview_window("main") {
                                    enter_long_capture_mode(&window);
                                }
                            }
                            "toggle_toolbar" => {
                                if let Some(window) = app.get_webview_window("main") {
                                    trigger_toggle_sticker_toolbar(&window);
                                }
                            }
                            "open_image" => {
                                if let Some(window) = app.get_webview_window("main") {
                                    show_overlay_host_impl(&window, false);
                                    let _ = window.emit("trigger-open-image", ());
                                }
                            }
                            _ => {}
                        }
                    }
                })
                .build(),
        )
        .manage(shared_app_settings.clone())
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "settings" {
                    return;
                }
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            capture::capture_region,
            overlay::update_pin_rects,
            overlay::set_mouse_monitor_active,
            sticker_io::save_sticker_image_as,
            sticker_io::save_sticker_drag_export,
            sticker_io::save_sticker_drag_export_from_path,
            overlay::get_cursor_position,
            sticker_io::copy_sticker_image_to_smart_clipboard,
            overlay::set_capture_input_active,
            persistence::save_session,
            persistence::load_session,
            persistence::save_history,
            persistence::load_history,
            persistence::save_tool_settings,
            persistence::load_tool_settings,
            load_app_settings,
            save_app_settings,
            fonts::get_installed_fonts,
            cli::get_boot_profile,
            overlay::show_canvas_window,
            overlay::show_overlay_host,
            overlay::set_overlay_click_through,
            overlay::set_native_drag_preflight_active,
            overlay::set_overlay_keyboard_capture_active,
            overlay::focus_overlay_window,
            overlay::set_overlay_capture_exclusion,
            overlay::hide_to_tray,
            overlay::trigger_capture_mode,
            runtime::append_runtime_log,
            precise_selection::get_precise_selection,
            long_capture_session::start_long_capture_session,
            long_capture_session::sample_long_capture_session,
            long_capture_session::finish_long_capture_session,
            long_capture_session::cancel_long_capture_session,
            native_capture::set_long_capture_ui_active,
            sticker_io::read_image_from_path,
            dialogs::open_image_for_edit,
            dialogs::read_clipboard_image
        ])
        .setup({
            let shared_app_settings = shared_app_settings.clone();
            move |app| {
                let single_instance_guard =
                    match try_acquire_single_instance(&single_instance_name()) {
                        Ok(Some(guard)) => guard,
                        Ok(None) => {
                            append_runtime_log_line("single_instance_already_running");
                            std::process::exit(0);
                        }
                        Err(error) => {
                            append_runtime_log_line(&format!(
                                "single_instance_acquire_failed :: {}",
                                error
                            ));
                            return Err(error.into());
                        }
                    };
                // Intentionally leak the guard so the OS mutex stays held for the
                // entire process lifetime; it is released when the process exits.
                std::mem::forget(single_instance_guard);

                allow_portable_asset_scopes(app.handle());
                force_restore_system_cursors();

                // Initialize Shared State
                let hit_map = SharedHitMap::new();
                app.manage(hit_map.clone());
                let capture_input_state = SharedCaptureInputState::new();
                app.manage(capture_input_state.clone());
                let long_capture_sessions = SharedLongCaptureSessions::new();
                app.manage(long_capture_sessions.clone());

                if let Err(error) = cleanup_clipboard_cache() {
                    append_runtime_log_line(&format!(
                        "clipboard_cache_cleanup_failed :: {}",
                        error
                    ));
                }

                #[cfg(desktop)]
                {
                    let settings = shared_app_settings.get();
                    register_configured_global_shortcuts(app.handle(), &settings);

                    let tray_menu = build_tray_menu(app.handle(), &settings)?;

                    let mut tray_builder = TrayIconBuilder::with_id("hook")
                        .menu(&tray_menu)
                        .tooltip("Hook")
                        .show_menu_on_left_click(true)
                        .on_menu_event(|app, event| match event.id().as_ref() {
                            "capture" => {
                                if let Some(window) = app.get_webview_window("main") {
                                    enter_capture_mode(&window);
                                }
                            }
                            "long_capture" => {
                                if let Some(window) = app.get_webview_window("main") {
                                    enter_long_capture_mode(&window);
                                }
                            }
                            "open_image" => {
                                if let Some(window) = app.get_webview_window("main") {
                                    show_overlay_host_impl(&window, false);
                                    if let Err(e) = window.emit("trigger-open-image", ()) {
                                        append_runtime_log_line(&format!(
                                            "tray_open_image emit_failed :: {}",
                                            e
                                        ));
                                    }
                                }
                            }
                            "settings" => {
                                if let Err(error) = open_settings_window(app) {
                                    append_runtime_log_line(&format!(
                                        "tray_open_settings_failed :: {}",
                                        error
                                    ));
                                }
                            }
                            "quit" => {
                                app.exit(0);
                            }
                            _ => {}
                        });

                    if let Some(icon) = app.default_window_icon().cloned() {
                        tray_builder = tray_builder.icon(icon);
                    }

                    let tray = tray_builder.build(app)?;
                    app.manage(tray);

                    let Some(window) = app.get_webview_window("main") else {
                        append_runtime_log_line("app_setup_main_window_missing");
                        return Err("main window missing during setup".into());
                    };
                    let boot_profile = boot_profile_from_env();
                    append_runtime_log_line(&format!(
                        "app_setup :: startup_mode={} initial_ui_mode={} auto_start_capture={}",
                        boot_profile.startup_mode,
                        boot_profile.initial_ui_mode,
                        boot_profile.auto_start_capture
                    ));
                    install_capture_mouse_hook_thread(window.clone());
                    install_overlay_keyboard_hook_thread(window.clone());
                    if boot_profile.initial_ui_mode == "tray" {
                        hide_to_tray_impl(&window);
                    } else if boot_profile.initial_ui_mode == "canvas" {
                        show_canvas_window_impl(&window);
                    } else {
                        show_overlay_host_impl(&window, true);
                    }
                    install_rdev_input_listener(
                        window.clone(),
                        hit_map.clone(),
                        capture_input_state.clone(),
                        long_capture_sessions.clone(),
                        shared_app_settings.clone(),
                    );
                }
                Ok(())
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
