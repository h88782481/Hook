import { createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import {
    addStickerPaletteColor,
    createDefaultStickerColorState,
    createDefaultStickerToolSettings,
    removeStickerPaletteColor,
} from "../services/stickerEditing";
import { normalizePaletteColor } from "../utils/colorUtils";
import {
    createEmptyStickerHistory,
    pushStickerHistorySnapshot,
    redoStickerHistorySnapshot,
    undoStickerHistorySnapshot,
    type StickerEditHistory,
    type StickerEditSnapshot,
} from "../services/stickerHistory";
import type {
    StickerColorState,
    StickerEditingDomain,
    StickerCanvasTool,
    StickerCreateTool,
    StickerToolSettings,
    StickerToolMode,
    StickerTransformMode,
} from "../types/stickerEditing";
import type { CaptureRect, LongCaptureAxis, LongCaptureDirection } from "../services/captureState";
import {
    addColorToHistory,
    addScreenshotToHistory,
    createEmptyHistoryState,
    removeScreenshotFromHistory,
    type HistoryState,
    type ScreenshotHistoryEntry,
} from "../services/historyModel";
import { api } from "../services/api";
import { applyStickerToolSettingsPatch, normalizeStickerToolSettings } from "../services/toolSettings";
import type { ClipboardStickerPayload } from "../types/stickerModel";

// Selection: selectedStickerIds is the single source of truth.
// selectedStickerId is the focused/active sticker (last entry), derived from it.
export const [selectedStickerIds, setSelectedStickerIds] = createStore<string[]>([]);

export const selectedStickerId = (): string | null => {
    const length = selectedStickerIds.length;
    return length > 0 ? selectedStickerIds[length - 1] : null;
};

export const selectionActions = {
    add: (id: string) => {
        setSelectedStickerIds((prev) => (prev.includes(id) ? prev.filter((uid) => uid !== id).concat(id) : [...prev, id]));
    },
    remove: (id: string) => {
        setSelectedStickerIds((prev) => prev.filter((uid) => uid !== id));
    },
    toggle: (id: string) => {
        if (selectedStickerIds.includes(id)) {
            selectionActions.remove(id);
        } else {
            selectionActions.add(id);
        }
    },
    clear: () => {
        setSelectedStickerIds([]);
    },
    set: (ids: string[]) => {
        setSelectedStickerIds(ids);
    },
    isSelected: (id: string) => selectedStickerIds.includes(id),
};

// Global Dragging State
export const [draggingStickerId, setDraggingStickerId] = createSignal<string | null>(null);
// Primary dragged sticker for snapping; multi-drag offsets live in multiDragPositions.
export const [multiDragPositions, setMultiDragPositions] = createSignal<Record<string, {x: number, y: number}> | null>(null);
// Capture Mode (Screenshot)
export const [isSelecting, setIsSelecting] = createSignal(false);
export const [captureMode, setCaptureMode] = createSignal<"region" | "long-vertical">("region");
export const [longCaptureSession, setLongCaptureSession] = createSignal<{
    active: boolean;
    rect: CaptureRect;
    frameCount: number;
    duplicateCount?: number;
    status: "capturing" | "stitching";
    axis?: LongCaptureAxis;
    direction?: LongCaptureDirection;
    confidence?: number;
    lastMessage?: string;
} | null>(null);
// Box Selection (Multi-Select)
export const [isBoxSelecting, setIsBoxSelecting] = createSignal(false);

export const [startPos, setStartPos] = createSignal<{x: number, y: number} | null>(null);
export const [selectionRect, setSelectionRect] = createSignal<{x: number, y: number, w: number, h: number} | null>(null);
export const [preciseRect, setPreciseRect] = createSignal<{x: number, y: number, w: number, h: number} | null>(null);
// Clean View Mode (Hides UI overlay)
export const [isCleanView, setIsCleanView] = createSignal(false);
export const [activeStickerEditTargetId, setActiveStickerEditTargetId] = createSignal<string | null>(null);
export const [selectedStickerAnnotationId, setSelectedStickerAnnotationId] = createSignal<string | null>(null);
export const [selectedStickerAnnotationIds, setSelectedStickerAnnotationIds] = createStore<string[]>([]);
export const [activeStickerGroupId, setActiveStickerGroupId] = createSignal<string | null>(null);
export const [stickerEditCancelToken, setStickerEditCancelToken] = createSignal(0);
/** True while sticker annotation text input is focused; disables overlay key hook so typing works. */
export const [annotationTextEditing, setAnnotationTextEditing] = createSignal(false);
export const [stickerToolSettings, setStickerToolSettings] = createStore<StickerToolSettings>(
    createDefaultStickerToolSettings(),
);
export const [installedStickerFonts, setInstalledStickerFonts] = createSignal<string[]>([]);
export const [stickerColorPickerReturnMode, setStickerColorPickerReturnMode] = createSignal<StickerCreateTool | null>(null);
export const [stickerColorState, setStickerColorState] = createStore<StickerColorState>(
    createDefaultStickerColorState(),
);
export const [stickerEditHistories, setStickerEditHistories] = createStore<Record<string, StickerEditHistory>>({});

// Color + Screenshot History (persisted to disk via save_history/load_history)
export const [historyState, setHistoryState] = createStore<HistoryState>(createEmptyHistoryState());
export const [isHistoryPanelOpen, setIsHistoryPanelOpen] = createSignal(false);

// Force Reactivity Tick for Layout (e.g. Fit Frame)
export const [layoutTick, setLayoutTick] = createSignal(0);

// Linking State
export const [linkingState, setLinkingState] = createSignal<{
    isLinking: boolean,
    sourceStickerId: string | null,
    sourcePortId: string | null,
    startX: number,
    startY: number
}>({
    isLinking: false,
    sourceStickerId: null,
    sourcePortId: null,
    startX: 0,
    startY: 0
});

export const [hoveringLink, setHoveringLink] = createSignal<{sourceStickerId: string | null, targetStickerId: string | null}>({
    sourceStickerId: null,
    targetStickerId: null
});

// Mouse Tracking
export const [mousePos, setMousePos] = createSignal({ x: 0, y: 0 });

// Sticker-Specific UI State (e.g. Panels open/close)
// Key: Sticker ID
export const [stickerUiState, setStickerUiState] = createStore<Record<string, { showActions: boolean; showSidePanel: boolean }>>({});


// Clipboard paste cascade state (shared content fields live on StickerContentPayload)
export type ClipboardData = ClipboardStickerPayload;
export const [clipboard, setClipboard] = createSignal<ClipboardData | null>(null);

// Persist the current history store to disk. Failures are non-fatal: history
// is a convenience cache, not critical state.
let persistHistoryTimer: ReturnType<typeof setTimeout> | null = null;
let persistToolSettingsTimer: ReturnType<typeof setTimeout> | null = null;
const persistHistory = async () => {
    if (persistHistoryTimer) clearTimeout(persistHistoryTimer);
    persistHistoryTimer = setTimeout(() => {
        void (async () => {
            try {
                await api.saveHistory(
                    [...historyState.colors],
                    [...historyState.screenshots],
                );
            } catch (error) {
                console.error("Failed to persist history", error);
            }
        })();
    }, 250);
};

const persistToolSettings = async () => {
    if (persistToolSettingsTimer) clearTimeout(persistToolSettingsTimer);
    persistToolSettingsTimer = setTimeout(() => {
        void (async () => {
            try {
                await api.saveToolSettings({ ...stickerToolSettings });
            } catch (error) {
                console.error("Failed to persist sticker tool settings", error);
            }
        })();
    }, 250);
};

export const uiActions = {

    // Helper to toggle actions menu safely
    toggleActions: (id: string) => {
        setStickerUiState(id, (prev) => {
            const current = prev?.showActions ?? false;
            return { ...prev, showActions: !current };
        });
    },
    // Helper to toggle sticker side panel safely
    toggleSidePanel: (id: string) => {
        setStickerUiState(id, (prev) => {
            const current = prev?.showSidePanel ?? false;
            return { ...prev, showSidePanel: !current };
        });
    },
    closeActions: (id: string) => {
        setStickerUiState(id, (prev) => ({
            ...prev,
            showActions: false,
        }));
    },
    closePopups: (id: string) => {
        setStickerUiState(id, (prev) => ({
            ...prev,
            showActions: false,
            showSidePanel: false,
        }));
    },
    closeAllPopups: () => {
        // Collapse every sticker's action/side popups. Iterate the keys currently
        // present in the store rather than leaving this as a no-op.
        Object.keys(stickerUiState).forEach((id) => {
            setStickerUiState(id, (prev) => ({
                ...prev,
                showActions: false,
                showSidePanel: false,
            }));
        });
    },
    clearStickerUiState: (stickerId: string) => {
        setStickerUiState(stickerId, undefined!);
    },
    setStickerEditMode: (mode: StickerToolSettings["mode"]) => {
        setStickerColorPickerReturnMode(null);
        if (mode === "select" || mode === "move" || mode === "rotate" || mode === "scale") {
            setStickerToolSettings((prev) =>
                applyStickerToolSettingsPatch(prev, {
                    domain: "existing",
                    mode,
                    transformMode: mode,
                }),
            );
            return;
        }

        setStickerToolSettings((prev) =>
            applyStickerToolSettingsPatch(prev, {
                domain: mode === "crop" || mode === "content-eraser" ? "sticker" : "create",
                mode,
                activeCanvasTool:
                    mode === "crop" || mode === "content-eraser"
                        ? mode
                        : prev.activeCanvasTool,
                activeTool:
                    mode === "idle" || mode === "crop" || mode === "content-eraser"
                        ? prev.activeTool
                        : mode,
            }),
        );
    },
    setStickerTransformMode: (transformMode: StickerTransformMode) => {
        setStickerColorPickerReturnMode(null);
        setStickerToolSettings((prev) =>
            applyStickerToolSettingsPatch(prev, {
                domain: "existing",
                mode: transformMode,
                transformMode,
            }),
        );
        void persistToolSettings();
    },
    setStickerEditingDomain: (domain: StickerEditingDomain) => {
        setStickerColorPickerReturnMode(null);
        setStickerToolSettings((prev) =>
            applyStickerToolSettingsPatch(prev, {
                domain,
                activeCanvasTool: domain === "sticker" ? "idle" : prev.activeCanvasTool,
                mode:
                    domain === "existing"
                        ? prev.transformMode
                        : domain === "sticker"
                          ? "idle"
                          : prev.activeTool,
            }),
        );
        void persistToolSettings();
    },
    setStickerActiveTool: (activeTool: StickerCreateTool) => {
        setStickerColorPickerReturnMode(null);
        setStickerToolSettings((prev) =>
            applyStickerToolSettingsPatch(prev, {
                domain: "create",
                mode: activeTool,
                activeTool,
            }),
        );
        void persistToolSettings();
    },
    setStickerCanvasTool: (activeCanvasTool: StickerCanvasTool) => {
        setStickerColorPickerReturnMode(null);
        setStickerToolSettings((prev) =>
            applyStickerToolSettingsPatch(prev, {
                domain: "sticker",
                mode: activeCanvasTool,
                activeCanvasTool,
            }),
        );
        void persistToolSettings();
    },
    beginStickerScreenColorPick: (returnMode?: StickerCreateTool | null) => {
        setStickerColorPickerReturnMode(returnMode && returnMode !== "color-picker" ? returnMode : null);
        setStickerToolSettings((prev) =>
            applyStickerToolSettingsPatch(prev, {
                mode: "color-picker",
                activeTool: "color-picker",
            }),
        );
    },
    consumeStickerColorPickerReturnMode: () => {
        const mode = stickerColorPickerReturnMode();
        setStickerColorPickerReturnMode(null);
        return mode;
    },
    patchStickerToolSettings: (updates: Partial<StickerToolSettings>) => {
        setStickerToolSettings((prev) => applyStickerToolSettingsPatch(prev, updates));
        void persistToolSettings();
    },
    setStickerToolSettings: (updates: Partial<StickerToolSettings>) => {
        setStickerToolSettings((prev) => applyStickerToolSettingsPatch(prev, updates));
        void persistToolSettings();
    },
    setStickerActiveColor: (color: string) => {
        setStickerColorState("activeColor", color);
    },
    addStickerPaletteColor: (color: string) => {
        const normalized = normalizePaletteColor(color);
        if (!normalized) return;
        setStickerColorState("palette", (palette) => addStickerPaletteColor(palette, normalized));
    },
    removeStickerPaletteColor: (color: string) => {
        const normalized = normalizePaletteColor(color);
        if (!normalized) return;
        setStickerColorState("palette", (palette) => removeStickerPaletteColor(palette, normalized));
    },

    // --- Color + Screenshot history ---
    // Replace the whole history state (used on load from disk).
    setHistoryState: (next: HistoryState) => {
        setHistoryState("colors", next.colors);
        setHistoryState("screenshots", next.screenshots);
    },
    recordColorHistory: (color: { hex: string; rgb: { r: number; g: number; b: number } }) => {
        setHistoryState("colors", (colors) => addColorToHistory(colors, color, Date.now()));
        void persistHistory();
    },
    recordScreenshotHistory: (entry: ScreenshotHistoryEntry) => {
        setHistoryState("screenshots", (screenshots) => addScreenshotToHistory(screenshots, entry));
        void persistHistory();
    },
    removeScreenshotHistory: (id: string) => {
        setHistoryState("screenshots", (screenshots) => removeScreenshotFromHistory(screenshots, id));
        void persistHistory();
    },
    toggleHistoryPanel: () => {
        setIsHistoryPanelOpen((open) => !open);
    },
    setHistoryPanelOpen: (open: boolean) => {
        setIsHistoryPanelOpen(open);
    },

    setActiveStickerEditTarget: (stickerId: string | null) => {
        setActiveStickerEditTargetId(stickerId);
    },
    showStickerToolbar: (stickerId: string) => {
        setActiveStickerEditTargetId(stickerId);
        setSelectedStickerAnnotationId(null);
        setSelectedStickerAnnotationIds([]);
        setStickerToolSettings((prev) =>
            applyStickerToolSettingsPatch(prev, {
                mode: "select",
                transformMode: "select",
            }),
        );
    },
    hideStickerToolbar: () => {
        setActiveStickerEditTargetId(null);
        setSelectedStickerAnnotationId(null);
        setSelectedStickerAnnotationIds([]);
        setStickerToolSettings((prev) =>
            applyStickerToolSettingsPatch(prev, {
                mode: "select",
                transformMode: "select",
            }),
        );
        setStickerEditCancelToken((value) => value + 1);
    },
    setSelectedStickerAnnotation: (annotationId: string | null) => {
        setSelectedStickerAnnotationId(annotationId);
        setSelectedStickerAnnotationIds(annotationId ? [annotationId] : []);
    },
    setSelectedStickerAnnotations: (annotationIds: string[]) => {
        const ids = Array.from(new Set(annotationIds));
        setSelectedStickerAnnotationIds(ids);
        setSelectedStickerAnnotationId(ids.length > 0 ? ids[ids.length - 1] : null);
    },
    requestStickerEditCancel: () => {
        setStickerEditCancelToken((value) => value + 1);
    },
    setActiveStickerGroup: (groupId: string | null) => {
        setActiveStickerGroupId(groupId);
    },
    pushStickerHistory: (stickerId: string, snapshot: StickerEditSnapshot) => {
        setStickerEditHistories(stickerId, (prev) =>
            pushStickerHistorySnapshot(prev || createEmptyStickerHistory(), snapshot),
        );
    },
    undoStickerHistory: (stickerId: string, current: StickerEditSnapshot) => {
        const result = undoStickerHistorySnapshot(
            stickerEditHistories[stickerId] || createEmptyStickerHistory(),
            current,
        );
        setStickerEditHistories(stickerId, result.history);
        return result.snapshot;
    },
    redoStickerHistory: (stickerId: string, current: StickerEditSnapshot) => {
        const result = redoStickerHistorySnapshot(
            stickerEditHistories[stickerId] || createEmptyStickerHistory(),
            current,
        );
        setStickerEditHistories(stickerId, result.history);
        return result.snapshot;
    },
    clearStickerHistory: (stickerId: string) => {
        setStickerEditHistories(stickerId, undefined!);
    },
};
