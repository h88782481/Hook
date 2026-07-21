import type { StickerShapeAnnotation } from "../types/stickerEditing";
import { isTransparentColor } from "../utils/colorUtils";

/** Whether a stroke should be painted (canvas) / emitted (SVG). */
export const hasVisibleStroke = (color: string | undefined, width: number) =>
    width > 0 && !isTransparentColor(color);

/** Whether a fill should be painted (canvas) / emitted (SVG). */
export const hasVisibleFill = (color: string | undefined) =>
    !!color && !isTransparentColor(color);

/** SVG stroke attribute: color or `"none"`. */
export const getVisibleStroke = (color: string, width: number) =>
    hasVisibleStroke(color, width) ? color : "none";

/** SVG fill attribute: color or `"transparent"`. */
export const getVisibleFill = (color: string | undefined) =>
    isTransparentColor(color) ? "transparent" : color!;

/** Corner radius for shape annotations; round-rect defaults to 12. */
export const getAnnotationCornerRadius = (shape: StickerShapeAnnotation) =>
    shape.style.cornerRadius ?? (shape.type === "round-rect" ? 12 : 0);
