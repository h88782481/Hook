import { unwrap } from "solid-js/store";
import {
    createSticker,
    stickerContentPayloadFromSticker,
    type SessionSticker,
    type Sticker,
} from "../types/stickerModel";
import { normalizePreviewSrc } from "./syncedImagePayload";

export interface FrozenStickerEntry {
    entryId: string;
    sourceStickerId: string;
    createdAt: string;
    snapshot: SessionSticker;
}

export const stickerToSessionSticker = (
    unit: Sticker,
    options?: { normalizePreview?: boolean },
): SessionSticker => {
    const content = stickerContentPayloadFromSticker(unit);
    return {
        id: unit.id,
        x: unit.x,
        y: unit.y,
        w: unit.w,
        h: unit.h,
        src: content.src || "",
        minified: content.minified ?? false,
        savedRect: content.savedRect || null,
        cropOffset: content.cropOffset || null,
        opacityNormal: content.opacityNormal ?? 1,
        opacityMini: content.opacityMini ?? 0.9,
        filePath: content.filePath || null,
        previewSrc: options?.normalizePreview
            ? normalizePreviewSrc(unit) || null
            : content.previewSrc || null,
        rasterizedAnnotationLayerSrc: content.rasterizedAnnotationLayerSrc || null,
        annotationState: content.annotationState || null,
        imageEditState: content.imageEditState || null,
        groupId: content.groupId || null,
        captureMeta: content.captureMeta || null,
    };
};

export const sessionStickerToSticker = (sticker: SessionSticker): Sticker =>
    createSticker({
        id: sticker.id,
        x: sticker.x,
        y: sticker.y,
        w: sticker.w,
        h: sticker.h,
        data: {
            src: sticker.src || undefined,
            minified: sticker.minified ?? false,
            savedRect: sticker.savedRect || undefined,
            cropOffset: sticker.cropOffset || undefined,
            opacityNormal: sticker.opacityNormal ?? 1,
            opacityMini: sticker.opacityMini ?? 0.9,
            previewSrc:
                sticker.previewSrc && sticker.previewSrc !== sticker.src
                    ? sticker.previewSrc
                    : undefined,
            filePath: sticker.filePath || undefined,
            rasterizedAnnotationLayerSrc: sticker.rasterizedAnnotationLayerSrc || undefined,
            annotationState: sticker.annotationState || undefined,
            imageEditState: sticker.imageEditState || undefined,
            groupId: sticker.groupId || undefined,
            captureMeta: sticker.captureMeta || undefined,
        },
    });

export const captureFrozenStickerSnapshot = (unit: Sticker): FrozenStickerEntry => ({
    entryId: crypto.randomUUID(),
    sourceStickerId: unit.id,
    createdAt: new Date().toISOString(),
    snapshot: structuredClone(unwrap(stickerToSessionSticker(unit))),
});

export const instantiateStickerFromFrozenSnapshot = (
    entry: FrozenStickerEntry,
    mouse: { x: number; y: number },
): Sticker => {
    const unit = sessionStickerToSticker(entry.snapshot);
    return createSticker({
        x: mouse.x + 50,
        y: mouse.y + 50,
        w: unit.w,
        h: unit.h,
        data: unit.data,
    });
};
