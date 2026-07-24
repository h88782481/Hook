import type {
    StickerCanvasTool,
    StickerCaptureMeta,
    StickerEditingDomain,
    StickerTransformMode,
} from "../types/stickerEditing";

export type CaptureShortcutContext =
    | "long-capturing"
    | "sticker-editing"
    | "unit-selected"
    | "canvas";

export interface CaptureRect {
    x: number;
    y: number;
    w: number;
    h: number;
}

/** File-backed capture result from the Tauri capture commands. */
export interface CaptureResponse {
    width: number;
    height: number;
    filePath: string;
}

export type CaptureSelectionMode = "region" | "long";
export type LongCaptureAxis = "vertical" | "horizontal";
export type LongCaptureDirection = "down" | "up" | "right" | "left";

/** snow-shot style sample result. */
export type ScrollCaptureSampleStatus = "success" | "no_change" | "no_image" | "no_data";
export type ScrollCaptureImageList = "Top" | "Bottom";
export type ScrollCaptureDirection = "Vertical" | "Horizontal";

export interface ScrollCaptureSampleResponse {
    status: ScrollCaptureSampleStatus;
    frameCount: number;
    noChangeCount: number;
    pendingCount: number;
    edgePosition?: number | null;
    direction?: ScrollCaptureDirection | null;
    imageList?: ScrollCaptureImageList | null;
}

export const isLongCaptureMode = (mode: CaptureSelectionMode) => mode === "long";

export const resolveShortcutContext = (input: {
    isLongCapturing: boolean;
    hasSelectedSticker: boolean;
    hasActiveStickerEditTarget: boolean;
    stickerEditingDomain: StickerEditingDomain;
    stickerTransformMode: StickerTransformMode;
    stickerCanvasTool: StickerCanvasTool;
}): CaptureShortcutContext => {
    if (input.isLongCapturing) return "long-capturing";
    if (!input.hasSelectedSticker) return "canvas";
    if (!input.hasActiveStickerEditTarget) return "unit-selected";
    if (input.stickerEditingDomain === "create") {
        return "sticker-editing";
    }
    if (input.stickerEditingDomain === "sticker") {
        return input.stickerCanvasTool === "idle" ? "unit-selected" : "sticker-editing";
    }
    return input.stickerTransformMode !== "select" ? "sticker-editing" : "unit-selected";
};

export const createCaptureMeta = (
    mode: CaptureSelectionMode,
    rect: CaptureRect,
    scrollAxis?: LongCaptureAxis,
): StickerCaptureMeta => ({
    kind: isLongCaptureMode(mode) ? "long" : "region",
    sourceRect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.w),
        h: Math.round(rect.h),
    },
    scrollAxis: isLongCaptureMode(mode) ? (scrollAxis ?? "vertical") : undefined,
});

const hasClass = (target: Partial<HTMLElement>, className: string) =>
    typeof target.classList?.contains === "function" && target.classList.contains(className);

export const shouldStartCanvasSelectionFromTarget = (target: EventTarget | null): boolean => {
    if (!target) return false;

    const element = target as Partial<HTMLElement>;
    const tagName = typeof element.tagName === "string" ? element.tagName.toLowerCase() : "";
    const insideStickerInteractionRoot =
        typeof element.closest === "function" &&
        !!element.closest("[data-sticker-interaction-root='true']");
    if (insideStickerInteractionRoot) {
        return false;
    }
    return (
        tagName === "html" ||
        tagName === "body" ||
        hasClass(element, "hook-canvas-root") ||
        hasClass(element, "hook-canvas-surface")
    );
};
