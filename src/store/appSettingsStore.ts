import { createSignal } from "solid-js";
import type { AppSettings } from "../services/appSettings";
import { defaultAppSettings } from "../services/appSettings";

const [appSettings, setAppSettings] = createSignal<AppSettings>(defaultAppSettings());

export { setAppSettings };

export const stickerToolbarDefaultVisible = () =>
    appSettings().stickerToolbarDefaultVisible;
