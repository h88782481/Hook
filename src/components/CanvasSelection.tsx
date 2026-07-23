import { Component, Show } from "solid-js";
import {
    isSelecting,
    isBoxSelecting,
    selectionRect,
    preciseRect,
    captureMode,
    longCaptureSession,
} from "../store/uiStore";

/** Solid dim panels around the selection hole — cheaper than a full-window
 *  semi-transparent WebView layer (ShareX / Snipaste style). */
const CAPTURE_DIM = "rgba(0, 0, 0, 0.45)";

export const CanvasSelection: Component = () => {
    return (
      <>
      <Show when={isSelecting()}>
        <div class="absolute inset-0 z-[100] pointer-events-none">
            <Show
                when={selectionRect()}
                fallback={
                    <div
                        class="absolute inset-0"
                        style={{ "background-color": CAPTURE_DIM }}
                    />
                }
            >
                {(rect) => (
                    <>
                        {/* Top */}
                        <div
                            class="absolute left-0 top-0 right-0"
                            style={{
                                height: `${Math.max(0, rect().y)}px`,
                                "background-color": CAPTURE_DIM,
                            }}
                        />
                        {/* Bottom */}
                        <div
                            class="absolute left-0 right-0 bottom-0"
                            style={{
                                top: `${rect().y + rect().h}px`,
                                "background-color": CAPTURE_DIM,
                            }}
                        />
                        {/* Left */}
                        <div
                            class="absolute left-0"
                            style={{
                                top: `${rect().y}px`,
                                width: `${Math.max(0, rect().x)}px`,
                                height: `${Math.max(0, rect().h)}px`,
                                "background-color": CAPTURE_DIM,
                            }}
                        />
                        {/* Right */}
                        <div
                            class="absolute right-0"
                            style={{
                                top: `${rect().y}px`,
                                left: `${rect().x + rect().w}px`,
                                height: `${Math.max(0, rect().h)}px`,
                                "background-color": CAPTURE_DIM,
                            }}
                        />

                        <div
                            class="absolute border-2 border-primary"
                            style={{
                                left: `${rect().x}px`,
                                top: `${rect().y}px`,
                                width: `${rect().w}px`,
                                height: `${rect().h}px`,
                            }}
                        >
                            <div class="hook-capture-chip absolute -top-7 left-0 px-2 py-1 font-mono text-[11px] font-semibold">
                                <span>{Math.round(rect().w)} x {Math.round(rect().h)}</span>
                                <Show when={captureMode() === "long"}>
                                    <span class="hook-capture-chip__tag px-1.5 py-[1px] text-[10px] font-semibold">长截图</span>
                                </Show>
                            </div>
                        </div>

                        <Show when={preciseRect()}>
                            <div
                                class="absolute border-2 border-dashed z-[101] pointer-events-none"
                                style={{
                                    left: `${preciseRect()!.x}px`,
                                    top: `${preciseRect()!.y}px`,
                                    width: `${preciseRect()!.w}px`,
                                    height: `${preciseRect()!.h}px`,
                                    "border-color": "#FFFF00",
                                    "background-color": "rgba(255, 255, 0, 0.3)",
                                }}
                            />
                        </Show>
                    </>
                )}
            </Show>
        </div>
      </Show>

      <Show when={longCaptureSession()}>
        {(session) => (
            <Show when={session().status === "capturing"}>
                <div
                    class="hook-capture-chip absolute z-[110] pointer-events-none px-2 py-1 text-[11px] font-semibold"
                    style={{
                        left: `${session().rect.x}px`,
                        top: session().rect.y >= 32 ? `${session().rect.y - 30}px` : `${session().rect.y + session().rect.h + 8}px`,
                    }}
                >
                    长截图区域 {Math.round(session().rect.w)} x {Math.round(session().rect.h)}
                </div>
            </Show>
        )}
      </Show>

      <Show when={isBoxSelecting() && selectionRect()}>
          <div
              class="absolute border z-[100] pointer-events-none"
              style={{
                  left: `${selectionRect()!.x}px`,
                  top: `${selectionRect()!.y}px`,
                  width: `${selectionRect()!.w}px`,
                  height: `${selectionRect()!.h}px`,
                  "border-color": "rgba(217, 255, 56, 0.92)",
                  "background-color": "rgba(217, 255, 56, 0.1)",
              }}
          />
      </Show>
    </>
    );
};
