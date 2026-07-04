import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const workflowSource = readFileSync(
    resolve(process.cwd(), ".github/workflows/build-hook-exe.yml"),
    "utf8",
);

describe("Hook workflow compatibility contract", () => {
    it("uses node24-compatible GitHub official action versions", () => {
        expect(workflowSource).toContain('uses: actions/checkout@v5');
        expect(workflowSource).toContain('uses: actions/setup-node@v6');
        expect(workflowSource).toContain('uses: actions/upload-artifact@v6');
        expect(workflowSource).not.toContain('uses: actions/checkout@v4');
        expect(workflowSource).not.toContain('uses: actions/setup-node@v5');
        expect(workflowSource).not.toContain('uses: actions/setup-node@v4');
        expect(workflowSource).not.toContain('uses: actions/upload-artifact@v4');
        expect(workflowSource).not.toContain('node-version: "20"');
        expect(workflowSource).toContain('node-version: "22"');
    });

    it("keeps the ordinary Hook build workflow scoped to main branch pushes", () => {
        expect(workflowSource).toContain("push:");
        expect(workflowSource).toContain("branches:");
        expect(workflowSource).toContain("- main");
        expect(workflowSource).not.toContain("tags:");
    });
});
