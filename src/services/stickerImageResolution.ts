import type { Link, Sticker } from "../types/stickerModel";

const STICKER_IMAGE_INPUT = "image";

const findConnectedImageInput = (sticker: Sticker, links: readonly Link[]) =>
    links.find((link) => link.toUnitId === sticker.id && link.toPortId === STICKER_IMAGE_INPUT);

export const resolveStickerImage = (input: {
    stickers: readonly Sticker[];
    links: readonly Link[];
    stickerId: string;
    visited?: Set<string>;
}): string | undefined => {
    const visited = input.visited ?? new Set<string>();
    if (visited.has(input.stickerId)) return undefined;
    visited.add(input.stickerId);

    const sticker = input.stickers.find((item) => item.id === input.stickerId);
    if (!sticker) return undefined;

    const connectedInput = findConnectedImageInput(sticker, input.links);
    if (connectedInput) {
        const upstream = resolveStickerImage({
            ...input,
            stickerId: connectedInput.fromUnitId,
            visited,
        });
        if (upstream) return upstream;
    }

    return sticker.data.previewSrc || sticker.data.src;
};
