import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const workflowSource = readFileSync(
    resolve(process.cwd(), ".github/workflows/build-hook-exe.yml"),
    "utf8",
);

describe("Hook workflow compatibility contract", () => {
    it("does not pin the EXE build workflow to deprecated Node.js 20", () => {
        expect(workflowSource).toContain('uses: actions/setup-node@v4');
        expect(workflowSource).not.toContain('node-version: "20"');
        expect(workflowSource).toContain('node-version: "22"');
    });
});
