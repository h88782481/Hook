import { Component, For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "../services/api";
import {
    type AppSettings,
    type AppShortcutBinding,
    defaultAppSettings,
    emptyShortcutBinding,
    formatShortcutBinding,
    isShortcutUnbound,
    normalizeAppSettings,
    shortcutBindingFromKeyboardEvent,
} from "../services/appSettings";

type ShortcutField = keyof AppSettings["shortcuts"];

const SHORTCUT_FIELDS: Array<{ id: ShortcutField; label: string; hint: string }> = [
    { id: "capture", label: "截图", hint: "全局快捷键，唤起区域截图（支持 PrtSc）" },
    { id: "longCapture", label: "长截图", hint: "全局快捷键，唤起长截图会话" },
    { id: "toggleToolbar", label: "切换贴图工具栏", hint: "显示或隐藏当前贴图工具栏" },
    { id: "openImage", label: "打开图片编辑", hint: "选择本地图片并放到画布上" },
];

export const SettingsPage: Component = () => {
    const [settings, setSettings] = createSignal<AppSettings>(defaultAppSettings());
    const [loading, setLoading] = createSignal(true);
    const [saving, setSaving] = createSignal(false);
    const [message, setMessage] = createSignal<string | null>(null);
    const [recording, setRecording] = createSignal<ShortcutField | null>(null);
    const [error, setError] = createSignal<string | null>(null);

    const load = async () => {
        setLoading(true);
        setError(null);
        try {
            const loaded = await api.loadAppSettings();
            setSettings(normalizeAppSettings(loaded));
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            setSettings(defaultAppSettings());
        } finally {
            setLoading(false);
        }
    };

    onMount(() => {
        void load();
        document.documentElement.classList.add("hook-settings-root");
        document.body.classList.add("hook-settings-body");
        onCleanup(() => {
            document.documentElement.classList.remove("hook-settings-root");
            document.body.classList.remove("hook-settings-body");
        });
    });

    const updateShortcut = (field: ShortcutField, binding: AppShortcutBinding) => {
        setSettings((prev) => ({
            ...prev,
            shortcuts: {
                ...prev.shortcuts,
                [field]: binding,
            },
        }));
    };

    const onRecordKeyEvent = (event: KeyboardEvent) => {
        const field = recording();
        if (!field) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.key === "Escape") {
            setRecording(null);
            return;
        }
        // Delete / Backspace while recording clears the binding.
        if (event.key === "Delete" || event.key === "Backspace") {
            updateShortcut(field, emptyShortcutBinding());
            setRecording(null);
            setMessage(`已清除「${SHORTCUT_FIELDS.find((item) => item.id === field)?.label ?? field}」快捷键`);
            return;
        }
        const binding = shortcutBindingFromKeyboardEvent(event);
        if (!binding) return;
        // Ignore bare modifier keydowns; wait for a real key.
        if (
            event.key === "Control" ||
            event.key === "Alt" ||
            event.key === "Shift" ||
            event.key === "Meta"
        ) {
            return;
        }
        updateShortcut(field, binding);
        setRecording(null);
        setMessage(`已更新「${SHORTCUT_FIELDS.find((item) => item.id === field)?.label ?? field}」快捷键`);
    };

    onMount(() => {
        window.addEventListener("keydown", onRecordKeyEvent, true);
        window.addEventListener("keyup", onRecordKeyEvent, true);
        onCleanup(() => {
            window.removeEventListener("keydown", onRecordKeyEvent, true);
            window.removeEventListener("keyup", onRecordKeyEvent, true);
        });
    });

    const save = async () => {
        setSaving(true);
        setError(null);
        setMessage(null);
        try {
            const saved = await api.saveAppSettings(settings());
            setSettings(normalizeAppSettings(saved));
            const captureKey = saved.shortcuts.capture.key;
            if (captureKey === "PrintScreen" || captureKey === "Snapshot") {
                setMessage(
                    "设置已保存。若 PrtSc 无效，请到 Windows 设置 → 辅助功能 → 键盘，关闭「使用 Print Screen 键打开屏幕截图」",
                );
            } else {
                setMessage("设置已保存");
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setSaving(false);
        }
    };

    const resetShortcuts = () => {
        const defaults = defaultAppSettings();
        setSettings((prev) => ({
            ...prev,
            shortcuts: defaults.shortcuts,
        }));
        setMessage("快捷键已恢复默认（需点保存生效）");
    };

    const closeWindow = async () => {
        try {
            await getCurrentWindow().close();
        } catch {
            // browser preview
        }
    };

    return (
        <div class="hook-settings-page">
            <header class="hook-settings-titlebar">
                <div>
                    <h1>设置</h1>
                    <p>快捷键、开机自启、全屏热键与截图后工具栏</p>
                </div>
                <button type="button" class="hook-settings-btn ghost" onClick={() => void closeWindow()}>
                    关闭
                </button>
            </header>

            <Show
                when={loading()}
                fallback={
                    <div class="hook-settings-body-content">
                        <section class="hook-settings-card">
                            <h2>通用</h2>
                            <label class="hook-settings-row">
                                <div class="hook-settings-row-text">
                                    <div class="hook-settings-row-title">开机自启</div>
                                    <div class="hook-settings-row-desc">登录 Windows 后自动启动 Hook</div>
                                </div>
                                <span
                                    class="hook-settings-toggle"
                                    classList={{ on: settings().autoStart }}
                                    role="switch"
                                    aria-checked={settings().autoStart}
                                    tabindex="0"
                                    onClick={() =>
                                        setSettings((prev) => ({
                                            ...prev,
                                            autoStart: !prev.autoStart,
                                        }))
                                    }
                                    onKeyDown={(event) => {
                                        if (event.key === " " || event.key === "Enter") {
                                            event.preventDefault();
                                            setSettings((prev) => ({
                                                ...prev,
                                                autoStart: !prev.autoStart,
                                            }));
                                        }
                                    }}
                                >
                                    <span class="hook-settings-toggle-thumb" />
                                </span>
                            </label>
                            <label class="hook-settings-row">
                                <div class="hook-settings-row-text">
                                    <div class="hook-settings-row-title">截图后默认显示工具栏</div>
                                    <div class="hook-settings-row-desc">
                                        开启后，新截图贴图会自动打开顶部编辑工具栏；关闭则保持隐藏
                                    </div>
                                </div>
                                <span
                                    class="hook-settings-toggle"
                                    classList={{ on: settings().stickerToolbarDefaultVisible }}
                                    role="switch"
                                    aria-checked={settings().stickerToolbarDefaultVisible}
                                    tabindex="0"
                                    onClick={() =>
                                        setSettings((prev) => ({
                                            ...prev,
                                            stickerToolbarDefaultVisible: !prev.stickerToolbarDefaultVisible,
                                        }))
                                    }
                                    onKeyDown={(event) => {
                                        if (event.key === " " || event.key === "Enter") {
                                            event.preventDefault();
                                            setSettings((prev) => ({
                                                ...prev,
                                                stickerToolbarDefaultVisible: !prev.stickerToolbarDefaultVisible,
                                            }));
                                        }
                                    }}
                                >
                                    <span class="hook-settings-toggle-thumb" />
                                </span>
                            </label>
                            <label class="hook-settings-row">
                                <div class="hook-settings-row-text">
                                    <div class="hook-settings-row-title">全屏时禁用截图快捷键</div>
                                    <div class="hook-settings-row-desc">
                                        前台窗口全屏（含远程桌面全屏）时不响应截图/长截图全局快捷键，避免误触本机截图
                                    </div>
                                </div>
                                <span
                                    class="hook-settings-toggle"
                                    classList={{ on: settings().disableHotkeysOnFullscreen }}
                                    role="switch"
                                    aria-checked={settings().disableHotkeysOnFullscreen}
                                    tabindex="0"
                                    onClick={() =>
                                        setSettings((prev) => ({
                                            ...prev,
                                            disableHotkeysOnFullscreen: !prev.disableHotkeysOnFullscreen,
                                        }))
                                    }
                                    onKeyDown={(event) => {
                                        if (event.key === " " || event.key === "Enter") {
                                            event.preventDefault();
                                            setSettings((prev) => ({
                                                ...prev,
                                                disableHotkeysOnFullscreen: !prev.disableHotkeysOnFullscreen,
                                            }));
                                        }
                                    }}
                                >
                                    <span class="hook-settings-toggle-thumb" />
                                </span>
                            </label>
                        </section>

                        <section class="hook-settings-card">
                            <div class="hook-settings-section-head">
                                <h2>功能快捷键</h2>
                                <button type="button" class="hook-settings-btn ghost compact" onClick={resetShortcuts}>
                                    恢复默认
                                </button>
                            </div>
                            <p class="hook-settings-hint">
                                点击「录制」后按下新组合键。Esc 取消。录制时按 Delete/Backspace，或点「清除」可取消绑定。
                            </p>
                            <For each={SHORTCUT_FIELDS}>
                                {(field) => (
                                    <div class="hook-settings-row">
                                        <div class="hook-settings-row-text">
                                            <div class="hook-settings-row-title">{field.label}</div>
                                            <div class="hook-settings-row-desc">{field.hint}</div>
                                        </div>
                                        <div class="hook-settings-shortcut-actions">
                                            <kbd
                                                class="hook-settings-shortcut"
                                                classList={{
                                                    recording: recording() === field.id,
                                                    unbound: isShortcutUnbound(settings().shortcuts[field.id]),
                                                }}
                                            >
                                                {recording() === field.id
                                                    ? "按下新快捷键…"
                                                    : formatShortcutBinding(settings().shortcuts[field.id])}
                                            </kbd>
                                            <button
                                                type="button"
                                                class="hook-settings-btn"
                                                classList={{ accent: recording() === field.id }}
                                                onClick={() =>
                                                    setRecording((prev) =>
                                                        prev === field.id ? null : field.id,
                                                    )
                                                }
                                            >
                                                {recording() === field.id ? "取消" : "录制"}
                                            </button>
                                            <button
                                                type="button"
                                                class="hook-settings-btn ghost compact"
                                                disabled={
                                                    recording() === field.id ||
                                                    isShortcutUnbound(settings().shortcuts[field.id])
                                                }
                                                onClick={() => {
                                                    updateShortcut(field.id, emptyShortcutBinding());
                                                    setMessage(`已清除「${field.label}」快捷键`);
                                                }}
                                            >
                                                清除
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </For>
                        </section>

                        <footer class="hook-settings-footer">
                            <Show when={message()}>
                                <span class="hook-settings-message">{message()}</span>
                            </Show>
                            <Show when={error()}>
                                <span class="hook-settings-error">{error()}</span>
                            </Show>
                            <button
                                type="button"
                                class="hook-settings-btn accent"
                                disabled={saving()}
                                onClick={() => void save()}
                            >
                                {saving() ? "保存中…" : "保存"}
                            </button>
                        </footer>
                    </div>
                }
            >
                <div class="hook-settings-loading">加载设置中…</div>
            </Show>
        </div>
    );
};
