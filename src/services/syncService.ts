import { api } from "./api";
import { graphStore } from "../store/graphStore";
import { STICKER_DEFAULT_PORTS, type Unit, type Link } from "../types/unit";
import { extraRects } from "./uiRegistry";
import type { BootProfile } from "./bootProfile";
import type { StickerGroup } from "../types/stickerEditing";
import { normalizePreviewSrc } from "./syncedImagePayload";

const mapSessionStickerToUnit = (sticker: any): Unit => ({
    id: sticker.id,
    type: "sticker",
    x: sticker.x,
    y: sticker.y,
    w: sticker.w,
    h: sticker.h,
    params: (sticker.params as Record<string, any>) || {},
    inputs: STICKER_DEFAULT_PORTS.inputs,
    outputs: STICKER_DEFAULT_PORTS.outputs,
    data: {
        src: sticker.src,
        minified: sticker.minified ?? false,
        savedRect: sticker.savedRect || undefined,
        cropOffset: sticker.cropOffset || undefined,
        opacityNormal: sticker.opacityNormal ?? 1,
        opacityMini: sticker.opacityMini ?? 0.9,
        previewSrc: sticker.previewSrc && sticker.previewSrc !== sticker.src ? sticker.previewSrc : undefined,
        filePath: sticker.filePath || undefined,
        rasterizedAnnotationLayerSrc: sticker.rasterizedAnnotationLayerSrc || undefined,
        outputs: sticker.outputs || undefined,
        annotationState: sticker.annotationState || undefined,
        imageEditState: sticker.imageEditState || undefined,
        groupId: sticker.groupId || undefined,
        captureMeta: sticker.captureMeta || undefined,
    },
});

const mapUnitToSessionSticker = (unit: Unit) => ({
    id: unit.id,
    src: unit.data.src || "",
    x: unit.x,
    y: unit.y,
    w: unit.w,
    h: unit.h,
    minified: unit.data.minified ?? false,
    savedRect: unit.data.savedRect || null,
    cropOffset: unit.data.cropOffset || null,
    opacityNormal: unit.data.opacityNormal ?? 1,
    opacityMini: unit.data.opacityMini ?? 0.9,
    params: unit.params || {},
    filePath: unit.data.filePath || null,
    previewSrc: normalizePreviewSrc(unit) || null,
    rasterizedAnnotationLayerSrc: unit.data.rasterizedAnnotationLayerSrc || null,
    outputs: unit.data.outputs || null,
    annotationState: unit.data.annotationState || null,
    imageEditState: unit.data.imageEditState || null,
    groupId: unit.data.groupId || null,
    captureMeta: unit.data.captureMeta || null,
});

const mapLinkToSessionLink = (link: Link) => ({
    id: link.id,
    fromUnitId: link.fromUnitId,
    fromPortId: link.fromPortId,
    toUnitId: link.toUnitId,
    toPortId: link.toPortId,
});

const mapGroupToSessionGroup = (group: StickerGroup) => ({
    id: group.id,
    name: group.name,
    hidden: group.hidden ?? false,
    locked: group.locked ?? false,
});

class SyncScheduler {
    private debounceTimer: number | null = null;
    private isSyncing = false;
    private retryCount = 0;
    private hasPendingSync = false;
    private readonly MAX_RETRIES = 5;
    private readonly DEBOUNCE_MS = 50;

    constructor(private doSync: () => Promise<void>) {}

    public schedule() {
        if (this.debounceTimer) window.clearTimeout(this.debounceTimer);
        this.hasPendingSync = true;

        this.debounceTimer = window.setTimeout(() => {
            this.trigger();
        }, this.DEBOUNCE_MS);
    }

    private async trigger() {
        if (this.isSyncing) return;

        this.isSyncing = true;
        this.hasPendingSync = false;

        try {
            await this.doSync();
            this.retryCount = 0;
        } catch (e) {
            console.error("Sync cycle failed", e);
            if (this.retryCount < this.MAX_RETRIES) {
                this.retryCount++;
                const delay = Math.min(1000 * Math.pow(2, this.retryCount), 10000);
                console.log(`Retrying sync in ${delay}ms (Attempt ${this.retryCount}/${this.MAX_RETRIES})`);
                setTimeout(() => {
                    this.hasPendingSync = true;
                    this.trigger();
                }, delay);
            } else {
                console.error("Max sync retries reached. Giving up until next trigger.");
            }
        } finally {
            this.isSyncing = false;
            if (this.hasPendingSync) {
                this.schedule();
            }
        }
    }
}

const executeSyncCycle = async () => {
    await api.saveSession(
        graphStore.units.map(mapUnitToSessionSticker),
        graphStore.links.map(mapLinkToSessionLink),
        graphStore.stickerGroups.map(mapGroupToSessionGroup),
        graphStore.recycleBin.map((entry) => entry),
        graphStore.referenceLibrary.map((entry) => entry),
    );
};

const scheduler = new SyncScheduler(executeSyncCycle);

export const syncService = {
    updateBackendRects: async () => {
        const dpr = window.devicePixelRatio || 1;

        const rects = graphStore.units.map((u) => ({
            id: u.id,
            x: Math.round(u.x * dpr),
            y: Math.round(u.y * dpr),
            width: Math.round(u.w * dpr),
            height: Math.round(u.h * dpr),
            name: u.data.minified ? "MINI" : "FULL",
        }));

        const overlays = extraRects();
        overlays.forEach((r) => {
            rects.push({
                id: r.name,
                x: Math.round(r.x * dpr),
                y: Math.round(r.y * dpr),
                width: Math.round(r.width * dpr),
                height: Math.round(r.height * dpr),
                name: r.name,
            });
        });

        try {
            await api.updatePinRects(rects);
        } catch (e) {
            console.error("Failed to update backend rects:", e);
        }
    },

    restoreSession: async (bootProfile?: BootProfile) => {
        try {
            const sessionData = await api.loadSession();
            if (sessionData) {
                const loadedUnits = (sessionData.stickers || []).map(mapSessionStickerToUnit);
                const loadedUnitIds = new Set(loadedUnits.map((unit) => unit.id));
                const loadedLinks = (sessionData.links || [])
                    .filter((link: any) => loadedUnitIds.has(link.fromUnitId) && loadedUnitIds.has(link.toUnitId))
                    .map((link: any) => ({
                        id: link.id,
                        fromUnitId: link.fromUnitId,
                        fromPortId: link.fromPortId,
                        toUnitId: link.toUnitId,
                        toPortId: link.toPortId,
                    }));

                graphStore.setUnits(loadedUnits);
                graphStore.setLinks(loadedLinks);
                graphStore.setStickerGroups((sessionData.groups || []) as StickerGroup[]);
                graphStore.setRecycleBin((sessionData.recycleBin || []) as any);
                graphStore.setReferenceLibrary((sessionData.referenceLibrary || []) as any);

                const paramsMap: any = {};
                loadedUnits.forEach((u: any) => {
                    paramsMap[u.id] = u.params || {};
                });
                graphStore.setUnitParams(paramsMap);

                syncService.updateBackendRects();
                if (bootProfile?.initialUiMode === "overlay" && loadedUnits.length > 0) {
                    await api.setMouseMonitorActive(true);
                    await syncService.updateBackendRects();
                }
            }
        } catch (e) {
            console.error("Session Load Failed:", e);
        }
    },

    performWorkflowSync: async () => {
        scheduler.schedule();
    },
};
