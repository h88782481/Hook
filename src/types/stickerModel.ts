import type {
    StickerAnnotationState,
    StickerCaptureMeta,
    StickerImageEditState,
} from "./stickerEditing";

export interface Port {
    id: string;
    type: "image";
    direction: "input" | "output";
    label?: string;
}

/**
 * Shared visual/content fields for a sticker image payload.
 * Used by in-memory StickerData, session persistence, and clipboard cascade.
 */
export interface StickerContentPayload {
    src?: string;
    previewSrc?: string;
    minified?: boolean;
    savedRect?: { x: number; y: number; w: number; h: number };
    cropOffset?: { x: number; y: number };
    opacityNormal?: number;
    opacityMini?: number;
    rasterizedAnnotationLayerSrc?: string;
    filePath?: string;
    dragOutFilePath?: string;
    annotationState?: StickerAnnotationState;
    imageEditState?: StickerImageEditState;
    groupId?: string;
    captureMeta?: StickerCaptureMeta;
}

export interface StickerData extends StickerContentPayload {
    stickerEditPropagation?: StickerEditPropagationState;
}

export interface StickerEditPropagationState {
    /** Default true. When false, upstream sticker annotation edits stop at this sticker. */
    acceptUpstream?: boolean;
    /** Set by direct user edits; upstream annotation edits no longer overwrite this sticker. */
    locallyEdited?: boolean;
    revision?: number;
}

export interface Sticker {
    id: string;

    x: number;
    y: number;
    w: number;
    h: number;

    data: StickerData;

    inputs: Port[];
    outputs: Port[];
}

export interface Link {
    id: string;
    fromStickerId: string;
    fromPortId: string;
    toStickerId: string;
    toPortId: string;
}

/** Session wire fields: same content payload, nullable for JSON round-trips. */
type SessionNullableContent = {
    [K in keyof Omit<StickerContentPayload, "dragOutFilePath">]?:
        | StickerContentPayload[K]
        | null;
};

export type SessionSticker = {
    id: string;
    x: number;
    y: number;
    w: number;
    h: number;
} & SessionNullableContent;

export interface SessionLink {
    id: string;
    fromStickerId: string;
    fromPortId: string;
    toStickerId: string;
    toPortId: string;
}

export interface SessionGroup {
    id: string;
    name: string;
    hidden?: boolean;
    locked?: boolean;
}

/**
 * Clipboard cascade payload: content fields plus paste positioning state.
 */
export interface ClipboardStickerPayload extends StickerContentPayload {
    src: string;
    w: number;
    h: number;

    originalId: string;
    originalX: number;
    originalY: number;
    nextCascadeX: number;
    nextCascadeY: number;
    offsetX: number;
    offsetY: number;
}

const STICKER_DEFAULT_PORTS = {
    inputs: [{ id: "image", type: "image" as const, direction: "input" as const, label: "Image" }],
    outputs: [{ id: "output_image", type: "image" as const, direction: "output" as const, label: "Image" }],
};

export const createSticker = (params: {
    id?: string;
    x: number;
    y: number;
    w: number;
    h: number;
    data?: StickerData;
}): Sticker => ({
    id: params.id ?? crypto.randomUUID(),
    x: params.x,
    y: params.y,
    w: params.w,
    h: params.h,
    inputs: [...STICKER_DEFAULT_PORTS.inputs],
    outputs: [...STICKER_DEFAULT_PORTS.outputs],
    data: params.data ?? {},
});

/** Extract the shared content payload from a live sticker (for clipboard / session). */
export const stickerContentPayloadFromSticker = (sticker: Sticker): StickerContentPayload => ({
    src: sticker.data.src,
    previewSrc: sticker.data.previewSrc,
    minified: sticker.data.minified,
    savedRect: sticker.data.savedRect,
    cropOffset: sticker.data.cropOffset,
    opacityNormal: sticker.data.opacityNormal,
    opacityMini: sticker.data.opacityMini,
    rasterizedAnnotationLayerSrc: sticker.data.rasterizedAnnotationLayerSrc,
    filePath: sticker.data.filePath,
    dragOutFilePath: sticker.data.dragOutFilePath,
    annotationState: sticker.data.annotationState,
    imageEditState: sticker.data.imageEditState,
    groupId: sticker.data.groupId,
    captureMeta: sticker.data.captureMeta,
});
