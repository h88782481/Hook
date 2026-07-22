import { Component, For, Show, createEffect, createSignal, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import { stickerStore } from "../store/stickerStore";
import {
  activeStickerEditTargetId,
  draggingStickerId,
  isCleanView,
  isSelecting,
  longCaptureSession,
  selectionActions,
  selectedStickerAnnotationId,
  selectedStickerAnnotationIds,
  stickerToolSettings,
  uiActions,
} from "../store/uiStore";
import { Sticker, Link } from "../types/stickerModel";
import { addOrUpdateRect, removeRect } from "../services/uiRegistry";
import { computeMinifiedStickerAnnotationViewport, computeMinifiedStickerViewport } from "../services/stickerEditing";
import { StickerSidePanel } from "./StickerSidePanel";
import { StickerPorts } from "./StickerPorts";
import { StickerAnnotationLayer } from "./StickerAnnotationLayer";
import { StickerTopStrip } from "./StickerTopStrip";
import { isStickerSurfaceDoubleClickTarget } from "../services/stickerDoubleClick";
import { resolveStickerBitmapSrc, toDisplayImageSrc } from "../services/imageSource";
import { api, isTauriRuntimeAvailable } from "../services/api";
import { stickerContextMenuController } from "../services/stickerContextMenuController";
import { renderStickerComposite } from "../services/stickerExport";
import { clamp, wheelZoomScaleFactor } from "../utils/math";

// GLOBAL STATE: Persist scroll positions across re-renders
const globalScrollRegistry: Record<string, number> = {};

interface Props {
  unit: Sticker;
  isSelected: boolean;
  showSidePanel: boolean;
  onMouseDown: (e: MouseEvent) => void;
  onDoubleTap: (e: MouseEvent) => void;
  onDelete: () => void;
  onLinkStart: (propId: string, startX: number, startY: number) => void;
  onLinkDrop: (propId: string) => void; // NEW: Robust Link Completion
  onLinkMove?: (portId: string, e: MouseEvent) => void; // NEW: Re-linking (Optional)
  onLinkHover: (targetId: string | null) => void; // NEW: Visualization feedback
  onRendered: (id: string, dataUrl: string) => void;
  onResize: (nextFrame: Pick<Sticker, "x" | "y" | "w" | "h">) => void; // NEW: Ctrl+Wheel Resize with Pivot
  onOpacityChange: (opacity: number) => void; // NEW: Alt+Wheel Opacity
  resolveLinkedImage?: (stickerId: string) => string | undefined; // NEW: Helper to resolve referenced images

  multiDragPositions?: Record<string, {x: number; y: number}> | null; // Multi-Drag State
  connectedLinks?: Link[]; // NEW: Full Links for resolving upstream units
  portsLayer?: HTMLElement; // NEW: Global Layer for Z-independent ports
}

export const StickerView: Component<Props> = (props) => {
  let unitContainerRef: HTMLDivElement | undefined;
  let nativeStickerDragStart:
      | {
            x: number;
            y: number;
            pointerId?: number;
            started: boolean;
        }
      | null = null;
  let nativeStickerDragInFlight = false;
  const [nativeStickerExportPreview, setNativeStickerExportPreview] = createSignal<{
      x: number;
      y: number;
      src: string;
      width: number;
      height: number;
  } | null>(null);
  type NativeDragPreflightOverlayPayload = {
      x?: number;
      y?: number;
      globalX?: number;
      globalY?: number;
      shiftKey?: boolean;
  };
  const logWheelEvent = (phase: string, detail: string) => {
      void api.debugLogEvent("sticker-wheel-trace", `layer=unit phase=${phase} unit=${props.unit.id} ${detail}`);
  };

  const liveSticker = () => stickerStore.stickers.find((unit) => unit.id === props.unit.id) || props.unit;
  const isMinified = () => !!liveSticker().data.minified;
  const hasSelectedExistingAnnotations = () => selectedStickerAnnotationIds.length > 0;
  const shouldBlockContainerMouseDown = () => {
      if (activeStickerEditTargetId() !== props.unit.id) return false;
      if (stickerToolSettings.domain !== "existing") {
          if (stickerToolSettings.domain === "create") return true;
          return stickerToolSettings.activeCanvasTool !== "idle";
      }
      if (stickerToolSettings.transformMode !== "select") return true;
      return hasSelectedExistingAnnotations();
  };
  const allowContainerMouseDown = () => !shouldBlockContainerMouseDown();
  const handleStickerDoubleClick = (event: MouseEvent) => {
      if (!isStickerSurfaceDoubleClickTarget(event.target, event.currentTarget)) {
          event.stopPropagation();
          return;
      }
      props.onDoubleTap(event);
  };
  const showSelectionBorder = () => true;

  const currentPos = () => {
      // Check Multi-Drag (Unified)
      if (draggingStickerId() && props.multiDragPositions && props.multiDragPositions[props.unit.id]) {
          return props.multiDragPositions[props.unit.id];
      }

      const unit = liveSticker();
      return { x: unit.x, y: unit.y };
  };

  const style = () => {
    const { x, y } = currentPos();
    const unit = liveSticker();

    return {
        left: `${x}px`,
        top: `${y}px`,
        width: `${unit.w}px`,
        // FIX: Force fixed height when minified (for crop), otherwise auto (for layout)
        height: isMinified() ? `${unit.h}px` : "auto",
        "z-index": props.isSelected ? 1000 : 10,
        position: "absolute" as const,
        // FIX: Disable transition during drag for instant tracking (Redundant if CSS removed, but safe)
        // FIX: Disable transition fully to ensure links track instantly with resize
        transition: "none",

        "overflow": isMinified() ? "hidden" : "visible", // CRITICAL: Minified = Clip Image; Normal = Show Ports (if not portal)
        // OVERRIDE: Prevent min-width from breaking minified size
        ...(isMinified() ? { "min-width": "0", "min-height": "0" } : {})
    };
  };

  const getOpacity = () => isMinified()
      ? (liveSticker().data.opacityMini ?? 0.9)
      : (liveSticker().data.opacityNormal ?? 1);
  const getImageEditState = () => liveSticker().data.imageEditState;
  const getCornerRadius = () => getImageEditState()?.cornerRadius ?? 0;
  const getImageBorderWidth = () => getImageEditState()?.borderWidth ?? 0;
  const getImageBorderColor = () => getImageEditState()?.borderColor ?? "transparent";
  const getCropRect = () => getImageEditState()?.cropRect;
  const getCropSourceSize = () => getImageEditState()?.sourceSize;
  const getTransform = () => {
      const scaleX = getImageEditState()?.flippedX ? -1 : 1;
      const scaleY = getImageEditState()?.flippedY ? -1 : 1;
      return `scale(${scaleX}, ${scaleY})`;
  };
  const getMinifiedViewport = () =>
      computeMinifiedStickerViewport(
          liveSticker().data.savedRect,
          liveSticker().data.cropOffset,
          getImageEditState(),
      );
  const getMinifiedAnnotationViewport = () =>
      computeMinifiedStickerAnnotationViewport(
          { w: liveSticker().w, h: liveSticker().h },
          liveSticker().data.savedRect,
          liveSticker().data.cropOffset,
      );

  // === PORT LOGIC ===
  const getInputs = () => [{ name: "image", label: "Image", type: "image", description: "Input image source" }];
  const getOutputs = () => [{ name: "output_image", label: "Image", type: "image" }];

  // Helper to determine Source Image
  // Priority:
  // 1. Input Connection (Upstream) -> Use resolved upstream image
  // 2. Screenshot / local src (Default)
  const displaySrc = () => {
      let resolvedSrc: string | undefined;
      {
          const imageInput = getInputs().find(i => i.name === 'image');
          if (imageInput && props.connectedLinks) {
               const link = props.connectedLinks.find(l => l.toPortId === imageInput.name);
               if (link && props.resolveLinkedImage) {
                   const src = props.resolveLinkedImage(link.fromStickerId);
                   if (src) {
                       resolvedSrc = src;
                   }
               }
          }
      }
      if (!resolvedSrc) {
          resolvedSrc = resolveStickerBitmapSrc(liveSticker().data) || "";
      }
      return toDisplayImageSrc(resolvedSrc) || "";
  };
  const baseImageSrc = () =>
      liveSticker().data.rasterizedAnnotationLayerSrc
          ? toDisplayImageSrc(liveSticker().data.src || displaySrc()) || ""
          : displaySrc();
  const fileBackedFallbacksInFlight = new Set<string>();
  const handleFileBackedImageLoadError = async () => {
      const unit = liveSticker();
      const filePath = unit.data.filePath;
      if (!filePath || unit.data.previewSrc?.startsWith("data:")) {
          return;
      }
      if (fileBackedFallbacksInFlight.has(unit.id)) {
          return;
      }

      fileBackedFallbacksInFlight.add(unit.id);
      try {
          const fallbackSrc = await api.readImageFromPath(filePath);
          stickerStore.actions.updateStickerData(props.unit.id, {
              previewSrc: fallbackSrc,
          });
      } catch (error) {
          console.warn("[StickerView] Failed to load file-backed image fallback", error);
      } finally {
          fileBackedFallbacksInFlight.delete(unit.id);
      }
  };

  const detachPendingNativeDragListeners = () => {
      if (typeof window === "undefined") return;
      window.removeEventListener("pointermove", handlePendingNativeDragPointerMove, true);
      window.removeEventListener("mousemove", handlePendingNativeDragPointerMove, true);
      window.removeEventListener("pointerup", handlePendingNativeDragEnd, true);
      window.removeEventListener("mouseup", handlePendingNativeDragEnd, true);
      window.removeEventListener("pointercancel", handlePendingNativeDragEnd, true);
      window.removeEventListener("hook:overlay-native-drag-preflight-move", handlePendingNativeDragOverlayMove as EventListener, true);
      window.removeEventListener("hook:overlay-native-drag-preflight-up", handlePendingNativeDragOverlayEnd as EventListener, true);
  };

  const clearPendingNativeStickerDrag = () => {
      nativeStickerDragStart = null;
      setNativeStickerExportPreview(null);
      void api.setNativeStickerDragPreflight(false);
      detachPendingNativeDragListeners();
  };

  const overlayPayloadClientPoint = (detail: NativeDragPreflightOverlayPayload | undefined) => {
      const x = detail?.x ?? detail?.globalX;
      const y = detail?.y ?? detail?.globalY;
      if (typeof x !== "number" || typeof y !== "number") return null;
      return { x, y };
  };

  const pointTargetsThisSticker = (x: number, y: number) => {
      if (!unitContainerRef) return false;
      const target = document.elementFromPoint(x, y);
      if (target instanceof Element) {
          const unitRoot = target.closest(".sticker-container");
          if (unitRoot) {
              return unitRoot === unitContainerRef;
          }
      }
      const rect = unitContainerRef.getBoundingClientRect();
      return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  };

  const attachPendingNativeDragListeners = () => {
      if (typeof window === "undefined") return;
      detachPendingNativeDragListeners();
      window.addEventListener("pointermove", handlePendingNativeDragPointerMove, true);
      window.addEventListener("mousemove", handlePendingNativeDragPointerMove, true);
      window.addEventListener("pointerup", handlePendingNativeDragEnd, true);
      window.addEventListener("mouseup", handlePendingNativeDragEnd, true);
      window.addEventListener("pointercancel", handlePendingNativeDragEnd, true);
      window.addEventListener("hook:overlay-native-drag-preflight-move", handlePendingNativeDragOverlayMove as EventListener, true);
      window.addEventListener("hook:overlay-native-drag-preflight-up", handlePendingNativeDragOverlayEnd as EventListener, true);
  };

  const beginPendingHookStickerExportDrag = (x: number, y: number, pointerId?: number) => {
      if (nativeStickerDragInFlight) return;
      void api.debugLogEvent(
          "sticker-export-drag-capture",
          `unit=${props.unit.id} x=${x} y=${y} pathFirst=${!!resolveExistingNativeDragFilePath()}`,
      );
      nativeStickerDragStart = { x, y, pointerId, started: false };
      setNativeStickerExportPreview(null);
      void api.setNativeStickerDragPreflight(true);
      attachPendingNativeDragListeners();
  };

  const buildNativeStickerDragFilenameHint = () => {
      let label = "image";
      label = label.toLowerCase().replace(/[^a-z0-9]/g, "");
      const suffix = props.unit.id.slice(-4);
      return `${label || "image"}_${suffix}`;
  };

  const resolveExistingNativeDragFilePath = () => {
      const unit = liveSticker();
      if (unit.data.dragOutFilePath) {
          return unit.data.dragOutFilePath;
      }
      if (!unit.data.filePath) return false;
      if (unit.data.rasterizedAnnotationLayerSrc) return false;
      if ((unit.data.annotationState?.elements?.length || 0) > 0) return false;

      const imageEditState = unit.data.imageEditState;
      if (!imageEditState) return unit.data.filePath;

      if ((imageEditState.contentEraseStrokes?.length || 0) > 0) return false;
      if (imageEditState.cropRect) return false;
      if (imageEditState.flippedX || imageEditState.flippedY) return false;
      if ((imageEditState.borderWidth || 0) > 0) return false;
      if ((imageEditState.cornerRadius || 0) > 0) return false;

      return unit.data.filePath;
  };

  const beginHookStickerExportDrag = async (globalX: number, globalY: number) => {
      if (nativeStickerDragInFlight) return;

      nativeStickerDragInFlight = true;
      try {
          const unit = liveSticker();
          const existingDragPath = resolveExistingNativeDragFilePath();
          const useExistingPath = typeof existingDragPath === "string" && existingDragPath.length > 0;
          void api.debugLogEvent(
              "sticker-export-drag-request",
              `unit=${props.unit.id} x=${globalX} y=${globalY} pathFirst=${useExistingPath} hasFilePath=${!!unit.data.filePath} hasDragOutFilePath=${!!unit.data.dragOutFilePath}`,
          );
          const path = useExistingPath
               ? await api.saveStickerDragExportFromPath(
                     existingDragPath as string,
                     buildNativeStickerDragFilenameHint(),
                     globalX,
                     globalY,
                 )
               : await (async () => {
                   const exportBase64 = await renderStickerComposite(unit);
                   return api.saveStickerDragExport(
                       exportBase64,
                       buildNativeStickerDragFilenameHint(),
                       globalX,
                       globalY,
                   );
               })();
          if (!useExistingPath) {
              stickerStore.actions.updateStickerData(props.unit.id, {
                  dragOutFilePath: path,
              });
          }
          void api.debugLogEvent("sticker-export-drag-saved", `unit=${props.unit.id} path=${path}`);
      } catch (error) {
          console.error("Hook sticker export drag failed", error);
          void api.debugLogEvent(
              "sticker-export-drag-failed",
              `unit=${props.unit.id} error=${error instanceof Error ? error.message : String(error)}`,
          );
      } finally {
          nativeStickerDragInFlight = false;
      }
  };

  const updateHookStickerExportDragPreview = (x: number, y: number) => {
      const start = nativeStickerDragStart;
      if (!start || nativeStickerDragInFlight) return;
      if (!start.started && Math.hypot(x - start.x, y - start.y) < 6) {
          return;
      }

      if (!start.started) {
          start.started = true;
          void api.debugLogEvent("sticker-export-drag-started", `unit=${props.unit.id} x=${x} y=${y}`);
      }

      const maxPreviewSize = 140;
      const scale = Math.min(1, maxPreviewSize / Math.max(props.unit.w, props.unit.h, 1));
      setNativeStickerExportPreview({
          x,
          y,
          src: baseImageSrc(),
          width: Math.max(24, props.unit.w * scale),
          height: Math.max(24, props.unit.h * scale),
      });
  };

  const handlePendingNativeDragPointerMove = (event: PointerEvent | MouseEvent) => {
      const start = nativeStickerDragStart;
      if (!start || nativeStickerDragInFlight) return;
      if ("pointerId" in event && start.pointerId !== undefined && event.pointerId !== start.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      updateHookStickerExportDragPreview(event.clientX, event.clientY);
  };

  const handlePendingNativeDragOverlayMove = (event: Event) => {
      const start = nativeStickerDragStart;
      if (!start || nativeStickerDragInFlight) return;
      const detail = (event as CustomEvent<NativeDragPreflightOverlayPayload>).detail;
      const point = overlayPayloadClientPoint(detail);
      if (!point) return;
      updateHookStickerExportDragPreview(point.x, point.y);
  };

  const handlePendingNativeDragEnd = (event?: PointerEvent | MouseEvent) => {
      if (
          event &&
          nativeStickerDragStart &&
          "pointerId" in event &&
          nativeStickerDragStart.pointerId !== undefined &&
          event.pointerId !== nativeStickerDragStart.pointerId
      ) {
          return;
      }
      const point = event ? { x: event.clientX, y: event.clientY } : null;
      const shouldExport = !!nativeStickerDragStart?.started && !!point;
      clearPendingNativeStickerDrag();
      if (shouldExport && point) {
          void beginHookStickerExportDrag(point.x, point.y);
      }
  };

  const handlePendingNativeDragOverlayDown = (event: Event) => {
      if (!isTauriRuntimeAvailable()) return;
      const detail = (event as CustomEvent<NativeDragPreflightOverlayPayload>).detail;
      if (!detail?.shiftKey) return;
      const point = overlayPayloadClientPoint(detail);
      if (!point || !pointTargetsThisSticker(point.x, point.y)) return;
      beginPendingHookStickerExportDrag(point.x, point.y);
  };

  const handlePendingNativeDragOverlayEnd = (event?: Event) => {
      const detail = (event as CustomEvent<NativeDragPreflightOverlayPayload> | undefined)?.detail;
      const point = overlayPayloadClientPoint(detail);
      const shouldExport = !!nativeStickerDragStart?.started && !!point;
      clearPendingNativeStickerDrag();
      if (shouldExport && point) {
          void beginHookStickerExportDrag(point.x, point.y);
      }
  };

  const handleNativeStickerPointerDownCapture = (event: PointerEvent) => {
      if (!isTauriRuntimeAvailable() || !event.shiftKey) return;
      event.preventDefault();
      event.stopPropagation();
      beginPendingHookStickerExportDrag(event.clientX, event.clientY, event.pointerId);
  };

  createEffect(() => {
      unitContainerRef?.addEventListener("pointerdown", handleNativeStickerPointerDownCapture, true);
      window.addEventListener("hook:overlay-native-drag-preflight-down", handlePendingNativeDragOverlayDown as EventListener, true);
      onCleanup(() => {
          unitContainerRef?.removeEventListener("pointerdown", handleNativeStickerPointerDownCapture, true);
          window.removeEventListener("hook:overlay-native-drag-preflight-down", handlePendingNativeDragOverlayDown as EventListener, true);
      });
  });

  onCleanup(() => {
      detachPendingNativeDragListeners();
  });

  createEffect(() => {
       const u = props.unit;

       // INPUT PORTS (Left strip for hit testing)
       const inputCount = getInputs().length;
       if (inputCount > 0) {
            getInputs().forEach((p, i) => {
                const portY = u.y + 24 + (i * (36));
                addOrUpdateRect({
                    id: `port-in-${u.id}-${i}`,
                    x: u.x - 18,
                    y: portY,
                    width: 18,
                    height: 24,
                    name: `PORT_IN_${p.name}`
                });
            });
       }

       // OUTPUT PORTS (Right strip)
       getOutputs().forEach((p, i) => {
            const portY = u.y + 24 + (i * (36));
            addOrUpdateRect({
                id: `port-out-${u.id}-${i}`,
                x: u.x + u.w,
                y: portY,
                width: 18,
                height: 24,
                name: `PORT_OUT_${p.name}`
            });
       });

       onCleanup(() => {
           getInputs().forEach((_, i) => removeRect(`port-in-${u.id}-${i}`));
           getOutputs().forEach((_, i) => removeRect(`port-out-${u.id}-${i}`));
       });
  });

  return (
    <div
      class={`sticker-container ${props.isSelected ? "selected" : ""} "sticker-node" ${isMinified() ? "minified" : ""}`}
      style={style()}

      ref={unitContainerRef}

      data-unit-id={props.unit.id} // NEW: For global hit-testing (Link Node)
      tabIndex={-1}
      onMouseDown={(event) => {
        if (allowContainerMouseDown()) {
            props.onMouseDown(event);
        }
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (isSelecting() || longCaptureSession()?.active) return;
        selectionActions.set([props.unit.id]);
        stickerContextMenuController.openForSticker(props.unit.id, {
            x: event.clientX,
            y: event.clientY,
        });
      }}
      onDblClick={handleStickerDoubleClick}
      onWheel={(e) => {
        if (e.ctrlKey) {
            e.preventDefault();
            e.stopPropagation();

            logWheelEvent(
                "ctrl-enter",
                `ctrl=${e.ctrlKey} alt=${e.altKey} shift=${e.shiftKey} minified=${isMinified()} activeEditTarget=${activeStickerEditTargetId() ?? "null"} selectedAnnotationCount=${selectedStickerAnnotationIds.length} primaryAnnotation=${selectedStickerAnnotationId() ?? "null"} deltaY=${e.deltaY}`,
            );
            if (isMinified()) return;
            const currentSticker = liveSticker();

            const rect = e.currentTarget.getBoundingClientRect();
            // Calculate scale of the view (in case canvas is zoomed)
            // If rect.width is 0 (hidden), safe fallback
            const viewScale = currentSticker.w > 0 ? rect.width / currentSticker.w : 1;

            // Mouse position relative to unit corner (in World Units)
            const relX = (e.clientX - rect.left) / viewScale;
            const relY = (e.clientY - rect.top) / viewScale;

            // Browser wheel direction: deltaY < 0 means wheel-up. Wheel-up should zoom in.
            const scaleFactor = wheelZoomScaleFactor(e.deltaY);

            const newW = Math.max(24, currentSticker.w * scaleFactor);
            const newH = Math.max(24, currentSticker.h * scaleFactor);

            // Calculate actual effective scale applied (in case of clamping)
            const effectiveScaleW = currentSticker.w > 0 ? newW / currentSticker.w : 1;
            const effectiveScaleH = currentSticker.h > 0 ? newH / currentSticker.h : 1;

            // New Position: Adjusted to keep the point under mouse stationary
            // NewUnitX = MouseX_World - (RelX_World * NewScale)
            // But MouseX_World = UnitX + RelX_World
            // So NewUnitX = UnitX + RelX_World - RelX_World * NewScale
            //             = UnitX + RelX_World * (1 - NewScale)
            const newX = currentSticker.x + relX * (1 - effectiveScaleW);
            const newY = currentSticker.y + relY * (1 - effectiveScaleH);
            const nextFrame = { x: newX, y: newY, w: newW, h: newH };

            logWheelEvent(
                "ctrl-resize",
                `ctrl=${e.ctrlKey} alt=${e.altKey} shift=${e.shiftKey} minified=${currentSticker.data.minified ?? false} relX=${relX.toFixed(2)} relY=${relY.toFixed(2)} nextW=${newW.toFixed(2)} nextH=${newH.toFixed(2)} nextX=${newX.toFixed(2)} nextY=${newY.toFixed(2)}`,
            );
            props.onResize(nextFrame);
        } else if (e.altKey) {
            e.preventDefault();
            e.stopPropagation();

            const currentSticker = liveSticker();
            const currentOp = currentSticker.data.minified
                ? (currentSticker.data.opacityMini ?? 0.9)
                : (currentSticker.data.opacityNormal ?? 1.0);

            // Step 0.05 per scroll click
            const delta = -e.deltaY * 0.001;
            const newOp = clamp(currentOp + delta, 0, 1);

            logWheelEvent(
                "alt-opacity",
                `ctrl=${e.ctrlKey} alt=${e.altKey} shift=${e.shiftKey} minified=${currentSticker.data.minified ?? false} currentOpacity=${currentOp.toFixed(3)} nextOpacity=${newOp.toFixed(3)} deltaY=${e.deltaY}`,
            );
            props.onOpacityChange(newOp);
        }
      }}
    >
        <Show when={nativeStickerExportPreview()}>
            {(preview) => (
                <Portal>
                    <div
                        class="hook-sticker-export-drag-preview"
                        style={{
                            position: "fixed",
                            left: `${preview().x + 18}px`,
                            top: `${preview().y + 18}px`,
                            width: `${preview().width}px`,
                            height: `${preview().height}px`,
                            "z-index": "2147483647",
                            "pointer-events": "none",
                            opacity: "0.86",
                            border: "1px solid rgba(219, 255, 0, 0.85)",
                            background: "rgba(0, 0, 0, 0.25)",
                            "box-shadow": "0 4px 16px rgba(0, 0, 0, 0.35)",
                        }}
                    >
                        <img
                            src={preview().src}
                            draggable={false}
                            style={{
                                width: "100%",
                                height: "100%",
                                "object-fit": "contain",
                                display: "block",
                            }}
                        />
                    </div>
                </Portal>
            )}
        </Show>
        <StickerPorts
            unit={props.unit}
            portsLayer={props.portsLayer}
            isCleanView={isCleanView()}

            x={currentPos().x}
            y={currentPos().y}
            width={props.unit.w}
            height={props.unit.h}

            onLinkStart={props.onLinkStart}
            onLinkDrop={props.onLinkDrop}
            onLinkMove={props.onLinkMove}
        />




        {(() => {

            return null;
        })()}

        {/* === VISUAL LAYER (Cropped Content) === */}
        <div class="sticker-visual" style={{
            width: "100%", height: `${props.unit.h}px`,
            "overflow": "hidden", // CRITICAL: Clipping for Windowing
            "position": "relative",
            "border-radius": `${getCornerRadius()}px`,
            "border": "none",
            "box-sizing": "border-box",
            "background": "transparent",
            "opacity": getOpacity(),
            "z-index": "1" // Ensure it covers the tucked-under ports
        }}>
            <img
                class="sticker-img"
                // Drag-Out to Save (HTML5 Drag)
                draggable={!isTauriRuntimeAvailable()}
                onDragStart={(e) => {
                    if (isTauriRuntimeAvailable()) {
                        e.preventDefault();
                        return;
                    }

                    // Only standard drag if Shift is held (Now: Shift = Drag Out)
                    if (!e.shiftKey) {
                        e.preventDefault();
                        return;
                    }

                    e.dataTransfer!.effectAllowed = "all"; // Allow Copy, Move, Link (Fixes Alt key forbidden cursor?)
                    e.dataTransfer!.clearData(); // CRITICAL: Clear browser default (which causes 'download' name)

                    // Construct DownloadURL
                    // Mime:FileName:Url

                    // ... (Counter logic same)
                    if (!(window as any)._nodeSaveCounts) (window as any)._nodeSaveCounts = {};
                    const counts = (window as any)._nodeSaveCounts;
                    const count = (counts[props.unit.id] || 0) + 1;
                    counts[props.unit.id] = count;

                    // Construct Filename: label_suffix_count.png
                    // 1. Get Base Label (e.g. "Pixelate" or "Image")
                    let label = "image";

                    // 2. Sanitize (lowercase, remove non-alphanumeric)
                    label = label.toLowerCase().replace(/[^a-z0-9]/g, '');

                    // 3. Get ID Suffix (last 4 chars)
                    const suffix = props.unit.id.slice(-4);

                    const filename = `${label}_${suffix}_${count}.png`;

                    const src = resolveStickerBitmapSrc(props.unit.data) || "";
                    const dragOutFilePath = props.unit.data.filePath;

                    if (dragOutFilePath) {
                         const normalizedFilePath = dragOutFilePath.replace(/\\/g, "/").startsWith("/")
                             ? dragOutFilePath.replace(/\\/g, "/")
                             : `/${dragOutFilePath.replace(/\\/g, "/")}`;
                         const fileUrl = encodeURI(`file://${normalizedFilePath}`);
                         const dlUrl = `image/png:${filename}:${fileUrl}`;

                         e.dataTransfer!.setData("DownloadURL", dlUrl);
                         e.dataTransfer!.setData("text/uri-list", fileUrl);
                         e.dataTransfer!.setData("text/plain", dragOutFilePath);
                         return;
                    }

                    if (src.startsWith("data:")) {
                         const mime = src.split(";")[0].split(":")[1] || "image/png";

                         // Convert Base64 to Blob URL to bypass data transfer size limits
                         try {
                             const byteString = atob(src.split(',')[1]);
                             const ab = new ArrayBuffer(byteString.length);
                             const ia = new Uint8Array(ab);
                             for (let i = 0; i < byteString.length; i++) {
                                 ia[i] = byteString.charCodeAt(i);
                             }
                             const blob = new Blob([ab], { type: mime });
                             const blobUrl = URL.createObjectURL(blob);

                             const dlUrl = `${mime}:${filename}:${blobUrl}`;
                             e.dataTransfer!.setData("DownloadURL", dlUrl);
                         } catch (err) {
                             console.error("Failed to create blob for drag:", err);
                             // Fallback to original data URI
                             const dlUrl = `${mime}:${filename}:${src}`;
                             e.dataTransfer!.setData("DownloadURL", dlUrl);
                         }

                         // Re-add text/uri-list for wide compatibility
                         e.dataTransfer!.setData("text/uri-list", src);

                         return;
                    }
                }}
                src={baseImageSrc()}
                onError={handleFileBackedImageLoadError}
                style={(() => {
                    if (isMinified()) {
                        // MINIFIED: Crop View
                        const viewport = getMinifiedViewport();
                        return {
                            "position": "absolute",
                            "width": `${viewport.width}px`,
                            "height": `${viewport.height}px`,
                            // CRITICAL: Force original size to ensure CROP not SCALE
                            "min-width": `${viewport.width}px`,
                            "min-height": `${viewport.height}px`,
                            "max-width": "none",
                            "max-height": "none",

                            "left": `-${viewport.offsetX}px`,
                            "top": `-${viewport.offsetY}px`,

                            "pointer-events": "auto",
                            "object-fit": "fill", // Use fill to force exact dimensions designated above
                            "transform": getTransform()
                        };
                    }
                    const cropRect = getCropRect();
                    const cropSourceSize = getCropSourceSize();
                    if (cropRect && cropSourceSize) {
                        return {
                            "position": "absolute",
                            "width": `${cropSourceSize.w}px`,
                            "height": `${cropSourceSize.h}px`,
                            "left": `-${cropRect.x}px`,
                            "top": `-${cropRect.y}px`,
                            "min-width": `${cropSourceSize.w}px`,
                            "min-height": `${cropSourceSize.h}px`,
                            "max-width": "none",
                            "max-height": "none",
                            "pointer-events": "auto",
                            "object-fit": "fill",
                            "transform": getTransform()
                        };
                    }
                    return {
                        "width": "100%",
                        "height": "100%",
                        "object-fit": "contain",
                        "max-width": "100%",
                        "max-height": "100%",
                        "pointer-events": "auto",
                        "transform": getTransform()
                    };
                })()}
            />

            <Show when={liveSticker().data.rasterizedAnnotationLayerSrc}>
                {(layerSrc) => (
                    <div
                        class="sticker-rasterized-annotation-layer-viewport absolute"
                        style={(() => {
                            const viewport = isMinified()
                                ? getMinifiedAnnotationViewport()
                                : {
                                      width: props.unit.w,
                                      height: props.unit.h,
                                      offsetX: 0,
                                      offsetY: 0,
                                  };
                            return {
                                width: `${viewport.width}px`,
                                height: `${viewport.height}px`,
                                left: `-${viewport.offsetX}px`,
                                top: `-${viewport.offsetY}px`,
                                "pointer-events": "none",
                                "z-index": 11,
                            };
                        })()}
                    >
                        <img
                            class="sticker-rasterized-annotation-layer pointer-events-none absolute inset-0"
                            src={layerSrc()}
                            draggable={false}
                            style={{
                                width: "100%",
                                height: "100%",
                                "object-fit": "fill",
                                "max-width": "100%",
                                "max-height": "100%",
                            }}
                        />
                    </div>
                )}
            </Show>

            <Show when={getImageBorderWidth() > 0}>
                <div
                    class="pointer-events-none absolute inset-0 z-[12] box-border"
                    style={{
                        border: `${getImageBorderWidth()}px solid ${getImageBorderColor()}`,
                        "border-radius": `${getCornerRadius()}px`,
                    }}
                />
            </Show>

            <Show when={isMinified()}>
                <div class="mini-overlay" style={{
                    "position": "absolute", "top":0, "left":0, "right":0, "bottom":0,
                    "border": (isCleanView()) ? "none" : (props.isSelected
                        ? "1px dashed #ffffff"
                        : "1px dashed #808080"),
                    "pointer-events": "none",
                    "z-index": 20
                }} />
            </Show>

            <div
                class="sticker-annotation-layer-viewport absolute"
                style={(() => {
                    const viewport = isMinified()
                        ? getMinifiedAnnotationViewport()
                        : {
                              width: props.unit.w,
                              height: props.unit.h,
                              offsetX: 0,
                              offsetY: 0,
                          };
                    return {
                        width: `${viewport.width}px`,
                        height: `${viewport.height}px`,
                        left: `-${viewport.offsetX}px`,
                        top: `-${viewport.offsetY}px`,
                    };
                })()}
            >
                <StickerAnnotationLayer
                    stickerId={props.unit.id}
                    width={isMinified() ? getMinifiedAnnotationViewport().width : props.unit.w}
                    height={isMinified() ? getMinifiedAnnotationViewport().height : props.unit.h}
                    imageSrc={displaySrc()}
                />
            </div>

        </div>

        <Show when={!isMinified() && !isCleanView()}>
            <Show when={props.isSelected && activeStickerEditTargetId() === props.unit.id}>
                <StickerTopStrip
                    stickerId={props.unit.id}
                    x={currentPos().x}
                    y={currentPos().y}
                    stickerWidth={props.unit.w}
                    stickerHeight={props.unit.h}
                />
            </Show>
            <Show when={showSelectionBorder()}>
                <div
                    class="selection-border"
                    style={{
                        inset: props.isSelected ? "-2px" : "-1px",
                        border: props.isSelected
                            ? "2px solid white"
                            : `1px solid rgba(255,255,255,${Math.max(0.2, getOpacity())})`,
                        "pointer-events": "none",
                    }}
                />
            </Show>
        </Show>

        {/* === INTERACTION LAYER (Floating panels, outside of cropped visual) === */}

        <Show when={props.showSidePanel}>
             <StickerSidePanel
             unit={props.unit}
        />
        </Show>

    </div>
  );
};
