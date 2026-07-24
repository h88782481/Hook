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

/**
 * snow-shot style long capture:
 * - Overlay is click-through so the OS scrolls the page under the cursor (no enigo wait → no stutter)
 * - Wheel only *signals* capture; capture pushes a queue; handle drains asynchronously
 * - Overlay is excluded from capture so tips never enter the stitch pipeline
 */
export function useSelection() {
    let autoLongCaptureRect: CaptureRect | null = null;
    let autoLongCaptureOrigin: { x: number; y: number } | null = null;
    let autoLongCaptureSessionId = 0;
    let autoLongCaptureFinishing = false;
    let autoLongCaptureBackendSessionId: string | null = null;
    let autoLongCaptureBackendFrameCount = 0;
    let autoLongCaptureNoChangeCount = 0;
    let autoLongCaptureAxis: LongCaptureAxis = "vertical";
    let autoLongCaptureWheelTimer: number | null = null;
    let autoLongCaptureLastList: ScrollCaptureImageList = "Bottom";
    let autoLongCaptureCapturing = false;
    let autoLongCaptureHandling = false;
    let autoLongCapturePendingCapture = false;
    let autoLongCaptureHeartbeatTimer: number | null = null;
    let autoLongCaptureLastWheelAtMs = 0;

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
                return "未匹配到重叠，请稍慢一点滚动";
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
        if (Math.abs(deltaX) > Math.abs(deltaY)) {
            autoLongCaptureAxis = "horizontal";
            return deltaX >= 0 ? "Bottom" : "Top";
        }
        autoLongCaptureAxis = "vertical";
        return deltaY >= 0 ? "Bottom" : "Top";
    };

    /** Drain stitch queue without blocking the next capture (snow-shot split). */
    const drainScrollCaptureHandle = async (sessionId: number) => {
        if (autoLongCaptureHandling) return;
        const backendSessionId = autoLongCaptureBackendSessionId;
        if (!backendSessionId || !isAutoLongCaptureSessionCurrent(sessionId)) return;

        autoLongCaptureHandling = true;
        try {
            for (;;) {
                if (!isAutoLongCaptureSessionCurrent(sessionId)) break;
                const response = await api.handleScrollCaptureSession(backendSessionId);
                if (response.status === "no_data") break;

                autoLongCaptureBackendFrameCount = Math.max(
                    autoLongCaptureBackendFrameCount,
                    response.frameCount,
                );
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
                    "auto-long-capture-handle",
                    `session=${backendSessionId} status=${response.status} frames=${response.frameCount} noChange=${response.noChangeCount} pending=${response.pendingCount}`,
                );
            }
        } catch (error) {
            await api.debugLogEvent(
                "auto-long-capture-handle-failed",
                error instanceof Error ? error.message : String(error),
            );
        } finally {
            autoLongCaptureHandling = false;
        }
    };

    const stopScrollCaptureHeartbeat = () => {
        if (autoLongCaptureHeartbeatTimer !== null) {
            window.clearInterval(autoLongCaptureHeartbeatTimer);
            autoLongCaptureHeartbeatTimer = null;
        }
    };

    const ensureScrollCaptureHeartbeat = (sessionId: number) => {
        if (autoLongCaptureHeartbeatTimer !== null) return;
        autoLongCaptureHeartbeatTimer = window.setInterval(() => {
            if (!isAutoLongCaptureSessionCurrent(sessionId)) {
                stopScrollCaptureHeartbeat();
                return;
            }
            // Keep sampling for a short window after the last wheel so mid-scroll frames aren't missed.
            if (Date.now() - autoLongCaptureLastWheelAtMs > 280) {
                stopScrollCaptureHeartbeat();
                return;
            }
            void pushScrollCaptureFrame(sessionId, autoLongCaptureLastList);
        }, 55);
    };

    /** Capture-only push (fast). Handle runs in background. */
    const pushScrollCaptureFrame = async (
        sessionId: number,
        scrollImageList: ScrollCaptureImageList,
    ) => {
        if (!isAutoLongCaptureSessionCurrent(sessionId)) return;
        const backendSessionId = autoLongCaptureBackendSessionId;
        if (!backendSessionId) return;

        if (autoLongCaptureCapturing) {
            autoLongCapturePendingCapture = true;
            autoLongCaptureLastList = scrollImageList;
            return;
        }

        autoLongCaptureCapturing = true;
        try {
            await api.captureScrollCaptureSession(backendSessionId, scrollImageList);
            void drainScrollCaptureHandle(sessionId);
        } catch (error) {
            await api.debugLogEvent(
                "auto-long-capture-capture-failed",
                error instanceof Error ? error.message : String(error),
            );
        } finally {
            autoLongCaptureCapturing = false;
            if (autoLongCapturePendingCapture && isAutoLongCaptureSessionCurrent(sessionId)) {
                autoLongCapturePendingCapture = false;
                void pushScrollCaptureFrame(sessionId, autoLongCaptureLastList);
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

        autoLongCaptureLastList = resolveScrollImageList(input);
        autoLongCaptureLastWheelAtMs = Date.now();
        ensureScrollCaptureHeartbeat(sessionId);

        if (autoLongCaptureWheelTimer !== null) {
            window.clearTimeout(autoLongCaptureWheelTimer);
        }
        autoLongCaptureWheelTimer = window.setTimeout(() => {
            autoLongCaptureWheelTimer = null;
            if (!isAutoLongCaptureSessionCurrent(sessionId)) return;
            void pushScrollCaptureFrame(sessionId, autoLongCaptureLastList);
        }, 16);
    };

    const startAutoLongCaptureSession = async (
        rect: CaptureRect,
        origin: { x: number; y: number },
    ) => {
        if (autoLongCaptureWheelTimer !== null) {
            window.clearTimeout(autoLongCaptureWheelTimer);
            autoLongCaptureWheelTimer = null;
        }
        stopScrollCaptureHeartbeat();
        autoLongCaptureSessionId += 1;
        const sessionId = autoLongCaptureSessionId;
        autoLongCaptureFinishing = false;
        autoLongCaptureRect = rect;
        autoLongCaptureOrigin = origin;
        autoLongCaptureAxis = "vertical";
        autoLongCaptureBackendSessionId = null;
        autoLongCaptureBackendFrameCount = 0;
        autoLongCaptureNoChangeCount = 0;
        autoLongCaptureLastList = "Bottom";
        autoLongCaptureCapturing = false;
        autoLongCaptureHandling = false;
        autoLongCapturePendingCapture = false;
        autoLongCaptureLastWheelAtMs = 0;

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
            lastMessage: "长截图中：直接滚动目标页面，Enter 完成，Esc 取消",
        });
        await api.debugLogEvent("auto-long-capture-start", `x=${rect.x} y=${rect.y} w=${rect.w} h=${rect.h}`);
        await api.setMouseMonitorActive(false);

        // Click-through: OS delivers wheel to the page under the cursor (smooth, no enigo).
        // Exclude overlay from capture so tips never pollute frames.
        await api.showOverlayHost(true);
        await api.setOverlayClickThrough(true);
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

        await sleep(17);
        await pushScrollCaptureFrame(sessionId, "Bottom");
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
        stopScrollCaptureHeartbeat();
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
            const deadline = Date.now() + 2000;
            while (
                (autoLongCaptureCapturing || autoLongCaptureHandling || autoLongCapturePendingCapture)
                && Date.now() < deadline
            ) {
                if (!autoLongCaptureHandling) {
                    void drainScrollCaptureHandle(sessionId);
                }
                await sleep(24);
            }
            // One last drain before export.
            await drainScrollCaptureHandle(sessionId);
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
            autoLongCaptureFinishing = false;
            autoLongCaptureRect = null;
            autoLongCaptureOrigin = null;
            autoLongCaptureBackendSessionId = null;
            autoLongCaptureBackendFrameCount = 0;
            autoLongCaptureNoChangeCount = 0;
            autoLongCaptureCapturing = false;
            autoLongCaptureHandling = false;
            autoLongCapturePendingCapture = false;
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
        stopScrollCaptureHeartbeat();
        autoLongCaptureSessionId += 1;
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
        autoLongCaptureCapturing = false;
        autoLongCaptureHandling = false;
        autoLongCapturePendingCapture = false;
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
