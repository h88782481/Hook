/**
 * Clamp a value between min and max bounds.
 * If max < min, returns min.
 */
export const clamp = (value: number, min: number, max: number): number => {
    if (max < min) return min;
    return Math.min(Math.max(value, min), max);
};

/**
 * Browser wheel → zoom scale factor.
 * deltaY < 0 (wheel up) zooms in. Clamped to avoid huge single-tick jumps.
 */
export const wheelZoomScaleFactor = (
    deltaY: number,
    min = 0.5,
    max = 1.5,
    sensitivity = 0.001,
): number => clamp(Math.exp(-deltaY * sensitivity), min, max);
