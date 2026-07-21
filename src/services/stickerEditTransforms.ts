import type {
    StickerAnnotationState,
    StickerImageEditState,
} from "../types/stickerEditing";
import type { Sticker } from "../types/stickerModel";
import {
    flipAnnotation,
    flipContentEraserStroke,
    scaleContentEraserStroke,
    type FlipAxis,
    type StickerFrame,
} from "./stickerAnnotationTransforms";
import { scaleStickerAnnotationState } from "./stickerEditPropagation";
import { scaleStrokeWidth } from "./stickerGeometry";

const getScale = (sourceFrame: StickerFrame, targetFrame: StickerFrame) => ({
    x: sourceFrame.w === 0 ? 1 : targetFrame.w / sourceFrame.w,
    y: sourceFrame.h === 0 ? 1 : targetFrame.h / sourceFrame.h,
});

export const scaleStickerImageEditState = (
    state: StickerImageEditState | undefined,
    sourceFrame: StickerFrame,
    targetFrame: StickerFrame,
): StickerImageEditState | undefined => {
    if (!state) return undefined;

    const scale = getScale(sourceFrame, targetFrame);

    return {
        ...state,
        contentEraseStrokes: state.contentEraseStrokes.map((stroke) =>
            scaleContentEraserStroke(stroke, scale.x, scale.y),
        ),
        borderWidth:
            state.borderWidth === undefined
                ? undefined
                : scaleStrokeWidth(state.borderWidth, scale.x, scale.y),
        cornerRadius:
            state.cornerRadius === undefined
                ? undefined
                : scaleStrokeWidth(state.cornerRadius, scale.x, scale.y),
    };
};

export const flipStickerAnnotationStateForFrame = (
    state: StickerAnnotationState | undefined,
    frame: StickerFrame,
    axis: FlipAxis,
): StickerAnnotationState | undefined => {
    if (!state) return undefined;

    return {
        serialCounter: state.serialCounter,
        elements: state.elements.map((annotation) => flipAnnotation(annotation, frame, axis)),
    };
};

export const flipStickerImageEditStateForFrame = (
    state: StickerImageEditState | undefined,
    frame: StickerFrame,
    axis: FlipAxis,
): StickerImageEditState | undefined => {
    if (!state) return undefined;

    return {
        ...state,
        contentEraseStrokes: state.contentEraseStrokes.map((stroke) =>
            flipContentEraserStroke(stroke, frame, axis),
        ),
    };
};

export const scaleStickerEditDataForFrame = (
    data: Sticker["data"],
    sourceFrame: StickerFrame,
    targetFrame: StickerFrame,
): Partial<Sticker["data"]> => {
    const updates: Partial<Sticker["data"]> = {};

    const annotationState = scaleStickerAnnotationState(
        data.annotationState,
        sourceFrame,
        targetFrame,
    );
    if (annotationState) {
        updates.annotationState = annotationState;
    }

    const imageEditState = scaleStickerImageEditState(
        data.imageEditState,
        sourceFrame,
        targetFrame,
    );
    if (imageEditState) {
        updates.imageEditState = imageEditState;
    }

    return updates;
};

export const flipStickerEditDataForFrame = (
    data: Sticker["data"],
    frame: StickerFrame,
    axis: FlipAxis,
): Partial<Sticker["data"]> => {
    const updates: Partial<Sticker["data"]> = {};

    const annotationState = flipStickerAnnotationStateForFrame(data.annotationState, frame, axis);
    if (annotationState) {
        updates.annotationState = annotationState;
    }

    const imageEditState = flipStickerImageEditStateForFrame(data.imageEditState, frame, axis);
    if (imageEditState) {
        updates.imageEditState = imageEditState;
    }

    return updates;
};
