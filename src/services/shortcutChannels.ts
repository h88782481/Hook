/**
 * Authoritative ownership map for shortcut actions across input channels.
 *
 * Channels:
 * - window: FE ShortcutManager (keydown inside the focused webview)
 * - global-plugin: tauri-plugin-global-shortcut (OS-level, works when unfocused)
 * - rdev-fallback: rdev listener when global-plugin registration fails for capture
 * - overlay-hook: Win32 LL keyboard hook while overlay captures keys
 *
 * Rule: register an action in at most one *primary* channel that can fire at
 * the same time. Fallbacks may mirror a primary only when the primary failed.
 */

export type ShortcutChannel =
    | "window"
    | "global-plugin"
    | "rdev-fallback"
    | "overlay-hook";

export type ShortcutActionOwner = {
    /** Human-readable action key shared across FE/BE docs. */
    action: string;
    /** Channel that should handle the action under normal conditions. */
    primary: ShortcutChannel;
    /** Optional secondary channels that may fire when primary cannot. */
    fallbacks?: ShortcutChannel[];
    /** FE ShortcutManager ids owned by the window channel (if any). */
    windowShortcutIds?: readonly string[];
};

/**
 * Capture / open-image / toolbar toggle are OS-global so they work while the
 * overlay is click-through or another app is focused. Window-channel handlers
 * must NOT also register those ids (double-fire).
 */
export const SHORTCUT_ACTION_OWNERS: readonly ShortcutActionOwner[] = [
    {
        action: "capture",
        primary: "global-plugin",
        fallbacks: ["rdev-fallback"],
    },
    {
        action: "long_capture",
        primary: "global-plugin",
        fallbacks: ["rdev-fallback"],
    },
    {
        action: "toggle_toolbar",
        primary: "global-plugin",
    },
    {
        action: "open_image",
        primary: "global-plugin",
    },
    {
        action: "escape",
        primary: "window",
        fallbacks: ["overlay-hook", "rdev-fallback"],
        windowShortcutIds: ["delete-escape", "cancel-selection", "cancel-sticker-edit"],
    },
    {
        action: "delete",
        primary: "window",
        fallbacks: ["overlay-hook", "rdev-fallback"],
        windowShortcutIds: ["delete", "delete-backspace"],
    },
    {
        action: "copy",
        primary: "window",
        fallbacks: ["overlay-hook"],
        windowShortcutIds: ["copy"],
    },
    {
        action: "paste",
        primary: "window",
        fallbacks: ["overlay-hook"],
        windowShortcutIds: ["paste"],
    },
    {
        action: "toggle_history",
        primary: "window",
        windowShortcutIds: ["toggle-history"],
    },
    {
        action: "save",
        primary: "window",
        windowShortcutIds: ["save"],
    },
    {
        action: "undo_edit",
        primary: "window",
        windowShortcutIds: ["undo-edit"],
    },
    {
        action: "redo_edit",
        primary: "window",
        windowShortcutIds: ["redo-edit"],
    },
    {
        action: "toggle_actions",
        primary: "window",
        windowShortcutIds: ["toggle-actions"],
    },
    {
        action: "toggle_side_panel",
        primary: "window",
        windowShortcutIds: ["toggle-side-panel"],
    },
    {
        action: "toggle_clean_view",
        primary: "window",
        windowShortcutIds: ["toggle-clean-view"],
    },
    {
        action: "transform_select",
        primary: "window",
        windowShortcutIds: ["transform-select", "transform-select-editing"],
    },
    {
        action: "transform_move",
        primary: "window",
        windowShortcutIds: ["transform-move", "transform-move-editing"],
    },
    {
        action: "transform_rotate",
        primary: "window",
        windowShortcutIds: ["transform-rotate", "transform-rotate-editing"],
    },
    {
        action: "transform_scale",
        primary: "window",
        windowShortcutIds: ["transform-scale", "transform-scale-editing"],
    },
];

/** FE ShortcutManager ids that the window channel is allowed to register. */
export const WINDOW_SHORTCUT_IDS: readonly string[] = SHORTCUT_ACTION_OWNERS.flatMap(
    (owner) => (owner.primary === "window" ? owner.windowShortcutIds ?? [] : []),
);
