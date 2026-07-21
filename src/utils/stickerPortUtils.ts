import { Sticker } from "../types/stickerModel";

/** Minified sticker port box height used by the ports overlay. */
export const MINIFIED_PORT_BOX = 60;

/**
 * Relative Y of a port within a sticker's local box.
 * Stickers expose a single image input/output; index/count remain for layout math.
 */
export const calculatePortOffsetY = (
    isMinified: boolean,
    containerHeight: number,
    index = 0,
    count = 1,
): number => {
    const safeCount = Math.max(1, count);
    if (isMinified) {
        const step = containerHeight / safeCount;
        return index * step + step / 2;
    }
    return 36 + index * 36;
};

/** Absolute canvas Y of the sticker's primary image port. */
export const calculatePortY = (u: Sticker): number => {
    const isMinified = !!u.data.minified;
    const height = isMinified ? MINIFIED_PORT_BOX : u.h;
    return u.y + calculatePortOffsetY(isMinified, height);
};
