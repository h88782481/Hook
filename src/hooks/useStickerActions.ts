import { api } from "../services/api";
import { stickerStore } from "../store/stickerStore";
import { syncService } from "../services/syncService";
import { logger } from "../services/logger";
import { setDraggingStickerId, setMultiDragPositions } from "../store/uiStore";
import { computeRestoredMinifiedStickerWindow } from "../services/stickerEditing";
import { resolveStickerImage } from "../services/stickerImageResolution";

export function useStickerActions() {
    const propagateFromSticker = (fromStickerId: string) => {
        const outLinks = stickerStore.links.filter((l) => l.fromUnitId === fromStickerId);

        outLinks.forEach((l) => {
            const childId = l.toUnitId;
            const childSticker = stickerStore.stickers.find((u) => u.id === childId);
            if (!childSticker) return;

            const inputValue = resolveStickerImage({
                stickers: stickerStore.stickers,
                links: stickerStore.links,
                stickerId: fromStickerId,
            });

            if (inputValue) {
                logger.debug(`[Propagation] Updating Sticker ${childId} with new input`);
                stickerStore.actions.updateStickerData(childId, {
                    previewSrc: inputValue,
                });
                queueMicrotask(() => propagateFromSticker(childId));
            }
        });
    };

    const handleDoubleClick = (e: MouseEvent, id: string) => {
        e.stopPropagation();

        const u = stickerStore.stickers.find((sticker) => sticker.id === id);
        if (!u) return;

        if (u.data.minified) {
            setDraggingStickerId(null);
            setMultiDragPositions(null);
            const saved = u.data.savedRect;
            if (saved) {
                const restored = computeRestoredMinifiedStickerWindow(
                    { x: u.x, y: u.y, w: u.w, h: u.h },
                    saved,
                    u.data.cropOffset,
                );
                stickerStore.actions.updateStickerWindowState(
                    id,
                    {
                        x: restored.x,
                        y: restored.y,
                        w: restored.w,
                        h: restored.h,
                    },
                    {
                        minified: false,
                    },
                );
            } else {
                stickerStore.actions.updateStickerData(id, { minified: false });
            }
            setTimeout(() => {
                syncService.updateBackendRects();
                syncService.scheduleSessionSync();
            }, 100);
            return;
        }

        const target = e.currentTarget as HTMLElement;
        const rect = target.getBoundingClientRect();
        const relX = (e.clientX - rect.left) / rect.width;
        const relY = (e.clientY - rect.top) / rect.height;
        const clickUnitX = relX * u.w;
        const clickUnitY = relY * u.h;
        const CROP_SIZE = 100;
        const offsetX = clickUnitX - CROP_SIZE / 2;
        const offsetY = clickUnitY - CROP_SIZE / 2;
        const newX = u.x + offsetX;
        const newY = u.y + offsetY;

        setDraggingStickerId(null);
        setMultiDragPositions(null);

        void api.debugLogEvent(
            "sticker-double-click-window",
            `unit=${id} relX=${relX.toFixed(4)} relY=${relY.toFixed(4)} rectW=${rect.width.toFixed(2)} rectH=${rect.height.toFixed(2)} offsetX=${offsetX.toFixed(2)} offsetY=${offsetY.toFixed(2)} frameX=${newX.toFixed(2)} frameY=${newY.toFixed(2)}`,
        );

        stickerStore.actions.updateStickerWindowState(
            id,
            {
                x: newX,
                y: newY,
                w: CROP_SIZE,
                h: CROP_SIZE,
            },
            {
                minified: true,
                savedRect: { x: u.x, y: u.y, w: u.w, h: u.h },
                cropOffset: { x: offsetX, y: offsetY },
            },
        );

        setTimeout(() => {
            syncService.updateBackendRects();
            syncService.scheduleSessionSync();
        }, 100);
    };

    return { propagateFromSticker, handleDoubleClick };
}
