import { Show, createEffect, createMemo, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import { api } from "../services/api";
import { renderStickerComposite } from "../services/stickerExport";
import {
    addRecycleBinEntry,
    cancelReferenceEntry,
    copyReferenceEntry,
    removeFrozenStickerEntry,
    restoreRecycleBinEntry,
    setReferenceEntry,
} from "../services/stickerLibraryModel";
import { stickerContextMenuController } from "../services/stickerContextMenuController";
import { captureFrozenStickerSnapshot } from "../services/stickerSnapshot";
import { syncService } from "../services/syncService";
import { addOrUpdateRect, removeRect } from "../services/uiRegistry";
import { stickerStore } from "../store/stickerStore";
import { selectionActions, uiActions } from "../store/uiStore";
import { StickerContextMenuPanel } from "./StickerContextMenuPanel";
import { StickerSnapshotListPanel } from "./StickerSnapshotListPanel";

const CONTEXT_MENU_RECT_ID = "sticker-context-menu-root";
const CONTEXT_MENU_RECT_NAME = "STICKER_CONTEXT_MENU_ROOT";

export const StickerContextMenuLayer = () => {
    let menuRootRef: HTMLDivElement | undefined;

    const closeMenu = () => {
        stickerContextMenuController.close();
    };

    const menuMouse = () => ({
        x: stickerContextMenuController.state.mouseX,
        y: stickerContextMenuController.state.mouseY,
    });

    const targetSticker = createMemo(() => {
        const targetStickerId = stickerContextMenuController.state.targetStickerId;
        if (!targetStickerId) {
            return undefined;
        }

        return stickerStore.stickers.find((unit) => unit.id === targetStickerId);
    });

    const referenceActionLabel = createMemo(() => {
        const target = targetSticker();
        if (!target) {
            return "设置坂考";
        }

        return stickerStore.referenceLibrary.some((entry) => entry.sourceStickerId === target.id)
            ? "坖消坂考"
            : "设置坂考";
    });

    const activeSubmenuEntries = createMemo(() => {
        switch (stickerContextMenuController.state.activeSubmenu) {
            case "recycleBin":
                return stickerStore.recycleBin;
            case "referenceLibrary":
                return stickerStore.referenceLibrary;
            default:
                return [];
        }
    });

    const persistSession = () => {
        void syncService.scheduleSessionSync();
    };

    const persistLayoutAndSession = () => {
        void syncService.notifyLayoutChange({ persist: true });
    };

    const handleCloseSticker = () => {
        const target = targetSticker();
        if (!target) {
            closeMenu();
            return;
        }

        stickerStore.setRecycleBin(addRecycleBinEntry(stickerStore.recycleBin, captureFrozenStickerSnapshot(target)));
        stickerStore.actions.removeSticker(target.id);
        uiActions.clearStickerHistory(target.id);
        selectionActions.clear();
        uiActions.hideStickerToolbar();
        closeMenu();
        persistLayoutAndSession();
    };

    const handleSave = async () => {
        const target = targetSticker();
        if (!target) {
            closeMenu();
            return;
        }

        try {
            const exportBase64 = await renderStickerComposite(target);
            const centerX = target.x + target.w / 2;
            const centerY = target.y + target.h / 2;
            await api.saveStickerImageAs(exportBase64, centerX, centerY);
        } catch (error) {
            console.error("Save sticker composite failed", error);
        } finally {
            closeMenu();
        }
    };

    const handleClearRecycleBin = () => {
        stickerStore.setRecycleBin([]);
        closeMenu();
        persistSession();
    };

    const handleToggleReference = () => {
        const target = targetSticker();
        if (!target) {
            closeMenu();
            return;
        }

        if (stickerStore.referenceLibrary.some((entry) => entry.sourceStickerId === target.id)) {
            stickerStore.setReferenceLibrary(cancelReferenceEntry(stickerStore.referenceLibrary, target.id));
        } else {
            stickerStore.setReferenceLibrary(
                setReferenceEntry(stickerStore.referenceLibrary, captureFrozenStickerSnapshot(target)),
            );
        }

        closeMenu();
        persistSession();
    };

    const handleClearReferenceLibrary = () => {
        stickerStore.setReferenceLibrary([]);
        closeMenu();
        persistSession();
    };

    const handleRecycleRestore = (entryId: string) => {
        const result = restoreRecycleBinEntry(stickerStore.recycleBin, entryId, menuMouse());

        stickerStore.setRecycleBin(result.entries);
        stickerStore.actions.addSticker(result.restored);
        uiActions.hideStickerToolbar();
        selectionActions.set([result.restored.id]);
        closeMenu();
        persistLayoutAndSession();
    };

    const handleRecycleDelete = (entryId: string) => {
        stickerStore.setRecycleBin(removeFrozenStickerEntry(stickerStore.recycleBin, entryId));
        persistSession();
    };

    const handleReferenceCopy = (entryId: string) => {
        const copied = copyReferenceEntry(stickerStore.referenceLibrary, entryId, menuMouse());

        stickerStore.actions.addSticker(copied);
        uiActions.hideStickerToolbar();
        selectionActions.set([copied.id]);
        closeMenu();
        persistLayoutAndSession();
    };

    const handleReferenceRemove = (entryId: string) => {
        stickerStore.setReferenceLibrary(removeFrozenStickerEntry(stickerStore.referenceLibrary, entryId));
        persistSession();
    };

    createEffect(() => {
        if (!stickerContextMenuController.state.isOpen) {
            return;
        }

        const handlePointerDown = (event: PointerEvent) => {
            if (menuRootRef?.contains(event.target as Node)) {
                return;
            }

            closeMenu();
        };

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key !== "Escape") {
                return;
            }

            closeMenu();
        };

        const handleWindowBlur = () => {
            closeMenu();
        };

        const handleVisibilityChange = () => {
            if (document.visibilityState === "hidden") {
                closeMenu();
            }
        };

        document.addEventListener("pointerdown", handlePointerDown, true);
        window.addEventListener("keydown", handleKeyDown, true);
        window.addEventListener("blur", handleWindowBlur);
        document.addEventListener("visibilitychange", handleVisibilityChange);

        onCleanup(() => {
            document.removeEventListener("pointerdown", handlePointerDown, true);
            window.removeEventListener("keydown", handleKeyDown, true);
            window.removeEventListener("blur", handleWindowBlur);
            document.removeEventListener("visibilitychange", handleVisibilityChange);
        });
    });

    createEffect(() => {
        if (!stickerContextMenuController.state.isOpen || !menuRootRef) {
            removeRect(CONTEXT_MENU_RECT_ID);
            void syncService.updateBackendRects();
            return;
        }

        const syncRect = () => {
            if (!menuRootRef) {
                return;
            }

            const rect = menuRootRef.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) {
                return;
            }

            addOrUpdateRect({
                id: CONTEXT_MENU_RECT_ID,
                x: rect.left,
                y: rect.top,
                width: rect.width,
                height: rect.height,
                name: CONTEXT_MENU_RECT_NAME,
            });
            void syncService.updateBackendRects();
        };

        requestAnimationFrame(syncRect);

        let observer: ResizeObserver | undefined;
        if (typeof ResizeObserver !== "undefined") {
            observer = new ResizeObserver(syncRect);
            observer.observe(menuRootRef);
        }

        onCleanup(() => {
            observer?.disconnect();
            removeRect(CONTEXT_MENU_RECT_ID);
            void syncService.updateBackendRects();
        });
    });

    createEffect(() => {
        if (!stickerContextMenuController.state.isOpen) {
            return;
        }

        if (!targetSticker()) {
            closeMenu();
        }
    });

    return (
        <Portal>
            <Show when={stickerContextMenuController.state.isOpen && stickerContextMenuController.state.targetStickerId}>
                <div class="pointer-events-none fixed inset-0 z-[1400]">
                    <div
                        ref={menuRootRef}
                        class="pointer-events-auto fixed flex items-start gap-0"
                        style={{
                            left: `${stickerContextMenuController.state.mouseX}px`,
                            top: `${stickerContextMenuController.state.mouseY}px`,
                        }}
                        onMouseDown={(event) => event.stopPropagation()}
                        onMouseUp={(event) => event.stopPropagation()}
                        onClick={(event) => event.stopPropagation()}
                        onContextMenu={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                        }}
                    >
                        <StickerContextMenuPanel
                            referenceActionLabel={referenceActionLabel()}
                            onCloseSticker={handleCloseSticker}
                            onSave={() => void handleSave()}
                            onClearRecycleBin={handleClearRecycleBin}
                            onToggleReference={handleToggleReference}
                            onClearReferenceLibrary={handleClearReferenceLibrary}
                            onOpenSubmenu={(submenu, anchor) => stickerContextMenuController.openSubmenu(submenu, anchor)}
                        />
                        <Show when={stickerContextMenuController.state.activeSubmenu !== "none"}>
                            <div
                                style={{
                                    "margin-top": `${stickerContextMenuController.state.submenuOffsetY}px`,
                                }}
                            >
                                <StickerSnapshotListPanel
                                    entries={activeSubmenuEntries()}
                                    onLeftActivate={(entryId) => {
                                        if (stickerContextMenuController.state.activeSubmenu === "recycleBin") {
                                            handleRecycleRestore(entryId);
                                            return;
                                        }

                                        handleReferenceCopy(entryId);
                                    }}
                                    onRightActivate={(entryId) => {
                                        if (stickerContextMenuController.state.activeSubmenu === "recycleBin") {
                                            handleRecycleDelete(entryId);
                                            return;
                                        }

                                        handleReferenceRemove(entryId);
                                    }}
                                />
                            </div>
                        </Show>
                    </div>
                </div>
            </Show>
        </Portal>
    );
};
