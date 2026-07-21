import type { Unit } from "../types/unit";

type ImagePayloadUnit = Pick<Unit, "data">;

export const normalizePreviewSrc = (unit: ImagePayloadUnit) => {
    const previewSrc = unit.data.previewSrc;
    if (!previewSrc || previewSrc === unit.data.src) {
        return undefined;
    }
    return previewSrc;
};
