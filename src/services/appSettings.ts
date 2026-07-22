export type AppShortcutBinding = {
    key: string;
    modifiers: string[];
};

type ShortcutSettings = {
    capture: AppShortcutBinding;
    longCapture: AppShortcutBinding;
    toggleToolbar: AppShortcutBinding;
    openImage: AppShortcutBinding;
};

export type AppSettings = {
    autoStart: boolean;
    stickerToolbarDefaultVisible: boolean;
    /** ShareX-style: ignore capture hotkeys while a fullscreen window is active. Default on. */
    disableHotkeysOnFullscreen: boolean;
    shortcuts: ShortcutSettings;
};

export const emptyShortcutBinding = (): AppShortcutBinding => ({
    key: "",
    modifiers: [],
});

export const isShortcutUnbound = (binding: AppShortcutBinding): boolean => !binding.key.trim();

const isPrintScreenKey = (key: string) =>
    key === "PrintScreen" || key === "PrtSc" || key === "PrtScn" || key === "Snapshot";

export const defaultAppSettings = (): AppSettings => ({
    autoStart: false,
    stickerToolbarDefaultVisible: false,
    disableHotkeysOnFullscreen: true,
    shortcuts: {
        capture: { key: "Digit1", modifiers: ["Control"] },
        longCapture: { key: "Digit3", modifiers: ["Control"] },
        toggleToolbar: { key: "KeyE", modifiers: ["Control"] },
        openImage: { key: "KeyO", modifiers: ["Control"] },
    },
});

const normalizeBinding = (
    value: Partial<AppShortcutBinding> | null | undefined,
    fallback: AppShortcutBinding,
): AppShortcutBinding => {
    // Missing/invalid entry → default. Explicit empty key → unbound.
    if (!value || typeof value.key !== "string") {
        return { key: fallback.key, modifiers: [...fallback.modifiers] };
    }
    const key = value.key.trim();
    if (!key) {
        return emptyShortcutBinding();
    }
    if (isPrintScreenKey(key)) {
        return { key: "PrintScreen", modifiers: [] };
    }
    return {
        key,
        modifiers: Array.isArray(value.modifiers)
            ? value.modifiers.filter((item): item is string => typeof item === "string")
            : [],
    };
};

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
        disableHotkeysOnFullscreen:
            typeof value?.disableHotkeysOnFullscreen === "boolean"
                ? value.disableHotkeysOnFullscreen
                : defaults.disableHotkeysOnFullscreen,
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

export const formatShortcutBinding = (binding: AppShortcutBinding): string => {
    if (isShortcutUnbound(binding)) return "未绑定";
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
          : binding.key === "PrintScreen"
            ? "PrtSc"
            : binding.key;
    parts.push(key);
    return parts.join("+");
};

export const shortcutBindingFromKeyboardEvent = (event: KeyboardEvent): AppShortcutBinding | null => {
    const modifiers: string[] = [];
    if (event.ctrlKey) modifiers.push("Control");
    if (event.altKey) modifiers.push("Alt");
    if (event.shiftKey) modifiers.push("Shift");
    if (event.metaKey) modifiers.push("Meta");

    // WebView2 may omit code for PrintScreen; fall back to key name.
    const code =
        event.code && event.code !== "Unidentified"
            ? event.code
            : event.key === "PrintScreen"
              ? "PrintScreen"
              : "";
    if (!code) return null;

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

    if (isPrintScreenKey(code) || event.key === "PrintScreen") {
        return { key: "PrintScreen", modifiers: [] };
    }

    return { key: code, modifiers };
};
