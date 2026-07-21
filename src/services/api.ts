import { invoke } from "@tauri-apps/api/core";
import { BootProfile, defaultBootProfile, normalizeBootProfile } from "./bootProfile";
import type { FrozenStickerEntry } from "./stickerSnapshot";
import type { SessionSticker, SessionLink, SessionGroup } from "../types/unit";
import type {
    LongCaptureAxis,
    LongCaptureDirection,
    LongCaptureOverlapAnalysis,
} from "./captureState";

// Arguments Types
export interface PinRect {
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
    name: string;
}

export interface CaptureResponse {
    base64: string;
    width: number;
    height: number;
    filePath?: string | null;
    fileUrl?: string | null;
}

export interface CaptureRegionOptions {
    compositionOverlayAlpha?: number;
}

export interface SessionData {
    stickers: SessionSticker[];
    links: SessionLink[];
    groups: SessionGroup[];
    recycleBin: FrozenStickerEntry[];
    referenceLibrary: FrozenStickerEntry[];
}

export interface PreciseSelectionResult {
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface ScreenColorSample {
    hex: string;
    rgb: { r: number; g: number; b: number };
}

export interface ToolSettingsData {
    stickerToolSettings?: Record<string, unknown> | null;
}

const warnedMethods = new Set<string>();
const BROWSER_SESSION_STORAGE_KEY = "hook_browser_preview_session";
const BROWSER_SESSION_DATA_URL_THRESHOLD = 8 * 1024;

const warnBrowserFallback = (method: string) => {
    if (warnedMethods.has(method)) return;
    warnedMethods.add(method);
    console.warn(`[API] ${method} skipped: Tauri runtime unavailable (browser preview mode)`);
};

// Type guard for Tauri runtime availability
interface WindowWithTauri extends Window {
    __TAURI_INTERNALS__?: unknown;
}

export const isTauriRuntimeAvailable = () =>
    typeof window !== "undefined" && typeof (window as WindowWithTauri).__TAURI_INTERNALS__ !== "undefined";

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

const loadBrowserPreviewSession = (): SessionData => {
    try {
        const raw = window.localStorage.getItem(BROWSER_SESSION_STORAGE_KEY);
        if (!raw) {
            return { stickers: [], links: [], groups: [], recycleBin: [], referenceLibrary: [] };
        }
        const parsed = JSON.parse(raw);
        if (
            Array.isArray(parsed?.stickers) &&
            Array.isArray(parsed?.links) &&
            Array.isArray(parsed?.groups) &&
            Array.isArray(parsed?.recycleBin) &&
            Array.isArray(parsed?.referenceLibrary)
        ) {
            return {
                stickers: parsed.stickers,
                links: parsed.links,
                groups: parsed.groups,
                recycleBin: parsed.recycleBin,
                referenceLibrary: parsed.referenceLibrary,
            } as SessionData;
        }
    } catch (error) {
        console.warn("[API] Failed to parse browser preview session:", error);
    }

    return { stickers: [], links: [], groups: [], recycleBin: [], referenceLibrary: [] };
};

const trimBrowserSessionValue = (
    value: string | null | undefined,
): string | null | undefined => {
    if (typeof value === "string" && value.startsWith("data:") && value.length > BROWSER_SESSION_DATA_URL_THRESHOLD) {
        return null;
    }
    return value;
};

const compactBrowserPreviewSession = (
    stickers: SessionSticker[],
    links: SessionLink[],
    groups: SessionGroup[],
    recycleBin: FrozenStickerEntry[],
    referenceLibrary: FrozenStickerEntry[],
): SessionData => ({
    stickers: stickers.map((sticker) => ({
        ...sticker,
        src: trimBrowserSessionValue(sticker?.src),
        previewSrc: trimBrowserSessionValue(sticker?.previewSrc),
        rasterizedAnnotationLayerSrc: trimBrowserSessionValue(sticker?.rasterizedAnnotationLayerSrc),
    })),
    links,
    groups,
    recycleBin,
    referenceLibrary,
});

const saveBrowserPreviewSession = (
    stickers: SessionSticker[],
    links: SessionLink[],
    groups: SessionGroup[],
    recycleBin: FrozenStickerEntry[],
    referenceLibrary: FrozenStickerEntry[],
) => {
    try {
        window.localStorage.setItem(
            BROWSER_SESSION_STORAGE_KEY,
            JSON.stringify({ stickers, links, groups, recycleBin, referenceLibrary }),
        );
    } catch (error) {
        try {
            const compact = compactBrowserPreviewSession(
                stickers,
                links,
                groups,
                recycleBin,
                referenceLibrary,
            );
            window.localStorage.setItem(
                BROWSER_SESSION_STORAGE_KEY,
                JSON.stringify(compact),
            );
        } catch (compactError) {
            console.warn("[API] Failed to save browser preview session:", compactError);
        }
    }
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
        safeInvoke("load_session", undefined, loadBrowserPreviewSession, false),

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
            () => saveBrowserPreviewSession(stickers, links, groups, recycleBin, referenceLibrary),
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

    getInstalledFonts: (): Promise<string[]> =>
        safeInvoke("get_installed_fonts", undefined, () => [], false),

    // --- UI / Overlay ---
    updatePinRects: (rects: PinRect[]): Promise<void> =>
        safeInvoke("update_pin_rects", { rects }, () => undefined, false),

    showOverlayHost: (clickThrough = true): Promise<void> =>
        safeInvoke("show_overlay_host", { clickThrough }, () => undefined, false),

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

    setCaptureInputActive: (active: boolean): Promise<void> =>
        safeInvoke("set_capture_input_active", { active }, () => undefined, false),

    debugLogEvent: (event: string, detail?: string): Promise<void> =>
        safeInvoke("append_runtime_log", { event, detail }, () => undefined, false),

    setMouseMonitorActive: (active: boolean): Promise<void> =>
        safeInvoke("set_mouse_monitor_active", { active }, () => undefined, false),

    // --- Capture ---
    captureRegion: (
        x: number,
        y: number,
        w: number,
        h: number,
        options?: CaptureRegionOptions,
    ): Promise<CaptureResponse> => {
        console.log("[API] captureRegion called with:", { x, y, w, h, options });
        return safeInvoke("capture_region", {
            x,
            y,
            w,
            h,
            compositionOverlayAlpha: options?.compositionOverlayAlpha,
        });
    },
    analyzeLongCapturePair: (
        previous: string,
        current: string,
        options?: {
            axis?: LongCaptureAxis;
            direction?: LongCaptureDirection;
            maxScan?: number;
            minOverlapPx?: number;
            minNewContentPx?: number;
        },
    ): Promise<LongCaptureOverlapAnalysis> =>
        safeInvoke("analyze_long_capture_pair", {
            previous,
            current,
            axis: options?.axis,
            direction: options?.direction,
            maxScan: options?.maxScan,
            minOverlapPx: options?.minOverlapPx,
            minNewContentPx: options?.minNewContentPx,
        }),
    stitchLongCaptureFrames: (
        frames: string[],
        options?: {
            axis?: LongCaptureAxis;
            direction?: LongCaptureDirection;
            maxScan?: number;
            minOverlapPx?: number;
        },
    ): Promise<CaptureResponse> =>
        safeInvoke("stitch_long_capture_frames", {
            frames,
            axis: options?.axis,
            direction: options?.direction,
            maxScan: options?.maxScan,
            minOverlapPx: options?.minOverlapPx,
        }),
    startLongCaptureSession: (
        rect: { x: number; y: number; w: number; h: number },
        axis?: LongCaptureAxis,
    ): Promise<string> =>
        safeInvoke("start_long_capture_session", { rect, axis }),
    sampleLongCaptureSession: (sessionId: string): Promise<{
        status: "recorded" | "duplicate";
        frameCount: number;
        duplicateCount: number;
        recorded: boolean;
        axis?: LongCaptureAxis | null;
        direction?: LongCaptureDirection | null;
    }> =>
        safeInvoke("sample_long_capture_session", { sessionId }),
    finishLongCaptureSession: (sessionId: string): Promise<CaptureResponse> =>
        safeInvoke("finish_long_capture_session", { sessionId }),
    cancelLongCaptureSession: (sessionId: string): Promise<void> =>
        safeInvoke("cancel_long_capture_session", { sessionId }),

    getPreciseSelection: (x: number, y: number, w: number, h: number): Promise<PreciseSelectionResult | null> =>
        safeInvoke("get_precise_selection", { x, y, w, h }),

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
        safeInvoke("copy_sticker_image_to_smart_clipboard", { base64Image: base64 }, () => "browser-preview", false),
};
