import { Component, createMemo, For, Show } from "solid-js";
import { graphStore } from "../store/graphStore";
import {
    linkingState,
    mousePos,
    hoveringLink,
    multiDragPositions,
    layoutTick,
    isCleanView
} from "../store/uiStore";
import { calculatePortY } from "../utils/graphUtils";

export const CanvasLinks: Component = () => {
    const renderPaths = createMemo(() => {
        layoutTick();

        const list = graphStore.units;
        const currentLinks = graphStore.links;
        const dPositions = multiDragPositions();

        if (isCleanView()) {
            return [];
        }

        return currentLinks.flatMap(link => {
             const sFrom = list.find(s => s.id === link.fromUnitId);
             const sTo = list.find(s => s.id === link.toUnitId);

             if (!sFrom || !sTo) return [];

             const currFrom = (dPositions && dPositions[sFrom.id])
                 ? { ...sFrom, x: dPositions[sFrom.id].x, y: dPositions[sFrom.id].y }
                 : sFrom;

             const currTo = (dPositions && dPositions[sTo.id])
                 ? { ...sTo, x: dPositions[sTo.id].x, y: dPositions[sTo.id].y }
                 : sTo;

             const bodyY1 = calculatePortY(currFrom, link.fromPortId, false);
             const bodyY2 = calculatePortY(currTo, link.toPortId, true);
             const bodyX1 = currFrom.x + currFrom.w + (currFrom.data.minified ? 4 : 6);
             const bodyX2 = currTo.x - (currTo.data.minified ? 4 : 6);

             return [{
                 x1: bodyX1, y1: bodyY1, x2: bodyX2, y2: bodyY2,
                 color: "#9CA3AF"
             }];
        });
    });

    return (
      <svg
        class="absolute inset-0 pointer-events-none z-[60] overflow-visible"
        width="100%"
        height="100%"
      >
        <defs>
            <marker id="arrowhead" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
                <polygon points="0 0, 10 3.5, 0 7" fill="#9CA3AF" />
            </marker>
        </defs>

        <Show when={linkingState().isLinking}>
             <path
                d={`M ${linkingState().startX} ${linkingState().startY} C ${linkingState().startX + 50} ${linkingState().startY}, ${mousePos().x - 50} ${mousePos().y}, ${mousePos().x} ${mousePos().y}`}
                fill="none"
                stroke="#AAC4FF"
                stroke-width="2"
                stroke-dasharray="5,5"
                marker-end="url(#arrowhead)"
             />
        </Show>

        <For each={renderPaths()}>
            {(coords) => (
                <path
                    d={`M ${coords.x1} ${coords.y1} C ${coords.x1 + 50} ${coords.y1}, ${coords.x2 - 50} ${coords.y2}, ${coords.x2} ${coords.y2}`}
                    fill="none"
                    stroke={coords.color}
                    stroke-width="2"
                    marker-end="url(#arrowhead)"
                />
            )}
        </For>

        <Show when={hoveringLink().sourceUnitId && hoveringLink().targetUnitId && !isCleanView()}>
            {(() => {
                const sFrom = graphStore.units.find(u => u.id === hoveringLink().sourceUnitId);
                const sTo = graphStore.units.find(u => u.id === hoveringLink().targetUnitId);
                if (sFrom && sTo) {
                    return (
                        <>
                             <path
                                d={`M ${sFrom.x + sFrom.w / 2} ${sFrom.y + sFrom.h / 2} C ${sFrom.x + sFrom.w / 2 + 50} ${sFrom.y + sFrom.h / 2}, ${sTo.x + sTo.w / 2 - 50} ${sTo.y + sTo.h / 2}, ${sTo.x + sTo.w / 2} ${sTo.y + sTo.h / 2}`}
                                fill="none"
                                stroke="#FACC15"
                                stroke-width="2"
                                stroke-dasharray="8,4"
                                class="animate-pulse"
                            />
                            <rect
                                x={sTo.x - 4}
                                y={sTo.y - 4}
                                width={sTo.w + 8}
                                height={sTo.h + 8}
                                fill="none"
                                stroke="#FACC15"
                                stroke-width="2"
                                stroke-dasharray="8,4"
                                rx="8"
                                class="animate-pulse"
                            />
                        </>
                    );
                }
                return null;
            })()}
        </Show>
      </svg>
    );
};
