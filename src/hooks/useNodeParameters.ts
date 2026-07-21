import { graphStore } from "../store/graphStore";
import { syncService } from "../services/syncService";
import { deriveUnitExecutionConfig } from "../services/nodeExecutionConfig";
import {
    PARAM_ui_resize,
    EXEC_PREFIX,
    EXEC_expanded,
    EXEC_upstreamDriven,
    EXEC_paramDriven,
    EXEC_listenUpstream,
    EXEC_notifyDownstream,
    EXEC_manualTrigger
} from "../constants";

export function useNodeParameters() {

    const handleParamChange = async (
        unitId: string,
        paramId: string,
        value: any,
        isFinal = false,
        triggerSource: "param" | "upstream" | "manual" = "param",
    ) => {
        // --- Handle UI Resize (Special Case) ---
        if (paramId === PARAM_ui_resize) {
            if (value && typeof value === 'object' && value.w && value.h) {
                console.log(`[UI Action] Resize unit ${unitId} to`, value);
                const unit = graphStore.units.find((candidate) => candidate.id === unitId);
                if (unit?.type === "sticker") {
                    graphStore.actions.resizeStickerFrame(unitId, {
                        x: unit.x,
                        y: unit.y,
                        w: value.w,
                        h: value.h,
                    });
                } else {
                    graphStore.actions.updateUnit(unitId, {
                        w: value.w,
                        h: value.h
                    });
                }
                syncService.updateBackendRects();
                syncService.performWorkflowSync();
            }
            return;
        }

        // --- Handle Execution Config Params (UI-only, no backend dispatch) ---
        if (paramId.startsWith(EXEC_PREFIX)) {
            // Initialize executionConfig if not present
            if (!graphStore.unitExecConfig[unitId]) {
                const unit = graphStore.units.find(u => u.id === unitId);
                const artCap = unit && graphStore.capabilities.find(c => c.id === unit.artId);
                const existingConfig = unit?.data?.executionConfig;

                graphStore.setUnitExecConfig(unitId, deriveUnitExecutionConfig({
                    capability: artCap || undefined,
                    explicitConfig: existingConfig,
                }));
            }

            // Update the specific field using path-based update (fine-grained reactivity)
            switch (paramId) {
                case EXEC_expanded:
                    graphStore.setUnitExecConfig(unitId, "__expanded", value);
                    break;
                case EXEC_upstreamDriven:
                    graphStore.setUnitExecConfig(unitId, "triggerMode", "upstreamDriven", value);
                    break;
                case EXEC_paramDriven:
                    graphStore.setUnitExecConfig(unitId, "triggerMode", "paramDriven", value);
                    break;
                case EXEC_listenUpstream:
                    graphStore.setUnitExecConfig(unitId, "propagation", "listenUpstream", value);
                    break;
                case EXEC_notifyDownstream:
                    graphStore.setUnitExecConfig(unitId, "propagation", "notifyDownstream", value);
                    break;
                case EXEC_manualTrigger:
                    console.log(`[Execution] Manual trigger for unit ${unitId}`);
                    graphStore.setUnitParams(unitId, (prev) => ({ ...(prev || {}), ["force_update"]: value }));
                    break;
            }

            // 2. MIRROR TO UNIT DATA & PERSIST
            // We must update unit.data.executionConfig so it's included in the sync snapshot
            const newConfig = { ...graphStore.unitExecConfig[unitId] };
            graphStore.actions.updateUnitData(unitId, { executionConfig: newConfig });

            // 3. SYNC TO BACKEND
            syncService.performWorkflowSync();

            if (paramId !== EXEC_manualTrigger) return;
        }

        const hasIncomingValueLink = graphStore.links.some(
            (link) => link.toUnitId === unitId && link.toPortId === paramId,
        );
        const shouldPersistManualParam = !(triggerSource === "upstream" && hasIncomingValueLink);

        // 1. Optimistic Update (UI Store). Upstream-linked updates are derived values,
        // so keep the manual fallback untouched and resolve the effective value later.
        if (shouldPersistManualParam) {
            graphStore.setUnitParams(unitId, (prev) => ({ ...(prev || {}), [paramId]: value }));

            if (isFinal) {
                 const unit = graphStore.units.find(u => u.id === unitId);
                 if (unit) {
                      // Important: Update the persisted logic.
                      graphStore.actions.updateUnit(unitId, { params: { ...unit.params, [paramId]: value } });
                 }
            }
        }

        // Keep local params only; remote ArtLoom / shader execution has been removed.
        if (!isFinal && triggerSource === "param") {
            return;
        }
        void syncService.performWorkflowSync();
    };

    return { handleParamChange };
}
