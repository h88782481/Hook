import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const rustSource = readFileSync(resolve(process.cwd(), "src-tauri/src/lib.rs"), "utf8");

const sliceFunctionBlock = (startMarker: string, endMarker: string) => {
    const start = rustSource.indexOf(startMarker);
    const end = rustSource.indexOf(endMarker, start);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    return rustSource.slice(start, end);
};

describe("capture focus preservation contract", () => {
    it("does not force Hook to take foreground focus when entering region capture mode", () => {
        const block = sliceFunctionBlock("fn enter_capture_mode", "fn enter_long_capture_mode");

        expect(block).toContain("show_overlay_host_impl(window, true);");
        expect(block).not.toContain("window.set_focus()");
    });

    it("does not force Hook to take foreground focus when entering long capture mode", () => {
        const block = sliceFunctionBlock("fn enter_long_capture_mode", "fn encode_rgb_image_as_capture_response");

        expect(block).toContain("show_overlay_host_impl(window, true);");
        expect(block).not.toContain("window.set_focus()");
    });
});
