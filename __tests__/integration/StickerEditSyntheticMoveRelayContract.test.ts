import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const readSource = (relativePath: string) =>
  readFileSync(resolve(process.cwd(), relativePath), "utf8");

const sourceBetween = (source: string, start: string, end: string) => {
  const startIndex = source.indexOf(start);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
};

describe("sticker edit synthetic move relay contract", () => {
  it("keeps a JS target-relay fallback even when native overlay drag move replay is enabled, so synthetic drag streams can still stay attached to the original sticker tool target", () => {
    const appSource = readSource("src/app.tsx");
    const rustSource = readSource("src-tauri/src/lib.rs");
    const globalMoveBlock = sourceBetween(
      appSource,
      "const handleGlobalMouseMove = (e: MouseEvent) => {",
      "const handleGlobalMouseUp = (e: MouseEvent) => {",
    );

    expect(rustSource).toContain("OverlayMove { x: f64, y: f64 }");
    expect(appSource).toContain('"overlay/global_mouse_move"');
    expect(appSource).toContain("let overlaySyntheticMoveRelayActive = false;");
    expect(appSource).toContain("const relayOverlaySyntheticPointerMove = (event: MouseEvent) => {");
    expect(appSource).toContain("overlaySyntheticPointerActive");
    expect(appSource).toContain("overlaySyntheticPrimaryButtonDown");
    expect(appSource).toContain("overlaySyntheticPointerTarget");
    expect(appSource).toContain("new PointerEvent");
    expect(appSource).toContain('new MouseEvent("mousemove"');
    expect(globalMoveBlock).not.toContain("if (overlaySyntheticMoveRelayActive) return;");
    expect(globalMoveBlock).toContain("if (!overlaySyntheticMoveRelayActive) {");
    expect(globalMoveBlock).toContain("relayOverlaySyntheticPointerMove(e);");
    expect(globalMoveBlock).toContain("handleDragMove(e);");
  });
});
