/**
 * Shortcut Manager - Centralized Keyboard Binding Management
 *
 * This module provides a clean API for registering, managing, and handling
 * keyboard shortcuts throughout the application. It prevents conflicts
 * and makes it easy to customize bindings.
 */

type ModifierKey = 'ctrl' | 'alt' | 'shift' | 'meta';

interface ShortcutDef {
  id: string;             // Unique identifier (e.g., "copy", "paste")
  key: string;            // Key code (e.g., "c", "Delete", "Tab")
  modifiers: ModifierKey[]; // Required modifiers
  description: string;    // Human-readable description
  enabled: boolean;       // Whether shortcut is active
  context?: string;       // Optional context (e.g., "unit-selected")
}

interface RuntimeShortcutBinding extends ShortcutDef {
  action: () => void | Promise<void>;
}

// Default shortcut definitions
const DEFAULT_SHORTCUTS: ShortcutDef[] = [
  // Clipboard Operations
  { id: 'copy', key: 'c', modifiers: ['ctrl'], description: 'Copy selected unit', enabled: true, context: 'unit-selected' },
  { id: 'paste', key: 'v', modifiers: ['ctrl'], description: 'Paste unit', enabled: true },
  { id: 'toggle-history', key: 'h', modifiers: ['ctrl'], description: 'Toggle color/screenshot history panel', enabled: true },
  { id: 'save', key: 's', modifiers: ['ctrl'], description: 'Save image', enabled: true, context: 'unit-selected' },
  { id: 'undo-edit', key: 'z', modifiers: ['ctrl'], description: 'Undo sticker edit', enabled: true, context: 'unit-selected' },
  { id: 'undo-edit-editing', key: 'z', modifiers: ['ctrl'], description: 'Undo sticker edit while drawing', enabled: true, context: 'sticker-editing' },
  { id: 'redo-edit', key: 'y', modifiers: ['ctrl'], description: 'Redo sticker edit', enabled: true, context: 'unit-selected' },
  { id: 'redo-edit-editing', key: 'y', modifiers: ['ctrl'], description: 'Redo sticker edit while drawing', enabled: true, context: 'sticker-editing' },
  { id: 'redo-edit-shift', key: 'z', modifiers: ['ctrl', 'shift'], description: 'Redo sticker edit (Ctrl+Shift+Z)', enabled: true, context: 'unit-selected' },
  { id: 'redo-edit-shift-editing', key: 'z', modifiers: ['ctrl', 'shift'], description: 'Redo sticker edit while drawing (Ctrl+Shift+Z)', enabled: true, context: 'sticker-editing' },

  // Sticker Operations
  { id: 'delete', key: 'Delete', modifiers: [], description: 'Delete selected unit', enabled: true, context: 'unit-selected' },
  { id: 'delete-backspace', key: 'Backspace', modifiers: [], description: 'Delete selected unit', enabled: true, context: 'unit-selected' },
  { id: 'delete-escape', key: 'Escape', modifiers: [], description: 'Delete/Deselect unit', enabled: true, context: 'unit-selected' },
  { id: 'cancel-selection', key: 'Escape', modifiers: [], description: 'Cancel screenshot selection', enabled: true, context: 'capture-selecting' },
  { id: 'cancel-sticker-edit', key: 'Escape', modifiers: [], description: 'Cancel sticker edit draft', enabled: true, context: 'sticker-editing' },

  // UI Toggles
  { id: 'toggle-side-panel', key: 'Tab', modifiers: [], description: 'Toggle Sticker Side Panel', enabled: true, context: 'unit-selected' },
  { id: 'toggle-clean-view', key: '4', modifiers: ['ctrl'], description: 'Toggle Clean View Mode', enabled: true },
  { id: 'transform-select', key: 'q', modifiers: [], description: 'Switch sticker transform mode to select', enabled: true, context: 'unit-selected' },
  { id: 'transform-move', key: 'w', modifiers: [], description: 'Switch sticker transform mode to move', enabled: true, context: 'unit-selected' },
  { id: 'transform-rotate', key: 'e', modifiers: [], description: 'Switch sticker transform mode to rotate', enabled: true, context: 'unit-selected' },
  { id: 'transform-scale', key: 'r', modifiers: [], description: 'Switch sticker transform mode to scale', enabled: true, context: 'unit-selected' },
  { id: 'transform-select-editing', key: 'q', modifiers: [], description: 'Switch sticker transform mode to select while editing', enabled: true, context: 'sticker-editing' },
  { id: 'transform-move-editing', key: 'w', modifiers: [], description: 'Switch sticker transform mode to move while editing', enabled: true, context: 'sticker-editing' },
  { id: 'transform-rotate-editing', key: 'e', modifiers: [], description: 'Switch sticker transform mode to rotate while editing', enabled: true, context: 'sticker-editing' },
  { id: 'transform-scale-editing', key: 'r', modifiers: [], description: 'Switch sticker transform mode to scale while editing', enabled: true, context: 'sticker-editing' },
];

// Drag modifier shortcuts (checked during mouse events, not keydown)
export const DRAG_MODIFIERS = {
  alignment: 'alt' as ModifierKey,     // Node snapping/alignment
  dragOut: 'shift' as ModifierKey,     // File drag-out to folder
  cascade: 'ctrl' as ModifierKey,      // Stack/cascade placement
};

class ShortcutManagerClass {
  private bindings: Map<string, RuntimeShortcutBinding> = new Map();
  private definitions: Map<string, ShortcutDef> = new Map();
  private contextProvider: (() => string | null) | null = null;

  constructor() {
    // Initialize with default definitions
    DEFAULT_SHORTCUTS.forEach(def => {
      this.definitions.set(def.id, { ...def });
    });
  }

  /**
   * Set the context provider function.
   * This function returns the current context (e.g., "unit-selected" or null)
   */
  setContextProvider(provider: () => string | null): void {
    this.contextProvider = provider;
  }

  /**
   * Register an action for a shortcut ID
   */
  register(id: string, action: () => void | Promise<void>): boolean {
    const def = this.definitions.get(id);
    if (!def) {
      console.warn(`[ShortcutManager] Unknown shortcut ID: ${id}`);
      return false;
    }

    this.bindings.set(id, { ...def, action });
    return true;
  }

  /**
   * Unregister a shortcut action
   */
  unregister(id: string): void {
    this.bindings.delete(id);
  }

  /**
   * Check if modifiers in event match requirements
   */
  private eventMatchesModifiers(e: KeyboardEvent, modifiers: ModifierKey[], triggerKey: string): boolean {
    const hasCtrl = modifiers.includes('ctrl');
    const hasAlt = modifiers.includes('alt');
    const hasShift = modifiers.includes('shift');
    const hasMeta = modifiers.includes('meta');

    // If the trigger key IS the modifier (e.g. key="Shift"), the event.shiftKey will be true.
    // We strictly enforce modifiers from the definition, but exempt the flag corresponding to the trigger key itself.

    if (triggerKey === 'Control') {
         if (e.altKey !== hasAlt) return false;
         if (e.shiftKey !== hasShift) return false;
         if (e.metaKey !== hasMeta) return false;
         // e.ctrlKey is expected to be true, but binding.modifiers might be empty. Ignore e.ctrlKey check.
         return true;
    }

    if (triggerKey === 'Shift') {
         if (e.ctrlKey !== hasCtrl) return false;
         if (e.altKey !== hasAlt) return false;
         if (e.metaKey !== hasMeta) return false;
         return true;
    }

    if (triggerKey === 'Alt') {
         if (e.ctrlKey !== hasCtrl) return false;
         if (e.shiftKey !== hasShift) return false;
         if (e.metaKey !== hasMeta) return false;
         return true;
    }

    return (
      e.ctrlKey === hasCtrl &&
      e.altKey === hasAlt &&
      e.shiftKey === hasShift &&
      e.metaKey === hasMeta
    );
  }

  /**
   * Handle keydown event - call this from global listener
   * Returns true if a shortcut was handled
   */
  handleKeyDown(e: KeyboardEvent): boolean {
    const currentContext = this.contextProvider?.() || null;

    for (const [_, binding] of this.bindings) {
      if (!binding.enabled) continue;

      // Check context requirement
      if (binding.context && binding.context !== currentContext) continue;

      // Check key match
      if (e.key !== binding.key && e.key.toLowerCase() !== binding.key.toLowerCase()) continue;

      // Check modifiers
      if (!this.eventMatchesModifiers(e, binding.modifiers, binding.key)) continue;

      // Skip repeated key presses for certain shortcuts
      if (e.repeat && (binding.key === 'Control' || binding.key === 'Shift')) continue;

      // Execute action
      try {
        binding.action();
        return true;
      } catch (err) {
        console.error(`[ShortcutManager] Error executing "${binding.id}":`, err);
      }
    }

    return false;
  }

  /**
   * Check if a drag modifier is active
   */
  isDragModifierActive(e: MouseEvent, modifier: keyof typeof DRAG_MODIFIERS): boolean {
    const key = DRAG_MODIFIERS[modifier];
    switch (key) {
      case 'alt': return e.altKey;
      case 'shift': return e.shiftKey;
      case 'ctrl': return e.ctrlKey;
      case 'meta': return e.metaKey;
      default: return false;
    }
  }
}

// Singleton export
export const ShortcutManager = new ShortcutManagerClass();
