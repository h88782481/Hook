import { createSignal } from "solid-js";
import { parseClampedInt } from "./math";

/**
 * Shared string draft for deferred numeric inputs (blur/Enter commit).
 * Display falls back to the live value while the user is not typing.
 */
export const createClampedDraft = () => {
    const [draft, setDraft] = createSignal<string | null>(null);

    return {
        set: setDraft,
        display: (fallback: number | string) => draft() ?? String(fallback),
        commit: (fallback: number, min: number, max: number, apply: (next: number) => void) => {
            const next = parseClampedInt(draft(), fallback, min, max);
            setDraft(null);
            if (next !== fallback) apply(next);
        },
    };
};
