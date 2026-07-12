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

describe("overlay real drag preference contract", () => {
  it("keeps ordinary sticker drags on real DOM mouse events once the overlay is already interactive, and only uses synthetic overlay drag replay while click-through is still active", () => {
    const rustSource = readSource("src-tauri/src/lib.rs");
    const hookProcBlock = sourceBetween(
      rustSource,
      "unsafe extern \"system\" fn capture_mouse_hook_proc",
      "fn install_capture_mouse_hook_thread",
    );
    const downBlock = sourceBetween(
      hookProcBlock,
      "WM_LBUTTONDOWN => {",
      "WM_LBUTTONUP => {",
    );
    const moveBlock = sourceBetween(
      hookProcBlock,
      "WM_MOUSEMOVE => {",
      "WM_LBUTTONDOWN => {",
    );
    const showOverlayBlock = sourceBetween(
      rustSource,
      "fn show_overlay_host_impl",
      "fn set_overlay_click_through_impl",
    );
    const clickThroughBlock = sourceBetween(
      rustSource,
      "fn set_overlay_click_through_impl",
      "fn set_overlay_capture_exclusion_impl",
    );

    expect(rustSource).toContain("static OVERLAY_CLICK_THROUGH_ACTIVE: AtomicBool = AtomicBool::new(true);");
    expect(rustSource).toContain("static OVERLAY_MOUSE_HOOK_SYNTHETIC_DRAG_ACTIVE: AtomicBool = AtomicBool::new(false);");
    expect(rustSource).toContain("let overlay_click_through = OVERLAY_CLICK_THROUGH_ACTIVE.load(Ordering::SeqCst);");
    expect(downBlock).toContain("OVERLAY_MOUSE_HOOK_SYNTHETIC_DRAG_ACTIVE");
    expect(downBlock).toContain("if overlay_click_through {");
    expect(downBlock).toContain("CaptureMouseHookEvent::OverlayDown");
    expect(moveBlock).toContain("OVERLAY_MOUSE_HOOK_SYNTHETIC_DRAG_ACTIVE.load(Ordering::SeqCst)");
    expect(moveBlock).not.toContain("OVERLAY_MOUSE_HOOK_DRAG_ACTIVE.load(Ordering::SeqCst)");
    expect(showOverlayBlock).toContain("OVERLAY_CLICK_THROUGH_ACTIVE.store(click_through, Ordering::SeqCst);");
    expect(clickThroughBlock).toContain("OVERLAY_CLICK_THROUGH_ACTIVE.store(click_through, Ordering::SeqCst);");
  });
});
