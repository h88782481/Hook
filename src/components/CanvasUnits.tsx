import { Component, For, onCleanup } from "solid-js";
import { StickerView } from "./StickerView";
import { stickerStore } from "../store/stickerStore";
import {
    selectionActions,
    unitUiState,
    multiDragPositions,
    activeStickerGroupId,
} from "../store/uiStore";
import { syncService } from "../services/syncService";

// Define Props for callbacks that are still managed by parent or complex flows
interface CanvasUnitsProps {
    onStartDrag: (e: MouseEvent, id: string) => void;
    onDoubleClick: (e: MouseEvent, id: string) => void;
    onDelete: (id: string) => void;

    // Linking events
    onLinkStart: (uId: string, portId: string, x: number, y: number) => void;
    onLinkDrop: (uId: string, portId: string) => void;
    onLinkMove: (uId: string, portId: string, e: MouseEvent) => void;
    onLinkHover: (uId: string, targetId: string | null) => void;
    onRendered: (id: string, dataUrl: string) => void;

    resolveUnitImage: (id: string) => string | undefined;
    portsLayerRef: HTMLDivElement | undefined;
}

export const CanvasUnits: Component<CanvasUnitsProps> = (props) => {
    const STICKER_RESIZE_SYNC_DEBOUNCE_MS = 140;
    const STICKER_APPEARANCE_SYNC_DEBOUNCE_MS = 140;
    let stickerResizeSyncTimer: number | null = null;
    let stickerAppearanceSyncTimer: number | null = null;

    const scheduleStickerResizeSync = (unitId: string) => {
        if (stickerResizeSyncTimer !== null) {
            window.clearTimeout(stickerResizeSyncTimer);
        }

        stickerResizeSyncTimer = window.setTimeout(() => {
            stickerResizeSyncTimer = null;
            stickerStore.actions.propagateStickerEditsFrom(unitId);
            void syncService.scheduleSessionSync();
        }, STICKER_RESIZE_SYNC_DEBOUNCE_MS);
    };

    const scheduleStickerAppearanceSync = () => {
        if (stickerAppearanceSyncTimer !== null) {
            window.clearTimeout(stickerAppearanceSyncTimer);
        }

        stickerAppearanceSyncTimer = window.setTimeout(() => {
            stickerAppearanceSyncTimer = null;
            void syncService.scheduleSessionSync();
        }, STICKER_APPEARANCE_SYNC_DEBOUNCE_MS);
    };

    onCleanup(() => {
        if (stickerResizeSyncTimer !== null) {
            window.clearTimeout(stickerResizeSyncTimer);
            stickerResizeSyncTimer = null;
        }
        if (stickerAppearanceSyncTimer !== null) {
            window.clearTimeout(stickerAppearanceSyncTimer);
            stickerAppearanceSyncTimer = null;
        }
    });

    return (
      <For each={stickerStore.stickers.filter((unit) => {
          const activeGroup = activeStickerGroupId();
          if (activeGroup && unit.data.groupId !== activeGroup) {
              return false;
          }
          const group = unit.data.groupId
              ? stickerStore.stickerGroups.find((item) => item.id === unit.data.groupId)
              : undefined;
          return !group?.hidden;
      })}>{(u) => {
          return (
          <StickerView
              // State
              unit={u}
              multiDragPositions={multiDragPositions()}
              isSelected={selectionActions.isSelected(u.id)}

              // UI State (Show/Hide panels)
              showActions={(unitUiState[u.id]?.showActions || false) && !u.data.minified}
              showSidePanel={(unitUiState[u.id]?.showSidePanel || false) && !u.data.minified}

              // Setup
              portsLayer={props.portsLayerRef}

              // Events
              onMouseDown={(e) => props.onStartDrag(e, u.id)}
              onDoubleTap={(e) => props.onDoubleClick(e, u.id)}

              onDelete={() => props.onDelete(u.id)}

              // Linking
              onLinkStart={(propId, x, y) => props.onLinkStart(u.id, propId, x, y)}
              onLinkDrop={(portId) => props.onLinkDrop(u.id, portId)}
              onLinkMove={(portId, e) => props.onLinkMove(u.id, portId, e)}
              onLinkHover={(targetId) => props.onLinkHover(u.id, targetId)}
              onRendered={props.onRendered}

              // Resizing
              onResize={(nextFrame) => {
                  stickerStore.actions.resizeStickerFrame(u.id, nextFrame, { propagate: false });
                  scheduleStickerResizeSync(u.id);
              }}
              onOpacityChange={(val) => {
                  if (u.data.minified) {
                      stickerStore.actions.updateStickerData(u.id, { opacityMini: val });
                  } else {
                      stickerStore.actions.updateStickerData(u.id, { opacityNormal: val });
                  }
                  scheduleStickerAppearanceSync();
              }}

              // Data Resolution
              connectedPorts={stickerStore.links.filter(l => l.toUnitId === u.id).map(l => l.toPortId)}
              connectedLinks={stickerStore.links.filter(l => l.toUnitId === u.id)}
              resolveUnitImage={props.resolveUnitImage}
          />
          );
      }}</For>
    );
};
