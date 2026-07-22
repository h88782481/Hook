import { clamp } from "../utils/math";

/** Snow Shot–inspired compact floating toolbar metrics. */
export const STICKER_TOP_STRIP_SLOT_WIDTH = 36;
export const STICKER_TOP_STRIP_HEIGHT = 40;
export const STICKER_TOP_STRIP_PROPERTY_BAR_HEIGHT = 36;
export const STICKER_TOP_STRIP_DRAG_WIDTH = 22;
export const STICKER_TOP_STRIP_PAD_X = 8;
export const STICKER_TOP_STRIP_SPLITTER_WIDTH = 9;
/** Tools: select, shape, line, brush, label, effect, eraser, crop, undo, redo, rasterize, confirm */
export const STICKER_TOP_STRIP_TOOL_COUNT = 12;
export const STICKER_TOP_STRIP_SPLITTER_COUNT = 3;

const STICKER_TOP_STRIP_MIN_WIDTH =
    STICKER_TOP_STRIP_DRAG_WIDTH +
    STICKER_TOP_STRIP_PAD_X * 2 +
    STICKER_TOP_STRIP_TOOL_COUNT * STICKER_TOP_STRIP_SLOT_WIDTH +
    STICKER_TOP_STRIP_SPLITTER_COUNT * STICKER_TOP_STRIP_SPLITTER_WIDTH;

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

export interface StickerTopStripDragOffset {
    x: number;
    y: number;
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
    dragOffset: StickerTopStripDragOffset = { x: 0, y: 0 },
): StickerTopStripLayout => {
    const safeViewportWidth = Math.max(0, Math.round(viewportWidth));
    const safeViewportHeight = Math.max(0, Math.round(viewportHeight));
    const width = Math.min(STICKER_TOP_STRIP_MIN_WIDTH, safeViewportWidth);
    const maxLeft = Math.max(0, safeViewportWidth - width);
    // Snow Shot: prefer right-align to sticker when sticker is wider than toolbar.
    const preferredLeft =
        anchor.w > width
            ? Math.round(anchor.x + anchor.w - width)
            : Math.round(anchor.x);
    const left = clamp(preferredLeft + Math.round(dragOffset.x), 0, maxLeft);
    const propertyBarHeight = showPropertyBar ? STICKER_TOP_STRIP_PROPERTY_BAR_HEIGHT : 0;
    const totalHeight = STICKER_TOP_STRIP_HEIGHT + propertyBarHeight;
    const gap = 6;

    const preferredAboveTop = Math.round(anchor.y - totalHeight - gap);
    const preferredBelowTop = Math.round(anchor.y + anchor.h + gap);
    const maxTop = Math.max(0, safeViewportHeight - totalHeight);
    const canFitAbove = preferredAboveTop >= 0;
    const canFitBelow = preferredBelowTop + totalHeight <= safeViewportHeight;

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

    const top = clamp(containerTop + Math.round(dragOffset.y), 0, maxTop);
    const placeBelow = placement === "below";

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
