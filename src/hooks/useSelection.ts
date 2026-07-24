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
    createAutoLongCaptureOptions,
    shouldDrainAutoLongCaptureBeforeFinish,
    resolveAutoLongCaptureBurstBudget,
    resolveAutoLongCaptureBurstPollInterval,
    resolveAutoLongCaptureSessionPollInterval,
    resolveAutoLongCaptureWheelPollInterval,
    shouldLogAutoLongCaptureFrame,
    shouldLogAutoLongCaptureWheel,
    shouldUpdateAutoLongCaptureStatus,
    AutoLongCaptureOptions,
    LongCaptureAxis,
    LongCaptureDirection,
} from "../services/captureState";

let cachedStickerRects: {id: string, x: number, y: number, w: number, h: number}[] = [];

export function useSelection() {
    let autoLongCaptureRect: CaptureRect | null = null;
    let autoLongCaptureOrigin: { x: number; y: number } | null = null;
    let autoLongCaptureOptions: AutoLongCaptureOptions | null = null;
    let autoLongCaptureTimer: number | null = null;
    let autoLongCaptureBusySessionId: number | null = null;
    let autoLongCaptureSessionId = 0;
    let autoLongCaptureFinishing = false;
    let autoLongCaptureBackendSessionId: string | null = null;
    let autoLongCaptureBackendFrameCount = 0;
    let autoLongCaptureBackendDuplicateCount = 0;
    let autoLongCaptureAxis: LongCaptureAxis | undefined;
    let autoLongCaptureDirection: LongCaptureDirection | undefined;
    let autoLongCaptureNextPollIntervalMs: number | null = null;
    let autoLongCaptureBurstBudget = 0;
    let autoLongCaptureBurstDeadlineAtMs = 0;
    let autoLongCaptureLastWheelAtMs = 0;
    let autoLongCaptureLastWheelLogAtMs = 0;
    let autoLongCaptureLastFrameLogAtMs = 0;
    let autoLongCaptureLastStatusUpdateAtMs = 0;

    const resetSelection = () => {
        setStartPos(null);
        setSelectionRect(null);
        setIsBoxSelecting(false);
        cachedStickerRects = [];
    };

    const stopAutoLongCaptureTimer = () => {
        if (autoLongCaptureTimer !== null) {
            window.clearTimeout(autoLongCaptureTimer);
            autoLongCaptureTimer = null;
        }
    };

    const setLongCaptureUiActive = (active: boolean) => {
        void api.setLongCaptureUiActive(active);
    };

    const restorePostCaptureInteractivity = async () => {
        await api.setOverlayClickThrough(true);
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

        // Record the capture in the screenshot history (downscaled thumbnail).
        // Non-blocking: a thumbnail failure must never break the capture flow.
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

    const describeLongCaptureRecordingStatus = (
        status: "recorded" | "duplicate",
    ) => {
        switch (status) {
            case "recorded":
                return "已采集当前画面，可继续向上/下或左/右滚动";
            case "duplicate":
                return "等待页面滚动，重复画面已忽略";
        }
    };

    const updateAutoLongCaptureSession = (
        analysis: {
            axis?: LongCaptureAxis;
            direction?: LongCaptureDirection;
            confidence?: number;
            message?: string;
            duplicateCount?: number;
        },
    ) => {
        setLongCaptureSession((session) => session && {
            ...session,
            frameCount: autoLongCaptureBackendFrameCount,
            duplicateCount: analysis.duplicateCount ?? autoLongCaptureBackendDuplicateCount,
            axis: analysis.axis ?? autoLongCaptureAxis,
            direction: analysis.direction ?? autoLongCaptureDirection,
            confidence: analysis.confidence,
            lastMessage: analysis.message,
        });
    };

    const isAutoLongCaptureSessionCurrent = (sessionId: number) =>
        sessionId === autoLongCaptureSessionId
        && !autoLongCaptureFinishing
        && !!autoLongCaptureRect
        && !!autoLongCaptureOptions;

    const setAutoLongCaptureNextPollInterval = (delayMs: number | null | undefined) => {
        if (!autoLongCaptureOptions || delayMs == null) return;
        const clampedDelay = Math.max(
            autoLongCaptureOptions.wheelPollIntervalMs,
            Math.min(autoLongCaptureOptions.maxPollIntervalMs, Math.round(delayMs)),
        );
        autoLongCaptureNextPollIntervalMs = autoLongCaptureNextPollIntervalMs == null
            ? clampedDelay
            : Math.min(autoLongCaptureNextPollIntervalMs, clampedDelay);
    };

    const scheduleAutoLongCaptureSample = (sessionId = autoLongCaptureSessionId) => {
        if (!isAutoLongCaptureSessionCurrent(sessionId) || !autoLongCaptureOptions) return;
        const delayMs = autoLongCaptureNextPollIntervalMs ?? autoLongCaptureOptions.pollIntervalMs;
        autoLongCaptureNextPollIntervalMs = null;
        stopAutoLongCaptureTimer();
        autoLongCaptureTimer = window.setTimeout(
            () => void sampleAutoLongCaptureFrame(sessionId),
            delayMs,
        );
    };

    const consumeAutoLongCaptureBurst = () => {
        if (!autoLongCaptureOptions) return false;
        const now = Date.now();
        if (autoLongCaptureBurstBudget <= 0) return false;
        if (now > autoLongCaptureBurstDeadlineAtMs) {
            autoLongCaptureBurstBudget = 0;
            return false;
        }
        autoLongCaptureBurstBudget -= 1;
        setAutoLongCaptureNextPollInterval(
            resolveAutoLongCaptureBurstPollInterval(autoLongCaptureOptions, autoLongCaptureBurstBudget),
        );
        return true;
    };

    const getAutoLongCaptureMillisSinceLastWheel = () =>
        autoLongCaptureLastWheelAtMs > 0 ? Date.now() - autoLongCaptureLastWheelAtMs : null;

    const drainAutoLongCaptureBeforeFinish = async (sessionId: number) => {
        if (!autoLongCaptureOptions) return;
        const options = autoLongCaptureOptions;
        const deadlineAt = Date.now() + options.finishDrainTimeoutMs;
        let drained = false;

        while (
            isAutoLongCaptureSessionCurrent(sessionId)
            && shouldDrainAutoLongCaptureBeforeFinish(options, {
                busy: autoLongCaptureBusySessionId === sessionId,
                burstBudget: autoLongCaptureBurstBudget,
                millisSinceLastWheel: getAutoLongCaptureMillisSinceLastWheel(),
            })
        ) {
            if (Date.now() >= deadlineAt) {
                await api.debugLogEvent(
                    "auto-long-capture-finish-drain-timeout",
                    `session=${autoLongCaptureBackendSessionId ?? "frontend"} busy=${autoLongCaptureBusySessionId === sessionId} burstBudget=${autoLongCaptureBurstBudget} millisSinceLastWheel=${getAutoLongCaptureMillisSinceLastWheel() ?? -1}`,
                );
                break;
            }

            drained = true;
            if (autoLongCaptureBusySessionId !== sessionId && autoLongCaptureBurstBudget > 0) {
                scheduleAutoLongCaptureSample(sessionId);
            }

            await new Promise<void>((resolve) => {
                window.setTimeout(resolve, options.burstPollIntervalMs);
            });
        }

        if (drained) {
            await api.debugLogEvent(
                "auto-long-capture-finish-drain",
                `session=${autoLongCaptureBackendSessionId ?? "frontend"} burstBudget=${autoLongCaptureBurstBudget} millisSinceLastWheel=${getAutoLongCaptureMillisSinceLastWheel() ?? -1}`,
            );
        }
    };

    const notifyAutoLongCaptureWheel = async (
        input: { deltaX?: number; deltaY?: number },
        sessionId = autoLongCaptureSessionId,
    ) => {
        if (!isAutoLongCaptureSessionCurrent(sessionId) || !autoLongCaptureOptions) return;
        const delayMs = resolveAutoLongCaptureWheelPollInterval(autoLongCaptureOptions, {
            axis: autoLongCaptureAxis,
            deltaX: input.deltaX,
            deltaY: input.deltaY,
        });
        if (delayMs == null) return;

        const now = Date.now();
        autoLongCaptureLastWheelAtMs = now;
        autoLongCaptureBurstDeadlineAtMs = now + autoLongCaptureOptions.burstWindowMs;
        autoLongCaptureBurstBudget = resolveAutoLongCaptureBurstBudget(
            autoLongCaptureOptions,
            autoLongCaptureBurstBudget,
        );
        setAutoLongCaptureNextPollInterval(delayMs);
        if (shouldLogAutoLongCaptureWheel(autoLongCaptureOptions, now, autoLongCaptureLastWheelLogAtMs)) {
            autoLongCaptureLastWheelLogAtMs = now;
            void api.debugLogEvent(
                "auto-long-capture-wheel",
                `session=${autoLongCaptureBackendSessionId ?? "frontend"} axis=${autoLongCaptureAxis ?? "unknown"} deltaX=${input.deltaX ?? 0} deltaY=${input.deltaY ?? 0} nextDelayMs=${autoLongCaptureNextPollIntervalMs ?? delayMs} busy=${autoLongCaptureBusySessionId === sessionId} burstBudget=${autoLongCaptureBurstBudget} burstDeadlineMs=${Math.max(0, autoLongCaptureBurstDeadlineAtMs - now)}`,
            );
        }

        if (autoLongCaptureBusySessionId === sessionId) {
            return;
        }

        scheduleAutoLongCaptureSample(sessionId);
    };

    const sampleAutoLongCaptureFrame = async (sessionId = autoLongCaptureSessionId) => {
        if (!isAutoLongCaptureSessionCurrent(sessionId) || !autoLongCaptureRect || !autoLongCaptureOptions) return;
        if (autoLongCaptureBusySessionId === sessionId) return;

        autoLongCaptureBusySessionId = sessionId;
        try {
            const backendSessionId = autoLongCaptureBackendSessionId;
            if (!backendSessionId) {
                await api.debugLogEvent(
                    "auto-long-capture-missing-backend-session",
                    `session=${sessionId}`,
                );
                return;
            }

            const response = await api.sampleLongCaptureSession(backendSessionId);
            if (!isAutoLongCaptureSessionCurrent(sessionId)) return;
            autoLongCaptureBackendFrameCount = response.frameCount;
            autoLongCaptureBackendDuplicateCount = response.duplicateCount;
            autoLongCaptureAxis = response.axis ?? autoLongCaptureAxis;
            autoLongCaptureDirection = response.direction ?? autoLongCaptureDirection;
            setAutoLongCaptureNextPollInterval(
                resolveAutoLongCaptureSessionPollInterval(autoLongCaptureOptions, response.status),
            );
            const now = Date.now();
            if (shouldUpdateAutoLongCaptureStatus(autoLongCaptureOptions, now, autoLongCaptureLastStatusUpdateAtMs)) {
                autoLongCaptureLastStatusUpdateAtMs = now;
                updateAutoLongCaptureSession({
                    axis: autoLongCaptureAxis,
                    direction: autoLongCaptureDirection,
                    duplicateCount: response.duplicateCount,
                    message: describeLongCaptureRecordingStatus(response.status),
                });
            }
            if (shouldLogAutoLongCaptureFrame(autoLongCaptureOptions, now, autoLongCaptureLastFrameLogAtMs)) {
                autoLongCaptureLastFrameLogAtMs = now;
                void api.debugLogEvent(
                    "auto-long-capture-frame",
                    `session=${autoLongCaptureBackendSessionId} count=${autoLongCaptureBackendFrameCount} duplicates=${response.duplicateCount} recorded=${response.recorded} status=${response.status}`,
                );
            }
        } catch (error) {
            await api.debugLogEvent("auto-long-capture-frame-failed", error instanceof Error ? error.message : String(error));
        } finally {
            if (autoLongCaptureBusySessionId === sessionId) {
                autoLongCaptureBusySessionId = null;
            }
            consumeAutoLongCaptureBurst();
            scheduleAutoLongCaptureSample(sessionId);
        }
    };

    const startAutoLongCaptureSession = async (
        rect: CaptureRect,
        origin: { x: number; y: number },
    ) => {
        stopAutoLongCaptureTimer();
        autoLongCaptureSessionId += 1;
        const sessionId = autoLongCaptureSessionId;
        autoLongCaptureBusySessionId = null;
        autoLongCaptureFinishing = false;
        autoLongCaptureRect = rect;
        autoLongCaptureOrigin = origin;
        autoLongCaptureOptions = createAutoLongCaptureOptions(rect);
        autoLongCaptureAxis = undefined;
        autoLongCaptureDirection = undefined;
        autoLongCaptureNextPollIntervalMs = null;
        autoLongCaptureBurstBudget = 0;
        autoLongCaptureBurstDeadlineAtMs = 0;
        autoLongCaptureLastWheelAtMs = 0;
        autoLongCaptureLastWheelLogAtMs = 0;
        autoLongCaptureLastFrameLogAtMs = 0;
        autoLongCaptureLastStatusUpdateAtMs = 0;
        autoLongCaptureBackendSessionId = null;
        autoLongCaptureBackendFrameCount = 0;
        autoLongCaptureBackendDuplicateCount = 0;

        resetSelection();
        setLongCaptureUiActive(true);
        setLongCaptureSession({
            active: true,
            rect,
            frameCount: 0,
            duplicateCount: 0,
            status: "capturing",
            lastMessage: "请滚动目标页面，Hook 会高频采集非重复画面并在结束时统一拼接",
        });
        await api.debugLogEvent("auto-long-capture-start", `x=${rect.x} y=${rect.y} w=${rect.w} h=${rect.h}`);
        await api.setMouseMonitorActive(false);
        await api.setOverlayClickThrough(true);
        // Exclude Hook from WGC/GDI samples so scrolling content underneath is
        // what gets fingerprinted — otherwise every frame matches the overlay.
        try {
            await api.setOverlayCaptureExclusion(true);
        } catch (error) {
            await api.debugLogEvent(
                "auto-long-capture-overlay-exclusion-failed",
                error instanceof Error ? error.message : String(error),
            );
        }
        try {
            autoLongCaptureBackendSessionId = await api.startLongCaptureSession(rect, autoLongCaptureAxis);
            await api.debugLogEvent(
                "auto-long-capture-backend-start",
                `session=${autoLongCaptureBackendSessionId} x=${rect.x} y=${rect.y} w=${rect.w} h=${rect.h} axis=${autoLongCaptureAxis ?? "auto"}`,
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
            try {
                await api.setOverlayCaptureExclusion(false);
            } catch {
                // ignore restore failure during abort
            }
            await restorePostCaptureInteractivity();
            return;
        }
        await sampleAutoLongCaptureFrame(sessionId);
    };

    const finishAutoLongCaptureSession = async () => {
        await api.setCaptureInputActive(false);
        if (autoLongCaptureFinishing) return false;
        if (!autoLongCaptureRect || !autoLongCaptureOrigin || !autoLongCaptureOptions) {
            return false;
        }

        const sessionId = autoLongCaptureSessionId;
        const rect = autoLongCaptureRect;
        const origin = autoLongCaptureOrigin;
        await drainAutoLongCaptureBeforeFinish(sessionId);
        const axis = autoLongCaptureAxis;
        const direction = autoLongCaptureDirection;
        const backendSessionId = autoLongCaptureBackendSessionId;

        autoLongCaptureFinishing = true;
        stopAutoLongCaptureTimer();
        setLongCaptureSession((session) => session && {
            ...session,
            status: "stitching",
            lastMessage: "正在统一拼接，无法匹配的临时帧会自动跳过",
        });

        try {
            if (!backendSessionId) {
                await api.debugLogEvent("auto-long-capture-finish-empty", `session=${sessionId}`);
                return false;
            }
            const response = await api.finishLongCaptureSession(backendSessionId);
            await addCaptureSticker(response, rect, origin, "long", axis);
            await api.debugLogEvent(
                "auto-long-capture-finish",
                `frames=${autoLongCaptureBackendFrameCount} duplicates=${autoLongCaptureBackendDuplicateCount} axis=${axis ?? "unknown"} direction=${direction ?? "unknown"}`,
            );
        } catch (error) {
            await api.debugLogEvent("auto-long-capture-finish-failed", error instanceof Error ? error.message : String(error));
        } finally {
            if (autoLongCaptureSessionId === sessionId) {
                autoLongCaptureSessionId += 1;
            }
            autoLongCaptureBusySessionId = null;
            autoLongCaptureFinishing = false;
            autoLongCaptureRect = null;
            autoLongCaptureOrigin = null;
            autoLongCaptureOptions = null;
            autoLongCaptureAxis = undefined;
            autoLongCaptureDirection = undefined;
            autoLongCaptureNextPollIntervalMs = null;
            autoLongCaptureBurstBudget = 0;
            autoLongCaptureBurstDeadlineAtMs = 0;
            autoLongCaptureLastWheelAtMs = 0;
            autoLongCaptureLastWheelLogAtMs = 0;
            autoLongCaptureLastFrameLogAtMs = 0;
            autoLongCaptureLastStatusUpdateAtMs = 0;
            autoLongCaptureBackendSessionId = null;
            autoLongCaptureBackendFrameCount = 0;
            autoLongCaptureBackendDuplicateCount = 0;
            setLongCaptureSession(null);
            setLongCaptureUiActive(false);
            resetSelection();
            try {
                await api.setOverlayCaptureExclusion(false);
            } catch (error) {
                await api.debugLogEvent(
                    "auto-long-capture-overlay-exclusion-restore-failed",
                    error instanceof Error ? error.message : String(error),
                );
            }
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
        stopAutoLongCaptureTimer();
        autoLongCaptureRect = null;
        autoLongCaptureOrigin = null;
        autoLongCaptureOptions = null;
        autoLongCaptureAxis = undefined;
        autoLongCaptureDirection = undefined;
        autoLongCaptureNextPollIntervalMs = null;
        autoLongCaptureBurstBudget = 0;
        autoLongCaptureBurstDeadlineAtMs = 0;
        autoLongCaptureLastWheelAtMs = 0;
        autoLongCaptureLastWheelLogAtMs = 0;
        autoLongCaptureLastFrameLogAtMs = 0;
        autoLongCaptureLastStatusUpdateAtMs = 0;
        if (autoLongCaptureBackendSessionId) {
            try {
                await api.cancelLongCaptureSession(autoLongCaptureBackendSessionId);
            } catch (error) {
                await api.debugLogEvent(
                    "auto-long-capture-backend-cancel-failed",
                    error instanceof Error ? error.message : String(error),
                );
            }
        }
        autoLongCaptureBackendSessionId = null;
        autoLongCaptureBackendFrameCount = 0;
        autoLongCaptureBackendDuplicateCount = 0;
        setLongCaptureSession(null);
        setLongCaptureUiActive(false);
        resetSelection();
        await api.debugLogEvent("auto-long-capture-cancel");
        try {
            await api.setOverlayCaptureExclusion(false);
        } catch (error) {
            await api.debugLogEvent(
                "auto-long-capture-overlay-exclusion-restore-failed",
                error instanceof Error ? error.message : String(error),
            );
        }
        await restorePostCaptureInteractivity();
        return true;
    };

    const handleSelectionStart = (e: Pick<MouseEvent, "clientX" | "clientY" | "shiftKey" | "ctrlKey">) => {
         // Canvas box selection only (region capture is native).
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
