import { createSignal } from "solid-js";

export interface PinRect {
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
    name: string; // Debug/Log name
}

// Global signal to track active overlay rects (Logic Pixels)
const [extraRects, setExtraRects] = createSignal<PinRect[]>([]);

const isSameRect = (left: PinRect, right: PinRect) =>
    left.id === right.id &&
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height &&
    left.name === right.name;

export const addOrUpdateRect = (rect: PinRect) => {
    setExtraRects(prev => {
        const idx = prev.findIndex(r => r.id === rect.id);
        if (idx >= 0) {
            if (isSameRect(prev[idx], rect)) {
                return prev;
            }
            // Update existing
            const copy = [...prev];
            copy[idx] = rect;
            return copy;
        }
        // Add new
        return [...prev, rect];
    });
};

export const removeRect = (id: string) => {
    setExtraRects(prev => {
        if (!prev.some(r => r.id === id)) {
            return prev;
        }
        return prev.filter(r => r.id !== id);
    });
};

export { extraRects };
