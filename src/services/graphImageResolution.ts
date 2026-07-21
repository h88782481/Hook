import type { Link, Unit } from "../types/unit";

const STICKER_IMAGE_INPUT = "image";

const findConnectedImageInput = (unit: Unit, links: readonly Link[]) =>
    links.find((link) => link.toUnitId === unit.id && link.toPortId === STICKER_IMAGE_INPUT);

export const resolveUnitImageFromGraph = (input: {
    units: readonly Unit[];
    links: readonly Link[];
    unitId: string;
    visited?: Set<string>;
}): string | undefined => {
    const visited = input.visited ?? new Set<string>();
    if (visited.has(input.unitId)) return undefined;
    visited.add(input.unitId);

    const unit = input.units.find((item) => item.id === input.unitId);
    if (!unit) return undefined;

    const connectedInput = findConnectedImageInput(unit, input.links);
    if (connectedInput) {
        const upstream = resolveUnitImageFromGraph({
            ...input,
            unitId: connectedInput.fromUnitId,
            visited,
        });
        if (upstream) return upstream;
    }

    return unit.data.previewSrc || unit.data.src;
};
