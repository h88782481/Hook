import type { Sticker } from "../types/stickerModel";

type ImagePayloadSticker = Pick<Sticker, "data">;

export const normalizePreviewSrc = (unit: ImagePayloadSticker) => {
    const previewSrc = unit.data.previewSrc;
    if (!previewSrc || previewSrc === unit.data.src) {
        return undefined;
    }
    return previewSrc;
};
