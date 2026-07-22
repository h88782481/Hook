import { clamp } from "../utils/math";

const STICKER_TOP_STRIP_SLOT_WIDTH = 50;
const STICKER_TOP_STRIP_SLOT_COUNT = 11;
const STICKER_TOP_STRIP_MIN_WIDTH = STICKER_TOP_STRIP_SLOT_WIDTH * STICKER_TOP_STRIP_SLOT_COUNT;
export const STICKER_TOP_STRIP_HEIGHT = 50;
const STICKER_TOP_STRIP_PROPERTY_BAR_HEIGHT = 40;

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
    /** Prefer keeping the main strip flush against the sticker edge. */
    placement: "above" | "below";
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

    // Prefer below the sticker; fall back to above when there isn't enough room.
    let placement: "above" | "below";
    let containerTop: number;
    if (canFitBelow) {
        placement = "below";
        containerTop = preferredBelowTop;
    } else if (canFitAbove) {
        placement = "above";
        containerTop = preferredAboveTop;
    } else {
        const availableAbove = clamp(Math.round(anchor.y), 0, safeViewportHeight);
        const availableBelow = Math.max(
            0,
            safeViewportHeight - Math.round(anchor.y + anchor.h),
        );
        placement = availableBelow > availableAbove ? "below" : "above";
        containerTop = placement === "below" ? maxTop : 0;
    }

    const top = clamp(containerTop, 0, maxTop);
    const placeBelow = placement === "below";

    // Keep the main tool strip flush against the sticker edge.
    // Below: [main][property]  |  Above: [property][main]
    const mainBarTop = placeBelow ? top : top + propertyBarHeight;
    const propertyBarTop = placeBelow ? top + STICKER_TOP_STRIP_HEIGHT : top;
    const propertyBar = showPropertyBar
        ? {
              left,
              top: propertyBarTop,
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
            top: mainBarTop,
            width,
            height: STICKER_TOP_STRIP_HEIGHT,
        },
        propertyBar,
        placement,
    };
};
