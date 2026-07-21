import { clamp } from "../utils/math";

export const STICKER_TOP_STRIP_SLOT_WIDTH = 50;
export const STICKER_TOP_STRIP_SLOT_COUNT = 10;
export const STICKER_TOP_STRIP_MIN_WIDTH = STICKER_TOP_STRIP_SLOT_WIDTH * STICKER_TOP_STRIP_SLOT_COUNT;
export const STICKER_TOP_STRIP_HEIGHT = 50;
export const STICKER_TOP_STRIP_PROPERTY_BAR_HEIGHT = 40;

interface StickerTopStripAnchor {
    x: number;
    y: number;
    w: number;
    h: number;
}

interface StickerTopStripFrame {
    left: number;
    top: number;
    width: number;
    height: number;
}

interface StickerTopStripLayout {
    container: StickerTopStripFrame;
    mainBar: StickerTopStripFrame;
    propertyBar: StickerTopStripFrame | null;
}

export const computeStickerTopStripLayout = (
    anchor: StickerTopStripAnchor,
    viewportWidth: number,
    viewportHeight: number,
    showPropertyBar: boolean,
): StickerTopStripLayout => {
    const safeViewportWidth = Math.max(0, Math.round(viewportWidth));
    const safeViewportHeight = Math.max(0, Math.round(viewportHeight));
    const width = Math.min(STICKER_TOP_STRIP_MIN_WIDTH, safeViewportWidth);
    const maxLeft = Math.max(0, safeViewportWidth - width);
    const left = clamp(Math.round(anchor.x), 0, maxLeft);
    const propertyBarHeight = showPropertyBar ? STICKER_TOP_STRIP_PROPERTY_BAR_HEIGHT : 0;
    const totalHeight = STICKER_TOP_STRIP_HEIGHT + propertyBarHeight;

    const preferredAboveTop = Math.round(anchor.y - totalHeight);
    const preferredBelowTop = Math.round(anchor.y + anchor.h);
    const maxTop = Math.max(0, safeViewportHeight - totalHeight);
    const canFitAbove = preferredAboveTop >= 0;
    const canFitBelow = preferredBelowTop + totalHeight <= safeViewportHeight;

    let containerTop: number;
    if (canFitAbove) {
        containerTop = preferredAboveTop;
    } else if (canFitBelow) {
        containerTop = preferredBelowTop;
    } else {
        const availableAbove = clamp(Math.round(anchor.y), 0, safeViewportHeight);
        const availableBelow = Math.max(
            0,
            safeViewportHeight - Math.round(anchor.y + anchor.h),
        );
        containerTop = availableAbove >= availableBelow ? 0 : maxTop;
    }

    const top = clamp(containerTop, 0, maxTop);
    const propertyBar = showPropertyBar
        ? {
              left,
              top,
              width,
              height: STICKER_TOP_STRIP_PROPERTY_BAR_HEIGHT,
          }
        : null;

    return {
        container: {
            left,
            top,
            width,
            height: totalHeight,
        },
        mainBar: {
            left,
            top: top + propertyBarHeight,
            width,
            height: STICKER_TOP_STRIP_HEIGHT,
        },
        propertyBar,
    };
};
