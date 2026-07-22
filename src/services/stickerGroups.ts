import type { StickerGroup } from "../types/stickerEditing";
import type { Sticker } from "../types/stickerModel";

export const upsertStickerGroup = (groups: StickerGroup[], nextGroup: StickerGroup): StickerGroup[] => {
    const existing = groups.find((group) => group.id === nextGroup.id);
    if (!existing) {
        return [...groups, nextGroup];
    }

    return groups.map((group) => (group.id === nextGroup.id ? { ...group, ...nextGroup } : group));
};

export const removeStickerGroup = (groups: StickerGroup[], groupId: string): StickerGroup[] =>
    groups.filter((group) => group.id !== groupId);

export const closeStickerGroupMembers = (units: Sticker[], groupId: string) => {
    const removedStickerIds = units
        .filter((unit) => unit.data.groupId === groupId)
        .map((unit) => unit.id);

    return {
        remainingStickers: units.filter((unit) => unit.data.groupId !== groupId),
        removedStickerIds,
    };
};
