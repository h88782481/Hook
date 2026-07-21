/**
 * Clamp a value between min and max bounds.
 * If max < min, returns min.
 */
export const clamp = (value: number, min: number, max: number): number => {
    if (max < min) return min;
    return Math.min(Math.max(value, min), max);
};
