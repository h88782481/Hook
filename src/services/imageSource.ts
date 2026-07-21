import { convertFileSrc } from "@tauri-apps/api/core";

const URL_SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const WINDOWS_DRIVE_PATH_PATTERN = /^[a-zA-Z]:[\\/]/;
const WINDOWS_UNC_PATH_PATTERN = /^\\\\[^\\]+\\[^\\]+/;

const isLikelyLocalFilePath = (src: string | null | undefined) => {
    if (!src) return false;
    return WINDOWS_DRIVE_PATH_PATTERN.test(src) || WINDOWS_UNC_PATH_PATTERN.test(src);
};

/**
 * Single entry for turning any stored image reference into a URL the webview can paint.
 * Handles data/blob/asset/http URLs, Windows file paths, and other schemes.
 */
export const toDisplayImageSrc = (
    src: string | null | undefined,
    fileSrcConverter: (path: string) => string = convertFileSrc,
): string | undefined => {
    if (!src) return undefined;
    if (
        src.startsWith("data:") ||
        src.startsWith("blob:") ||
        src.startsWith("asset:") ||
        src.startsWith("http:") ||
        src.startsWith("https:")
    ) {
        return src;
    }
    if (isLikelyLocalFilePath(src)) {
        return fileSrcConverter(src);
    }
    if (URL_SCHEME_PATTERN.test(src)) {
        return src;
    }
    return src;
};

/** Capture payloads are always file-backed; resolve via the shared display-src entry. */
export const resolveCaptureDisplaySrc = (capture: { filePath: string }) => {
    const displaySrc = toDisplayImageSrc(capture.filePath);
    if (!displaySrc) {
        throw new Error("Capture response is missing a displayable filePath");
    }
    return displaySrc;
};
