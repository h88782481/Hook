/**
 * Shared annotation paint specs for SVG preview and canvas export.
 * Pure layout/geometry only — no DOM, Canvas, or Solid.
 */
import type {
    StickerAnnotation,
    StickerEffectAnnotation,
    StickerLineAnnotation,
    StickerPoint,
    StickerShapeAnnotation,
    StickerTextAnnotation,
} from "../types/stickerEditing";
import {
    getAnnotationCornerRadius,
    hasVisibleFill,
    hasVisibleStroke,
} from "./stickerAnnotationStyle";
import { buildSerialAnnotationMetrics } from "./stickerEditing";
import {
    buildArrowHeadPolygon,
    buildPolygonPoints,
    buildTrianglePoints,
    getAnnotationCenter,
    getArrowHeadSizeOptions,
    getArrowShaftPoints,
} from "./stickerGeometry";
import { buildStrokePath, getStrokeDashArray } from "./stickerStrokePath";
import { DEFAULT_TEXT_FONT_SIZE } from "./stickerTextDefaults";

export type AnnotationRotation = {
    cx: number;
    cy: number;
    degrees: number;
};

export type ShapePaintStyle = {
    stroke: string;
    strokeWidth: number;
    fill: string | undefined;
    opacity: number;
    dashPattern: StickerShapeAnnotation["style"]["dashPattern"];
    drawStroke: boolean;
    drawFill: boolean;
};

export type ShapePaintGeometry =
    | { kind: "ellipse"; cx: number; cy: number; rx: number; ry: number }
    | { kind: "rect"; x: number; y: number; w: number; h: number; rx: number; ry: number }
    | { kind: "polygon"; points: StickerPoint[]; cornerRadius: number };

export type ShapePaintSpec = {
    rotation: AnnotationRotation | null;
    style: ShapePaintStyle;
    geometry: ShapePaintGeometry;
};

export type LinePaintSpec = {
    shaftPoints: StickerPoint[];
    pathD: string;
    arrowHead: StickerPoint[] | null;
    arrowHeadPathD: string;
    style: StickerLineAnnotation["style"];
    dashCap: "butt" | "round";
};

export type TextPaintDefaults = {
    textFontSize?: number;
    textFontFamily?: string;
    serialFontFamily?: string;
};

export type TextPaintLayout = {
    isSerial: boolean;
    text: string;
    fontSize: number;
    fontWeight: 500 | 700;
    fontFamily: string;
    color: string;
    paintX: number;
    paintY: number;
    textAnchor: "start" | "middle";
    rotation: AnnotationRotation | null;
    serial: {
        cx: number;
        cy: number;
        radius: number;
        borderWidth: number;
        fill: string | undefined;
        stroke: string | undefined;
        drawFill: boolean;
        drawStroke: boolean;
    } | null;
};

type RotatableAnnotation =
    | StickerShapeAnnotation
    | StickerTextAnnotation
    | StickerEffectAnnotation
    | StickerAnnotation;

export const getAnnotationRotation = (
    annotation: RotatableAnnotation,
): AnnotationRotation | null => {
    if (!("rotation" in annotation) || !annotation.rotation) return null;
    const center = getAnnotationCenter(annotation);
    return { cx: center.x, cy: center.y, degrees: annotation.rotation };
};

export const buildSvgRotationTransform = (rotation: AnnotationRotation | null) =>
    rotation ? `rotate(${rotation.degrees} ${rotation.cx} ${rotation.cy})` : undefined;

export const applyCanvasRotation = (
    context: CanvasRenderingContext2D,
    rotation: AnnotationRotation | null,
) => {
    if (!rotation) return;
    context.translate(rotation.cx, rotation.cy);
    context.rotate((rotation.degrees * Math.PI) / 180);
    context.translate(-rotation.cx, -rotation.cy);
};

export const buildArrowHeadPathD = (points: StickerPoint[]) =>
    points.length === 3
        ? `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y} L ${points[2].x} ${points[2].y} Z`
        : "";

const resolveShapePaintStyle = (shape: StickerShapeAnnotation): ShapePaintStyle => ({
    stroke: shape.style.color,
    strokeWidth: shape.style.width,
    fill: shape.style.fill,
    opacity: shape.style.opacity ?? 1,
    dashPattern: shape.style.dashPattern,
    drawStroke: hasVisibleStroke(shape.style.color, shape.style.width),
    drawFill: hasVisibleFill(shape.style.fill),
});

export const resolveShapePaintSpec = (
    shape: StickerShapeAnnotation,
    polygonSidesDefault = 6,
): ShapePaintSpec => {
    const style = resolveShapePaintStyle(shape);
    const rotation = getAnnotationRotation(shape);
    const cornerRadius = getAnnotationCornerRadius(shape);

    if (shape.type === "ellipse") {
        return {
            rotation,
            style,
            geometry: {
                kind: "ellipse",
                cx: shape.x + shape.w / 2,
                cy: shape.y + shape.h / 2,
                rx: shape.w / 2,
                ry: shape.h / 2,
            },
        };
    }

    if (shape.type === "triangle" || shape.type === "polygon") {
        const points =
            shape.type === "triangle"
                ? buildTrianglePoints(shape)
                : buildPolygonPoints(shape, shape.sides ?? polygonSidesDefault);
        return {
            rotation,
            style,
            geometry: { kind: "polygon", points, cornerRadius },
        };
    }

    return {
        rotation,
        style,
        geometry: {
            kind: "rect",
            x: shape.x,
            y: shape.y,
            w: shape.w,
            h: shape.h,
            rx: cornerRadius,
            ry: cornerRadius,
        },
    };
};

export const resolveLinePaintSpec = (line: StickerLineAnnotation): LinePaintSpec => {
    const isArrow = line.type === "arrow";
    const sizeOptions = getArrowHeadSizeOptions(line.style.width || 2);
    const shaftPoints = isArrow
        ? getArrowShaftPoints(line.points, sizeOptions)
        : line.points;
    const arrowHead = isArrow ? buildArrowHeadPolygon(line.points, sizeOptions) : null;
    return {
        shaftPoints,
        pathD: buildStrokePath(shaftPoints),
        arrowHead,
        arrowHeadPathD: arrowHead ? buildArrowHeadPathD(arrowHead) : "",
        style: line.style,
        dashCap: getStrokeDashArray(line.style.dashPattern) ? "butt" : "round",
    };
};

/** Draft preview: optionally trim shaft + build arrow head while dragging. */
export const resolveArrowDraftPaint = (
    points: StickerPoint[],
    strokeWidth: number,
    showArrowHead: boolean,
) => {
    if (!showArrowHead) {
        return {
            pathD: buildStrokePath(points),
            arrowHead: null as StickerPoint[] | null,
            arrowHeadPathD: "",
        };
    }
    const sizeOptions = getArrowHeadSizeOptions(strokeWidth);
    const arrowHead = buildArrowHeadPolygon(points, sizeOptions);
    return {
        pathD: buildStrokePath(getArrowShaftPoints(points, sizeOptions)),
        arrowHead,
        arrowHeadPathD: arrowHead ? buildArrowHeadPathD(arrowHead) : "",
    };
};

export const resolveTextPaintLayout = (
    text: StickerTextAnnotation,
    defaults?: TextPaintDefaults,
): TextPaintLayout => {
    const isSerial = text.type === "serial";
    const serialMetrics = buildSerialAnnotationMetrics(text.style.cornerRadius ?? 14);
    const fontSize =
        text.fontSize ??
        (isSerial
            ? serialMetrics.fontSize
            : (defaults?.textFontSize ?? DEFAULT_TEXT_FONT_SIZE));
    const fontFamily =
        text.fontFamily ??
        (isSerial
            ? (defaults?.serialFontFamily ?? "Segoe UI")
            : (defaults?.textFontFamily ?? "Segoe UI"));
    const borderWidth = text.style.width || serialMetrics.borderWidth;
    const paintY = isSerial ? text.y - fontSize / 2 : text.y + fontSize / 2;
    const paintX = isSerial ? text.x + serialMetrics.radius : text.x;

    return {
        isSerial,
        text: text.text,
        fontSize,
        fontWeight: isSerial ? 700 : 500,
        fontFamily,
        color: text.style.color,
        paintX,
        paintY,
        textAnchor: isSerial ? "middle" : "start",
        rotation: getAnnotationRotation(text),
        serial: isSerial
            ? {
                  cx: text.x + serialMetrics.radius,
                  cy: paintY,
                  radius: serialMetrics.radius,
                  borderWidth,
                  fill: text.style.fill,
                  stroke: text.style.color,
                  drawFill: hasVisibleFill(text.style.fill),
                  drawStroke: hasVisibleStroke(text.style.color, borderWidth),
              }
            : null,
    };
};
