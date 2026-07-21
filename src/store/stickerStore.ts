import { createStore, unwrap } from "solid-js/store";
import { Sticker, Link } from "../types/stickerModel";
import type { StickerGroup } from "../types/stickerEditing";
import type { StickerEditSnapshot } from "../services/stickerHistory";
import type { FrozenStickerEntry } from "../services/stickerSnapshot";
import {
    buildStickerEditPropagationPatches,
    markStickerEditPropagationLocally,
} from "../services/stickerEditPropagation";
import { scaleStickerEditDataForFrame } from "../services/stickerEditTransforms";
import {
    closeStickerGroupMembers,
    removeStickerGroup,
    toggleStickerGroupHidden,
    toggleStickerGroupLocked,
    upsertStickerGroup,
} from "../services/stickerGroups";

const [stickers, setStickers] = createStore<Sticker[]>([]);
const [links, setLinks] = createStore<Link[]>([]);
const [stickerGroups, setStickerGroups] = createStore<StickerGroup[]>([]);
const [recycleBin, setRecycleBin] = createStore<FrozenStickerEntry[]>([]);
const [referenceLibrary, setReferenceLibrary] = createStore<FrozenStickerEntry[]>([]);

const addSticker = (sticker: Sticker) => {
    setStickers((prev) => [...prev, sticker]);
};

const removeSticker = (id: string) => {
    setStickers((prev) => prev.filter((u) => u.id !== id));
    setLinks((prev) => prev.filter((l) => l.fromUnitId !== id && l.toUnitId !== id));
};

const updateSticker = (id: string, updates: Partial<Sticker>) => {
    setStickers(
        (u) => u.id === id,
        (prev) => ({ ...prev, ...updates }),
    );
};

const updateStickerData = (id: string, updates: Partial<Sticker["data"]>) => {
    const shouldInvalidateDragOutFilePath =
        !Object.prototype.hasOwnProperty.call(updates, "dragOutFilePath") &&
        (
            Object.prototype.hasOwnProperty.call(updates, "src") ||
            Object.prototype.hasOwnProperty.call(updates, "previewSrc") ||
            Object.prototype.hasOwnProperty.call(updates, "filePath") ||
            Object.prototype.hasOwnProperty.call(updates, "rasterizedAnnotationLayerSrc") ||
            Object.prototype.hasOwnProperty.call(updates, "annotationState") ||
            Object.prototype.hasOwnProperty.call(updates, "imageEditState")
        );
    const nextUpdates = shouldInvalidateDragOutFilePath
        ? { ...updates, dragOutFilePath: undefined }
        : updates;

    setStickers(
        (u) => u.id === id,
        "data",
        (prev) => ({ ...prev, ...nextUpdates }),
    );
};

const updateStickerEditData = (
    id: string,
    updates: Partial<Sticker["data"]>,
    options: { markLocalEdit?: boolean } = {},
) => {
    const sticker = stickers.find((item) => item.id === id);
    const nextUpdates: Partial<Sticker["data"]> = { ...updates };

    if (options.markLocalEdit !== false) {
        nextUpdates.stickerEditPropagation = markStickerEditPropagationLocally(
            sticker?.data.stickerEditPropagation,
        );
    }

    updateStickerData(id, nextUpdates);
};

const resizeStickerFrame = (
    id: string,
    frame: Pick<Sticker, "x" | "y" | "w" | "h">,
    options: { propagate?: boolean } = {},
) => {
    const sticker = stickers.find((item) => item.id === id);
    if (!sticker) {
        updateSticker(id, frame);
        return;
    }

    const editUpdates = scaleStickerEditDataForFrame(
        unwrap(sticker.data),
        { w: sticker.w, h: sticker.h },
        frame,
    );
    updateSticker(id, frame);
    if (Object.keys(editUpdates).length > 0) {
        updateStickerEditData(id, editUpdates, { markLocalEdit: false });
    }
    if (options.propagate !== false) {
        propagateStickerEditsFrom(id);
    }
};

const propagateStickerEditsFrom = (sourceStickerId: string) => {
    const patches = buildStickerEditPropagationPatches({
        stickers: unwrap(stickers),
        links: unwrap(links),
        sourceStickerId,
    });
    patches.forEach((patch) => {
        updateStickerData(patch.stickerId, patch.data);
    });
    return patches;
};

const updateStickerWindowState = (
    id: string,
    frame: Pick<Sticker, "x" | "y" | "w" | "h">,
    data: Partial<Sticker["data"]>,
) => {
    updateSticker(id, frame);
    updateStickerData(id, data);
};

const restoreStickerEditSnapshot = (id: string, snapshot: StickerEditSnapshot) => {
    updateSticker(id, snapshot.unitRect);
    updateStickerEditData(
        id,
        {
            annotationState: snapshot.annotationState,
            imageEditState: snapshot.imageEditState,
            ...(snapshot.imageData || {}),
        },
        { markLocalEdit: false },
    );
};

const addOrUpdateStickerGroup = (group: StickerGroup) => {
    setStickerGroups((prev) => upsertStickerGroup(prev, group));
};

const deleteStickerGroup = (groupId: string) => {
    setStickerGroups((prev) => removeStickerGroup(prev, groupId));
};

const setStickerGroup = (stickerId: string, groupId: string | undefined) => {
    updateStickerData(stickerId, { groupId });
};

const setGroupHidden = (groupId: string) => {
    setStickerGroups((prev) => toggleStickerGroupHidden(prev, groupId));
};

const setGroupLocked = (groupId: string) => {
    setStickerGroups((prev) => toggleStickerGroupLocked(prev, groupId));
};

const closeStickerGroup = (groupId: string) => {
    const { removedStickerIds } = closeStickerGroupMembers(stickers, groupId);
    removedStickerIds.forEach((id) => removeSticker(id));
    setStickerGroups((prev) => removeStickerGroup(prev, groupId));
    return removedStickerIds;
};

const addLink = (link: Link) => {
    setLinks((prev) => [...prev, link]);
};

const removeLink = (id: string) => {
    setLinks((prev) => prev.filter((l) => l.id !== id));
};

export const stickerStore = {
    stickers,
    links,
    stickerGroups,
    recycleBin,
    referenceLibrary,
    setStickers,
    setLinks,
    setStickerGroups,
    setRecycleBin,
    setReferenceLibrary,
    actions: {
        addSticker,
        removeSticker,
        updateSticker,
        updateStickerData,
        updateStickerEditData,
        resizeStickerFrame,
        propagateStickerEditsFrom,
        updateStickerWindowState,
        restoreStickerEditSnapshot,
        addOrUpdateStickerGroup,
        deleteStickerGroup,
        setStickerGroup,
        setGroupHidden,
        setGroupLocked,
        closeStickerGroup,
        addLink,
        removeLink,
    },
};
