import type {
    StickerAnnotationState,
    StickerCaptureMeta,
    StickerGroup,
    StickerImageEditState,
} from "./stickerEditing";

export interface Port {
    id: string;
    type: "image";
    direction: "input" | "output";
    label?: string;
}

export interface StickerData {
    src?: string;
    minified?: boolean;
    savedRect?: { x: number; y: number; w: number; h: number };
    cropOffset?: { x: number; y: number };
  opacityNormal?: number;
  opacityMini?: number;

  previewSrc?: string;
    rasterizedAnnotationLayerSrc?: string;
    filePath?: string;
    dragOutFilePath?: string;

    annotationState?: StickerAnnotationState;
    imageEditState?: StickerImageEditState;
    stickerEditPropagation?: StickerEditPropagationState;
    groupId?: string;
    captureMeta?: StickerCaptureMeta;
}

export interface StickerEditPropagationState {
    /** Default true. When false, upstream sticker annotation edits stop at this sticker. */
    acceptUpstream?: boolean;
    /** Set by direct user edits; upstream annotation edits no longer overwrite this sticker. */
    locallyEdited?: boolean;
    revision?: number;
    upstreamSourceStickerId?: string;
    upstreamSourceRevision?: number;
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
    fromUnitId: string;
    fromPortId: string;
    toUnitId: string;
    toPortId: string;
}

export interface SessionSticker {
    id: string;
    x: number;
    y: number;
    w: number;
    h: number;
    src?: string | null;
    previewSrc?: string | null;
    minified?: boolean | null;
    savedRect?: { x: number; y: number; w: number; h: number } | null;
    cropOffset?: { x: number; y: number } | null;
    opacityNormal?: number | null;
    opacityMini?: number | null;
    filePath?: string | null;
    rasterizedAnnotationLayerSrc?: string | null;
    annotationState?: StickerData["annotationState"] | null;
    imageEditState?: StickerData["imageEditState"] | null;
    groupId?: string | null;
    captureMeta?: StickerData["captureMeta"] | null;
}

export interface SessionLink {
    id: string;
    fromUnitId: string;
    fromPortId: string;
    toUnitId: string;
    toPortId: string;
}

export interface SessionGroup {
    id: string;
    name: string;
    hidden?: boolean;
    locked?: boolean;
}

export type { StickerGroup };

export const STICKER_DEFAULT_PORTS = {
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
