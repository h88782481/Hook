import { unwrap } from "solid-js/store";
import {
    createSticker,
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
): SessionSticker => ({
    id: unit.id,
    src: unit.data.src || "",
    x: unit.x,
    y: unit.y,
    w: unit.w,
    h: unit.h,
    minified: unit.data.minified ?? false,
    savedRect: unit.data.savedRect || null,
    cropOffset: unit.data.cropOffset || null,
    opacityNormal: unit.data.opacityNormal ?? 1,
    opacityMini: unit.data.opacityMini ?? 0.9,
    filePath: unit.data.filePath || null,
    previewSrc: options?.normalizePreview
        ? normalizePreviewSrc(unit) || null
        : unit.data.previewSrc || null,
    rasterizedAnnotationLayerSrc: unit.data.rasterizedAnnotationLayerSrc || null,
    annotationState: unit.data.annotationState || null,
    imageEditState: unit.data.imageEditState || null,
    groupId: unit.data.groupId || null,
    captureMeta: unit.data.captureMeta || null,
});

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
