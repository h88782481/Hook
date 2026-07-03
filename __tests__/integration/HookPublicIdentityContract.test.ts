import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const tauriConfig = JSON.parse(
    readFileSync(resolve(process.cwd(), "src-tauri/tauri.conf.json"), "utf8"),
);
const rustSource = readFileSync(resolve(process.cwd(), "src-tauri/src/lib.rs"), "utf8");
const readmeSource = readFileSync(resolve(process.cwd(), "README.md"), "utf8");
const architectureSource = readFileSync(
    resolve(process.cwd(), "TECHNICAL_ARCHITECTURE.md"),
    "utf8",
);

describe("Hook public identity contract", () => {
    it("uses the yamiyu company Tauri identifier without changing the visible product name", () => {
        expect(tauriConfig.identifier).toBe("com.yamiyu.hook");
        expect(tauriConfig.productName).toBe("hook");
    });

    it("keeps legacy app-data fallbacks so older local installs retain user state", () => {
        expect(rustSource).toContain('const LEGACY_TAURI_IDENTIFIERS: &[&str] = &["io.github.aiaimimi0920.hook", "com.vmjcv.hook"];');
        expect(rustSource).toContain("fn legacy_app_data_dirs_from_current");
        expect(rustSource).toContain("fn resolve_effective_app_data_dir");
        expect(rustSource).toContain("fn effective_app_data_dir");
        expect(rustSource).toContain("app_data_dir_contains_user_state");
    });

    it("documents the split between public bundle identity and local compatibility paths", () => {
        expect(readmeSource).toContain("com.yamiyu.hook");
        expect(readmeSource).toContain("io.github.aiaimimi0920.hook");
        expect(readmeSource).toContain("com.vmjcv.hook");
        expect(architectureSource).toContain("com.yamiyu.hook");
        expect(architectureSource).toContain("io.github.aiaimimi0920.hook");
        expect(architectureSource).toContain("com.vmjcv.hook");
        expect(readmeSource).toContain("yamiyu");
    });
});
