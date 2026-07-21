import { stickerStore } from "../store/stickerStore";
import { linkingState, setLinkingState, setMousePos, setIsSelecting, setHoveringLink } from "../store/uiStore";
import { syncService } from "../services/syncService";
import { calculatePortY } from "../utils/stickerPortUtils";

interface UseLinkingOptions {
    onLinkCreated?: (sourceUnitId: string, targetUnitId: string, targetPortId: string) => void;
}

export function useLinking(options: UseLinkingOptions = {}) {

    const startLinking = (unitId: string, paramId: string, x: number, y: number) => {
        setLinkingState({
            isLinking: true,
            sourceUnitId: unitId,
            sourceParamId: paramId,
            startX: x,
            startY: y
        });
        setIsSelecting(false);
    };

    const handleLinkHover = (sourceId: string, targetId: string | null) => {
        setHoveringLink({ sourceUnitId: sourceId, targetUnitId: targetId });
    };

    const handleInputLinkDrag = (unitId: string, portId: string, e: MouseEvent) => {
        // 1. Check if occupied
        const index = stickerStore.links.findIndex(l => l.toUnitId === unitId && l.toPortId === portId);
        if (index !== -1) {
            const link = stickerStore.links[index];
            const sourceSticker = stickerStore.stickers.find(u => u.id === link.fromUnitId);

            if (sourceSticker) {
                console.log("Re-linking (Moving) from input:", portId, "Source:", sourceSticker.id);

                const startX = sourceSticker.x + sourceSticker.w + (sourceSticker.data.minified ? 0 : 6);
                const startY = calculatePortY(sourceSticker, link.fromPortId, false);

                // 2. Remove existing link using Action
                stickerStore.actions.removeLink(link.id);

                // 3. Start Linking State
                setLinkingState({
                    isLinking: true,
                    sourceUnitId: link.fromUnitId,
                    sourceParamId: link.fromPortId,
                    startX: startX,
                    startY: startY
                });

                setMousePos({ x: e.clientX, y: e.clientY });
            }
        }
    };

    const handleLinkDrop = (targetUnitId: string, targetPortId: string) => {
        const state = linkingState();
        if (state.isLinking && state.sourceUnitId && state.sourceParamId && state.sourceUnitId !== targetUnitId) {
             const sourceId = state.sourceUnitId;

             // Cycle Detection
             const hasCycle = (start: string, end: string) => {
                 const visited = new Set<string>();
                 const queue = [start];
                 visited.add(start);

                 while (queue.length > 0) {
                     const curr = queue.shift()!;
                     if (curr === end) return true;

                     const neighbors = stickerStore.links
                         .filter(l => l.fromUnitId === curr)
                         .map(l => l.toUnitId);

                     for (const n of neighbors) {
                         if (!visited.has(n)) {
                             visited.add(n);
                             queue.push(n);
                         }
                     }
                 }
                 return false;
             };

             if (hasCycle(targetUnitId, sourceId)) {
                 alert("Cyclic dependency detected!");
                 setLinkingState({ isLinking: false, sourceUnitId: null, sourceParamId: null, startX: 0, startY: 0 });
                 return;
             }

             // Create Link
             const newLink = {
                 id: crypto.randomUUID(),
                 fromUnitId: sourceId,
                 fromPortId: state.sourceParamId,
                 toUnitId: targetUnitId,
                 toPortId: targetPortId
             };

             // Remove existing link to this specific input port (Single Input Rule)
             const existing = stickerStore.links.find(l => l.toUnitId === targetUnitId && l.toPortId === targetPortId);
             if (existing) {
                 stickerStore.actions.removeLink(existing.id);
             }

             stickerStore.actions.addLink(newLink);
             options.onLinkCreated?.(sourceId, targetUnitId, targetPortId);
             syncService.scheduleSessionSync();
        }
        setLinkingState({ isLinking: false, sourceUnitId: null, sourceParamId: null, startX: 0, startY: 0 });
    };

    return { startLinking, handleLinkHover, handleInputLinkDrag, handleLinkDrop };
}
