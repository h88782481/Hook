import type { Link, Unit } from "../types/unit";

const DEFAULT_IMAGE_INPUTS = ["image", "input"];

const isImageLikePort = (name?: string, type?: string) => {
    const normalizedName = (name || "").toLowerCase();
    const normalizedType = (type || "").toLowerCase();

    return (
        normalizedType.includes("image") ||
        DEFAULT_IMAGE_INPUTS.includes(normalizedName) ||
        normalizedName.endsWith("_image") ||
        normalizedName.endsWith("_file")
    );
};

const isNonEmptyString = (value: string | undefined): value is string =>
    typeof value === "string" && value.length > 0;

const getImageInputNames = (unit: Unit) => {
    const unitInputs =
        unit.inputs
            ?.filter((input) => isImageLikePort(input.id || input.label, input.type))
            .map((input) => input.id || input.label)
            .filter(isNonEmptyString) || [];
    return unitInputs.length > 0 ? unitInputs : ["image"];
};

const findConnectedImageInput = (unit: Unit, links: readonly Link[]) => {
    const imageInputs = new Set(getImageInputNames(unit));
    return links.find((link) => link.toUnitId === unit.id && imageInputs.has(link.toPortId));
};

const imageOutputAliases = new Set(["output", "output_image", "image", "preview"]);

const isImageOutputPort = (unit: Unit, portId: string) => {
    const normalized = portId.toLowerCase();
    if (imageOutputAliases.has(normalized)) return true;
    const unitPort = unit.outputs?.find((port) => port.id === portId || port.label === portId);
    return !!unitPort && isImageLikePort(unitPort.id || unitPort.label, unitPort.type);
};

export const resolveUnitOutputValue = (input: {
    units: readonly Unit[];
    links: readonly Link[];
    unitId: string;
    portId: string;
    visited?: Set<string>;
}): unknown => {
    const visited = input.visited ?? new Set<string>();
    const visitKey = `${input.unitId}:${input.portId}`;
    if (visited.has(visitKey)) return undefined;
    visited.add(visitKey);

    const unit = input.units.find((item) => item.id === input.unitId);
    if (!unit) return undefined;

    if (isImageOutputPort(unit, input.portId)) {
        return resolveUnitImageFromGraph({
            units: input.units,
            links: input.links,
            unitId: input.unitId,
            visited,
        });
    }

    if (unit.data.outputs && Object.prototype.hasOwnProperty.call(unit.data.outputs, input.portId)) {
        return unit.data.outputs[input.portId];
    }

    return undefined;
};

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

    const manualImage = unit.params?.image_path;
    if (typeof manualImage === "string" && manualImage.startsWith("data:")) {
        return manualImage;
    }

    return unit.data.previewSrc || unit.data.src;
};
