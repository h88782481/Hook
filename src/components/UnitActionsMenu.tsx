import { Component } from "solid-js";

interface UnitActionsMenuProps {
  unitId: string;
  expanded: boolean;
  onToggleExpand: () => void;
}

export const UnitActionsMenu: Component<UnitActionsMenuProps> = (props) => {
  return (
    <div
        class="hook-actions-shell h-[50px] min-h-[50px] w-full z-10 relative flex overflow-hidden"
        style={{
            "flex-shrink": 0
        }}
    >
        <div
            class="min-w-0 flex items-center justify-start overflow-hidden relative"
            style={{ flex: 3 }}
        >
                <div class="absolute right-0 top-3 bottom-3 w-[1px] bg-white/5"></div>
            <div class="hook-actions-shell__title ml-3 max-w-[calc(100%-24px)]">
                <span class="hook-actions-shell__dot"></span>
                <span
                    class="font-bold text-[10px] uppercase tracking-widest text-shadow-sm whitespace-nowrap truncate"
                    style={{ color: "inherit" }}
                >
                    Image <span class="opacity-50 ml-0.5">#{props.unitId.slice(-4)}</span>
                </span>
            </div>
        </div>

        <div
            class="min-w-0 flex h-full border-l border-white/5"
            style={{ flex: 1 }}
        >
            <button
                class="hook-terminal-btn group relative h-full w-full cursor-pointer flex items-center justify-center transition-all"
                onClick={(e) => {
                    e.stopPropagation();
                    props.onToggleExpand();
                }}
                onMouseDown={(e) => e.stopPropagation()}
                onMouseUp={(e) => e.stopPropagation()}
                onDblClick={(e) => e.stopPropagation()}
                title="展开设置"
            >
                <div class="absolute inset-0 bg-white/5 opacity-0 group-hover:opacity-100 transition-opacity"></div>
                <svg
                    class="w-4 h-4 transition-transform group-hover:text-white"
                    style={{ transform: props.expanded ? "rotate(180deg)" : "rotate(0deg)" }}
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                >
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 5l7 7m0 0l-7 7m7-7H3"/>
                </svg>
            </button>
        </div>
    </div>
  );
};
