/**
 * useShortcuts - SolidJS hook for keyboard shortcut integration
 *
 * Window-channel registrations are driven by WINDOW_SHORTCUT_IDS (derived from
 * the shortcut ownership map) so actions owned by Rust global shortcuts
 * (toggle toolbar, open image, capture) are never double-registered here.
 */

import { onMount, onCleanup } from "solid-js";
import { ShortcutManager, DRAG_MODIFIERS } from "../services/shortcuts";
import { WINDOW_SHORTCUT_IDS } from "../services/shortcutChannels";

interface ShortcutHandlers {
  // Clipboard
  onCopy?: () => void | Promise<void>;
  onPaste?: () => void | Promise<void>;
  onToggleHistory?: () => void | Promise<void>;
  onSave?: () => void | Promise<void>;
  onUndoEdit?: () => void | Promise<void>;
  onRedoEdit?: () => void | Promise<void>;

  // Sticker Operations
  onDelete?: () => void | Promise<void>;
  onCancelSelection?: () => void | Promise<void>;
  onCancelStickerEdit?: () => void | Promise<void>;

  // UI Toggles (toolbar / open-image are Rust global-plugin only)
  onToggleSidePanel?: () => void | Promise<void>;
  onToggleCleanView?: () => void | Promise<void>;
  onTransformSelect?: () => void | Promise<void>;
  onTransformMove?: () => void | Promise<void>;
  onTransformRotate?: () => void | Promise<void>;
  onTransformScale?: () => void | Promise<void>;
}

interface UseShortcutsOptions {
  handlers: ShortcutHandlers;
  contextProvider: () => string | null;
}

const HANDLER_BY_SHORTCUT_ID: Record<string, keyof ShortcutHandlers> = {
  copy: "onCopy",
  paste: "onPaste",
  "toggle-history": "onToggleHistory",
  save: "onSave",
  "undo-edit": "onUndoEdit",
  "undo-edit-editing": "onUndoEdit",
  "redo-edit": "onRedoEdit",
  "redo-edit-editing": "onRedoEdit",
  "redo-edit-shift": "onRedoEdit",
  "redo-edit-shift-editing": "onRedoEdit",
  delete: "onDelete",
  "delete-backspace": "onDelete",
  "delete-escape": "onDelete",
  "cancel-selection": "onCancelSelection",
  "cancel-sticker-edit": "onCancelStickerEdit",
  "toggle-side-panel": "onToggleSidePanel",
  "toggle-clean-view": "onToggleCleanView",
  "transform-select": "onTransformSelect",
  "transform-move": "onTransformMove",
  "transform-rotate": "onTransformRotate",
  "transform-scale": "onTransformScale",
  "transform-select-editing": "onTransformSelect",
  "transform-move-editing": "onTransformMove",
  "transform-rotate-editing": "onTransformRotate",
  "transform-scale-editing": "onTransformScale",
};

/**
 * Hook to set up keyboard shortcut handling
 */
export function useShortcuts(options: UseShortcutsOptions) {
  onMount(() => {
    ShortcutManager.setContextProvider(options.contextProvider);

    const { handlers } = options;
    const registeredIds: string[] = [];

    for (const id of WINDOW_SHORTCUT_IDS) {
      const handlerKey = HANDLER_BY_SHORTCUT_ID[id];
      if (!handlerKey) continue;
      const handler = handlers[handlerKey];
      if (!handler) continue;
      if (ShortcutManager.register(id, handler)) {
        registeredIds.push(id);
      }
    }

    const shouldSuppressBareAlt = (e: KeyboardEvent) =>
      e.key === 'Alt' && !e.ctrlKey && !e.metaKey;

    // On Windows WebView, a bare Alt press can enter the native accelerator
    // path and break the next wheel gesture from reaching the Hook overlay.
    // Hook uses Alt only as an in-canvas modifier, so we suppress the native
    // bare-Alt default at the app boundary.
    const suppressBareAlt = (e: KeyboardEvent) => {
      if (!shouldSuppressBareAlt(e)) return false;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      return true;
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (suppressBareAlt(e)) return;

      const target = e.target as HTMLElement;
      const isEditing = target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';
      if (isEditing && !['Escape', 'Tab'].includes(e.key)) return;

      const handled = ShortcutManager.handleKeyDown(e);
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (suppressBareAlt(e)) return;
    };

    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('keyup', handleKeyUp, true);

    onCleanup(() => {
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('keyup', handleKeyUp, true);
      for (const id of registeredIds) {
        ShortcutManager.unregister(id);
      }
    });
  });
}

/**
 * Check drag modifiers for mouse events
 */
export function checkDragModifier(e: MouseEvent, type: keyof typeof DRAG_MODIFIERS): boolean {
  return ShortcutManager.isDragModifierActive(e, type);
}
