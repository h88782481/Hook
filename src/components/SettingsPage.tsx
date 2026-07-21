import { Component, For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "../services/api";
import {
    type AppSettings,
    type ShortcutBinding,
    defaultAppSettings,
    formatShortcutBinding,
    normalizeAppSettings,
    shortcutBindingFromKeyboardEvent,
} from "../services/appSettings";

type ShortcutField = keyof AppSettings["shortcuts"];

const SHORTCUT_FIELDS: Array<{ id: ShortcutField; label: string; hint: string }> = [
    { id: "capture", label: "截图", hint: "全局快捷键，唤起区域截图" },
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

    const updateShortcut = (field: ShortcutField, binding: ShortcutBinding) => {
        setSettings((prev) => ({
            ...prev,
            shortcuts: {
                ...prev.shortcuts,
                [field]: binding,
            },
        }));
    };

    const onRecordKeyDown = (event: KeyboardEvent) => {
        const field = recording();
        if (!field) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.key === "Escape") {
            setRecording(null);
            return;
        }
        const binding = shortcutBindingFromKeyboardEvent(event);
        if (!binding) return;
        updateShortcut(field, binding);
        setRecording(null);
        setMessage(`已更新「${SHORTCUT_FIELDS.find((item) => item.id === field)?.label ?? field}」快捷键`);
    };

    onMount(() => {
        window.addEventListener("keydown", onRecordKeyDown, true);
        onCleanup(() => window.removeEventListener("keydown", onRecordKeyDown, true));
    });

    const save = async () => {
        setSaving(true);
        setError(null);
        setMessage(null);
        try {
            const saved = await api.saveAppSettings(settings());
            setSettings(normalizeAppSettings(saved));
            setMessage("设置已保存");
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
            <header class="hook-settings-header">
                <div>
                    <h1>Hook 设置</h1>
                    <p>自定义快捷键、开机自启与截图后工具栏行为</p>
                </div>
                <button class="hook-terminal-btn px-3 py-1" onClick={() => void closeWindow()}>
                    关闭
                </button>
            </header>

            <Show when={loading()} fallback={
                <div class="hook-settings-body-content">
                    <section class="hook-settings-section">
                        <h2>通用</h2>
                        <label class="hook-settings-row">
                            <div>
                                <div class="hook-settings-row-title">开机自启</div>
                                <div class="hook-settings-row-desc">登录 Windows 后自动启动 Hook</div>
                            </div>
                            <input
                                type="checkbox"
                                checked={settings().autoStart}
                                onChange={(event) =>
                                    setSettings((prev) => ({
                                        ...prev,
                                        autoStart: event.currentTarget.checked,
                                    }))
                                }
                            />
                        </label>
                        <label class="hook-settings-row">
                            <div>
                                <div class="hook-settings-row-title">截图后默认显示工具栏</div>
                                <div class="hook-settings-row-desc">
                                    开启后，新截图贴图会自动打开顶部编辑工具栏；关闭则保持隐藏
                                </div>
                            </div>
                            <input
                                type="checkbox"
                                checked={settings().stickerToolbarDefaultVisible}
                                onChange={(event) =>
                                    setSettings((prev) => ({
                                        ...prev,
                                        stickerToolbarDefaultVisible: event.currentTarget.checked,
                                    }))
                                }
                            />
                        </label>
                    </section>

                    <section class="hook-settings-section">
                        <div class="hook-settings-section-head">
                            <h2>功能快捷键</h2>
                            <button class="hook-terminal-btn px-2 py-0.5" onClick={resetShortcuts}>
                                恢复默认
                            </button>
                        </div>
                        <p class="hook-settings-hint">
                            点击「录制」后按下新组合键。Esc 取消录制。
                        </p>
                        <For each={SHORTCUT_FIELDS}>
                            {(field) => (
                                <div class="hook-settings-row">
                                    <div>
                                        <div class="hook-settings-row-title">{field.label}</div>
                                        <div class="hook-settings-row-desc">{field.hint}</div>
                                    </div>
                                    <div class="hook-settings-shortcut-actions">
                                        <code class="hook-settings-shortcut">
                                            {recording() === field.id
                                                ? "按下新快捷键…"
                                                : formatShortcutBinding(settings().shortcuts[field.id])}
                                        </code>
                                        <button
                                            class="hook-terminal-btn px-2 py-0.5"
                                            onClick={() =>
                                                setRecording((prev) =>
                                                    prev === field.id ? null : field.id,
                                                )
                                            }
                                        >
                                            {recording() === field.id ? "取消" : "录制"}
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
                            class="hook-terminal-btn hook-settings-save px-4 py-1.5"
                            disabled={saving()}
                            onClick={() => void save()}
                        >
                            {saving() ? "保存中…" : "保存设置"}
                        </button>
                    </footer>
                </div>
            }>
                <div class="hook-settings-loading">加载设置中…</div>
            </Show>
        </div>
    );
};
