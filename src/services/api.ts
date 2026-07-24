import { invoke } from "@tauri-apps/api/core";
import { BootProfile, defaultBootProfile, normalizeBootProfile } from "./bootProfile";
import type { AppSettings } from "./appSettings";
import { defaultAppSettings, normalizeAppSettings } from "./appSettings";
import type { FrozenStickerEntry } from "./stickerSnapshot";
import type { PinRect } from "../types/pinRect";
import type { SessionSticker, SessionLink, SessionGroup } from "../types/stickerModel";
import type {
    CaptureResponse,
    LongCaptureAxis,
    ScrollCaptureImageList,
    ScrollCaptureSampleResponse,
} from "./captureState";

interface SessionData {
    stickers: SessionSticker[];
    links: SessionLink[];
    groups: SessionGroup[];
    recycleBin: FrozenStickerEntry[];
    referenceLibrary: FrozenStickerEntry[];
}

interface ToolSettingsData {
    stickerToolSettings?: Record<string, unknown> | null;
}

const warnedMethods = new Set<string>();

const warnBrowserFallback = (method: string) => {
    if (warnedMethods.has(method)) return;
    warnedMethods.add(method);
    console.warn(`[API] ${method} skipped: Tauri runtime unavailable (browser UI preview)`);
};

interface WindowWithTauri extends Window {
    __TAURI_INTERNALS__?: unknown;
}

export const isTauriRuntimeAvailable = () =>
    typeof window !== "undefined" && typeof (window as WindowWithTauri).__TAURI_INTERNALS__ !== "undefined";

const emptySession = (): SessionData => ({
    stickers: [],
    links: [],
    groups: [],
    recycleBin: [],
    referenceLibrary: [],
});

/** Invoke a Tauri command, or run a no-op fallback when only the Vite UI is open. */
const safeInvoke = async <T>(
    command: string,
    args: Record<string, unknown> | undefined,
    fallback?: () => T | Promise<T>,
    warnOnFallback: boolean = true,
): Promise<T> => {
    if (!isTauriRuntimeAvailable()) {
        if (fallback) {
            if (warnOnFallback) {
                warnBrowserFallback(command);
            }
            return await fallback();
        }
        throw new Error(`Tauri runtime unavailable for command: ${command}`);
    }

    return invoke(command, args);
};

/**
 * Typed API Layer for Backend Communication
 * All raw `invoke` calls should be routed through here.
 */
export const api = {
    getBootProfile: (): Promise<BootProfile> =>
        safeInvoke("get_boot_profile", undefined, () => defaultBootProfile, false).then(normalizeBootProfile),

    // --- Session Management ---
    loadSession: (): Promise<SessionData> =>
        safeInvoke("load_session", undefined, emptySession, false),

    saveSession: (
        stickers: SessionSticker[],
        links: SessionLink[],
        groups: SessionGroup[],
        recycleBin: FrozenStickerEntry[],
        referenceLibrary: FrozenStickerEntry[],
    ): Promise<void> =>
        safeInvoke(
            "save_session",
            { stickers, links, groups, recycleBin, referenceLibrary },
            () => undefined,
            false,
        ),

    // --- Color + Screenshot History ---
    loadHistory: (): Promise<{ colors: unknown[]; screenshots: unknown[] }> =>
        safeInvoke("load_history", undefined, () => ({ colors: [], screenshots: [] }), false),

    saveHistory: (colors: unknown[], screenshots: unknown[]): Promise<void> =>
        safeInvoke("save_history", { colors, screenshots }, () => undefined, false),

    loadToolSettings: (): Promise<ToolSettingsData> =>
        safeInvoke("load_tool_settings", undefined, () => ({ stickerToolSettings: null }), false),

    saveToolSettings: (stickerToolSettings: Record<string, unknown>): Promise<void> =>
        safeInvoke("save_tool_settings", { stickerToolSettings }, () => undefined, false),

    loadAppSettings: (): Promise<AppSettings> =>
        safeInvoke("load_app_settings", undefined, () => defaultAppSettings(), false).then(
            normalizeAppSettings,
        ),

    saveAppSettings: (settings: AppSettings): Promise<AppSettings> =>
        safeInvoke("save_app_settings", { settings }, () => settings, false).then(
            normalizeAppSettings,
        ),

    getInstalledFonts: (): Promise<string[]> =>
        safeInvoke("get_installed_fonts", undefined, () => [], false),

    // --- UI / Overlay ---
    updatePinRects: (rects: PinRect[]): Promise<void> =>
        safeInvoke("update_pin_rects", { rects }, () => undefined, false),

    showOverlayHost: (clickThrough = true): Promise<void> =>
        safeInvoke("show_overlay_host", { clickThrough }, () => undefined, false),

    hideOverlayHost: (): Promise<void> =>
        safeInvoke("hide_overlay_host", undefined, () => undefined, false),

    setOverlayClickThrough: (clickThrough: boolean): Promise<void> =>
        safeInvoke("set_overlay_click_through", { clickThrough }, () => undefined, false),

    setNativeStickerDragPreflight: (active: boolean): Promise<void> =>
        safeInvoke("set_native_drag_preflight_active", { active }, () => undefined, false),

    setOverlayKeyboardCaptureActive: (active: boolean): Promise<void> =>
        safeInvoke("set_overlay_keyboard_capture_active", { active }, () => undefined, false),

    focusOverlayWindow: (): Promise<void> =>
        safeInvoke("focus_overlay_window", undefined, () => undefined, false),

    setOverlayCaptureExclusion: (enabled: boolean): Promise<void> =>
        safeInvoke("set_overlay_capture_exclusion", { enabled }, () => undefined, false),

    showCanvasWindow: (): Promise<void> =>
        safeInvoke("show_canvas_window", undefined, () => undefined, false),

    hideToTray: (): Promise<void> =>
        safeInvoke("hide_to_tray", undefined, () => undefined, false),

    triggerCaptureMode: (): Promise<void> =>
        safeInvoke("trigger_capture_mode", undefined, () => undefined, false),

    setCaptureInputActive: (
        active: boolean,
        options?: { sampleColor?: boolean },
    ): Promise<void> =>
        safeInvoke(
            "set_capture_input_active",
            {
                active,
                sampleColor: options?.sampleColor ?? false,
            },
            () => undefined,
            false,
        ),

    debugLogEvent: (event: string, detail?: string): Promise<void> =>
        safeInvoke("append_runtime_log", { event, detail }, () => undefined, false),

    setMouseMonitorActive: (active: boolean): Promise<void> =>
        safeInvoke("set_mouse_monitor_active", { active }, () => undefined, false),

    setLongCaptureUiActive: (active: boolean): Promise<void> =>
        safeInvoke("set_long_capture_ui_active", { active }, () => undefined, false),

    // --- Capture ---
    captureRegion: (
        x: number,
        y: number,
        w: number,
        h: number,
    ): Promise<CaptureResponse> =>
        safeInvoke("capture_region", {
            x,
            y,
            w,
            h,
        }),
    startScrollCaptureSession: (
        rect: { x: number; y: number; w: number; h: number },
        axis?: LongCaptureAxis,
    ): Promise<string> =>
        safeInvoke("start_scroll_capture_session", { rect, axis }),
    sampleScrollCaptureSession: (
        sessionId: string,
        scrollImageList: ScrollCaptureImageList = "Bottom",
        hideOverlayBeforeCapture = false,
    ): Promise<ScrollCaptureSampleResponse> =>
        safeInvoke("sample_scroll_capture_session", {
            sessionId,
            scrollImageList,
            hideOverlayBeforeCapture,
        }),
    captureScrollCaptureSession: (
        sessionId: string,
        scrollImageList: ScrollCaptureImageList = "Bottom",
    ): Promise<void> =>
        safeInvoke("capture_scroll_capture_session", { sessionId, scrollImageList }),
    handleScrollCaptureSession: (sessionId: string): Promise<ScrollCaptureSampleResponse> =>
        safeInvoke("handle_scroll_capture_session", { sessionId }),
    finishScrollCaptureSession: (sessionId: string): Promise<CaptureResponse> =>
        safeInvoke("finish_scroll_capture_session", { sessionId }),
    cancelScrollCaptureSession: (sessionId: string): Promise<void> =>
        safeInvoke("cancel_scroll_capture_session", { sessionId }),
    scrollThrough: (length: number, axis: LongCaptureAxis = "vertical"): Promise<void> =>
        safeInvoke("scroll_through", { length, axis }),

    // --- System ---
    getCursorPosition: (): Promise<{x: number, y: number}> =>
        safeInvoke("get_cursor_position", undefined, () => ({ x: 0, y: 0 }), false),

    // --- File IO ---
    readImageFromPath: (path: string): Promise<string> =>
        safeInvoke("read_image_from_path", { path }),

    saveStickerDragExport: (
        base64: string,
        filenameHint: string | undefined,
        globalX: number,
        globalY: number,
    ): Promise<string> =>
        safeInvoke(
            "save_sticker_drag_export",
            { base64Image: base64, filenameHint, globalX, globalY },
            () => {
                throw new Error("Shift drag export requires the Tauri desktop runtime");
            },
            false,
        ),

    saveStickerDragExportFromPath: (
        path: string,
        filenameHint: string | undefined,
        globalX: number,
        globalY: number,
    ): Promise<string> =>
        safeInvoke(
            "save_sticker_drag_export_from_path",
            { path, filenameHint, globalX, globalY },
            () => {
                throw new Error("Shift drag export from path requires the Tauri desktop runtime");
            },
            false,
        ),

    saveStickerImageAs: (base64: string, dialogCenterX: number, dialogCenterY: number): Promise<string | null> =>
        safeInvoke("save_sticker_image_as", { base64Image: base64, dialogCenterX, dialogCenterY }),
    openImageForEdit: (): Promise<string | null> =>
        safeInvoke("open_image_for_edit", undefined, () => null, false),
    readClipboardImage: (): Promise<string | null> =>
        safeInvoke("read_clipboard_image", undefined, () => null, false),

    copyStickerImageToSmartClipboard: (base64: string): Promise<string> =>
        safeInvoke("copy_sticker_image_to_smart_clipboard", { base64Image: base64 }, () => "ui-preview", false),
};
