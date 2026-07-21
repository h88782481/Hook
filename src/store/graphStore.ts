import { createStore, unwrap } from "solid-js/store";
import { Unit, Link } from "../types/unit";
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

const [units, setUnits] = createStore<Unit[]>([]);
const [links, setLinks] = createStore<Link[]>([]);
const [stickerGroups, setStickerGroups] = createStore<StickerGroup[]>([]);
const [recycleBin, setRecycleBin] = createStore<FrozenStickerEntry[]>([]);
const [referenceLibrary, setReferenceLibrary] = createStore<FrozenStickerEntry[]>([]);

const addUnit = (unit: Unit) => {
    setUnits((prev) => [...prev, unit]);
};

const removeUnit = (id: string) => {
    setUnits((prev) => prev.filter((u) => u.id !== id));
    setLinks((prev) => prev.filter((l) => l.fromUnitId !== id && l.toUnitId !== id));
};

const updateUnit = (id: string, updates: Partial<Unit>) => {
    setUnits(
        (u) => u.id === id,
        (prev) => ({ ...prev, ...updates }),
    );
};

const updateUnitData = (id: string, updates: Partial<Unit["data"]>) => {
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

    setUnits(
        (u) => u.id === id,
        "data",
        (prev) => ({ ...prev, ...nextUpdates }),
    );
};

const updateStickerEditData = (
    id: string,
    updates: Partial<Unit["data"]>,
    options: { markLocalEdit?: boolean } = {},
) => {
    const unit = units.find((item) => item.id === id);
    const nextUpdates: Partial<Unit["data"]> = { ...updates };

    if (options.markLocalEdit !== false) {
        nextUpdates.stickerEditPropagation = markStickerEditPropagationLocally(
            unit?.data.stickerEditPropagation,
        );
    }

    updateUnitData(id, nextUpdates);
};

const resizeStickerFrame = (
    id: string,
    frame: Pick<Unit, "x" | "y" | "w" | "h">,
    options: { propagate?: boolean } = {},
) => {
    const unit = units.find((item) => item.id === id);
    if (!unit) {
        updateUnit(id, frame);
        return;
    }

    const editUpdates = scaleStickerEditDataForFrame(
        unwrap(unit.data),
        { w: unit.w, h: unit.h },
        frame,
    );
    updateUnit(id, frame);
    if (Object.keys(editUpdates).length > 0) {
        updateStickerEditData(id, editUpdates, { markLocalEdit: false });
    }
    if (options.propagate !== false) {
        propagateStickerEditsFrom(id);
    }
};

const propagateStickerEditsFrom = (sourceUnitId: string) => {
    const patches = buildStickerEditPropagationPatches({
        units: unwrap(units),
        links: unwrap(links),
        sourceUnitId,
    });
    patches.forEach((patch) => {
        updateUnitData(patch.unitId, patch.data);
    });
    return patches;
};

const updateStickerWindowState = (
    id: string,
    frame: Pick<Unit, "x" | "y" | "w" | "h">,
    data: Partial<Unit["data"]>,
) => {
    updateUnit(id, frame);
    updateUnitData(id, data);
};

const restoreStickerEditSnapshot = (id: string, snapshot: StickerEditSnapshot) => {
    updateUnit(id, snapshot.unitRect);
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

const setUnitGroup = (unitId: string, groupId: string | undefined) => {
    updateUnitData(unitId, { groupId });
};

const setGroupHidden = (groupId: string) => {
    setStickerGroups((prev) => toggleStickerGroupHidden(prev, groupId));
};

const setGroupLocked = (groupId: string) => {
    setStickerGroups((prev) => toggleStickerGroupLocked(prev, groupId));
};

const closeStickerGroup = (groupId: string) => {
    const { removedUnitIds } = closeStickerGroupMembers(units, groupId);
    removedUnitIds.forEach((id) => removeUnit(id));
    setStickerGroups((prev) => removeStickerGroup(prev, groupId));
    return removedUnitIds;
};

const addLink = (link: Link) => {
    setLinks((prev) => [...prev, link]);
};

const removeLink = (id: string) => {
    setLinks((prev) => prev.filter((l) => l.id !== id));
};

export const graphStore = {
    units,
    links,
    stickerGroups,
    recycleBin,
    referenceLibrary,
    setUnits,
    setLinks,
    setStickerGroups,
    setRecycleBin,
    setReferenceLibrary,
    actions: {
        addUnit,
        removeUnit,
        updateUnit,
        updateUnitData,
        updateStickerEditData,
        resizeStickerFrame,
        propagateStickerEditsFrom,
        updateStickerWindowState,
        restoreStickerEditSnapshot,
        addOrUpdateStickerGroup,
        deleteStickerGroup,
        setUnitGroup,
        setGroupHidden,
        setGroupLocked,
        closeStickerGroup,
        addLink,
        removeLink,
    },
};
