export type ShortcutBinding = {
    key: string;
    modifiers: string[];
};

export type ShortcutSettings = {
    capture: ShortcutBinding;
    longCapture: ShortcutBinding;
    toggleToolbar: ShortcutBinding;
    openImage: ShortcutBinding;
};

export type AppSettings = {
    autoStart: boolean;
    stickerToolbarDefaultVisible: boolean;
    shortcuts: ShortcutSettings;
};

export const defaultAppSettings = (): AppSettings => ({
    autoStart: false,
    stickerToolbarDefaultVisible: false,
    shortcuts: {
        capture: { key: "Digit1", modifiers: ["Control"] },
        longCapture: { key: "Digit3", modifiers: ["Control"] },
        toggleToolbar: { key: "KeyE", modifiers: ["Control"] },
        openImage: { key: "KeyO", modifiers: ["Control"] },
    },
});

const normalizeBinding = (
    value: Partial<ShortcutBinding> | null | undefined,
    fallback: ShortcutBinding,
): ShortcutBinding => ({
    key: typeof value?.key === "string" && value.key.trim() ? value.key : fallback.key,
    modifiers: Array.isArray(value?.modifiers)
        ? value.modifiers.filter((item): item is string => typeof item === "string")
        : fallback.modifiers,
});

export const normalizeAppSettings = (
    value: Partial<AppSettings> | null | undefined,
): AppSettings => {
    const defaults = defaultAppSettings();
    return {
        autoStart: typeof value?.autoStart === "boolean" ? value.autoStart : defaults.autoStart,
        stickerToolbarDefaultVisible:
            typeof value?.stickerToolbarDefaultVisible === "boolean"
                ? value.stickerToolbarDefaultVisible
                : defaults.stickerToolbarDefaultVisible,
        shortcuts: {
            capture: normalizeBinding(value?.shortcuts?.capture, defaults.shortcuts.capture),
            longCapture: normalizeBinding(
                value?.shortcuts?.longCapture,
                defaults.shortcuts.longCapture,
            ),
            toggleToolbar: normalizeBinding(
                value?.shortcuts?.toggleToolbar,
                defaults.shortcuts.toggleToolbar,
            ),
            openImage: normalizeBinding(
                value?.shortcuts?.openImage,
                defaults.shortcuts.openImage,
            ),
        },
    };
};

export const formatShortcutBinding = (binding: ShortcutBinding): string => {
    const parts = binding.modifiers.map((modifier) => {
        const lower = modifier.toLowerCase();
        if (lower === "ctrl" || lower === "control") return "Ctrl";
        if (lower === "alt") return "Alt";
        if (lower === "shift") return "Shift";
        if (lower === "meta" || lower === "super" || lower === "win") return "Win";
        return modifier;
    });
    const key = binding.key.startsWith("Digit")
        ? binding.key.slice(5)
        : binding.key.startsWith("Key")
          ? binding.key.slice(3)
          : binding.key;
    parts.push(key);
    return parts.join("+");
};

export const shortcutBindingFromKeyboardEvent = (event: KeyboardEvent): ShortcutBinding | null => {
    const modifiers: string[] = [];
    if (event.ctrlKey) modifiers.push("Control");
    if (event.altKey) modifiers.push("Alt");
    if (event.shiftKey) modifiers.push("Shift");
    if (event.metaKey) modifiers.push("Meta");

    const code = event.code;
    if (
        code === "ControlLeft" ||
        code === "ControlRight" ||
        code === "ShiftLeft" ||
        code === "ShiftRight" ||
        code === "AltLeft" ||
        code === "AltRight" ||
        code === "MetaLeft" ||
        code === "MetaRight"
    ) {
        return null;
    }

    return { key: code, modifiers };
};
