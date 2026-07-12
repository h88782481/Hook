import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const readSource = (relativePath: string) =>
  readFileSync(resolve(process.cwd(), relativePath), "utf8");

describe("Hook legacy Escape delete contract", () => {
  it("routes Escape in unit-selected context to the same destructive handler as Delete and Backspace", () => {
    const shortcutsSource = readSource("src/hooks/useShortcuts.ts");

    expect(shortcutsSource).toContain(
      "ShortcutManager.register('delete-escape', handlers.onDelete);",
    );
    expect(shortcutsSource).not.toContain("onEscapeUnitSelected");
    expect(shortcutsSource).not.toContain("handlers.onEscapeUnitSelected");
  });

  it("keeps the selected-unit delete logic shared by Delete, Backspace, frontend Escape, and backend Escape", () => {
    const appSource = readSource("src/app.tsx");

    expect(appSource).toContain("const deleteSelectedUnitOrAnnotation = () =>");
    expect(appSource).toContain("onDelete: deleteSelectedUnitOrAnnotation");
    expect(appSource).toContain("deleteSelectedUnitOrAnnotation();");

    const deleteStart = appSource.indexOf("const deleteSelectedUnitOrAnnotation = () =>");
    const deleteEnd = appSource.indexOf("useShortcuts({", deleteStart);
    const deleteBlock = appSource.slice(deleteStart, deleteEnd);

    expect(deleteStart).toBeGreaterThan(-1);
    expect(deleteEnd).toBeGreaterThan(deleteStart);
    expect(deleteBlock).toContain("removeAnnotationById");
    expect(deleteBlock).toContain("graphStore.actions.removeUnit(id)");
    expect(deleteBlock).toContain("uiActions.clearStickerHistory(id)");
    expect(deleteBlock).toContain("selectionActions.clear()");
    expect(deleteBlock).toContain("uiActions.hideStickerToolbar()");
    expect(deleteBlock).toContain("syncService.updateBackendRects()");
    expect(appSource).toContain("hasActiveStickerEditTarget:");
  });

  it("emits global Escape from the backend so the same selected-unit delete behavior works when the overlay is not focused", () => {
    const rustSource = readSource("src-tauri/src/lib.rs");
    const escapeStart = rustSource.indexOf("rdev::EventType::KeyPress(rdev::Key::Escape)");
    const escapeEnd = rustSource.indexOf("rdev::EventType::MouseMove", escapeStart);
    const escapeBlock = rustSource.slice(escapeStart, escapeEnd);

    expect(escapeStart).toBeGreaterThan(-1);
    expect(escapeEnd).toBeGreaterThan(escapeStart);
    expect(escapeBlock).toContain('window.emit("trigger-escape"');
    expect(escapeBlock).toContain("append_runtime_log_line(\"rdev_escape_triggered\")");
  });

  it("guards global Delete and Backspace so stale selections are not deleted while the user is typing in another app", () => {
    const rustSource = readSource("src-tauri/src/lib.rs");
    const deleteStart = rustSource.indexOf("rdev::EventType::KeyPress(rdev::Key::Delete)");
    const deleteEnd = rustSource.indexOf("rdev::EventType::KeyPress(rdev::Key::Return)", deleteStart);
    const deleteBlock = rustSource.slice(deleteStart, deleteEnd);

    expect(deleteStart).toBeGreaterThan(-1);
    expect(deleteEnd).toBeGreaterThan(deleteStart);
    expect(deleteBlock).toContain("rdev::EventType::KeyPress(rdev::Key::Backspace)");
    expect(deleteBlock).toContain('window.emit("trigger-delete"');
    expect(deleteBlock).toContain("append_runtime_log_line(\"rdev_delete_triggered\")");

    const appSource = readSource("src/app.tsx");
    const dragStart = appSource.indexOf("const onStartDragUnit = (e: MouseEvent, id: string) =>");
    const dragEnd = appSource.indexOf("const resolveUnitImage", dragStart);
    const dragBlock = appSource.slice(dragStart, dragEnd);
    const deleteListenerStart = appSource.indexOf('listen("trigger-delete"');
    const deleteListenerEnd = appSource.indexOf("});", deleteListenerStart);
    const deleteListenerBlock = appSource.slice(deleteListenerStart, deleteListenerEnd);

    expect(appSource).toContain('listen("trigger-delete"');
    expect(appSource).toContain("STICKER_GLOBAL_DELETE_ARM_WINDOW_MS");
    expect(appSource).toContain("let lastStickerKeyboardDeleteArmAt = 0");
    expect(appSource).toContain("const armStickerKeyboardDelete = () =>");
    expect(dragBlock).toContain("armStickerKeyboardDelete();");
    expect(deleteListenerBlock).toContain("Date.now() - lastStickerKeyboardDeleteArmAt");
    expect(deleteListenerBlock).toContain("STICKER_GLOBAL_DELETE_ARM_WINDOW_MS");
    expect(deleteListenerBlock).toContain("trigger-delete-ignored-stale");
    expect(deleteListenerBlock).toContain("deleteSelectedUnitOrAnnotation();");
  });
});
