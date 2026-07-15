import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const readSource = (relativePath: string) =>
  readFileSync(resolve(process.cwd(), relativePath), "utf8");

const sourceBetween = (source: string, start: string, end: string) => {
  const startIndex = source.indexOf(start);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
};

describe("overlay input shield window contract", () => {
  it("uses a native no-activate shield window with a rect-union region to block pointer passthrough under stickers without turning the WebView overlay itself interactive", () => {
    const rustSource = readSource("src-tauri/src/lib.rs");
    const updateRectsBlock = sourceBetween(
      rustSource,
      "fn update_pin_rects(",
      "#[tauri::command]\nfn set_mouse_monitor_active",
    );
    const mouseMonitorBlock = sourceBetween(
      rustSource,
      "fn set_mouse_monitor_active(",
      "#[tauri::command]\nfn get_cursor_position",
    );

    expect(rustSource).toContain("ensure_overlay_input_shield_window");
    expect(rustSource).toContain("sync_overlay_input_shield_region");
    expect(rustSource).toContain("CreateWindowExW");
    expect(rustSource).toContain("SetWindowRgn");
    expect(rustSource).toContain("CreateRectRgn");
    expect(rustSource).toContain("CombineRgn");
    expect(rustSource).toContain("SetLayeredWindowAttributes");
    expect(rustSource).toContain("WS_EX_LAYERED");
    expect(rustSource).toContain("MA_NOACTIVATE");
    expect(rustSource).toContain("OVERLAY_INPUT_SHIELD_HWND");
    expect(updateRectsBlock).toContain("sync_overlay_input_shield_region");
    expect(mouseMonitorBlock).toContain("sync_overlay_input_shield_region");
  });

  it("classifies sticker chrome, panels, menus, and ports as synthetic video-safe rects", () => {
    const rustSource = readSource("src-tauri/src/lib.rs");

    expect(rustSource).toContain("fn is_sticker_body_synthetic_rect");
    expect(rustSource).toContain("fn is_overlay_ui_synthetic_rect");
    expect(rustSource).toContain('rect.name == "MINI" || rect.name == "FULL"');
    expect(rustSource).toContain('"STICKER_TOP_STRIP"');
    expect(rustSource).toContain('"STICKER_TOP_STRIP_MENU"');
    expect(rustSource).toContain('"STICKER_CONTEXT_MENU_ROOT"');
    expect(rustSource).toContain('"ACTIONS_MENU"');
    expect(rustSource).toContain('"PARAMS_PANEL"');
    expect(rustSource).toContain('"TEXT_EDITOR"');
    expect(rustSource).toContain('"EXEC_SETTINGS"');
    expect(rustSource).toContain('"COLOR_PICKER"');
    expect(rustSource).toContain('rect.name.starts_with("PORT_IN_")');
    expect(rustSource).toContain('rect.name.starts_with("PORT_OUT_")');
    expect(rustSource).toContain("is_sticker_body_synthetic_rect(rect) || is_overlay_ui_synthetic_rect(rect)");
  });

  it("keeps sticker chrome and popup UI inside the native synthetic shield instead of cutting holes that make the WebView receive real hover", () => {
    const rustSource = readSource("src-tauri/src/lib.rs");
    const shieldBlock = sourceBetween(
      rustSource,
      "fn sync_overlay_input_shield_region(",
      "#[cfg(not(target_os = \"windows\"))]\nfn sync_overlay_input_shield_region",
    );

    expect(shieldBlock).toContain("shield_rects");
    expect(shieldBlock).toContain("is_synthetic_overlay_rect(rect)");
    expect(shieldBlock).not.toContain("cutout_rects");
    expect(shieldBlock).not.toContain("RGN_DIFF");
  });

  it("routes synthetic mouse and wheel events while the cursor is inside overlay UI rects such as font dropdowns and context menus", () => {
    const rustSource = readSource("src-tauri/src/lib.rs");
    const routeBlock = sourceBetween(
      rustSource,
      "fn should_route_overlay_mouse_events(",
      "#[cfg(target_os = \"windows\")]\nunsafe extern \"system\" fn capture_mouse_hook_proc",
    );

    expect(routeBlock).not.toContain("!is_synthetic_overlay_rect(rect) && rect.contains(x, y)");
    expect(routeBlock).toContain("is_synthetic_overlay_rect(rect) && rect.contains(x, y)");
  });
});
