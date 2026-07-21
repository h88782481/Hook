export const TRANSPARENT_COLOR = "transparent";

export type RgbaColor = { r: number; g: number; b: number; a: number };

const DEFAULT_RGBA: RgbaColor = { r: 255, g: 0, b: 0, a: 1 };

const parseHexByte = (str: string, fallback: number) => {
    const parsed = parseInt(str, 16);
    return Number.isNaN(parsed) ? fallback : parsed;
};

const toHexByte = (n: number) => Math.round(n).toString(16).padStart(2, "0");

/** Parse #RGB / #RRGGBB / #RRGGBBAA / "transparent" into RGBA (0-255, alpha 0-1). */
export const hexToRgba = (hex: string, fallback: RgbaColor = DEFAULT_RGBA): RgbaColor => {
    if (!hex || typeof hex !== "string") {
        return { ...fallback };
    }
    if (hex.trim().toLowerCase() === TRANSPARENT_COLOR) {
        return { r: fallback.r, g: fallback.g, b: fallback.b, a: 0 };
    }
    const cleaned = hex.replace("#", "");
    if (cleaned.length === 8) {
        return {
            r: parseHexByte(cleaned.substring(0, 2), 0),
            g: parseHexByte(cleaned.substring(2, 4), 0),
            b: parseHexByte(cleaned.substring(4, 6), 0),
            a: parseHexByte(cleaned.substring(6, 8), 255) / 255,
        };
    }
    if (cleaned.length === 6) {
        return {
            r: parseHexByte(cleaned.substring(0, 2), 0),
            g: parseHexByte(cleaned.substring(2, 4), 0),
            b: parseHexByte(cleaned.substring(4, 6), 0),
            a: 1,
        };
    }
    if (cleaned.length === 3 && /^[0-9a-fA-F]{3}$/.test(cleaned)) {
        return {
            r: parseHexByte(cleaned[0] + cleaned[0], 0),
            g: parseHexByte(cleaned[1] + cleaned[1], 0),
            b: parseHexByte(cleaned[2] + cleaned[2], 0),
            a: 1,
        };
    }
    return { ...fallback };
};

/** Encode RGBA to #RRGGBB or #RRGGBBAA when alpha < 1. */
export const rgbaToHex = (r: number, g: number, b: number, a: number): string => {
    if (a < 1) {
        return `#${toHexByte(r)}${toHexByte(g)}${toHexByte(b)}${toHexByte(a * 255)}`;
    }
    return `#${toHexByte(r)}${toHexByte(g)}${toHexByte(b)}`;
};

/**
 * Alpha (0-1) encoded in a color string.
 * Supports "transparent" (=0), #RRGGBBAA, and treats other hex as opaque.
 */
const getColorAlpha = (color: string | undefined): number => {
    if (!color) return 0;
    const trimmed = color.trim().toLowerCase();
    if (trimmed === TRANSPARENT_COLOR) return 0;
    const hex = trimmed.replace(/^#/, "");
    if (/^[0-9a-f]{8}$/.test(hex)) {
        return parseInt(hex.slice(6, 8), 16) / 255;
    }
    return 1;
};

export const isTransparentColor = (color: string | undefined) =>
    !color ||
    color.trim().toLowerCase() === TRANSPARENT_COLOR ||
    getColorAlpha(color) === 0;

/** Normalize palette entries to #rrggbb / #rrggbbaa / "transparent". */
export const normalizePaletteColor = (color: string): string | null => {
    const trimmed = color.trim();
    if (!trimmed) return null;
    if (trimmed.toLowerCase() === TRANSPARENT_COLOR) {
        return TRANSPARENT_COLOR;
    }

    const normalized = trimmed.replace(/^#/, "");
    if (/^[0-9a-fA-F]{3}$/.test(normalized)) {
        return `#${normalized
            .split("")
            .map((part) => `${part}${part}`)
            .join("")
            .toLowerCase()}`;
    }
    if (/^[0-9a-fA-F]{6}$/.test(normalized)) {
        return `#${normalized.toLowerCase()}`;
    }
    if (/^[0-9a-fA-F]{8}$/.test(normalized)) {
        const hex = normalized.toLowerCase();
        const alpha = parseInt(hex.slice(6, 8), 16);
        if (alpha === 0) {
            return TRANSPARENT_COLOR;
        }
        return `#${hex}`;
    }
    return null;
};
