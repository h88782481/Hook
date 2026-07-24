import { Component, Show } from "solid-js";
import {
    isBoxSelecting,
    selectionRect,
    longCaptureSession,
} from "../store/uiStore";

/** Box-select marquee + long-capture status chip. Region capture UI lives in the
 *  native softbuffer window now — nothing WebView-based for screenshot drag. */
export const CanvasSelection: Component = () => {
    return (
      <>
      <Show when={longCaptureSession()}>
        {(session) => (
            <Show when={session().status === "capturing" || session().status === "stitching"}>
                <div
                    class="hook-capture-chip absolute z-[110] pointer-events-none px-2 py-1 text-[11px] font-semibold"
                    style={{
                        left: `${session().rect.x}px`,
                        top: session().rect.y >= 32
                            ? `${session().rect.y - 30}px`
                            : `${session().rect.y + session().rect.h + 8}px`,
                    }}
                >
                    {session().status === "stitching"
                        ? "长截图拼接中…"
                        : `长截图区域 ${Math.round(session().rect.w)} x ${Math.round(session().rect.h)}`}
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
