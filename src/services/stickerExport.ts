import type { Sticker } from "../types/stickerModel";
import type {
    StickerAnnotation,
    StickerEffectAnnotation,
    StickerLineAnnotation,
    StickerTextAnnotation,
} from "../types/stickerEditing";
import {
    BLUR_EFFECT_OVERLAY_FILL,
    computeEffectSourceProjection,
    paintMosaicGrid,
    renderBlurToCanvas,
} from "./stickerEffects";
import { HIGHLIGHTER_LAYER_OPACITY } from "./stickerEditing";
import {
    applyCanvasRotation,
    getAnnotationRotation,
    resolveLinePaintSpec,
    resolveShapePaintSpec,
    resolveTextPaintLayout,
} from "./stickerAnnotationPaint";
import { traceRoundedPolygonPath } from "./stickerGeometry";
import {
    annotationRenderRank,
    loadImage,
    drawStrokePath,
    eraseStrokePathToTransparency,
    applyLineDash,
} from "./stickerCanvas";
import { resolveStickerBitmapSrc } from "./imageSource";

const applyShapePaintStyle = (
    context: CanvasRenderingContext2D,
    style: ReturnType<typeof resolveShapePaintSpec>["style"],
) => {
    context.strokeStyle = style.stroke;
    context.lineWidth = style.strokeWidth;
    context.globalAlpha = style.opacity;
    applyLineDash(context, style.dashPattern, style.strokeWidth);
};

const paintShapeFillAndStroke = (
    context: CanvasRenderingContext2D,
    style: ReturnType<typeof resolveShapePaintSpec>["style"],
) => {
    if (style.drawFill && style.fill) {
        context.fillStyle = style.fill;
        context.fill();
    }
    if (style.drawStroke) {
        context.stroke();
    }
};

const drawArrowHeadFromSpec = (
    context: CanvasRenderingContext2D,
    head: NonNullable<ReturnType<typeof resolveLinePaintSpec>["arrowHead"]>,
    style: StickerLineAnnotation["style"],
) => {
    context.save();
    context.beginPath();
    context.moveTo(head[0].x, head[0].y);
    context.lineTo(head[1].x, head[1].y);
    context.lineTo(head[2].x, head[2].y);
    context.closePath();
    context.fillStyle = style.color;
    context.globalAlpha = style.opacity ?? 1;
    context.fill();
    context.restore();
};

const drawAnnotation = (
    context: CanvasRenderingContext2D,
    annotation: StickerAnnotation,
    sourceImage: HTMLImageElement,
    unit: Sticker,
) => {
    switch (annotation.type) {
        case "rect":
        case "round-rect":
        case "ellipse":
        case "triangle":
        case "polygon": {
            const spec = resolveShapePaintSpec(annotation);
            context.save();
            applyCanvasRotation(context, spec.rotation);
            applyShapePaintStyle(context, spec.style);
            if (spec.geometry.kind === "ellipse") {
                context.beginPath();
                context.ellipse(
                    spec.geometry.cx,
                    spec.geometry.cy,
                    spec.geometry.rx,
                    spec.geometry.ry,
                    0,
                    0,
                    Math.PI * 2,
                );
                paintShapeFillAndStroke(context, spec.style);
            } else if (spec.geometry.kind === "polygon") {
                context.lineJoin = "round";
                traceRoundedPolygonPath(
                    context,
                    spec.geometry.points,
                    spec.geometry.cornerRadius,
                );
                paintShapeFillAndStroke(context, spec.style);
            } else if (spec.geometry.rx > 0) {
                context.beginPath();
                context.roundRect(
                    spec.geometry.x,
                    spec.geometry.y,
                    spec.geometry.w,
                    spec.geometry.h,
                    spec.geometry.rx,
                );
                paintShapeFillAndStroke(context, spec.style);
            } else {
                if (spec.style.drawFill && spec.style.fill) {
                    context.fillStyle = spec.style.fill;
                    context.fillRect(
                        spec.geometry.x,
                        spec.geometry.y,
                        spec.geometry.w,
                        spec.geometry.h,
                    );
                }
                if (spec.style.drawStroke) {
                    context.strokeRect(
                        spec.geometry.x,
                        spec.geometry.y,
                        spec.geometry.w,
                        spec.geometry.h,
                    );
                }
            }
            context.restore();
            return;
        }
        case "line":
        case "polyline":
        case "brush":
        case "highlighter":
        case "arrow": {
            const line = annotation as StickerLineAnnotation;
            const spec = resolveLinePaintSpec(line);
            drawStrokePath(context, spec.shaftPoints, line.style);
            if (spec.arrowHead) {
                drawArrowHeadFromSpec(context, spec.arrowHead, line.style);
            }
            return;
        }
        case "text":
        case "serial": {
            const layout = resolveTextPaintLayout(annotation as StickerTextAnnotation);
            context.save();
            context.font = `${layout.fontWeight} ${layout.fontSize}px "${layout.fontFamily}", sans-serif`;
            context.textBaseline = "middle";
            applyCanvasRotation(context, layout.rotation);
            if (layout.serial) {
                if (layout.serial.drawFill && layout.serial.fill) {
                    context.fillStyle = layout.serial.fill;
                    context.beginPath();
                    context.arc(
                        layout.serial.cx,
                        layout.serial.cy,
                        layout.serial.radius,
                        0,
                        Math.PI * 2,
                    );
                    context.fill();
                }
                if (layout.serial.drawStroke && layout.serial.stroke) {
                    context.strokeStyle = layout.serial.stroke;
                    context.lineWidth = layout.serial.borderWidth;
                    context.beginPath();
                    context.arc(
                        layout.serial.cx,
                        layout.serial.cy,
                        layout.serial.radius,
                        0,
                        Math.PI * 2,
                    );
                    context.stroke();
                }
                context.fillStyle = layout.color;
                const measure = context.measureText(layout.text);
                context.fillText(
                    layout.text,
                    layout.paintX - measure.width / 2,
                    layout.paintY,
                );
            } else {
                context.fillStyle = layout.color;
                context.fillText(layout.text, layout.paintX, layout.paintY);
            }
            context.restore();
            return;
        }
        case "mosaic":
        case "blur": {
            const effect = annotation as StickerEffectAnnotation;
            // Brush-stroke effects: render the full mosaic/blur over the stroke
            // bounding box into an offscreen layer, then keep only the painted
            // region by masking with the brush stroke (destination-in), and
            // composite the masked result back onto the main canvas.
            const boxW = Math.max(1, Math.ceil(effect.w));
            const boxH = Math.max(1, Math.ceil(effect.h));
            const points = effect.points ?? [];
            const brushWidth = Math.max(1, effect.brushWidth ?? effect.style.width ?? 12);

            const layer = document.createElement("canvas");
            layer.width = boxW;
            layer.height = boxH;
            const layerContext = layer.getContext("2d");
            if (!layerContext) {
                return;
            }

            // The layer is in box-local coordinates, so shift the projection by
            // -effect.x/-effect.y instead of +effect.x/+effect.y.
            const projection = computeEffectSourceProjection(
                { x: effect.x, y: effect.y, w: effect.w, h: effect.h },
                { w: unit.w, h: unit.h },
                { w: sourceImage.width, h: sourceImage.height },
                unit.data.imageEditState,
            );

            // Trace the brush stroke in box-local coordinates so both the mosaic
            // pattern stroke and the blur mask follow the painted path.
            const traceStrokePath = () => {
                layerContext.beginPath();
                if (points.length === 1) {
                    // Single tap: a round cap dot. Drawn as a 0-length segment so
                    // the round line cap paints a circle.
                    layerContext.moveTo(points[0].x - effect.x, points[0].y - effect.y);
                    layerContext.lineTo(points[0].x - effect.x + 0.01, points[0].y - effect.y);
                } else {
                    layerContext.moveTo(points[0].x - effect.x, points[0].y - effect.y);
                    for (let i = 1; i < points.length; i += 1) {
                        layerContext.lineTo(points[i].x - effect.x, points[i].y - effect.y);
                    }
                }
            };

            if (effect.type === "mosaic") {
                // Mosaic: paint a grid of square cells whose colors come from each
                // cell's ABSOLUTE sticker position (so the grid never repeats), then
                // mask it down to the brush stroke via destination-in. The cells
                // NEVER sample the underlying image, so the censored content cannot
                // leak. The box origin (effect.x/effect.y) is passed so the export
                // cells align to the same absolute grid as the live overlay.
                paintMosaicGrid(
                    layerContext,
                    boxW,
                    boxH,
                    Math.max(2, Math.round(effect.strength || 12)),
                    effect.x,
                    effect.y,
                );

                if (points.length > 0) {
                    layerContext.save();
                    layerContext.globalCompositeOperation = "destination-in";
                    layerContext.strokeStyle = "#000000";
                    layerContext.lineWidth = brushWidth;
                    layerContext.lineCap = "round";
                    layerContext.lineJoin = "round";
                    traceStrokePath();
                    layerContext.stroke();
                    layerContext.restore();
                }
            } else {
                // Blur: render the blurred source over the box, tint it, then mask
                // it down to the brush stroke via destination-in.
                if (projection) {
                    renderBlurToCanvas(
                        layerContext,
                        sourceImage,
                        projection,
                        effect.strength || 8,
                    );
                }
                layerContext.fillStyle = BLUR_EFFECT_OVERLAY_FILL;
                layerContext.fillRect(0, 0, boxW, boxH);

                if (points.length > 0) {
                    layerContext.save();
                    layerContext.globalCompositeOperation = "destination-in";
                    layerContext.strokeStyle = "#000000";
                    layerContext.lineWidth = brushWidth;
                    layerContext.lineCap = "round";
                    layerContext.lineJoin = "round";
                    traceStrokePath();
                    layerContext.stroke();
                    layerContext.restore();
                }
            }

            context.save();
            applyCanvasRotation(context, getAnnotationRotation(effect));
            context.drawImage(layer, effect.x, effect.y);
            context.restore();
            return;
        }
    }
};

const drawAnnotationsWithHighlighterLayer = (
    context: CanvasRenderingContext2D,
    annotations: StickerAnnotation[],
    sourceImage: HTMLImageElement,
    unit: Sticker,
    layerWidth: number,
    layerHeight: number,
) => {
    // Censoring effects sit at the bottom and blur renders below mosaic, so a
    // blur brush can never paint over (and erase) a mosaic covering the same
    // pixels. Rank is the primary key; zIndex preserves the within-rank order.
    const sorted = [...annotations].sort(
        (a, b) => annotationRenderRank(a.type) - annotationRenderRank(b.type) || a.zIndex - b.zIndex,
    );
    const highlighters = sorted.filter(
        (annotation): annotation is StickerLineAnnotation => annotation.type === "highlighter",
    );

    // Composite all highlighter strokes through one offscreen layer at full
    // opacity, then blit the layer once at HIGHLIGHTER_LAYER_OPACITY. This
    // prevents overlapping/self-crossing strokes from compounding their alpha
    // and matches the live <g opacity> rendering. The wash sits beneath the
    // other annotations, mirroring the live layer order.
    if (highlighters.length > 0 && layerWidth > 0 && layerHeight > 0) {
        const layer = document.createElement("canvas");
        layer.width = layerWidth;
        layer.height = layerHeight;
        const layerContext = layer.getContext("2d");
        if (layerContext) {
            for (const highlighter of highlighters) {
                drawStrokePath(layerContext, highlighter.points, {
                    color: highlighter.style.color,
                    width: highlighter.style.width,
                    opacity: 1,
                });
            }
            context.save();
            context.globalAlpha = HIGHLIGHTER_LAYER_OPACITY;
            context.drawImage(layer, 0, 0);
            context.restore();
        }
    }

    for (const annotation of sorted) {
        if (annotation.type === "highlighter") continue;
        drawAnnotation(context, annotation, sourceImage, unit);
    }
};

const renderStickerCompositeWithAnnotations = async (
    unit: Sticker,
    annotationsOverride: StickerAnnotation[],
    options?: {
        includeRasterizedAnnotationLayer?: boolean;
    },
): Promise<string> => {
    const baseSrc = resolveStickerBitmapSrc(unit.data, { useRasterizedBase: true });
    if (!baseSrc) {
        throw new Error("Sticker has no image source");
    }

    const image = await loadImage(baseSrc);
    const cropRect = unit.data.imageEditState?.cropRect;
    const sourceSize = unit.data.imageEditState?.sourceSize || { w: image.width, h: image.height };
    const renderWidth = Math.max(1, Math.round(unit.w));
    const renderHeight = Math.max(1, Math.round(unit.h));

    const canvas = document.createElement("canvas");
    canvas.width = renderWidth;
    canvas.height = renderHeight;
    const context = canvas.getContext("2d");
    if (!context) {
        throw new Error("Canvas context unavailable");
    }

    const radius = unit.data.imageEditState?.cornerRadius ?? 0;
    if (radius > 0) {
        context.save();
        context.beginPath();
        context.roundRect(0, 0, renderWidth, renderHeight, radius);
        context.clip();
    }

    context.save();
    context.globalAlpha = unit.data.opacityNormal ?? 1;
    if (unit.data.imageEditState?.flippedX || unit.data.imageEditState?.flippedY) {
        context.translate(unit.data.imageEditState?.flippedX ? renderWidth : 0, unit.data.imageEditState?.flippedY ? renderHeight : 0);
        context.scale(unit.data.imageEditState?.flippedX ? -1 : 1, unit.data.imageEditState?.flippedY ? -1 : 1);
    }

    if (cropRect) {
        context.drawImage(
            image,
            cropRect.x,
            cropRect.y,
            cropRect.w,
            cropRect.h,
            0,
            0,
            renderWidth,
            renderHeight,
        );
    } else {
        context.drawImage(image, 0, 0, renderWidth, renderHeight);
    }
    context.restore();

    for (const stroke of unit.data.imageEditState?.contentEraseStrokes || []) {
        eraseStrokePathToTransparency(context, stroke.points, stroke.width);
    }

    const borderWidth = unit.data.imageEditState?.borderWidth ?? 0;
    const borderColor = unit.data.imageEditState?.borderColor;
    if (borderWidth > 0 && borderColor) {
        context.save();
        context.strokeStyle = borderColor;
        context.lineWidth = borderWidth;
        const inset = borderWidth / 2;
        context.strokeRect(
            inset,
            inset,
            Math.max(0, renderWidth - borderWidth),
            Math.max(0, renderHeight - borderWidth),
        );
        context.restore();
    }

    if (options?.includeRasterizedAnnotationLayer !== false && unit.data.rasterizedAnnotationLayerSrc) {
        const annotationLayer = await loadImage(unit.data.rasterizedAnnotationLayerSrc);
        context.drawImage(annotationLayer, 0, 0, renderWidth, renderHeight);
    }

    drawAnnotationsWithHighlighterLayer(
        context,
        annotationsOverride,
        image,
        unit,
        renderWidth,
        renderHeight,
    );

    if (radius > 0) {
        context.restore();
    }

    return canvas.toDataURL("image/png");
};

export const renderStickerComposite = async (unit: Sticker): Promise<string> =>
    renderStickerCompositeWithAnnotations(
        unit,
        unit.data.annotationState?.elements || [],
    );

export const renderStickerBaseLayer = async (unit: Sticker): Promise<string> =>
    renderStickerCompositeWithAnnotations(unit, [], {
        includeRasterizedAnnotationLayer: false,
    });

export const renderStickerTransparentAnnotationLayer = async (
    unit: Sticker,
    annotationIds: string[],
): Promise<string> => {
    const baseSrc = resolveStickerBitmapSrc(unit.data, { useRasterizedBase: true });
    if (!baseSrc) {
        throw new Error("Sticker has no image source");
    }

    const annotationIdSet = new Set(annotationIds);
    const annotationsOverride = (unit.data.annotationState?.elements || []).filter((annotation) =>
        annotationIdSet.has(annotation.id),
    );

    if (annotationsOverride.length === 0) {
        throw new Error("No sticker annotations to rasterize");
    }

    const image = await loadImage(baseSrc);
    const renderWidth = Math.max(1, Math.round(unit.w));
    const renderHeight = Math.max(1, Math.round(unit.h));
    const canvas = document.createElement("canvas");
    canvas.width = renderWidth;
    canvas.height = renderHeight;
    const context = canvas.getContext("2d");
    if (!context) {
        throw new Error("Canvas context unavailable");
    }

    const radius = unit.data.imageEditState?.cornerRadius ?? 0;
    if (radius > 0) {
        context.save();
        context.beginPath();
        context.roundRect(0, 0, renderWidth, renderHeight, radius);
        context.clip();
    }

    if (unit.data.rasterizedAnnotationLayerSrc) {
        const existingLayer = await loadImage(unit.data.rasterizedAnnotationLayerSrc);
        context.drawImage(existingLayer, 0, 0, renderWidth, renderHeight);
    }

    drawAnnotationsWithHighlighterLayer(
        context,
        annotationsOverride,
        image,
        unit,
        renderWidth,
        renderHeight,
    );

    if (radius > 0) {
        context.restore();
    }

    return canvas.toDataURL("image/png");
};
