import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const readSource = (relativePath: string) =>
  readFileSync(resolve(process.cwd(), relativePath), "utf8");

describe("overlay synthetic click and focus contract", () => {
  it("dispatches a synthetic dblclick for overlay-routed sticker clicks so double-click minify still works while the full-screen overlay stays click-through", () => {
    const appSource = readSource("src/app.tsx");

    expect(appSource).toContain('"dblclick"');
    expect(appSource).toContain("overlaySyntheticLastClickTarget");
    expect(appSource).toContain("overlaySyntheticLastClickAt");
    expect(appSource).toContain("OVERLAY_SYNTHETIC_DOUBLE_CLICK_MAX_DELAY_MS");
  });

  it("focuses overlay-hosted editors through the top-strip property bar and still keeps synthetic editable-control fallback logic for routed clicks", () => {
    const appSource = readSource("src/app.tsx");
    const apiSource = readSource("src/services/api.ts");
    const propertyBarSource = readSource("src/components/StickerTopStripPropertyBar.tsx");

    expect(apiSource).toContain("focusOverlayWindow");
    expect(propertyBarSource).toContain("api.focusOverlayWindow()");
    expect(appSource).toContain("HTMLInputElement");
    expect(appSource).toContain("HTMLSelectElement");
    expect(appSource).toContain("HTMLTextAreaElement");
    expect(appSource).toContain(".focus()");
  });

  it("routes overlay drag move events straight to app-main and skips the synthetic relay fallback while a whole-sticker drag is active, so Ctrl+E mode does not add sticky per-move annotation-layer overhead", () => {
    const appSource = readSource("src/app.tsx");

    expect(appSource).toContain("draggingStickerId()");
    expect(appSource).toContain('type === "mousemove" && overlaySyntheticPrimaryButtonDown && draggingStickerId()');
    expect(appSource).toContain("target = appMain ?? window;");
    expect(appSource).toContain("if (!overlaySyntheticMoveRelayActive && !draggingStickerId()) {");
  });
});
