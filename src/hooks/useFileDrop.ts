import { onMount, onCleanup } from "solid-js";
import { stickerStore } from "../store/stickerStore";
import { syncService } from "../services/syncService";
import { createSticker } from "../types/stickerModel";

const SUPPORTED_IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".bmp"];

const isSupportedImageFile = (file: File) => {
    if (file.type.startsWith("image/")) {
        return true;
    }

    const lowerName = file.name.toLowerCase();
    return SUPPORTED_IMAGE_EXTENSIONS.some((extension) => lowerName.endsWith(extension));
};

const readFileAsDataUrl = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error ?? new Error("Failed to read dropped file"));
        reader.onload = () => {
            if (typeof reader.result === "string") {
                resolve(reader.result);
                return;
            }
            reject(new Error("Dropped file did not produce a data URL"));
        };
        reader.readAsDataURL(file);
    });

export function useFileDrop() {
    onMount(() => {
        const handleDragOver = (e: DragEvent) => {
            const files = e.dataTransfer?.files;
            if (!files || files.length === 0) {
                return;
            }

            e.preventDefault();
            if (e.dataTransfer) {
                e.dataTransfer.dropEffect = "copy";
            }
        };

        const handleDrop = async (e: DragEvent) => {
            const files = e.dataTransfer?.files;
            if (!files || files.length === 0) {
                return;
            }

            e.preventDefault();

            const file = files[0];
            if (!file || !isSupportedImageFile(file)) {
                console.log("Dropped file is not a supported image:", file?.name);
                return;
            }

            try {
                const base64Src = await readFileAsDataUrl(file);
                const mx = e.clientX;
                const my = e.clientY;

                const allStickers = stickerStore.stickers;
                let hitUnitId: string | null = null;

                for (let i = allStickers.length - 1; i >= 0; i--) {
                    const u = allStickers[i];
                    if (!u.data.minified &&
                        mx >= u.x && mx <= u.x + u.w &&
                        my >= u.y && my <= u.y + u.h) {
                        hitUnitId = u.id;
                        break;
                    }
                }

                if (hitUnitId) {
                    stickerStore.actions.updateStickerData(hitUnitId, {
                        previewSrc: base64Src,
                    });

                    window.setTimeout(() => {
                        void syncService.scheduleSessionSync();
                    }, 50);
                    return;
                }

                const newSticker = createSticker({
                    x: mx - 100,
                    y: my - 100,
                    w: 200,
                    h: 200,
                    data: {
                        src: base64Src,
                        minified: false,
                    },
                });

                stickerStore.actions.addSticker(newSticker);
                void syncService.updateBackendRects();
            } catch (error) {
                console.error("File Drop Failed:", error);
            }
        };

        window.addEventListener("dragover", handleDragOver);
        window.addEventListener("drop", handleDrop);

        onCleanup(() => {
            window.removeEventListener("dragover", handleDragOver);
            window.removeEventListener("drop", handleDrop);
        });
    });
}
