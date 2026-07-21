import { Sticker } from "../types/stickerModel";

/**
 * Calculates the Y position of a port on a sticker.
 * Stickers expose a single image input/output.
 */
export const calculatePortY = (u: Sticker, _portName: string, _isInput: boolean): number => {
    const index = 0;
    const count = 1;

    if (u.data.minified) {
        const step = u.h / count;
        return u.y + (index * step) + (step / 2);
    }

    return u.y + 36 + (index * 36);
};
