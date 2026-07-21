import { Component, For, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { Unit } from "../types/unit";

interface UnitPortsProps {
  unit: Unit;
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

export const UnitPorts: Component<UnitPortsProps> = (props) => {
  const isMinified = () => !!props.unit.data.minified;

  const getInputs = () => [{ name: "image", label: "Image", type: "image" }];
  const getOutputs = () => [{ name: "output_image", label: "Image", type: "image" }];

  const isPortVisible = (portName: string) => {
      const userVis = props.unit.data.portVisibility?.[portName];
      if (typeof userVis === "boolean") return userVis;
      return true;
  };

  const getVisibleInputs = () => getInputs().filter((p) => isPortVisible(p.name));
  const getVisibleOutputs = () => getOutputs().filter((p) => isPortVisible(p.name));

  return (
        <Show when={props.portsLayer && !props.isCleanView}>
            <Portal mount={props.portsLayer!}>
                    <div
                        class="absolute pointer-events-none"
                        style={{
                            left: `${props.x}px`,
                            top: `${props.y}px`,
                            width: `${isMinified() ? 60 : props.width}px`,
                            height: `${isMinified() ? 60 : props.height}px`,
                        }}
                    >
                        <For each={getVisibleInputs()}>
                            {(port, index) => {
                                const top = () => {
                                    if (isMinified()) {
                                        const step = 60 / getVisibleInputs().length;
                                        return index() * step + step / 2;
                                    }
                                    return 36 + index() * 36;
                                };
                                return (
                                    <div
                                        class="absolute -left-[6px] w-3 h-3 rounded-full bg-[var(--primary)] border border-white/40 pointer-events-auto cursor-crosshair z-20"
                                        style={{ top: `${top()}px`, transform: "translateY(-50%)" }}
                                        title={port.label || port.name}
                                        onMouseDown={(e) => {
                                            e.stopPropagation();
                                            if (props.onLinkMove) {
                                                props.onLinkMove(port.name, e);
                                            }
                                        }}
                                        onMouseUp={(e) => {
                                            e.stopPropagation();
                                            props.onLinkDrop(port.name);
                                        }}
                                    />
                                );
                            }}
                        </For>
                        <For each={getVisibleOutputs()}>
                            {(port, index) => {
                                const top = () => {
                                    if (isMinified()) {
                                        const step = 60 / getVisibleOutputs().length;
                                        return index() * step + step / 2;
                                    }
                                    return 36 + index() * 36;
                                };
                                return (
                                    <div
                                        class="absolute -right-[6px] w-3 h-3 rounded-full bg-[var(--accent-blue)] border border-white/40 pointer-events-auto cursor-crosshair z-20"
                                        style={{ top: `${top()}px`, transform: "translateY(-50%)" }}
                                        title={port.label || port.name}
                                        onMouseDown={(e) => {
                                            e.stopPropagation();
                                            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                                            props.onLinkStart(port.name, rect.left + rect.width / 2, rect.top + rect.height / 2);
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
