import { unwrap } from "solid-js/store";
import { api } from "../services/api";
import { createSticker, stickerContentPayloadFromSticker, type ClipboardStickerPayload } from "../types/stickerModel";
import { mousePos, selectedStickerId, selectedStickerAnnotationId, clipboard, setClipboard, ClipboardData, selectionActions, uiActions } from "../store/uiStore";
import { logger } from "../services/logger";
import { stickerStore } from "../store/stickerStore";
import { syncService } from "../services/syncService";
import { renderStickerComposite } from "../services/stickerExport";
import { captureStickerEditSnapshot } from "../services/stickerHistory";
import { duplicateAnnotationById } from "../services/stickerAnnotationMutations";
import type { Sticker } from "../types/stickerModel";

/** Copy a sticker image to internal + system clipboard (ignores annotation selection). */
export async function copyStickerImageById(stickerId: string): Promise<boolean> {
    const unit = stickerStore.stickers.find((item) => item.id === stickerId);
    if (!unit) return false;

    const mp = mousePos();
    const s = unwrap(unit);
    const content = stickerContentPayloadFromSticker(s);
    const nextClipState: ClipboardStickerPayload = {
        ...content,
        src: content.src || "",
        dragOutFilePath: content.dragOutFilePath || content.filePath,
        w: s.w,
        h: s.h,
        offsetX: mp.x - s.x,
        offsetY: mp.y - s.y,
        originalId: s.id,
        originalX: s.x,
        originalY: s.y,
        nextCascadeX: s.x + 20,
        nextCascadeY: s.y + 20,
    };

    setClipboard(nextClipState);
    logger.debug("Copied sticker to internal clipboard", { stickerId });

    try {
        const exportBase64 = await renderStickerComposite(unit as Sticker);
        if (s.data.src) {
            const path = await api.copyStickerImageToSmartClipboard(exportBase64);
            setClipboard((current) =>
                current && current.originalId === s.id
                    ? {
                          ...current,
                          dragOutFilePath: path,
                      }
                    : current,
            );
            logger.info(`Copied to smart system clipboard as image/file: ${path}`);
        } else {
            await navigator.clipboard.writeText(JSON.stringify(nextClipState));
        }
        return true;
    } catch (error) {
        console.error("Clipboard write failed", error);
        return false;
    }
}

export function useClipboard() {

    const handleCopy = async () => {
        const id = selectedStickerId();
        const annotationId = selectedStickerAnnotationId();

        if (id) {
            const unit = stickerStore.stickers.find(u => u.id === id);
            if (unit) {
                if (annotationId && unit.data.annotationState) {
                    const duplicated = duplicateAnnotationById(unit.data.annotationState, annotationId);
                    if (duplicated.createdAnnotationId) {
                        uiActions.pushStickerHistory(id, captureStickerEditSnapshot(unit));
                        stickerStore.actions.updateStickerData(id, {
                            annotationState: {
                                ...unit.data.annotationState,
                                elements: duplicated.elements,
                            },
                        });
                        uiActions.setSelectedStickerAnnotation(duplicated.createdAnnotationId);
                        await syncService.scheduleSessionSync();
                        return;
                    }
                }

                await copyStickerImageById(id);
                return;
            }
        }
    };

    const handlePaste = async () => {
        // 0. Get Absolute Cursor Position from Backend (Handles transparent/click-through areas)
        let mp = mousePos(); // Fallback
        try {
            const rawPos = await api.getCursorPosition();
            if (rawPos) {
                 // Convert physical pixels to logical CSS pixels if needed
                 // The backend uses Window::cursor_position() which returns physical pixels?
                 // Wait, tauri::CursorPosition returns Logical or Physical?
                 // lib.rs uses `PhysicalPosition<f64>`, so we need to divide by DPR.
                 const dpr = window.devicePixelRatio || 1;
                 mp = { x: rawPos.x / dpr, y: rawPos.y / dpr };
                 logger.debug("Paste: Using Backend Cursor Pos", mp);
            }
        } catch (e) {
            console.warn("Backend cursor fetch failed, using cached JS mousePos", e);
        }

        // 1. Try Internal Clipboard First (Fastest, preserves Types)
        const clip = clipboard();

        if (clip) {
            pasteClipboardData(clip, mp);
            return;
        }

        // 2. Try System Clipboard
        try {
            const text = await navigator.clipboard.readText();
            if (text) {
                // Try Parse as ClipboardData
                try {
                    const data = JSON.parse(text);
                    // Check if it matches ClipboardData structure (Sticker)
                    if (data.src && (data.w || data.h)) {
                        pasteClipboardData(data, mp);
                        return;
                    }
                } catch (e) {
                    // Not JSON
                }
            }

            // 3. Image Binary
             const items = await navigator.clipboard.read();
             for (const item of items) {
                 if (item.types.some(t => t.startsWith("image/"))) {
                     const blob = await item.getType(item.types.find(t => t.startsWith("image/"))!);
                     const reader = new FileReader();
                     reader.onload = async () => {
                          const base64 = reader.result as string;
                          createImageSticker(base64, mp); // Pass MP explicitly
                     };
                     reader.readAsDataURL(blob);
                     return;
                 }
             }

        } catch (e) {
            console.error("Paste failed", e);
        }
    };

    const handleSave = async () => {
        const id = selectedStickerId();
        if (!id) return;
        const unit = stickerStore.stickers.find((candidate) => candidate.id === id);
        if (!unit) return;

        try {
            const exportBase64 = await renderStickerComposite(unit);
            const centerX = unit.x + unit.w / 2;
            const centerY = unit.y + unit.h / 2;
            const path = await api.saveStickerImageAs(exportBase64, centerX, centerY);
            if (path) {
                logger.info(`Saved sticker composite to: ${path}`);
            }
        } catch (error) {
            console.error("Save sticker composite failed", error);
        }
    };

    // Helper to detect if mouse is "inside" the original source node's area
    const isMouseInsideOriginal = (clip: ClipboardData, mx: number, my: number) => {
        // Try to find the original unit to get its CURRENT position
        // This handles cases where the user moved the node after copying
        const currentSticker = stickerStore.stickers.find(u => u.id === clip.originalId);

        let targetX = clip.originalX;
        let targetY = clip.originalY;
        let targetW = clip.w;
        let targetH = clip.h;

        if (currentSticker) {
            targetX = currentSticker.x;
            targetY = currentSticker.y;
            targetW = currentSticker.w;
            targetH = currentSticker.h;
        }

        return (mx >= targetX && mx <= targetX + targetW &&
                my >= targetY && my <= targetY + targetH);
    };

    const pasteClipboardData = (clip: ClipboardData, mp: {x: number, y: number}) => {
        let newX = mp.x;
        let newY = mp.y;

        // CASCADE MODE DETECTION
        // Logic: If mouse is inside the original source rect, we assume the user wants to "duplicate on top".
        // In this case, we use the `nextCascade` position instead of mouse position.
        const inside = isMouseInsideOriginal(clip, mp.x, mp.y);
        let isCascade = inside;

        if (isCascade) {
            newX = clip.nextCascadeX;
            newY = clip.nextCascadeY;
            logger.debug("PASTE DEBUG [Cascade Mode]:", {
                mousePos: mp,
                originalId: clip.originalId,
                nextCascade: { x: newX, y: newY }
            });
        } else {
            // RELATIVE MODE
            // Restore Mouse Offset so the node appears "under" the cursor exactly as copied
            if (clip.offsetX !== undefined && clip.offsetY !== undefined) {
                 newX = mp.x - clip.offsetX;
                 newY = mp.y - clip.offsetY;
            } else {
                 newX = mp.x;
                 newY = mp.y;
            }

            logger.debug("PASTE DEBUG [Relative Mode]:", {
                mousePos: mp,
                calculated: { x: newX, y: newY },
                clipboardData: clip, // Log full clip data to check for offsets/rects
                windowState: {
                    scrollX: window.scrollX,
                    scrollY: window.scrollY,
                    innerWidth: window.innerWidth,
                    innerHeight: window.innerHeight,
                    dpr: window.devicePixelRatio
                },
                screen: { width: window.screen.width, height: window.screen.height }
            });
        }

        // Create sticker from clipboard payload
        const newSticker = createSticker({
            x: newX,
            y: newY,
            w: clip.w,
            h: clip.h,
            data: {
                src: clip.src,
                minified: clip.minified,
                savedRect: clip.savedRect,
                cropOffset: clip.cropOffset,
                opacityNormal: clip.opacityNormal,
                opacityMini: clip.opacityMini,
                rasterizedAnnotationLayerSrc: clip.rasterizedAnnotationLayerSrc,
                annotationState: clip.annotationState,
                imageEditState: clip.imageEditState,
                previewSrc: clip.previewSrc,
                filePath: clip.filePath,
                dragOutFilePath: clip.dragOutFilePath,
                groupId: clip.groupId,
                captureMeta: clip.captureMeta,
            },
        });

        stickerStore.actions.addSticker(newSticker);
        selectionActions.set([newSticker.id]);
        syncService.updateBackendRects();

        // Debug Logs
        logger.debug("Paste:", { isCascade, newX, newY, nextCascadeX: clip.nextCascadeX });

        // Update clipboard so the next paste uses this sticker as the cascade anchor.
        const nextClip: ClipboardData = {
            ...clip,
            originalId: newSticker.id,
            originalX: newX,
            originalY: newY,
            nextCascadeX: newX + 20,
            nextCascadeY: newY + 20,
        };
        setClipboard(nextClip);
        logger.debug("Updated Clipboard Anchor:", { id: nextClip.originalId, nextCascade: { x: nextClip.nextCascadeX, y: nextClip.nextCascadeY } });
    };

    const createImageSticker = (base64: string, mpOverride?: {x: number, y: number}) => {
        const mp = mpOverride || mousePos();
        const newSticker = createSticker({
            x: mp.x,
            y: mp.y,
            w: 300,
            h: 300,
            data: {
                src: base64,
                minified: false,
            },
        });
        stickerStore.actions.addSticker(newSticker);
        syncService.updateBackendRects();
        return newSticker.id;
    };

    return { handlePaste, handleCopy, handleSave, createImageSticker };
}
