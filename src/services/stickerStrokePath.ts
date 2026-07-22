import type { StickerPoint } from "../types/stickerEditing";

export type StickerDashPattern = "solid" | "dash-1" | "dash-2";

/** Shared dash segment ratios. SVG uses as-is; canvas scales by stroke width. */
const DASH_PATTERN_SEGMENTS: Record<"dash-1" | "dash-2", readonly number[]> = {
    "dash-1": [8, 4],
    "dash-2": [4, 2, 1, 2],
};

export const getStrokeDashArray = (dashPattern?: StickerDashPattern) => {
    if (!dashPattern || dashPattern === "solid") return undefined;
    return DASH_PATTERN_SEGMENTS[dashPattern].join(" ");
};

/**
 * Resolve a canvas line-dash array (in px) from the annotation dash pattern,
 * scaled by stroke width so the pattern stays proportional.
 */
export const getDashSegments = (
    dashPattern: StickerDashPattern | undefined,
    width: number,
): number[] => {
    if (!dashPattern || dashPattern === "solid") return [];
    const unit = Math.max(1, width);
    return DASH_PATTERN_SEGMENTS[dashPattern].map((segment) => segment * unit);
};

/**
 * Build an SVG path `d` that traces the brush stroke.
 * A single point still needs a tiny segment so the round line cap paints a dot.
 */
export const buildStrokePath = (points: StickerPoint[]) => {
    if (points.length === 0) return "";
    if (points.length === 1) {
        const point = points[0];
        return `M ${point.x} ${point.y} L ${point.x + 0.01} ${point.y}`;
    }
    return points
        .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`)
        .join(" ");
};

/** Walk polyline points with moveTo/lineTo semantics shared by canvas drawing. */
export const traceStrokePolyline = (
    points: StickerPoint[],
    moveTo: (x: number, y: number) => void,
    lineTo: (x: number, y: number) => void,
) => {
    if (points.length < 2) return false;
    moveTo(points[0].x, points[0].y);
    for (let index = 1; index < points.length; index += 1) {
        lineTo(points[index].x, points[index].y);
    }
    return true;
};
