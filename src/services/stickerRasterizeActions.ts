import { stickerStore } from "../store/stickerStore";
import { uiActions } from "../store/uiStore";
import type { Sticker } from "../types/stickerModel";
import { composeRasterizedStickerPreview } from "./stickerBitmapLayers";
import {
    renderStickerBaseLayer,
    renderStickerTransparentAnnotationLayer,
} from "./stickerExport";
import { captureStickerEditSnapshot } from "./stickerHistory";
import {
    createRasterizedStickerData,
    getRasterizableAnnotationIds,
    type StickerRasterizeScope,
} from "./stickerRasterize";
import { syncService } from "./syncService";

export const rasterizeStickerAnnotationsForUnit = async (params: {
    unitId: string;
    currentSticker: Sticker;
    scope: StickerRasterizeScope;
    selectedAnnotationId: string | null;
    selectedAnnotationIds?: string[];
}): Promise<boolean> => {
    const annotationIds = getRasterizableAnnotationIds(
        params.currentSticker,
        params.scope,
        params.scope === "selected"
            ? (params.selectedAnnotationIds?.length ? params.selectedAnnotationIds : params.selectedAnnotationId)
            : params.selectedAnnotationId,
    );
    if (annotationIds.length === 0) return false;

    try {
        const currentSticker = params.currentSticker;
        const baseLayerSrc = await renderStickerBaseLayer(currentSticker);
        const rasterizedAnnotationLayerSrc = await renderStickerTransparentAnnotationLayer(
            currentSticker,
            annotationIds,
        );
        const previewSrc = await composeRasterizedStickerPreview(
            baseLayerSrc,
            rasterizedAnnotationLayerSrc,
            { w: currentSticker.w, h: currentSticker.h },
        );
        uiActions.pushStickerHistory(
            params.unitId,
            captureStickerEditSnapshot(currentSticker, { includeImageData: true }),
        );
        stickerStore.actions.updateStickerData(
            params.unitId,
            createRasterizedStickerData(
                currentSticker,
                {
                    baseLayerSrc,
                    rasterizedAnnotationLayerSrc,
                    previewSrc,
                },
                annotationIds,
            ),
        );
        await syncService.scheduleSessionSync();
        return true;
    } catch (error) {
        console.error("Rasterize sticker annotations failed", error);
        return false;
    }
};
