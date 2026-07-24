import { api } from "../services/api";

import {
    isBoxSelecting, setIsBoxSelecting,
    startPos, setStartPos,
    selectionRect, setSelectionRect,
    selectionActions,
    setLongCaptureSession,
    uiActions,
} from "../store/uiStore";
import { createThumbnailDataUrl } from "../services/historyModel";
import { resolveCaptureDisplaySrc } from "../services/imageSource";

import { stickerStore } from "../store/stickerStore";
import { syncService } from "../services/syncService";
import { createSticker } from "../types/stickerModel";
import { stickerToolbarDefaultVisible } from "../store/appSettingsStore";
import {
    CaptureRect,
    CaptureResponse,
    CaptureSelectionMode,
    createCaptureMeta,
    LongCaptureAxis,
    ScrollCaptureImageList,
    ScrollCaptureSampleStatus,
} from "../services/captureState";

let cachedStickerRects: {id: string, x: number, y: number, w: number, h: number}[] = [];

const sleep = (ms: number) => new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
});

export function useSelection() {
    let autoLongCaptureRect: CaptureRect | null = null;
    let autoLongCaptureOrigin: { x: number; y: number } | null = null;
    let autoLongCaptureBusySessionId: number | null = null;
    let autoLongCaptureSessionId = 0;
    let autoLongCaptureFinishing = false;
    let autoLongCaptureBackendSessionId: string | null = null;
    let autoLongCaptureBackendFrameCount = 0;
    let autoLongCaptureNoChangeCount = 0;
    let autoLongCaptureAxis: LongCaptureAxis = "vertical";
    let autoLongCapturePendingScrollThrough = false;
    let autoLongCaptureWheelTimer: number | null = null;
    let autoLongCaptureLastWheel: { deltaX: number; deltaY: number } | null = null;

    const resetSelection = () => {
        setStartPos(null);
        setSelectionRect(null);
        setIsBoxSelecting(false);
        cachedStickerRects = [];
    };

    const setLongCaptureUiActive = (active: boolean) => {
        void api.setLongCaptureUiActive(active);
    };

    const restorePostCaptureInteractivity = async () => {
        await api.showOverlayHost(true);
        await api.setOverlayClickThrough(true);
        try {
            await api.setOverlayCaptureExclusion(false);
        } catch {
            // ignore
        }
        if (stickerStore.stickers.length > 0) {
            await api.setMouseMonitorActive(true);
            await syncService.notify({ layout: true });
        } else {
            await api.setMouseMonitorActive(false);
        }
    };

    const addCaptureSticker = async (
        response: CaptureResponse,
        rect: CaptureRect,
        origin: { x: number; y: number },
        mode: CaptureSelectionMode = "region",
        scrollAxis?: LongCaptureAxis,
    ) => {
        const dpr = window.devicePixelRatio || 1;
        const cssW = response.width / dpr;
        const cssH = response.height / dpr;

        const newSticker = createSticker({
            x: origin.x,
            y: origin.y,
            w: cssW,
            h: cssH,
            data: {
                src: resolveCaptureDisplaySrc(response),
                filePath: response.filePath,
                opacityNormal: 1.0,
                opacityMini: 0.9,
                minified: false,
                captureMeta: createCaptureMeta(mode, rect, scrollAxis),
            },
        });

        stickerStore.actions.addSticker(newSticker);
        selectionActions.set([newSticker.id]);
        if (stickerToolbarDefaultVisible()) {
            uiActions.showStickerToolbar(newSticker.id);
        }
        await syncService.notify({ layout: true, persist: true });
        await api.debugLogEvent("selection-capture-success", `cssW=${cssW} cssH=${cssH}`);

        void (async () => {
            try {
                const thumb = await createThumbnailDataUrl(newSticker.data.src ?? "");
                if (!thumb.thumbnail) return;
                uiActions.recordScreenshotHistory({
                    id: newSticker.id,
                    thumbnail: thumb.thumbnail,
                    width: response.width,
                    height: response.height,
                    at: Date.now(),
                });
            } catch (error) {
                console.error("Failed to record screenshot history", error);
            }
        })();
    };

    const describeScrollCaptureStatus = (status: ScrollCaptureSampleStatus) => {
        switch (status) {
            case "success":
                return "已拼接新画面，继续滚动即可";
            case "no_change":
                return "画面未变化，可继续滚动";
            case "no_image":
                return "未匹配到可拼接内容，稍慢滚动再试";
            case "no_data":
                return "等待采集…";
        }
    };

    const updateAutoLongCaptureSession = (analysis: {
        message?: string;
        noChangeCount?: number;
        axis?: LongCaptureAxis;
    }) => {
        setLongCaptureSession((session) => session && {
            ...session,
            frameCount: autoLongCaptureBackendFrameCount,
            noChangeCount: analysis.noChangeCount ?? autoLongCaptureNoChangeCount,
            axis: analysis.axis ?? autoLongCaptureAxis,
            lastMessage: analysis.message,
        });
    };

    const isAutoLongCaptureSessionCurrent = (sessionId: number) =>
        sessionId === autoLongCaptureSessionId
        && !autoLongCaptureFinishing
        && !!autoLongCaptureRect;

    const resolveScrollImageList = (input: {
        deltaX?: number;
        deltaY?: number;
    }): ScrollCaptureImageList => {
        const deltaX = input.deltaX ?? 0;
        const deltaY = input.deltaY ?? 0;
        if (autoLongCaptureAxis === "horizontal") {
            return deltaX >= 0 ? "Bottom" : "Top";
        }
        return deltaY >= 0 ? "Bottom" : "Top";
    };

    /**
     * snow-shot style tick:
     * 1) scroll_through (page moves)
     * 2) wait one frame
     * 3) capture + handle (overlay stays visible; excluded from capture)
     */
    const runScrollCaptureTick = async (
        sessionId: number,
        scrollImageList: ScrollCaptureImageList,
        scrollLength: number,
        scrollAxis: LongCaptureAxis,
    ) => {
        if (!isAutoLongCaptureSessionCurrent(sessionId) || !autoLongCaptureRect) return;
        if (autoLongCaptureBusySessionId === sessionId) return;

        const backendSessionId = autoLongCaptureBackendSessionId;
        if (!backendSessionId) {
            await api.debugLogEvent("auto-long-capture-missing-backend-session", `session=${sessionId}`);
            return;
        }

        autoLongCaptureBusySessionId = sessionId;
        try {
            // Overlay stays up (no window.hide). Tips stay visible too — the window is
            // content-protected / excluded from capture so UI never enters the stitch.
            if (scrollLength !== 0 && !autoLongCapturePendingScrollThrough) {
                autoLongCapturePendingScrollThrough = true;
                try {
                    await api.scrollThrough(scrollLength > 0 ? 1 : -1, scrollAxis);
                } catch (error) {
                    await api.debugLogEvent(
                        "auto-long-capture-scroll-through-failed",
                        error instanceof Error ? error.message : String(error),
                    );
                } finally {
                    autoLongCapturePendingScrollThrough = false;
                }
            } else {
                // First seed frame: tiny settle wait.
                await sleep(17);
            }

            const response = await api.sampleScrollCaptureSession(
                backendSessionId,
                scrollImageList,
                false,
            );
            if (!isAutoLongCaptureSessionCurrent(sessionId)) return;

            autoLongCaptureBackendFrameCount = response.frameCount;
            autoLongCaptureNoChangeCount = response.noChangeCount;
            if (response.direction === "Horizontal") {
                autoLongCaptureAxis = "horizontal";
            } else if (response.direction === "Vertical") {
                autoLongCaptureAxis = "vertical";
            }

            updateAutoLongCaptureSession({
                axis: autoLongCaptureAxis,
                noChangeCount: response.noChangeCount,
                message: describeScrollCaptureStatus(response.status),
            });
            void api.debugLogEvent(
                "auto-long-capture-frame",
                `session=${backendSessionId} status=${response.status} frames=${response.frameCount} noChange=${response.noChangeCount} list=${scrollImageList}`,
            );
        } catch (error) {
            await api.debugLogEvent(
                "auto-long-capture-frame-failed",
                error instanceof Error ? error.message : String(error),
            );
        } finally {
            try {
                await api.setOverlayClickThrough(false);
            } catch {
                // ignore
            }
            if (autoLongCaptureBusySessionId === sessionId) {
                autoLongCaptureBusySessionId = null;
            }
        }
    };

    const notifyAutoLongCaptureWheel = async (
        input: { deltaX?: number; deltaY?: number },
        sessionId = autoLongCaptureSessionId,
    ) => {
        if (!isAutoLongCaptureSessionCurrent(sessionId)) return;
        const deltaX = input.deltaX ?? 0;
        const deltaY = input.deltaY ?? 0;
        if (deltaX === 0 && deltaY === 0) return;

        autoLongCaptureLastWheel = { deltaX, deltaY };

        // snow-shot throttles capture; coalesce rapid wheel events into one tick.
        if (autoLongCaptureWheelTimer !== null) {
            window.clearTimeout(autoLongCaptureWheelTimer);
        }
        autoLongCaptureWheelTimer = window.setTimeout(() => {
            autoLongCaptureWheelTimer = null;
            const last = autoLongCaptureLastWheel;
            if (!last || !isAutoLongCaptureSessionCurrent(sessionId)) return;

            const nextAxis: LongCaptureAxis =
                Math.abs(last.deltaX) > Math.abs(last.deltaY) ? "horizontal" : "vertical";
            autoLongCaptureAxis = nextAxis;

            const list = resolveScrollImageList(last);
            const scrollLength = nextAxis === "horizontal" ? last.deltaX : last.deltaY;
            void api.debugLogEvent(
                "auto-long-capture-wheel",
                `session=${autoLongCaptureBackendSessionId ?? "frontend"} axis=${nextAxis} deltaX=${last.deltaX} deltaY=${last.deltaY} list=${list}`,
            );
            void runScrollCaptureTick(sessionId, list, scrollLength, nextAxis);
        }, 32);
    };

    const startAutoLongCaptureSession = async (
        rect: CaptureRect,
        origin: { x: number; y: number },
    ) => {
        if (autoLongCaptureWheelTimer !== null) {
            window.clearTimeout(autoLongCaptureWheelTimer);
            autoLongCaptureWheelTimer = null;
        }
        autoLongCaptureSessionId += 1;
        const sessionId = autoLongCaptureSessionId;
        autoLongCaptureBusySessionId = null;
        autoLongCaptureFinishing = false;
        autoLongCaptureRect = rect;
        autoLongCaptureOrigin = origin;
        autoLongCaptureAxis = "vertical";
        autoLongCaptureBackendSessionId = null;
        autoLongCaptureBackendFrameCount = 0;
        autoLongCaptureNoChangeCount = 0;
        autoLongCapturePendingScrollThrough = false;
        autoLongCaptureLastWheel = null;

        resetSelection();
        setLongCaptureUiActive(true);
        setLongCaptureSession({
            active: true,
            rect,
            frameCount: 0,
            noChangeCount: 0,
            status: "capturing",
            axis: "vertical",
            tipVisible: true,
            lastMessage: "长截图中：滚动页面采集，Enter 完成拼接，Esc 取消",
        });
        await api.debugLogEvent("auto-long-capture-start", `x=${rect.x} y=${rect.y} w=${rect.w} h=${rect.h}`);
        await api.setMouseMonitorActive(false);

        // Keep overlay visible (no hide/show flicker). Exclude it from WGC/GDI capture
        // so tips never enter the stitch pipeline — same idea as snow-shot tip opacity hide.
        await api.showOverlayHost(false);
        await api.setOverlayClickThrough(false);
        try {
            await api.setOverlayCaptureExclusion(true);
        } catch (error) {
            await api.debugLogEvent(
                "auto-long-capture-overlay-exclusion-failed",
                error instanceof Error ? error.message : String(error),
            );
        }

        try {
            autoLongCaptureBackendSessionId = await api.startScrollCaptureSession(rect, autoLongCaptureAxis);
            await api.debugLogEvent(
                "auto-long-capture-backend-start",
                `session=${autoLongCaptureBackendSessionId} x=${rect.x} y=${rect.y} w=${rect.w} h=${rect.h}`,
            );
        } catch (error) {
            autoLongCaptureBackendSessionId = null;
            await api.debugLogEvent(
                "auto-long-capture-backend-start-failed",
                error instanceof Error ? error.message : String(error),
            );
            setLongCaptureSession(null);
            setLongCaptureUiActive(false);
            resetSelection();
            await restorePostCaptureInteractivity();
            return;
        }

        // Seed first frame (no scroll), snow-shot also builds index from the first image.
        await sleep(17);
        await runScrollCaptureTick(sessionId, "Bottom", 0, "vertical");
    };

    const finishAutoLongCaptureSession = async () => {
        await api.setCaptureInputActive(false);
        if (autoLongCaptureFinishing) return false;
        if (!autoLongCaptureRect || !autoLongCaptureOrigin) {
            return false;
        }

        const sessionId = autoLongCaptureSessionId;
        const rect = autoLongCaptureRect;
        const origin = autoLongCaptureOrigin;
        const axis = autoLongCaptureAxis;
        const backendSessionId = autoLongCaptureBackendSessionId;

        autoLongCaptureFinishing = true;
        if (autoLongCaptureWheelTimer !== null) {
            window.clearTimeout(autoLongCaptureWheelTimer);
            autoLongCaptureWheelTimer = null;
        }
        setLongCaptureSession((session) => session && {
            ...session,
            status: "stitching",
            tipVisible: true,
            lastMessage: "正在导出长截图…",
        });

        try {
            if (!backendSessionId) {
                await api.debugLogEvent("auto-long-capture-finish-empty", `session=${sessionId}`);
                return false;
            }
            const deadline = Date.now() + 800;
            while (autoLongCaptureBusySessionId === sessionId && Date.now() < deadline) {
                await sleep(24);
            }
            const response = await api.finishScrollCaptureSession(backendSessionId);
            await addCaptureSticker(response, rect, origin, "long", axis);
            await api.debugLogEvent(
                "auto-long-capture-finish",
                `frames=${autoLongCaptureBackendFrameCount} noChange=${autoLongCaptureNoChangeCount} axis=${axis}`,
            );
        } catch (error) {
            await api.debugLogEvent(
                "auto-long-capture-finish-failed",
                error instanceof Error ? error.message : String(error),
            );
        } finally {
            if (autoLongCaptureSessionId === sessionId) {
                autoLongCaptureSessionId += 1;
            }
            autoLongCaptureBusySessionId = null;
            autoLongCaptureFinishing = false;
            autoLongCaptureRect = null;
            autoLongCaptureOrigin = null;
            autoLongCaptureBackendSessionId = null;
            autoLongCaptureBackendFrameCount = 0;
            autoLongCaptureNoChangeCount = 0;
            autoLongCapturePendingScrollThrough = false;
            autoLongCaptureLastWheel = null;
            setLongCaptureSession(null);
            setLongCaptureUiActive(false);
            resetSelection();
            await restorePostCaptureInteractivity();
        }
        return true;
    };

    const cancelAutoLongCaptureSession = async () => {
        await api.setCaptureInputActive(false);
        if (!autoLongCaptureRect) return false;
        if (autoLongCaptureWheelTimer !== null) {
            window.clearTimeout(autoLongCaptureWheelTimer);
            autoLongCaptureWheelTimer = null;
        }
        autoLongCaptureSessionId += 1;
        autoLongCaptureBusySessionId = null;
        autoLongCaptureFinishing = false;
        autoLongCaptureRect = null;
        autoLongCaptureOrigin = null;
        if (autoLongCaptureBackendSessionId) {
            try {
                await api.cancelScrollCaptureSession(autoLongCaptureBackendSessionId);
            } catch (error) {
                await api.debugLogEvent(
                    "auto-long-capture-backend-cancel-failed",
                    error instanceof Error ? error.message : String(error),
                );
            }
        }
        autoLongCaptureBackendSessionId = null;
        autoLongCaptureBackendFrameCount = 0;
        autoLongCaptureNoChangeCount = 0;
        autoLongCapturePendingScrollThrough = false;
        autoLongCaptureLastWheel = null;
        setLongCaptureSession(null);
        setLongCaptureUiActive(false);
        resetSelection();
        await api.debugLogEvent("auto-long-capture-cancel");
        await restorePostCaptureInteractivity();
        return true;
    };

    const handleSelectionStart = (e: Pick<MouseEvent, "clientX" | "clientY" | "shiftKey" | "ctrlKey">) => {
         setIsBoxSelecting(true);
         setStartPos({ x: e.clientX, y: e.clientY });
         setSelectionRect({ x: e.clientX, y: e.clientY, w: 0, h: 0 });

         if (!e.shiftKey && !e.ctrlKey) {
             selectionActions.clear();
         }

         cachedStickerRects = stickerStore.stickers.map(u => ({
             id: u.id, x: u.x, y: u.y, w: u.w, h: u.h
         }));
    };

    const handleSelectionMove = (e: Pick<MouseEvent, "clientX" | "clientY" | "shiftKey" | "ctrlKey">) => {
        const start = startPos();
        if (!isBoxSelecting() || !start) return;

        const current = { x: e.clientX, y: e.clientY };
        const isLeft = current.x < start.x;
        const isUp = current.y < start.y;
        const w = Math.abs(start.x - current.x);
        const h = Math.abs(start.y - current.y);
        const x = isLeft ? start.x - w : start.x;
        const y = isUp ? start.y - h : start.y;
        const nextRect = { x, y, w, h };
        const prev = selectionRect();
        if (
            !prev ||
            prev.x !== nextRect.x ||
            prev.y !== nextRect.y ||
            prev.w !== nextRect.w ||
            prev.h !== nextRect.h
        ) {
            setSelectionRect(nextRect);
        }

        const selR = x + w;
        const selB = y + h;
        selectionActions.set(
            cachedStickerRects
                .filter((u) => {
                    const uR = u.x + u.w;
                    const uB = u.y + u.h;
                    return !(selR < u.x || x > uR || selB < u.y || y > uB);
                })
                .map((u) => u.id),
        );
    };

    const handleSelectionEnd = (_event?: Pick<MouseEvent, "clientX" | "clientY" | "shiftKey" | "ctrlKey">) => {
        if (isBoxSelecting()) {
            setIsBoxSelecting(false);
            setSelectionRect(null);
            setStartPos(null);
            cachedStickerRects = [];
        }
    };

    return {
        handleSelectionStart,
        handleSelectionMove,
        handleSelectionEnd,
        resetSelection,
        finishAutoLongCaptureSession,
        cancelAutoLongCaptureSession,
        notifyAutoLongCaptureWheel,
        addCaptureSticker,
        startAutoLongCaptureSession,
        restorePostCaptureInteractivity,
    };
}
