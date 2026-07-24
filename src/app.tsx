import { onMount, onCleanup, createEffect, createSignal, Show, ErrorBoundary } from "solid-js";
import { api, isTauriRuntimeAvailable } from "./services/api";
import { listen } from "@tauri-apps/api/event";
import { installErrorDiagnostics } from "./services/errorDiagnostics";
import { logger } from "./services/logger";

import "./app.css";

// Components
import { CanvasLinks } from "./components/CanvasLinks";
import { CanvasStickers } from "./components/CanvasStickers";
import { CanvasSelection } from "./components/CanvasSelection";
import { StickerGroupBar } from "./components/StickerGroupBar";
import { HistoryPanel } from "./components/HistoryPanel";
import { StickerContextMenuLayer } from "./components/StickerContextMenuLayer";
import { sanitizeHistoryState } from "./services/historyModel";
import { normalizeStickerToolSettings } from "./services/toolSettings";
import { setAppSettings } from "./store/appSettingsStore";
import { normalizeAppSettings } from "./services/appSettings";
import { addRecycleBinEntry } from "./services/stickerLibraryModel";
import { captureFrozenStickerSnapshot } from "./services/stickerSnapshot";

// Stores & Services
import { stickerStore } from "./store/stickerStore";
import {
    linkingState,
    setLinkingState,
    setMousePos,
    selectedStickerId,
    uiActions,
    isCleanView,
    setIsCleanView,
    selectedStickerIds,
    selectionActions,
    activeStickerEditTargetId,
    setActiveStickerEditTargetId,
    stickerToolSettings,
    selectedStickerAnnotationId,
    longCaptureSession,
    draggingStickerId,
    annotationTextEditing,
} from "./store/uiStore";


import { syncService } from "./services/syncService";
import { resolveStickerImage } from "./services/stickerImageResolution";
import type { BootProfile } from "./services/bootProfile";
import { captureStickerEditSnapshot } from "./services/stickerHistory";
import { removeAnnotationById } from "./services/stickerAnnotationMutations";
import { stickerContextMenuController } from "./services/stickerContextMenuController";
import {
    resolveShortcutContext,
    shouldStartCanvasSelectionFromTarget,
} from "./services/captureState";

// Hooks
import { useDraggable } from "./hooks/useDraggable";
import { useSelection } from "./hooks/useSelection";
import { useShortcuts, checkDragModifier } from "./hooks/useShortcuts";
import { useLinking } from "./hooks/useLinking";
import { useStickerActions } from "./hooks/useStickerActions";
import { useClipboard } from "./hooks/useClipboard";
import { useFileDrop } from "./hooks/useFileDrop";
import type { Sticker, Link } from "./types/stickerModel";

type OverlaySyntheticMousePayload = {
    x?: number;
    y?: number;
    globalX?: number;
    globalY?: number;
    ctrlKey?: boolean;
    altKey?: boolean;
    shiftKey?: boolean;
    deltaY?: number;
    nativeDragPreflight?: boolean;
};

export default function App() {
  let portsLayerRef: HTMLDivElement | undefined;
  let activeBootProfile: BootProfile | null = null;
  const tauriRuntime = isTauriRuntimeAvailable();

  // Hooks Integration
  const { startDrag, handleDragMove, handleDragEnd } = useDraggable();
  const {
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
  } = useSelection();
  const { handleDoubleClick, propagateFromSticker } = useStickerActions();
  const { startLinking, handleLinkDrop, handleInputLinkDrag, handleLinkHover } = useLinking({
      onLinkCreated: (sourceId) => {
          stickerStore.actions.propagateStickerEditsFrom(sourceId);
          // Defer propagation to a microtask so it runs after the synchronous
          // store writes above settle, without the arbitrary 20ms delay.
          queueMicrotask(() => propagateFromSticker(sourceId));
      },
  });
  const { handlePaste, handleCopy, handleSave, createImageSticker } = useClipboard();
  useFileDrop();

  const STICKER_GLOBAL_DELETE_ARM_WINDOW_MS = 2500;
  const OVERLAY_SYNTHETIC_CLICK_MAX_DISTANCE = 4;
  const OVERLAY_SYNTHETIC_DOUBLE_CLICK_MAX_DELAY_MS = 320;
  let lastStickerKeyboardDeleteArmAt = 0;
  let overlaySyntheticPointerTarget: EventTarget | null = null;
  let overlaySyntheticPointerDownTarget: EventTarget | null = null;
  let overlaySyntheticHoverTarget: EventTarget | null = null;
  let overlaySyntheticPointerDownPoint: { x: number; y: number } | null = null;
  let overlaySyntheticLastClickTarget: EventTarget | null = null;
  let overlaySyntheticLastClickPoint: { x: number; y: number } | null = null;
  let overlaySyntheticLastClickAt = 0;
  let overlaySyntheticPointerActive = false;
  let overlaySyntheticPrimaryButtonDown = false;
  let overlaySyntheticMoveRelayActive = false;
  const armStickerKeyboardDelete = () => {
      lastStickerKeyboardDeleteArmAt = Date.now();
  };
  const resetOverlaySyntheticPointerState = () => {
      overlaySyntheticPointerTarget = null;
      overlaySyntheticPointerActive = false;
      overlaySyntheticPrimaryButtonDown = false;
      overlaySyntheticMoveRelayActive = false;
  };
  const dispatchSyntheticOverlayMouseEvent = (
      type: "mousedown" | "mousemove" | "mouseup" | "wheel" | "contextmenu",
      payload: OverlaySyntheticMousePayload,
  ) => {
      if (typeof document === "undefined") return;

      const clientX = payload.x ?? payload.globalX ?? 0;
      const clientY = payload.y ?? payload.globalY ?? 0;
      const appMain = document.getElementById("app-main");
      const resolveEditableSyntheticControl = (target: EventTarget | null) => {
          if (!(target instanceof Element)) return null;
          if (
              target instanceof HTMLInputElement ||
              target instanceof HTMLSelectElement ||
              target instanceof HTMLTextAreaElement
          ) {
              return target;
          }
          return target.closest("input, select, textarea");
      };
      const focusEditableSyntheticControl = (target: EventTarget | null) => {
          const editable = resolveEditableSyntheticControl(target);
          if (!editable || !(editable instanceof HTMLElement)) return;
          editable.focus();
      };
      const isOverlayRootTarget = (target: EventTarget | null) =>
          target === appMain ||
          target === document.body ||
          target === document.documentElement ||
          target === window;
      const isStickerInteractionRootTarget = (target: EventTarget | null) =>
          target instanceof Element &&
          target.getAttribute("data-sticker-interaction-root") === "true";
      const resolveTarget = (allowFallback: boolean) => {
          const rawTarget = document.elementFromPoint(clientX, clientY) as EventTarget | null;
          if (!rawTarget || isOverlayRootTarget(rawTarget)) {
              return allowFallback ? appMain ?? window : null;
          }
          if (rawTarget instanceof Element) {
              const stickerInteractionRoot =
                  rawTarget.closest?.("[data-sticker-interaction-root='true']") ?? null;
              if (stickerInteractionRoot) {
                  return stickerInteractionRoot;
              }
          }
          return rawTarget;
      };
      const buildBaseInit = (button: number, buttons: number) => ({
          bubbles: true,
          cancelable: true,
          composed: true,
          clientX,
          clientY,
          screenX: payload.globalX ?? clientX,
          screenY: payload.globalY ?? clientY,
          ctrlKey: !!payload.ctrlKey,
          altKey: !!payload.altKey,
          shiftKey: !!payload.shiftKey,
          button,
          buttons,
      });
      const dispatchHoverTransition = (
          nextTarget: EventTarget | null,
          pointerInit: PointerEventInit,
          mouseInit: MouseEventInit,
      ) => {
          const previousTarget = overlaySyntheticHoverTarget;
          if (previousTarget === nextTarget) {
              return;
          }

          if (previousTarget) {
              if (typeof PointerEvent !== "undefined") {
                  previousTarget.dispatchEvent(
                      new PointerEvent("pointerout", {
                          ...pointerInit,
                          relatedTarget: nextTarget,
                      }),
                  );
                  previousTarget.dispatchEvent(
                      new PointerEvent("pointerleave", {
                          ...pointerInit,
                          bubbles: false,
                          relatedTarget: nextTarget,
                      }),
                  );
              }
              previousTarget.dispatchEvent(
                  new MouseEvent("mouseout", {
                      ...mouseInit,
                      relatedTarget: nextTarget,
                  }),
              );
              previousTarget.dispatchEvent(
                  new MouseEvent("mouseleave", {
                      ...mouseInit,
                      bubbles: false,
                      relatedTarget: nextTarget,
                  }),
              );
          }

          if (nextTarget) {
              if (typeof PointerEvent !== "undefined") {
                  nextTarget.dispatchEvent(
                      new PointerEvent("pointerover", {
                          ...pointerInit,
                          relatedTarget: previousTarget,
                      }),
                  );
                  nextTarget.dispatchEvent(
                      new PointerEvent("pointerenter", {
                          ...pointerInit,
                          bubbles: false,
                          relatedTarget: previousTarget,
                      }),
                  );
              }
              nextTarget.dispatchEvent(
                  new MouseEvent("mouseover", {
                      ...mouseInit,
                      relatedTarget: previousTarget,
                  }),
              );
              nextTarget.dispatchEvent(
                  new MouseEvent("mouseenter", {
                      ...mouseInit,
                      bubbles: false,
                      relatedTarget: previousTarget,
                  }),
              );
          }

          overlaySyntheticHoverTarget = nextTarget;
      };

      const baseInit =
          type === "contextmenu"
              ? buildBaseInit(2, 0)
              : buildBaseInit(
                    0,
                    type === "mouseup"
                        ? 0
                        : overlaySyntheticPrimaryButtonDown || type === "mousedown"
                          ? 1
                          : 0,
                );
      const pointerInit: PointerEventInit = {
          ...baseInit,
          pointerId: 1,
          pointerType: "mouse",
          isPrimary: true,
      };
      const shouldResolveLiveOverlayTarget =
          linkingState().isLinking && (type === "mousemove" || type === "mouseup");

      let target: EventTarget | null =
          type === "mousemove" && !overlaySyntheticPrimaryButtonDown
              ? resolveTarget(false)
              : resolveTarget(true);
      const shouldBypassSyntheticPointerCapture =
          type === "mousedown" &&
          !!payload.shiftKey &&
          isStickerInteractionRootTarget(target);
      if (type === "mousedown") {
          if (shouldBypassSyntheticPointerCapture) {
              overlaySyntheticPointerDownTarget = null;
              overlaySyntheticPointerDownPoint = null;
              resetOverlaySyntheticPointerState();
          } else {
              resetOverlaySyntheticPointerState();
              overlaySyntheticPointerTarget = target;
              overlaySyntheticPointerDownTarget = target;
              overlaySyntheticPointerDownPoint = { x: clientX, y: clientY };
              overlaySyntheticPointerActive = true;
              overlaySyntheticPrimaryButtonDown = true;
          }
      } else if (shouldResolveLiveOverlayTarget) {
          target = resolveTarget(true);
      } else if (
          (type === "mousemove" || type === "mouseup") &&
          overlaySyntheticPointerActive &&
          overlaySyntheticPointerTarget
      ) {
          target = overlaySyntheticPointerTarget;
      }
      if (type === "mousemove" && overlaySyntheticPrimaryButtonDown && draggingStickerId()) {
          target = appMain ?? window;
      }

      if (!target) {
          dispatchHoverTransition(null, pointerInit, baseInit);
          return;
      }

      if (
          type === "mousedown" ||
          (type === "mousemove" && !overlaySyntheticPrimaryButtonDown) ||
          type === "contextmenu"
      ) {
          dispatchHoverTransition(target, pointerInit, baseInit);
      }
      if (type === "mousedown") {
          focusEditableSyntheticControl(target);
      }

      if (type !== "wheel" && type !== "contextmenu" && typeof PointerEvent !== "undefined") {
          target.dispatchEvent(
              new PointerEvent(
                  type === "mouseup"
                      ? "pointerup"
                      : type === "mousemove"
                        ? "pointermove"
                        : "pointerdown",
                  pointerInit,
              ),
          );
      }

      if (type === "wheel") {
          target.dispatchEvent(
              new WheelEvent("wheel", {
                  ...baseInit,
                  deltaY: payload.deltaY ?? 0,
              }),
          );
      } else if (type === "contextmenu") {
          target.dispatchEvent(new MouseEvent("contextmenu", baseInit));
      } else {
          target.dispatchEvent(new MouseEvent(type, baseInit));
      }

      if (type === "mouseup") {
          if (
              overlaySyntheticPointerDownTarget &&
              overlaySyntheticPointerDownTarget === target &&
              overlaySyntheticPointerDownPoint &&
              Math.hypot(
                  clientX - overlaySyntheticPointerDownPoint.x,
                  clientY - overlaySyntheticPointerDownPoint.y,
              ) <= OVERLAY_SYNTHETIC_CLICK_MAX_DISTANCE
          ) {
              focusEditableSyntheticControl(target);
              target.dispatchEvent(new MouseEvent("click", buildBaseInit(0, 0)));
              const clickTime = Date.now();
              const isDoubleClick =
                  overlaySyntheticLastClickTarget === target &&
                  overlaySyntheticLastClickPoint &&
                  clickTime - overlaySyntheticLastClickAt <= OVERLAY_SYNTHETIC_DOUBLE_CLICK_MAX_DELAY_MS &&
                  Math.hypot(
                      clientX - overlaySyntheticLastClickPoint.x,
                      clientY - overlaySyntheticLastClickPoint.y,
                  ) <= OVERLAY_SYNTHETIC_CLICK_MAX_DISTANCE;
              if (isDoubleClick) {
                  target.dispatchEvent(new MouseEvent("dblclick", buildBaseInit(0, 0)));
                  overlaySyntheticLastClickTarget = null;
                  overlaySyntheticLastClickPoint = null;
                  overlaySyntheticLastClickAt = 0;
              } else {
                  overlaySyntheticLastClickTarget = target;
                  overlaySyntheticLastClickPoint = { x: clientX, y: clientY };
                  overlaySyntheticLastClickAt = clickTime;
              }
          }
          overlaySyntheticPointerDownTarget = null;
          overlaySyntheticPointerDownPoint = null;
          resetOverlaySyntheticPointerState();
      }
  };
  const relayOverlaySyntheticPointerMove = (event: MouseEvent) => {
      if (
          !overlaySyntheticPointerActive ||
          !overlaySyntheticPrimaryButtonDown ||
          !overlaySyntheticPointerTarget ||
          event.target === overlaySyntheticPointerTarget
      ) {
          return;
      }

      const baseInit = {
          bubbles: true,
          cancelable: true,
          composed: true,
          clientX: event.clientX,
          clientY: event.clientY,
          screenX: event.screenX,
          screenY: event.screenY,
          ctrlKey: event.ctrlKey,
          altKey: event.altKey,
          shiftKey: event.shiftKey,
          button: 0,
          buttons: event.buttons,
      };

      overlaySyntheticMoveRelayActive = true;
      try {
          if (typeof PointerEvent !== "undefined") {
              overlaySyntheticPointerTarget.dispatchEvent(
                  new PointerEvent("pointermove", {
                      ...baseInit,
                      pointerId: 1,
                      pointerType: "mouse",
                      isPrimary: true,
                  }),
              );
          }
          overlaySyntheticPointerTarget.dispatchEvent(new MouseEvent("mousemove", baseInit));
      } finally {
          overlaySyntheticMoveRelayActive = false;
      }
  };

  const toggleStickerToolbarVisibility = () => {
      const stickerId = selectedStickerId();
      if (tauriRuntime) {
          void api.debugLogEvent(
              "toggle-sticker-toolbar",
              `selected=${stickerId ?? "null"} active=${activeStickerEditTargetId() ?? "null"}`,
          );
      }
      if (!stickerId) return;
      const selectedSticker = stickerStore.stickers.find((unit) => unit.id === stickerId);
      if (!selectedSticker) return;

      if (activeStickerEditTargetId() === stickerId) {
          uiActions.hideStickerToolbar();
          return;
      }

      uiActions.showStickerToolbar(stickerId);
  };

  const scheduleOverlayHitTestRefresh = (options: { forceClickThrough?: boolean } = {}) => {
      window.setTimeout(() => {
          void (async () => {
              if (options.forceClickThrough) {
                  await api.setOverlayClickThrough(true);
              }
              if (stickerStore.stickers.length > 0) {
                  await api.setMouseMonitorActive(true);
                  await syncService.notify({ layout: true });
              }
          })();
      }, 0);
  };

  const applyStickerHistorySnapshot = async (direction: "undo" | "redo") => {
      const id = selectedStickerId();
      if (!id) return;
      const unit = stickerStore.stickers.find((item) => item.id === id);
      if (!unit) return;

      const current = captureStickerEditSnapshot(unit, { includeImageData: true });
      const snapshot =
          direction === "undo"
              ? uiActions.undoStickerHistory(id, current)
              : uiActions.redoStickerHistory(id, current);

      if (!snapshot) return;
      stickerStore.actions.restoreStickerEditSnapshot(id, snapshot);
      stickerStore.actions.propagateStickerEditsFrom(id);
      await syncService.notify({ persist: true });
  };

  const deleteSelectedStickerOrAnnotation = () => {
      const annotationId = selectedStickerAnnotationId();
      const stickerId = selectedStickerId();
      if (annotationId && stickerId) {
          const activeSticker = stickerStore.stickers.find((unit) => unit.id === stickerId);
          if (activeSticker?.data.annotationState) {
              uiActions.pushStickerHistory(stickerId, captureStickerEditSnapshot(activeSticker));
              stickerStore.actions.updateStickerEditData(stickerId, {
                  annotationState: removeAnnotationById(activeSticker.data.annotationState, annotationId),
              });
              stickerStore.actions.propagateStickerEditsFrom(stickerId);
              uiActions.setSelectedStickerAnnotation(null);
              void syncService.notify({ persist: true });
              return;
          }
      }

      const selectedSticker = selectedStickerId();
      const ids = selectedStickerIds.length > 0
          ? [...selectedStickerIds]
          : selectedSticker
              ? [selectedSticker]
              : [];

      if (ids.length > 0) {
          const recycleEntries = ids
              .map((id) => stickerStore.stickers.find((unit) => unit.id === id))
              .filter((unit): unit is Sticker => !!unit)
              .map((unit) => captureFrozenStickerSnapshot(unit));

          if (recycleEntries.length > 0) {
              stickerStore.setRecycleBin(
                  recycleEntries.reduce(
                      (entries, entry) => addRecycleBinEntry(entries, entry),
                      [...stickerStore.recycleBin],
                  ),
              );
          }

          ids.forEach((id) => stickerStore.actions.removeSticker(id));
          ids.forEach((id) => {
              // Clear all per-unit UI state keyed by unit id so deleting a unit
              // does not leak history/panel/notice entries for its dead id.
              uiActions.clearStickerHistory(id);
              uiActions.clearStickerUiState(id);
          });

          selectionActions.clear();
          uiActions.hideStickerToolbar();

          void syncService.notify({ layout: true, persist: true });
      }
  };

  // Edit an existing image: try clipboard first (image bytes or file path from
  // Explorer copy), create sticker, enter edit mode. Falls back to file dialog.
  const openImageForEdit = async () => {
      try {
          // Try clipboard first
          const clipboardData = await api.readClipboardImage();
          if (clipboardData) {
              const center = {
                  x: (typeof window !== "undefined" ? window.innerWidth : 800) / 2,
                  y: (typeof window !== "undefined" ? window.innerHeight : 600) / 2,
              };
              const stickerId = createImageSticker(clipboardData, center);
              if (stickerId) {
                  setActiveStickerEditTargetId(stickerId);
              }
              void syncService.notify({ persist: true });
              return;
          }

          // Fallback: file dialog
          const dataUrl = await api.openImageForEdit();
          if (!dataUrl) return;
          const center = {
              x: (typeof window !== "undefined" ? window.innerWidth : 800) / 2,
              y: (typeof window !== "undefined" ? window.innerHeight : 600) / 2,
          };
          const stickerId = createImageSticker(dataUrl, center);
          if (stickerId) {
              setActiveStickerEditTargetId(stickerId);
          }
          void syncService.notify({ persist: true });
      } catch (error) {
          console.error("Open image for edit failed", error);
          await api.debugLogEvent(
              "open-image-for-edit-failure",
              error instanceof Error ? error.message : String(error),
          );
      }
  };

  createEffect(() => {
      if (!tauriRuntime) return;
      void api.setOverlayKeyboardCaptureActive(
          Boolean(selectedStickerId()) && !longCaptureSession()?.active && !annotationTextEditing(),
      );
  });

  // Shortcuts
  useShortcuts({
      contextProvider: () => {
          return resolveShortcutContext({
              isLongCapturing: Boolean(longCaptureSession()?.active),
              hasSelectedSticker: Boolean(selectedStickerId()),
              hasActiveStickerEditTarget: activeStickerEditTargetId() === selectedStickerId(),
              stickerEditingDomain: stickerToolSettings.domain,
              stickerTransformMode: stickerToolSettings.transformMode,
              stickerCanvasTool: stickerToolSettings.activeCanvasTool,
          });
      },
      handlers: {
          onCopy: handleCopy,
          onPaste: handlePaste,
          onSave: handleSave,
          onToggleHistory: () => uiActions.toggleHistoryPanel(),
          onUndoEdit: () => applyStickerHistorySnapshot("undo"),
          onRedoEdit: () => applyStickerHistorySnapshot("redo"),
          onDelete: deleteSelectedStickerOrAnnotation,
          onCancelSelection: async () => {
              if (longCaptureSession()?.active) {
                  await cancelAutoLongCaptureSession();
                  return;
              }
              resetSelection();
              uiActions.setSelectedStickerAnnotation(null);
          },
          onCancelStickerEdit: () => {
              uiActions.requestStickerEditCancel();
          },
          onToggleSidePanel: () => {
              const id = selectedStickerId();
              if (id) {
                  uiActions.toggleSidePanel(id);
                  scheduleOverlayHitTestRefresh();
              }
          },
          onToggleCleanView: () => {
              logger.debug("Toggle Clean View Mode");
              setIsCleanView(!isCleanView());
          },
          onTransformSelect: () => {
              if (selectedStickerId()) {
                  uiActions.setStickerTransformMode("select");
              }
          },
          onTransformMove: () => {
              if (selectedStickerId()) {
                  uiActions.setStickerTransformMode("move");
              }
          },
          onTransformRotate: () => {
              if (selectedStickerId()) {
                  uiActions.setStickerTransformMode("rotate");
              }
          },
          onTransformScale: () => {
              if (selectedStickerId()) {
                  uiActions.setStickerTransformMode("scale");
              }
          },
      }
  });

  // Initialization
  onMount(async () => {
      logger.debug("App Mounted - Initializing...");
      const cleanups: Array<() => void> = [];
      const tauriRuntimeAvailable = tauriRuntime;
      let bootProfile: BootProfile | null = null;

      let onWindowMouseMove: ((e: MouseEvent) => void) | null = null;
      let onWindowMouseUp: ((e: MouseEvent) => void) | null = null;

      // Global error diagnostics (localStorage + on-screen overlay + best-effort
      // IPC) live in a dedicated module so they survive a synchronous webview
      // crash. installErrorDiagnostics returns a disposer for the listeners.
      cleanups.push(installErrorDiagnostics(tauriRuntimeAvailable));

      if (tauriRuntimeAvailable) {
          void api.debugLogEvent("frontend-mounted");
      }

      try {
          bootProfile = await api.getBootProfile();
          activeBootProfile = bootProfile;
          if (tauriRuntimeAvailable) {
              void api.debugLogEvent(
                  "boot-profile-loaded",
                  `startupMode=${bootProfile.startupMode} initialUiMode=${bootProfile.initialUiMode} autoStartCapture=${bootProfile.autoStartCapture}`,
              );
          }
      } catch (error) {
          console.warn("Failed to load boot profile, falling back to defaults:", error);
          if (tauriRuntimeAvailable) {
              void api.debugLogEvent(
                  "boot-profile-failed",
                  error instanceof Error ? error.message : String(error),
              );
          }
      }

      try {
          const toolSettingsData = await api.loadToolSettings();
          if (toolSettingsData?.stickerToolSettings) {
              uiActions.setStickerToolSettings(
                  normalizeStickerToolSettings(toolSettingsData.stickerToolSettings as Record<string, unknown>),
              );
          }
      } catch (error) {
          console.warn("Failed to load sticker tool settings:", error);
      }

      try {
          const loadedAppSettings = await api.loadAppSettings();
          setAppSettings(normalizeAppSettings(loadedAppSettings));
      } catch (error) {
          console.warn("Failed to load app settings:", error);
      }

      if (tauriRuntimeAvailable) {
          const unlistenAppSettings = await listen("app-settings-updated", (event) => {
              setAppSettings(normalizeAppSettings(event.payload as Parameters<typeof normalizeAppSettings>[0]));
          });
          cleanups.push(unlistenAppSettings);

          // Native freeze+select results (region / long). No WebView selection UI.
          const unlistenNativeCaptureResult = await listen<{
              width: number;
              height: number;
              filePath: string;
              rect: { x: number; y: number; w: number; h: number };
          }>("native-capture-result", (event) => {
              void api.debugLogEvent("native-capture-result-listener");
              const { width, height, filePath, rect } = event.payload;
              void (async () => {
                  try {
                      await addCaptureSticker(
                          { width, height, filePath },
                          rect,
                          { x: rect.x, y: rect.y },
                          "region",
                      );
                  } catch (error) {
                      console.error("Native capture sticker failed", error);
                      await api.debugLogEvent(
                          "native-capture-sticker-failure",
                          error instanceof Error ? error.message : String(error),
                      );
                  } finally {
                      await restorePostCaptureInteractivity();
                  }
              })();
          });

          const unlistenNativeLongRect = await listen<{
              x: number;
              y: number;
              w: number;
              h: number;
          }>("native-long-capture-rect", (event) => {
              void api.debugLogEvent("native-long-capture-rect-listener");
              const rect = event.payload;
              void startAutoLongCaptureSession(rect, { x: rect.x, y: rect.y });
          });

          const unlistenNativeCaptureCancelled = await listen("native-capture-cancelled", () => {
              void api.debugLogEvent("native-capture-cancelled-listener");
              resetSelection();
              void restorePostCaptureInteractivity();
          });

          // Finish an in-flight long-capture session (hotkey pressed again).
          const unlistenLongCapture = await listen("trigger-long-capture", () => {
              void api.debugLogEvent("trigger-long-capture-listener");
              if (longCaptureSession()?.active) {
                  void finishAutoLongCaptureSession();
              }
          });

          const unlistenLongCaptureFinish = await listen("trigger-long-capture-finish", () => {
              void api.debugLogEvent("trigger-long-capture-finish-listener");
              if (longCaptureSession()?.active) {
                  void finishAutoLongCaptureSession();
              }
          });

          const unlistenLongCaptureWheel = await listen<{ deltaX?: number; deltaY?: number }>("trigger-long-capture-wheel", (event) => {
              if (!longCaptureSession()?.active) return;
              void notifyAutoLongCaptureWheel({
                  deltaX: event.payload?.deltaX,
                  deltaY: event.payload?.deltaY,
              });
          });

          const unlistenStickerToolbar = await listen("trigger-toggle-sticker-toolbar", () => {
              logger.debug("Backend Triggered Sticker Toolbar Toggle");
              void api.debugLogEvent("trigger-toggle-sticker-toolbar-listener");
              toggleStickerToolbarVisibility();
          });

          const unlistenOpenImage = await listen("trigger-open-image", () => {
              void api.debugLogEvent("trigger-open-image-listener");
              void openImageForEdit();
          });

          const unlistenCopy = await listen("trigger-copy", () => {
              void api.debugLogEvent("trigger-copy-listener");
              if (!selectedStickerId()) return;
              void handleCopy();
          });

          const unlistenPaste = await listen("trigger-paste", () => {
              void api.debugLogEvent("trigger-paste-listener");
              if (!selectedStickerId()) return;
              void handlePaste();
          });

          const unlistenUndo = await listen("trigger-undo", () => {
              void api.debugLogEvent("trigger-undo-listener");
              if (!selectedStickerId()) return;
              void applyStickerHistorySnapshot("undo");
          });

          const unlistenRedo = await listen("trigger-redo", () => {
              void api.debugLogEvent("trigger-redo-listener");
              if (!selectedStickerId()) return;
              void applyStickerHistorySnapshot("redo");
          });

          const unlistenEscape = await listen("trigger-escape", () => {
              void api.debugLogEvent("trigger-escape-listener");
              if (longCaptureSession()?.active) {
                  void cancelAutoLongCaptureSession();
                  return;
              }
              if (selectedStickerId()) {
                  deleteSelectedStickerOrAnnotation();
              }
          });

          const unlistenDelete = await listen("trigger-delete", () => {
              void api.debugLogEvent("trigger-delete-listener");
              if (longCaptureSession()?.active) {
                  return;
              }
              if (!selectedStickerId()) {
                  return;
              }
              const elapsedMs = Date.now() - lastStickerKeyboardDeleteArmAt;
              if (elapsedMs > STICKER_GLOBAL_DELETE_ARM_WINDOW_MS) {
                  void api.debugLogEvent("trigger-delete-ignored-stale", `elapsedMs=${elapsedMs}`);
                  return;
              }
              deleteSelectedStickerOrAnnotation();
          });

          const unlistenOverlayMouseDown = await listen<OverlaySyntheticMousePayload>(
              "overlay/global_mouse_down",
              (event) => {
                  if (event.payload?.nativeDragPreflight) {
                      window.dispatchEvent(
                          new CustomEvent("hook:overlay-native-drag-preflight-down", {
                              detail: event.payload,
                          }),
                      );
                  } else {
                      dispatchSyntheticOverlayMouseEvent("mousedown", event.payload);
                  }
              },
          );

          const unlistenOverlayMouseMove = await listen<OverlaySyntheticMousePayload>(
              "overlay/global_mouse_move",
              (event) => {
                  if (event.payload?.nativeDragPreflight) {
                      window.dispatchEvent(
                          new CustomEvent("hook:overlay-native-drag-preflight-move", {
                              detail: event.payload,
                          }),
                      );
                  } else {
                      dispatchSyntheticOverlayMouseEvent("mousemove", event.payload);
                  }
              },
          );

          const unlistenOverlayMouseUp = await listen<OverlaySyntheticMousePayload>(
              "overlay/global_mouse_up",
              (event) => {
                  if (event.payload?.nativeDragPreflight) {
                      window.dispatchEvent(
                          new CustomEvent("hook:overlay-native-drag-preflight-up", {
                              detail: event.payload,
                          }),
                      );
                  } else {
                      dispatchSyntheticOverlayMouseEvent("mouseup", event.payload);
                  }
              },
          );

          const unlistenOverlayMouseWheel = await listen<OverlaySyntheticMousePayload>(
              "overlay/global_mouse_wheel",
              (event) => {
                  dispatchSyntheticOverlayMouseEvent("wheel", event.payload);
              },
          );

          const unlistenOverlayContextMenu = await listen<OverlaySyntheticMousePayload>(
              "overlay/global_context_menu",
              (event) => {
                  dispatchSyntheticOverlayMouseEvent("contextmenu", event.payload);
              },
          );

          cleanups.push(
              unlistenNativeCaptureResult,
              unlistenNativeLongRect,
              unlistenNativeCaptureCancelled,
              unlistenLongCapture,
              unlistenLongCaptureFinish,
              unlistenLongCaptureWheel,
              unlistenStickerToolbar,
              unlistenOpenImage,
              unlistenCopy,
              unlistenPaste,
              unlistenUndo,
              unlistenRedo,
              unlistenEscape,
              unlistenDelete,
              unlistenOverlayMouseDown,
              unlistenOverlayMouseMove,
              unlistenOverlayMouseUp,
              unlistenOverlayMouseWheel,
              unlistenOverlayContextMenu,
          );

          onWindowMouseMove = (e: MouseEvent) => {
              handleGlobalMouseMove(e);
          };

          onWindowMouseUp = (e: MouseEvent) => {
              handleGlobalMouseUp(e);
          };

          window.addEventListener("mousemove", onWindowMouseMove);
          window.addEventListener("mouseup", onWindowMouseUp);
      }

      await syncService.restoreSession(bootProfile || undefined);

      // Load persisted color/screenshot history (best-effort; never blocks boot).
      try {
          const rawHistory = await api.loadHistory();
          uiActions.setHistoryState(sanitizeHistoryState(rawHistory));
      } catch (error) {
          console.warn("Failed to load history; starting with empty history.", error);
      }

      if (bootProfile?.autoStartCapture) {
          await api.debugLogEvent("boot-autostart-capture");
          await api.triggerCaptureMode();
      }

      onCleanup(() => {
          cleanups.forEach((fn) => fn());
          if (onWindowMouseMove) {
              window.removeEventListener("mousemove", onWindowMouseMove);
          }
          if (onWindowMouseUp) {
              window.removeEventListener("mouseup", onWindowMouseUp);
          }
      });
  });

  // Push pin rects when sticker geometry / overlay pin registry changes.
  createEffect(() => {
      // Track store/registry reads inside notify({ layout: true }) -> pushPinRects.
      syncService.notify({ layout: true });
  });

  createEffect(() => {
      if (!longCaptureSession()?.active) {
          return;
      }

      stickerContextMenuController.close();
  });

  // Global Event Handlers
  const handleGlobalMouseMove = (e: MouseEvent) => {
      setMousePos({ x: e.clientX, y: e.clientY });
      if (!overlaySyntheticMoveRelayActive && !draggingStickerId()) {
          relayOverlaySyntheticPointerMove(e);
      }
      handleDragMove(e);
      handleSelectionMove(e);
  };

  const handleGlobalMouseUp = (e: MouseEvent) => {
      handleDragEnd();
      handleSelectionEnd(e);
      resetOverlaySyntheticPointerState();

      setLinkingState(prev => ({ ...prev, isLinking: false }));
  };

  const handleGlobalMouseDown = (e: MouseEvent) => {
      // Background click → box-select stickers (region capture is native).
      if (shouldStartCanvasSelectionFromTarget(e.target)) {
           if (!e.shiftKey && !e.ctrlKey) {
               selectionActions.clear();
               resetSelection();
               uiActions.hideStickerToolbar();
           }

            if (!checkDragModifier(e, 'dragOut')) {
                 handleSelectionStart(e);
            }
      }
  };

  // Sticker Interaction wrappers
  const onStartDragSticker = (e: MouseEvent, id: string) => {
      // FIX: Allow native file drag if Shift is held (Drag-Out Mode)
      if (checkDragModifier(e, 'dragOut')) {
           return; // Allow native behavior (no preventDefault)
      }

      armStickerKeyboardDelete();
      e.stopPropagation(); // Stop propagation to canvas
      e.preventDefault();  // Stop text selection

      // Multi-Select Interaction Logic
      const wasSelected = selectedStickerIds.includes(id);
      const targetSticker = stickerStore.stickers.find((unit) => unit.id === id);
      const targetGroup = targetSticker?.data.groupId
          ? stickerStore.stickerGroups.find((group) => group.id === targetSticker.data.groupId)
          : undefined;
      const activeEditTarget = activeStickerEditTargetId();
      if (activeEditTarget && activeEditTarget !== id) {
          uiActions.hideStickerToolbar();
      }
      if (targetGroup?.locked) {
          return;
      }

      if (e.ctrlKey) {
           // Toggle Logic
           if (wasSelected) {
               // If already selected, we DON'T toggle off immediately on MouseDown.
               // We wait to see if it's a Drag or a Click.
               // This is handled by the onClick callback passed to startDrag below.
           } else {
               selectionActions.add(id);
           }
      } else {
           // No Modifiers
           if (!wasSelected) {
               // Clicked unselected -> Exclusive Select
               selectionActions.set([id]);
           }
           // else: Clicked part of group -> Keep group (for potential drag)
      }

      startDrag(e, id, (clickedId) => {
          const clickedSticker = stickerStore.stickers.find((unit) => unit.id === clickedId);
          if (!clickedSticker || activeStickerEditTargetId() !== clickedId) {
              uiActions.hideStickerToolbar();
          }
          // Handle Click (No Drag)
          if (e.ctrlKey) {
              // Only toggle off if it WAS selected *before* this interaction
              if (wasSelected) {
                  selectionActions.toggle(clickedId);
              }
          } else {
              // Click without Ctrl on a group member -> Exclusive Select (Deselect others)
              selectionActions.set([clickedId]);
          }
      });
  };



  const resolveLinkedImage = (id: string): string | undefined => {
      return resolveStickerImage({
          stickers: stickerStore.stickers,
          links: stickerStore.links,
          stickerId: id,
      });
  };

  return (
    <ErrorBoundary
        fallback={(error, reset) => {
            // A render-time throw is caught here (window.onerror cannot see SolidJS
            // render errors). Show the full message + stack on screen and persist
            // it, so the intermittent content-eraser crash can be read directly
            // instead of surfacing as the webview's bare "uncaught client exception".
            const detail =
                error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
            try {
                window.localStorage.setItem(
                    "hook-last-error",
                    `[${new Date().toISOString()}] render-error\n${detail}`,
                );
            } catch {
                /* ignore */
            }
            if (isTauriRuntimeAvailable()) {
                void api.debugLogEvent("render-error", detail);
            }
            return (
                <div
                    style={{
                        position: "fixed",
                        inset: "0",
                        "z-index": "2147483647",
                        background: "rgba(120,0,0,0.95)",
                        color: "#fff",
                        font: "12px/1.5 monospace",
                        "white-space": "pre-wrap",
                        overflow: "auto",
                        padding: "16px",
                    }}
                >
                    {"render-error (click ?? to recover)\n\n" + detail}
                    <div style={{ "margin-top": "12px" }}>
                        <button
                            type="button"
                            style={{
                                background: "#fff",
                                color: "#900",
                                padding: "4px 12px",
                                "border-radius": "6px",
                            }}
                            onClick={reset}
                        >
                            ??
                        </button>
                    </div>
                </div>
            );
        }}
    >
    <main
        id="app-main"
        class="w-screen h-screen bg-transparent overflow-hidden select-none"
        onMouseDown={handleGlobalMouseDown}
        onMouseMove={handleGlobalMouseMove}
        onMouseUp={handleGlobalMouseUp}
        onContextMenu={(e) => e.preventDefault()}
    >
        <CanvasLinks />

        <StickerGroupBar />
        <HistoryPanel
            onReuseScreenshot={(thumbnail) => {
                const center = {
                    x: (typeof window !== "undefined" ? window.innerWidth : 800) / 2,
                    y: (typeof window !== "undefined" ? window.innerHeight : 600) / 2,
                };
                createImageSticker(thumbnail, center);
                void syncService.notify({ persist: true });
            }}
        />

        <div id="ports-layer" ref={portsLayerRef!} class="absolute inset-0 z-[5] pointer-events-none overflow-visible"></div>

        <CanvasStickers
            onStartDrag={onStartDragSticker}
            onDoubleClick={handleDoubleClick}

            onDelete={(id) => {
                stickerStore.actions.removeSticker(id);
                if (selectedStickerId() === id) {
                    uiActions.hideStickerToolbar();
                }
                void syncService.notify({ layout: true, persist: true });
            }}

            onLinkStart={startLinking}
            onLinkDrop={handleLinkDrop}
            onLinkMove={handleInputLinkDrag}
            onLinkHover={handleLinkHover}

            onRendered={(id, dataUrl) => {
                stickerStore.actions.updateStickerData(id, {
                    previewSrc: dataUrl,
                });
                propagateFromSticker(id);
                void syncService.notify({ persist: true });
            }}

            resolveLinkedImage={resolveLinkedImage}
            portsLayerRef={portsLayerRef}
        />

        <StickerContextMenuLayer />

        <CanvasSelection />

        <Show when={longCaptureSession()}>
            {(session) => (
                <div class="hook-terminal-shell hook-terminal-shell--strong hook-capture-status-shell absolute right-5 top-5 z-[120] px-4 py-3 text-xs pointer-events-none">
                    <div class="hook-capture-status-title mb-1 text-sm font-semibold">长截图录制中</div>
                    <div>已拼接 {session().frameCount} 帧</div>
                    <div>未变化 {session().noChangeCount ?? 0} 次</div>
                    <div>方向 {session().axis === "horizontal" ? "水平" : "垂直"}</div>
                    <div class="hook-capture-status-copy mt-1">{session().lastMessage ?? "滚动目标页面采集，完成后按 Enter 导出"}</div>
                    <div class="hook-capture-status-shortcut mt-2">Enter/Ctrl+3 完成，Esc 取消</div>
                </div>
            )}
        </Show>
    </main>
    </ErrorBoundary>
  );
}
