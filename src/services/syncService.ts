import { api } from "./api";
import { stickerStore } from "../store/stickerStore";
import type { Link } from "../types/stickerModel";
import { extraRects } from "./uiRegistry";
import type { BootProfile } from "./bootProfile";
import type { StickerGroup } from "../types/stickerEditing";
import {
    sessionStickerToSticker,
    stickerToSessionSticker,
} from "./stickerSnapshot";

const mapLinkToSessionLink = (link: Link) => ({
    id: link.id,
    fromStickerId: link.fromStickerId,
    fromPortId: link.fromPortId,
    toStickerId: link.toStickerId,
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
        stickerStore.stickers.map((unit) => stickerToSessionSticker(unit, { normalizePreview: true })),
        stickerStore.links.map(mapLinkToSessionLink),
        stickerStore.stickerGroups.map(mapGroupToSessionGroup),
        stickerStore.recycleBin.map((entry) => entry),
        stickerStore.referenceLibrary.map((entry) => entry),
    );
};

const scheduler = new SyncScheduler(executeSyncCycle);

export const syncService = {
    updateBackendRects: async () => {
        const dpr = window.devicePixelRatio || 1;

        const rects = stickerStore.stickers.map((u) => ({
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

    /** Push hit-map rects; optionally debounce-persist the session. */
    notifyLayoutChange: async (options?: { persist?: boolean }) => {
        await syncService.updateBackendRects();
        if (options?.persist) {
            scheduler.schedule();
        }
    },

    restoreSession: async (bootProfile?: BootProfile) => {
        try {
            const sessionData = await api.loadSession();
            if (sessionData) {
                const loadedStickers = sessionData.stickers.map(sessionStickerToSticker);
                const loadedStickerIds = new Set(loadedStickers.map((unit) => unit.id));
                const loadedLinks = sessionData.links
                    .filter((link) => loadedStickerIds.has(link.fromStickerId) && loadedStickerIds.has(link.toStickerId))
                    .map((link) => ({
                        id: link.id,
                        fromStickerId: link.fromStickerId,
                        fromPortId: link.fromPortId,
                        toStickerId: link.toStickerId,
                        toPortId: link.toPortId,
                    }));

                stickerStore.setStickers(loadedStickers);
                stickerStore.setLinks(loadedLinks);
                stickerStore.setStickerGroups(sessionData.groups as StickerGroup[]);
                stickerStore.setRecycleBin(sessionData.recycleBin as any);
                stickerStore.setReferenceLibrary(sessionData.referenceLibrary as any);

                await syncService.updateBackendRects();
                if (bootProfile?.initialUiMode === "overlay" && loadedStickers.length > 0) {
                    await api.setMouseMonitorActive(true);
                    await syncService.updateBackendRects();
                }
            }
        } catch (e) {
            console.error("Session Load Failed:", e);
        }
    },

    scheduleSessionSync: async () => {
        scheduler.schedule();
    },
};
