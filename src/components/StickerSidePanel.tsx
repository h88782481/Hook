import { Component, Show, createSignal } from "solid-js";
import { Sticker } from "../types/stickerModel";
import { StickerActionsMenu } from "./StickerActionsMenu";
import { stickerStore } from "../store/stickerStore";
import { syncService } from "../services/syncService";

interface StickerSidePanelProps {
  unit: Sticker;
}

export const StickerSidePanel: Component<StickerSidePanelProps> = (props) => {
  const [expanded, setExpanded] = createSignal(false);

  const acceptsUpstreamStickerEditPropagation = () =>
      props.unit.data.stickerEditPropagation?.acceptUpstream ?? true;

  const setAcceptsUpstreamStickerEditPropagation = (acceptUpstream: boolean) => {
      stickerStore.actions.updateStickerData(props.unit.id, {
          stickerEditPropagation: {
              ...props.unit.data.stickerEditPropagation,
              acceptUpstream,
          },
      });
      void syncService.notify({ persist: true });
  };

  return (
    <div class="hook-terminal-shell absolute left-full top-0 ml-2 z-20 flex w-[220px] flex-col overflow-hidden">
      <StickerActionsMenu
        stickerId={props.unit.id}
        expanded={expanded()}
        onToggleExpand={() => setExpanded(!expanded())}
      />
      <Show when={expanded()}>
        <div class="border-t border-white/5 p-3 text-[11px]">
          <label class="flex items-center justify-between gap-2 cursor-pointer">
            <span class="opacity-80">接受上游标注同步</span>
            <input
              type="checkbox"
              class="w-3.5 h-3.5 rounded cursor-pointer"
              style={{ "accent-color": "var(--primary)" }}
              checked={acceptsUpstreamStickerEditPropagation()}
              onChange={(e) => {
                e.stopPropagation();
                setAcceptsUpstreamStickerEditPropagation(e.currentTarget.checked);
              }}
            />
          </label>
        </div>
      </Show>
    </div>
  );
};
