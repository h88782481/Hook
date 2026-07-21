import type {
    ContentEraserStroke,
    StickerAnnotation,
    StickerTextAnnotation,
} from "../types/stickerEditing";
import type { Sticker } from "../types/stickerModel";
import { buildSerialAnnotationMetrics } from "./stickerEditing";
import { scaleAnnotation, scaleStrokeWidth } from "./stickerGeometry";
import { DEFAULT_TEXT_FONT_SIZE, DEFAULT_TEXT_WIDTH_FACTOR } from "./stickerTextDefaults";

export type StickerFrame = Pick<Sticker, "w" | "h">;
export type FlipAxis = "x" | "y";

export { scaleAnnotation };

export const scaleContentEraserStroke = (
    stroke: ContentEraserStroke,
    scaleX: number,
    scaleY: number,
): ContentEraserStroke => ({
    ...stroke,
    points: stroke.points.map((point) => ({
        x: point.x * scaleX,
        y: point.y * scaleY,
    })),
    width: scaleStrokeWidth(stroke.width, scaleX, scaleY),
});

const mirrorPoint = (
    point: { x: number; y: number },
    frame: StickerFrame,
    axis: FlipAxis,
) => ({
    x: axis === "x" ? frame.w - point.x : point.x,
    y: axis === "y" ? frame.h - point.y : point.y,
});

const measureAnnotationTextWidth = (annotation: StickerTextAnnotation, fontSize: number) => {
    if (typeof document !== "undefined" && typeof document.createElement === "function") {
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d");
        if (context) {
            context.font = `${annotation.type === "serial" ? "700" : "500"} ${fontSize}px "Segoe UI", sans-serif`;
            const width = context.measureText(annotation.text).width;
            if (Number.isFinite(width) && width > 0) {
                return width;
            }
        }
    }

    return Math.max(fontSize, annotation.text.length * fontSize * DEFAULT_TEXT_WIDTH_FACTOR);
};

/** Mirror an annotation across the sticker frame on the given axis. */
export const flipAnnotation = (
    annotation: StickerAnnotation,
    frame: StickerFrame,
    axis: FlipAxis,
): StickerAnnotation => {
    if (
        annotation.type === "rect" ||
        annotation.type === "round-rect" ||
        annotation.type === "ellipse" ||
        annotation.type === "triangle" ||
        annotation.type === "polygon"
    ) {
        return {
            ...annotation,
            x: axis === "x" ? frame.w - annotation.x - annotation.w : annotation.x,
            y: axis === "y" ? frame.h - annotation.y - annotation.h : annotation.y,
        };
    }

    if (annotation.type === "mosaic" || annotation.type === "blur") {
        return {
            ...annotation,
            x: axis === "x" ? frame.w - annotation.x - annotation.w : annotation.x,
            y: axis === "y" ? frame.h - annotation.y - annotation.h : annotation.y,
            points: annotation.points?.map((point) => mirrorPoint(point, frame, axis)),
        };
    }

    if (annotation.type === "text" || annotation.type === "serial") {
        const fontSize =
            annotation.fontSize ??
            (annotation.type === "serial"
                ? buildSerialAnnotationMetrics(annotation.style.cornerRadius ?? 14).fontSize
                : DEFAULT_TEXT_FONT_SIZE);

        if (annotation.type === "serial") {
            const serialMetrics = buildSerialAnnotationMetrics(annotation.style.cornerRadius ?? 14);
            return {
                ...annotation,
                x: axis === "x" ? frame.w - annotation.x - serialMetrics.radius * 2 : annotation.x,
                y: axis === "y" ? frame.h - annotation.y + fontSize : annotation.y,
            };
        }

        const textWidth = measureAnnotationTextWidth(annotation, fontSize);
        return {
            ...annotation,
            x: axis === "x" ? frame.w - annotation.x - textWidth : annotation.x,
            y: axis === "y" ? frame.h - annotation.y - fontSize : annotation.y,
        };
    }

    return annotation.type === "line" ||
        annotation.type === "polyline" ||
        annotation.type === "arrow" ||
        annotation.type === "brush" ||
        annotation.type === "highlighter"
        ? {
              ...annotation,
              points: annotation.points.map((point) => mirrorPoint(point, frame, axis)),
          }
        : annotation;
};

export const flipContentEraserStroke = (
    stroke: ContentEraserStroke,
    frame: StickerFrame,
    axis: FlipAxis,
): ContentEraserStroke => ({
    ...stroke,
    points: stroke.points.map((point) => mirrorPoint(point, frame, axis)),
});
