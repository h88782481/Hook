import type {
    StickerAnnotationState,
    StickerCaptureMeta,
    StickerGroup,
    StickerImageEditState,
} from "./stickerEditing";

export interface Port {
    id: string;
    type: "image" | "text" | "number" | "boolean" | "any";
    direction: "input" | "output";
    label?: string;
}

export interface UnitData {
    src?: string;
    minified?: boolean;
    savedRect?: { x: number; y: number; w: number; h: number };
    cropOffset?: { x: number; y: number };
    opacityNormal?: number;
    opacityMini?: number;

    portVisibility?: Record<string, boolean>;
    disabledParamValues?: Record<string, any>;

    previewSrc?: string;
    rasterizedAnnotationLayerSrc?: string;
    filePath?: string;
    dragOutFilePath?: string;
    outputs?: Record<string, unknown>;

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
    upstreamSourceUnitId?: string;
    upstreamSourceRevision?: number;
}

export interface Unit {
    id: string;
    type: "sticker";

    x: number;
    y: number;
    w: number;
    h: number;

    data: UnitData;
    params: Record<string, any>;

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
    params?: Record<string, unknown> | null;
    filePath?: string | null;
    rasterizedAnnotationLayerSrc?: string | null;
    outputs?: Record<string, unknown> | null;
    annotationState?: UnitData["annotationState"] | null;
    imageEditState?: UnitData["imageEditState"] | null;
    groupId?: string | null;
    captureMeta?: UnitData["captureMeta"] | null;
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
