import { pointToSegmentDistance } from "../services/stickerGeometry";
import type { StickerPoint } from "../types/stickerEditing";

export type TransformAxisMode = "xy" | "x" | "y";

type ScreenRgb = { r: number; g: number; b: number };

interface TransformGizmoOptions {
    axisLength?: number;
    hitPadding?: number;
    centerSize?: number;
    handleSize?: number;
}

interface GizmoRect {
    x: number;
    y: number;
    w: number;
    h: number;
}

const DEFAULT_TRANSFORM_GIZMO_AXIS_LENGTH = 44;
const DEFAULT_TRANSFORM_GIZMO_HIT_PADDING = 8;
const DEFAULT_TRANSFORM_GIZMO_CENTER_SIZE = 10;
const DEFAULT_TRANSFORM_GIZMO_SCALE_HANDLE_SIZE = 12;

const isPointInRect = (point: StickerPoint, rect: GizmoRect, padding = 0) =>
    point.x >= rect.x - padding &&
    point.x <= rect.x + rect.w + padding &&
    point.y >= rect.y - padding &&
    point.y <= rect.y + rect.h + padding;

const getCenterHandleRect = (center: StickerPoint, centerSize = DEFAULT_TRANSFORM_GIZMO_CENTER_SIZE): GizmoRect => ({
    x: center.x - centerSize / 2,
    y: center.y - centerSize / 2,
    w: centerSize,
    h: centerSize,
});

export const getScaleGizmoHandleRects = (
    center: StickerPoint,
    options: TransformGizmoOptions = {},
) => {
    const axisLength = options.axisLength ?? DEFAULT_TRANSFORM_GIZMO_AXIS_LENGTH;
    const centerSize = options.centerSize ?? DEFAULT_TRANSFORM_GIZMO_CENTER_SIZE;
    const handleSize = options.handleSize ?? DEFAULT_TRANSFORM_GIZMO_SCALE_HANDLE_SIZE;

    return {
        center: getCenterHandleRect(center, centerSize),
        x: {
            x: center.x + axisLength - handleSize / 2,
            y: center.y - handleSize / 2,
            w: handleSize,
            h: handleSize,
        },
        y: {
            x: center.x - handleSize / 2,
            y: center.y + axisLength - handleSize / 2,
            w: handleSize,
            h: handleSize,
        },
    };
};

export const resolveMoveGizmoAxisAtPoint = (
    point: StickerPoint,
    center: StickerPoint,
    options: TransformGizmoOptions = {},
): TransformAxisMode | null => {
    const axisLength = options.axisLength ?? DEFAULT_TRANSFORM_GIZMO_AXIS_LENGTH;
    const hitPadding = options.hitPadding ?? DEFAULT_TRANSFORM_GIZMO_HIT_PADDING;
    const centerRect = getCenterHandleRect(center, options.centerSize ?? DEFAULT_TRANSFORM_GIZMO_CENTER_SIZE);
    if (isPointInRect(point, centerRect, hitPadding)) {
        return "xy";
    }

    const onXAxis = pointToSegmentDistance(
        point,
        { x: center.x - axisLength, y: center.y },
        { x: center.x + axisLength, y: center.y },
    ) <= hitPadding;
    if (onXAxis) {
        return "x";
    }

    const onYAxis = pointToSegmentDistance(
        point,
        { x: center.x, y: center.y - axisLength },
        { x: center.x, y: center.y + axisLength },
    ) <= hitPadding;
    return onYAxis ? "y" : null;
};

export const resolveScaleGizmoAxisAtPoint = (
    point: StickerPoint,
    center: StickerPoint,
    options: TransformGizmoOptions = {},
): TransformAxisMode | null => {
    const axisLength = options.axisLength ?? DEFAULT_TRANSFORM_GIZMO_AXIS_LENGTH;
    const hitPadding = options.hitPadding ?? DEFAULT_TRANSFORM_GIZMO_HIT_PADDING;
    const handleRects = getScaleGizmoHandleRects(center, options);

    if (isPointInRect(point, handleRects.center, hitPadding)) {
        return "xy";
    }
    if (isPointInRect(point, handleRects.x, hitPadding)) {
        return "x";
    }
    if (isPointInRect(point, handleRects.y, hitPadding)) {
        return "y";
    }

    const onXAxis = pointToSegmentDistance(
        point,
        center,
        { x: handleRects.x.x + handleRects.x.w / 2, y: handleRects.x.y + handleRects.x.h / 2 },
    ) <= hitPadding;
    if (onXAxis) {
        return "x";
    }

    const onYAxis = pointToSegmentDistance(
        point,
        center,
        { x: handleRects.y.x + handleRects.y.w / 2, y: handleRects.y.y + handleRects.y.h / 2 },
    ) <= hitPadding;
    return onYAxis ? "y" : null;
};

export type DraftShape = {
    mode: "crop" | "shape-rect" | "shape-round-rect" | "shape-ellipse" | "shape-triangle" | "shape-polygon";
    start: StickerPoint;
    current: StickerPoint;
    constrainSquare?: boolean;
    snapStep?: number;
};

export type DraftLine = {
    mode: "line" | "polyline" | "arrow" | "brush" | "highlighter" | "content-eraser" | "mosaic" | "blur";
    points: StickerPoint[];
    showArrowHead?: boolean;
};

export type GlobalColorPickerMousePayload = {
    x?: number;
    y?: number;
    globalX?: number;
    globalY?: number;
    hex?: string;
    rgb?: ScreenRgb;
};

export type ColorPickerPreview = {
    x: number;
    y: number;
    hex: string;
    rgb: ScreenRgb;
};

export type PendingTextInput = {
    annotationId?: string;
    x: number;
    y: number;
    value: string;
    fontSize: number;
    color: string;
    fontFamily: string;
};

export const isBoundedBoxMode = (mode: DraftShape["mode"]) =>
    mode === "crop" ||
    mode === "shape-rect" ||
    mode === "shape-round-rect" ||
    mode === "shape-ellipse" ||
    mode === "shape-triangle" ||
    mode === "shape-polygon";

export const isRegularShapeMode = (mode: DraftShape["mode"]) =>
    mode === "shape-rect" || mode === "shape-round-rect" || mode === "shape-ellipse" || mode === "shape-triangle" || mode === "shape-polygon";

export const isStraightLineMode = (mode: DraftLine["mode"]) =>
    mode === "line" ||
    mode === "arrow" ||
    mode === "brush" ||
    mode === "highlighter";

export const isMeasuredLineMode = (mode: DraftLine["mode"]) =>
    mode === "line" || mode === "arrow";

export { annotationRenderRank } from "../services/stickerCanvas";
export { getStrokeDashArray } from "../services/stickerStrokePath";

export {
    getAnnotationCornerRadius,
    getVisibleFill,
    getVisibleStroke,
} from "../services/stickerAnnotationStyle";

export const normalizeRect = (start: StickerPoint, end: StickerPoint) => ({
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    w: Math.abs(end.x - start.x),
    h: Math.abs(end.y - start.y),
});
