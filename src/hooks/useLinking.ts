import { stickerStore } from "../store/stickerStore";
import { linkingState, setLinkingState, setMousePos, setHoveringLink } from "../store/uiStore";
import { syncService } from "../services/syncService";
import { calculatePortY } from "../utils/stickerPortUtils";

interface UseLinkingOptions {
    onLinkCreated?: (sourceStickerId: string, targetStickerId: string, targetPortId: string) => void;
}

export function useLinking(options: UseLinkingOptions = {}) {

    const startLinking = (stickerId: string, portId: string, x: number, y: number) => {
        setLinkingState({
            isLinking: true,
            sourceStickerId: stickerId,
            sourcePortId: portId,
            startX: x,
            startY: y
        });
    };

    const handleLinkHover = (sourceId: string, targetId: string | null) => {
        setHoveringLink({ sourceStickerId: sourceId, targetStickerId: targetId });
    };

    const handleInputLinkDrag = (stickerId: string, portId: string, e: MouseEvent) => {
        // 1. Check if occupied
        const index = stickerStore.links.findIndex(l => l.toStickerId === stickerId && l.toPortId === portId);
        if (index !== -1) {
            const link = stickerStore.links[index];
            const sourceSticker = stickerStore.stickers.find(u => u.id === link.fromStickerId);

            if (sourceSticker) {
                console.log("Re-linking (Moving) from input:", portId, "Source:", sourceSticker.id);

                const startX = sourceSticker.x + sourceSticker.w + (sourceSticker.data.minified ? 0 : 6);
                const startY = calculatePortY(sourceSticker);

                // 2. Remove existing link using Action
                stickerStore.actions.removeLink(link.id);

                // 3. Start Linking State
                setLinkingState({
                    isLinking: true,
                    sourceStickerId: link.fromStickerId,
                    sourcePortId: link.fromPortId,
                    startX: startX,
                    startY: startY
                });

                setMousePos({ x: e.clientX, y: e.clientY });
            }
        }
    };

    const handleLinkDrop = (targetStickerId: string, targetPortId: string) => {
        const state = linkingState();
        if (state.isLinking && state.sourceStickerId && state.sourcePortId && state.sourceStickerId !== targetStickerId) {
             const sourceId = state.sourceStickerId;

             // Cycle Detection
             const hasCycle = (start: string, end: string) => {
                 const visited = new Set<string>();
                 const queue = [start];
                 visited.add(start);

                 while (queue.length > 0) {
                     const curr = queue.shift()!;
                     if (curr === end) return true;

                     const neighbors = stickerStore.links
                         .filter(l => l.fromStickerId === curr)
                         .map(l => l.toStickerId);

                     for (const n of neighbors) {
                         if (!visited.has(n)) {
                             visited.add(n);
                             queue.push(n);
                         }
                     }
                 }
                 return false;
             };

             if (hasCycle(targetStickerId, sourceId)) {
                 alert("Cyclic dependency detected!");
                 setLinkingState({ isLinking: false, sourceStickerId: null, sourcePortId: null, startX: 0, startY: 0 });
                 return;
             }

             // Create Link
             const newLink = {
                 id: crypto.randomUUID(),
                 fromStickerId: sourceId,
                 fromPortId: state.sourcePortId,
                 toStickerId: targetStickerId,
                 toPortId: targetPortId
             };

             // Remove existing link to this specific input port (Single Input Rule)
             const existing = stickerStore.links.find(l => l.toStickerId === targetStickerId && l.toPortId === targetPortId);
             if (existing) {
                 stickerStore.actions.removeLink(existing.id);
             }

             stickerStore.actions.addLink(newLink);
             options.onLinkCreated?.(sourceId, targetStickerId, targetPortId);
             syncService.notify({ persist: true });
        }
        setLinkingState({ isLinking: false, sourceStickerId: null, sourcePortId: null, startX: 0, startY: 0 });
    };

    return { startLinking, handleLinkHover, handleInputLinkDrag, handleLinkDrop };
}
