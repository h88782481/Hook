import { unwrap } from "solid-js/store";
import {
    STICKER_DEFAULT_PORTS,
    type SessionSticker,
    type Unit,
} from "../types/unit";
import { normalizePreviewSrc } from "./syncedImagePayload";

/** Recycle/reference snapshots share the session sticker wire format. */
export type FrozenStickerSessionSnapshot = SessionSticker;

export interface FrozenStickerEntry {
    entryId: string;
    sourceStickerId: string;
    createdAt: string;
    snapshot: FrozenStickerSessionSnapshot;
}

export const unitToSessionSticker = (
    unit: Unit,
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

export const sessionStickerToUnit = (sticker: SessionSticker): Unit => ({
    id: sticker.id,
    type: "sticker",
    x: sticker.x,
    y: sticker.y,
    w: sticker.w,
    h: sticker.h,
    inputs: [...STICKER_DEFAULT_PORTS.inputs],
    outputs: [...STICKER_DEFAULT_PORTS.outputs],
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

export const captureFrozenStickerSnapshot = (unit: Unit): FrozenStickerEntry => ({
    entryId: crypto.randomUUID(),
    sourceStickerId: unit.id,
    createdAt: new Date().toISOString(),
    snapshot: structuredClone(unwrap(unitToSessionSticker(unit))),
});

export const instantiateStickerFromFrozenSnapshot = (
    entry: FrozenStickerEntry,
    mouse: { x: number; y: number },
): Unit => {
    const unit = sessionStickerToUnit(entry.snapshot);
    return {
        ...unit,
        id: crypto.randomUUID(),
        x: mouse.x + 50,
        y: mouse.y + 50,
        inputs: [...STICKER_DEFAULT_PORTS.inputs],
        outputs: [...STICKER_DEFAULT_PORTS.outputs],
    };
};
