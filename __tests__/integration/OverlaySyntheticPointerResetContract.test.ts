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

describe("overlay synthetic pointer reset contract", () => {
  it("resets frontend synthetic overlay drag state when capture begins and when a global mouse-up finishes interaction, so post-capture sticker drags do not inherit stale locked pointer targets", () => {
    const appSource = readSource("src/app.tsx");
    const resetBlock = sourceBetween(
      appSource,
      "const resetOverlaySyntheticPointerState = () => {",
      "const dispatchSyntheticOverlayMouseEvent = (",
    );
    const beginCaptureBlock = sourceBetween(
      appSource,
      "const beginCaptureSelection = async (mode: CaptureSelectionMode) => {",
      "// Initialization",
    );
    const globalMouseUpBlock = sourceBetween(
      appSource,
      "const handleGlobalMouseUp = (e: MouseEvent) => {",
      "const handleGlobalMouseDown = (e: MouseEvent) => {",
    );
    const dispatchBlock = sourceBetween(
      appSource,
      "const dispatchSyntheticOverlayMouseEvent = (",
      "const relayOverlaySyntheticPointerMove = (event: MouseEvent) => {",
    );

    expect(resetBlock).toContain("overlaySyntheticPointerTarget = null;");
    expect(resetBlock).toContain("overlaySyntheticPointerActive = false;");
    expect(resetBlock).toContain("overlaySyntheticPrimaryButtonDown = false;");
    expect(resetBlock).toContain("overlaySyntheticMoveRelayActive = false;");
    expect(beginCaptureBlock).toContain("resetOverlaySyntheticPointerState();");
    expect(globalMouseUpBlock).toContain("resetOverlaySyntheticPointerState();");
    expect(dispatchBlock).toContain("if (type === \"mousedown\") {");
    expect(dispatchBlock).toContain("resetOverlaySyntheticPointerState();");
  });
});
