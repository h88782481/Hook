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

    const sampleScrollCaptureFrame = async (
        sessionId: number,
        scrollImageList: ScrollCaptureImageList,
        options?: { scrollThroughLength?: number; scrollAxis?: LongCaptureAxis },
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
            // snow-shot: hide UI tip for ~1 frame, capture region, then scroll-through.
            const response = await api.sampleScrollCaptureSession(backendSessionId, scrollImageList, true);
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

            const scrollLength = options?.scrollThroughLength;
            const scrollAxis = options?.scrollAxis ?? autoLongCaptureAxis;
            if (scrollLength != null && scrollLength !== 0 && !autoLongCapturePendingScrollThrough) {
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
            }

            // Restore tip visibility after sample (overlay was briefly hidden by backend).
            // Keep click-through off so wheel is owned by Hook + scroll_through (snow-shot).
            await api.showOverlayHost(false);
            await api.setOverlayClickThrough(false);
        } catch (error) {
            await api.debugLogEvent(
                "auto-long-capture-frame-failed",
                error instanceof Error ? error.message : String(error),
            );
            try {
                await api.showOverlayHost(false);
                await api.setOverlayClickThrough(false);
            } catch {
                // ignore
            }
        } finally {
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

        // Prefer the dominant wheel axis for this gesture.
        const nextAxis: LongCaptureAxis =
            Math.abs(deltaX) > Math.abs(deltaY) ? "horizontal" : "vertical";

        // snow-shot locks direction at init — restart early if axis changes before real scrolling progress.
        if (
            nextAxis !== autoLongCaptureAxis
            && autoLongCaptureBackendFrameCount <= 1
            && autoLongCaptureRect
        ) {
            autoLongCaptureAxis = nextAxis;
            updateAutoLongCaptureSession({
                axis: nextAxis,
                message: nextAxis === "horizontal" ? "已切换为水平滚动拼接" : "已切换为垂直滚动拼接",
            });
            try {
                if (autoLongCaptureBackendSessionId) {
                    await api.cancelScrollCaptureSession(autoLongCaptureBackendSessionId);
                }
                autoLongCaptureBackendSessionId = await api.startScrollCaptureSession(
                    autoLongCaptureRect,
                    nextAxis,
                );
                autoLongCaptureBackendFrameCount = 0;
                autoLongCaptureNoChangeCount = 0;
                await sampleScrollCaptureFrame(sessionId, "Bottom");
            } catch (error) {
                await api.debugLogEvent(
                    "auto-long-capture-axis-switch-failed",
                    error instanceof Error ? error.message : String(error),
                );
            }
        } else {
            autoLongCaptureAxis = nextAxis;
        }

        const list = resolveScrollImageList(input);
        const scrollLength = autoLongCaptureAxis === "horizontal" ? deltaX : deltaY;
        void api.debugLogEvent(
            "auto-long-capture-wheel",
            `session=${autoLongCaptureBackendSessionId ?? "frontend"} axis=${autoLongCaptureAxis} deltaX=${deltaX} deltaY=${deltaY} list=${list}`,
        );
        await sampleScrollCaptureFrame(sessionId, list, {
            scrollThroughLength: scrollLength,
            scrollAxis: autoLongCaptureAxis,
        });
    };

    const startAutoLongCaptureSession = async (
        rect: CaptureRect,
        origin: { x: number; y: number },
    ) => {
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

        resetSelection();
        setLongCaptureUiActive(true);
        setLongCaptureSession({
            active: true,
            rect,
            frameCount: 0,
            noChangeCount: 0,
            status: "capturing",
            axis: "vertical",
            lastMessage: "长截图中：滚动页面采集，Enter 完成拼接，Esc 取消",
        });
        await api.debugLogEvent("auto-long-capture-start", `x=${rect.x} y=${rect.y} w=${rect.w} h=${rect.h}`);
        await api.setMouseMonitorActive(false);

        // Keep overlay visible for status tip; do NOT click-through — scroll goes through scroll_through.
        await api.showOverlayHost(false);
        await api.setOverlayClickThrough(false);
        try {
            await api.setOverlayCaptureExclusion(false);
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

        // snow-shot: first capture happens on first wheel (axis known). Seed one frame so Enter always works.
        await sleep(17);
        await sampleScrollCaptureFrame(sessionId, "Bottom");
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
        setLongCaptureSession((session) => session && {
            ...session,
            status: "stitching",
            lastMessage: "正在导出长截图…",
        });

        try {
            if (!backendSessionId) {
                await api.debugLogEvent("auto-long-capture-finish-empty", `session=${sessionId}`);
                return false;
            }
            // Wait briefly if a sample is in flight.
            const deadline = Date.now() + 400;
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
