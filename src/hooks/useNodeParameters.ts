import { graphStore } from "../store/graphStore";
import { syncService } from "../services/syncService";
import { PARAM_ui_resize } from "../constants";

export function useNodeParameters() {
    const handleParamChange = async (
        unitId: string,
        paramId: string,
        value: any,
        isFinal = false,
        triggerSource: "param" | "upstream" | "manual" = "param",
    ) => {
        if (paramId === PARAM_ui_resize) {
            if (value && typeof value === "object" && value.w && value.h) {
                const unit = graphStore.units.find((candidate) => candidate.id === unitId);
                if (unit) {
                    graphStore.actions.resizeStickerFrame(unitId, {
                        x: unit.x,
                        y: unit.y,
                        w: value.w,
                        h: value.h,
                    });
                }
                syncService.updateBackendRects();
                syncService.performWorkflowSync();
            }
            return;
        }

        const hasIncomingValueLink = graphStore.links.some(
            (link) => link.toUnitId === unitId && link.toPortId === paramId,
        );
        const shouldPersistManualParam = !(triggerSource === "upstream" && hasIncomingValueLink);

        if (shouldPersistManualParam) {
            graphStore.setUnitParams(unitId, (prev) => ({ ...(prev || {}), [paramId]: value }));

            if (isFinal) {
                const unit = graphStore.units.find((u) => u.id === unitId);
                if (unit) {
                    graphStore.actions.updateUnit(unitId, { params: { ...unit.params, [paramId]: value } });
                }
            }
        }

        if (!isFinal && triggerSource === "param") {
            return;
        }
        void syncService.performWorkflowSync();
    };

    return { handleParamChange };
}
