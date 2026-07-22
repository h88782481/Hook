import type {
    ContentEraserStroke,
    StickerAnnotation,
    StickerAnnotationState,
    StickerEffectAnnotation,
    StickerImageEditState,
    StickerLineAnnotation,
    StickerPoint,
    StickerShapeAnnotation,
    StickerTextAnnotation,
} from "../types/stickerEditing";
import type { Link, StickerEditPropagationState, Sticker } from "../types/stickerModel";
import { scaleAnnotation } from "./stickerGeometry";

interface StickerEditPropagationPatch {
    stickerId: string;
    data: Partial<Sticker["data"]>;
}

interface BuildStickerEditPropagationPatchesInput {
    stickers: readonly Sticker[];
    links: readonly Link[];
    sourceStickerId: string;
}

const cloneAnnotationState = (state: StickerAnnotationState): StickerAnnotationState =>
    structuredClone(state);

const samePoint = (a: StickerPoint, b: StickerPoint) =>
    Math.abs(a.x - b.x) < 0.0001 && Math.abs(a.y - b.y) < 0.0001;

const clipSegmentToFrame = (
    start: StickerPoint,
    end: StickerPoint,
    frame: Pick<Sticker, "w" | "h">,
): [StickerPoint, StickerPoint] | undefined => {
    const minX = 0;
    const minY = 0;
    const maxX = frame.w;
    const maxY = frame.h;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    let entering = 0;
    let leaving = 1;

    const clip = (p: number, q: number) => {
        if (p === 0) return q >= 0;

        const ratio = q / p;
        if (p < 0) {
            if (ratio > leaving) return false;
            if (ratio > entering) entering = ratio;
            return true;
        }

        if (ratio < entering) return false;
        if (ratio < leaving) leaving = ratio;
        return true;
    };

    if (
        !clip(-dx, start.x - minX) ||
        !clip(dx, maxX - start.x) ||
        !clip(-dy, start.y - minY) ||
        !clip(dy, maxY - start.y)
    ) {
        return undefined;
    }

    return [
        { x: start.x + entering * dx, y: start.y + entering * dy },
        { x: start.x + leaving * dx, y: start.y + leaving * dy },
    ];
};

const clipPointPathToFrame = (
    points: readonly StickerPoint[],
    frame: Pick<Sticker, "w" | "h">,
): StickerPoint[][] => {
    if (frame.w <= 0 || frame.h <= 0 || points.length < 2) return [];

    const groups: StickerPoint[][] = [];
    let current: StickerPoint[] = [];

    for (let index = 1; index < points.length; index += 1) {
        const clipped = clipSegmentToFrame(points[index - 1], points[index], frame);
        if (!clipped) {
            if (current.length >= 2) groups.push(current);
            current = [];
            continue;
        }

        const [segmentStart, segmentEnd] = clipped;
        const last = current[current.length - 1];
        if (!last) {
            current = [segmentStart, segmentEnd];
            continue;
        }

        if (!samePoint(last, segmentStart)) {
            if (current.length >= 2) groups.push(current);
            current = [segmentStart, segmentEnd];
            continue;
        }

        if (!samePoint(last, segmentEnd)) {
            current = [...current, segmentEnd];
        }
    }

    if (current.length >= 2) groups.push(current);
    return groups;
};

const withClippedId = (id: string, index: number) => (index === 0 ? id : `${id}:clip${index + 1}`);

const clipBoxToFrame = <T extends StickerShapeAnnotation | StickerEffectAnnotation>(
    annotation: T,
    frame: Pick<Sticker, "w" | "h">,
): T | undefined => {
    const x = Math.max(0, annotation.x);
    const y = Math.max(0, annotation.y);
    const right = Math.min(frame.w, annotation.x + annotation.w);
    const bottom = Math.min(frame.h, annotation.y + annotation.h);
    if (right <= x || bottom <= y) return undefined;

    return {
        ...annotation,
        x,
        y,
        w: right - x,
        h: bottom - y,
    };
};

const clipAnnotationToFrame = (
    annotation: StickerAnnotation,
    frame: Pick<Sticker, "w" | "h">,
): StickerAnnotation[] => {
    if (
        annotation.type === "rect" ||
        annotation.type === "round-rect" ||
        annotation.type === "ellipse" ||
        annotation.type === "mosaic" ||
        annotation.type === "blur"
    ) {
        const clipped = clipBoxToFrame(annotation, frame);
        return clipped ? [clipped] : [];
    }

    if (annotation.type === "text" || annotation.type === "serial") {
        const text = annotation as StickerTextAnnotation;
        return text.x >= 0 && text.x <= frame.w && text.y >= 0 && text.y <= frame.h
            ? [text]
            : [];
    }

    const line = annotation as StickerLineAnnotation;
    return clipPointPathToFrame(line.points, frame).map((points, index) => ({
        ...line,
        id: withClippedId(line.id, index),
        points,
    }));
};

const getContainedFrameTransform = (
    sourceFrame: Pick<Sticker, "w" | "h">,
    targetFrame: Pick<Sticker, "w" | "h">,
) => {
    if (sourceFrame.w === 0 || sourceFrame.h === 0) {
        return {
            scale: 1,
            offsetX: (targetFrame.w - sourceFrame.w) / 2,
            offsetY: (targetFrame.h - sourceFrame.h) / 2,
        };
    }

    const scale = Math.min(targetFrame.w / sourceFrame.w, targetFrame.h / sourceFrame.h);
    return {
        scale,
        offsetX: (targetFrame.w - sourceFrame.w * scale) / 2,
        offsetY: (targetFrame.h - sourceFrame.h * scale) / 2,
    };
};

const mapStickerAnnotationStateToContainedFrame = (
    state: StickerAnnotationState | undefined,
    sourceFrame: Pick<Sticker, "w" | "h">,
    targetFrame: Pick<Sticker, "w" | "h">,
): StickerAnnotationState | undefined => {
    if (!state) return undefined;

    const transform = getContainedFrameTransform(sourceFrame, targetFrame);
    const cloned = cloneAnnotationState(state);

    return {
        serialCounter: cloned.serialCounter,
        elements: cloned.elements.flatMap((annotation) =>
            clipAnnotationToFrame(annotation, sourceFrame).map((clipped) =>
                scaleAnnotation(
                    clipped,
                    transform.scale,
                    transform.scale,
                    transform.offsetX,
                    transform.offsetY,
                ),
            ),
        ),
    };
};

const clipContentEraserStrokeToFrame = (
    stroke: ContentEraserStroke,
    frame: Pick<Sticker, "w" | "h">,
): ContentEraserStroke[] =>
    clipPointPathToFrame(stroke.points, frame).map((points, index) => ({
        ...stroke,
        id: withClippedId(stroke.id, index),
        points,
    }));

const mapContentEraserStrokeToContainedFrame = (
    stroke: ContentEraserStroke,
    scale: number,
    offsetX: number,
    offsetY: number,
): ContentEraserStroke => ({
    ...stroke,
    points: stroke.points.map((point) => ({
        x: point.x * scale + offsetX,
        y: point.y * scale + offsetY,
    })),
    width: stroke.width * Math.abs(scale),
});

const mapStickerImageEditStateToContainedFrame = (
    state: StickerImageEditState | undefined,
    sourceFrame: Pick<Sticker, "w" | "h">,
    targetFrame: Pick<Sticker, "w" | "h">,
): StickerImageEditState | undefined => {
    if (!state) return undefined;

    const transform = getContainedFrameTransform(sourceFrame, targetFrame);

    return {
        ...state,
        contentEraseStrokes: state.contentEraseStrokes.flatMap((stroke) =>
            clipContentEraserStrokeToFrame(stroke, sourceFrame).map((clipped) =>
                mapContentEraserStrokeToContainedFrame(
                    clipped,
                    transform.scale,
                    transform.offsetX,
                    transform.offsetY,
                ),
            ),
        ),
        borderWidth:
            state.borderWidth === undefined
                ? undefined
                : state.borderWidth * Math.abs(transform.scale),
        cornerRadius:
            state.cornerRadius === undefined
                ? undefined
                : state.cornerRadius * Math.abs(transform.scale),
    };
};

export const markStickerEditPropagationLocally = (
    previous?: StickerEditPropagationState,
): StickerEditPropagationState => ({
    ...previous,
    acceptUpstream: previous?.acceptUpstream ?? true,
    locallyEdited: true,
    revision: (previous?.revision ?? 0) + 1,
});

const shouldAcceptUpstreamStickerEdit = (unit: Sticker) => {
    const propagation = unit.data.stickerEditPropagation;
    return (propagation?.acceptUpstream ?? true) && !propagation?.locallyEdited;
};

export const buildStickerEditPropagationPatches = ({
    stickers,
    links,
    sourceStickerId,
}: BuildStickerEditPropagationPatchesInput): StickerEditPropagationPatch[] => {
    const workingStickers = new Map(stickers.map((sticker) => [sticker.id, structuredClone(sticker)] as const));
    const patches: StickerEditPropagationPatch[] = [];
    const visitedEdges = new Set<string>();

    const visit = (fromStickerId: string) => {
        const sourceSticker = workingStickers.get(fromStickerId);
        if (!sourceSticker) return;

        const outgoingLinks = links.filter((link) => link.fromStickerId === fromStickerId);
        outgoingLinks.forEach((link) => {
            const edgeKey = `${link.fromStickerId}->${link.toStickerId}:${link.id}`;
            if (visitedEdges.has(edgeKey)) return;
            visitedEdges.add(edgeKey);

            const targetSticker = workingStickers.get(link.toStickerId);
            if (!targetSticker) return;
            if (!shouldAcceptUpstreamStickerEdit(targetSticker)) return;

            const annotationState = mapStickerAnnotationStateToContainedFrame(
                sourceSticker.data.annotationState,
                sourceSticker,
                targetSticker,
            );
            const imageEditState = mapStickerImageEditStateToContainedFrame(
                sourceSticker.data.imageEditState,
                sourceSticker,
                targetSticker,
            );
            const data: Partial<Sticker["data"]> = {
                annotationState,
                imageEditState,
                stickerEditPropagation: {
                    ...targetSticker.data.stickerEditPropagation,
                    acceptUpstream: targetSticker.data.stickerEditPropagation?.acceptUpstream ?? true,
                    locallyEdited: false,
                },
            };

            const nextTarget: Sticker = {
                ...targetSticker,
                data: {
                    ...targetSticker.data,
                    ...data,
                },
            };
            workingStickers.set(targetSticker.id, nextTarget);
            patches.push({ stickerId: targetSticker.id, data });
            visit(targetSticker.id);
        });
    };

    visit(sourceStickerId);
    return patches;
};
