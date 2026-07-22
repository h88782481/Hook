import type { StickerPoint } from "../types/stickerEditing";
import { toDisplayImageSrc } from "./imageSource";
import {
    getDashSegments,
    traceStrokePolyline,
    type StickerDashPattern,
} from "./stickerStrokePath";

export type { StickerDashPattern };

/**
 * Render-order rank for sticker annotations. Censoring effects sit at the bottom
 * so painted annotations stay visible. Among effects, blur renders below mosaic
 * so a blur brush never paints over a mosaic censoring the same pixels.
 */
export const annotationRenderRank = (type: string) =>
    type === "blur" ? 0 : type === "mosaic" ? 1 : 2;

/**
 * Apply line dash pattern to canvas context, guarded against incomplete mock implementations.
 */
export const applyLineDash = (
    context: CanvasRenderingContext2D,
    dashPattern: StickerDashPattern | undefined,
    width: number,
) => {
    if (typeof context.setLineDash !== "function") return;
    context.setLineDash(getDashSegments(dashPattern, width));
};

/**
 * Draw a stroked path through the given points on a canvas context.
 * Handles single-point paths as circles, multi-point paths as polylines.
 * Supports opacity and optional dash patterns.
 */
export const drawStrokePath = (
    context: CanvasRenderingContext2D,
    points: StickerPoint[],
    style: {
        color: string;
        width: number;
        opacity?: number;
        dashPattern?: StickerDashPattern;
    },
) => {
    if (points.length < 1) return;

    context.save();
    context.globalAlpha = style.opacity ?? 1;

    // Single point: draw as a circle
    if (points.length === 1) {
        context.fillStyle = style.color;
        context.beginPath();
        context.arc(points[0].x, points[0].y, Math.max(0.5, style.width / 2), 0, Math.PI * 2);
        context.fill();
        context.restore();
        return;
    }

    // Multi-point: draw as a polyline
    context.beginPath();
    traceStrokePolyline(
        points,
        (x, y) => context.moveTo(x, y),
        (x, y) => context.lineTo(x, y),
    );
    context.strokeStyle = style.color;
    context.lineWidth = style.width;
    // A round cap extends each dash by half the stroke width on both ends,
    // which fills the gaps and makes a dashed line look solid. Use a butt cap
    // whenever a dash pattern is active so the gaps stay visible.
    const dashSegments = style.dashPattern ? getDashSegments(style.dashPattern, style.width) : [];
    context.lineCap = dashSegments.length > 0 ? "butt" : "round";
    context.lineJoin = "round";
    if (style.dashPattern) {
        applyLineDash(context, style.dashPattern, style.width);
    }
    context.stroke();
    context.restore();
};

/**
 * Erase along a stroke path using destination-out (content / annotation eraser).
 */
export const eraseStrokePathToTransparency = (
    context: CanvasRenderingContext2D,
    points: StickerPoint[],
    width: number,
) => {
    context.save();
    context.globalCompositeOperation = "destination-out";
    drawStrokePath(context, points, {
        color: "#000000",
        width,
        opacity: 1,
    });
    context.restore();
};

/**
 * Load an image from a data URL or file path.
 */
export const loadImage = (src: string) =>
    new Promise<HTMLImageElement>((resolve, reject) => {
        if (!src) {
            reject(new Error("Cannot load image from empty source"));
            return;
        }
        const resolvedSrc = toDisplayImageSrc(src) || src;
        const image = new Image();
        // Non-data/blob sources (e.g. file:/asset: paths) taint the canvas unless
        // they are loaded as crossOrigin, which makes a later toDataURL throw a
        // SecurityError. Request anonymous CORS for those so the rasterized erase
        // and export pipelines can read the canvas back.
        if (!resolvedSrc.startsWith("data:") && !resolvedSrc.startsWith("blob:")) {
            image.crossOrigin = "anonymous";
        }
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("Failed to load image"));
        image.src = resolvedSrc;
    });
