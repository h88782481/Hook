import { Component, For, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { Sticker } from "../types/stickerModel";
import { calculatePortOffsetY, MINIFIED_PORT_BOX } from "../utils/stickerPortUtils";

interface StickerPortsProps {
  unit: Sticker;
  portsLayer?: HTMLElement;
  isCleanView: boolean;

  x: number;
  y: number;
  width: number;
  height: number;

  onLinkStart: (propId: string, startX: number, startY: number) => void;
  onLinkDrop: (propId: string) => void;
  onLinkMove?: (portId: string, e: MouseEvent) => void;
}

export const StickerPorts: Component<StickerPortsProps> = (props) => {
  const isMinified = () => !!props.unit.data.minified;
  const getInputs = () => props.unit.inputs;
  const getOutputs = () => props.unit.outputs;
  const portBoxHeight = () => (isMinified() ? MINIFIED_PORT_BOX : props.height);

  return (
        <Show when={props.portsLayer && !props.isCleanView}>
            <Portal mount={props.portsLayer!}>
                    <div
                        class="absolute pointer-events-none"
                        style={{
                            left: `${props.x}px`,
                            top: `${props.y}px`,
                            width: `${isMinified() ? MINIFIED_PORT_BOX : props.width}px`,
                            height: `${portBoxHeight()}px`,
                        }}
                    >
                        <For each={getInputs()}>
                            {(port, index) => {
                                const top = () => calculatePortOffsetY(
                                    isMinified(),
                                    portBoxHeight(),
                                    index(),
                                    getInputs().length,
                                );
                                return (
                                    <div
                                        class="absolute -left-[6px] w-3 h-3 rounded-full bg-[var(--primary)] border border-white/40 pointer-events-auto cursor-crosshair z-20"
                                        style={{ top: `${top()}px`, transform: "translateY(-50%)" }}
                                        title={port.label || port.id}
                                        onMouseDown={(e) => {
                                            e.stopPropagation();
                                            if (props.onLinkMove) {
                                                props.onLinkMove(port.id, e);
                                            }
                                        }}
                                        onMouseUp={(e) => {
                                            e.stopPropagation();
                                            props.onLinkDrop(port.id);
                                        }}
                                    />
                                );
                            }}
                        </For>
                        <For each={getOutputs()}>
                            {(port, index) => {
                                const top = () => calculatePortOffsetY(
                                    isMinified(),
                                    portBoxHeight(),
                                    index(),
                                    getOutputs().length,
                                );
                                return (
                                    <div
                                        class="absolute -right-[6px] w-3 h-3 rounded-full bg-[var(--accent-blue)] border border-white/40 pointer-events-auto cursor-crosshair z-20"
                                        style={{ top: `${top()}px`, transform: "translateY(-50%)" }}
                                        title={port.label || port.id}
                                        onMouseDown={(e) => {
                                            e.stopPropagation();
                                            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                                            props.onLinkStart(port.id, rect.left + rect.width / 2, rect.top + rect.height / 2);
                                        }}
                                    />
                                );
                            }}
                        </For>
                    </div>
            </Portal>
        </Show>
  );
};
