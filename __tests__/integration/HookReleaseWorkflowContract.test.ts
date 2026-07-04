import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("Hook release workflow contract", () => {
  const workflowPath = resolve(
    process.cwd(),
    ".github/workflows/release-hook-tag.yml",
  );
  const packageScriptPath = resolve(
    process.cwd(),
    "scripts/package-release-zip.ps1",
  );

  it("adds a dedicated tag-triggered GitHub Release workflow", () => {
    expect(existsSync(workflowPath)).toBe(true);

    const workflowSource = readFileSync(workflowPath, "utf8");
    expect(workflowSource).toContain("push:");
    expect(workflowSource).toContain("tags:");
    expect(workflowSource).toContain("- 'V*.*.*'");
    expect(workflowSource).toContain("workflow_dispatch:");
    expect(workflowSource).toContain("contents: write");
    expect(workflowSource).toContain("uses: actions/checkout@v5");
    expect(workflowSource).toContain("uses: actions/setup-node@v6");
    expect(workflowSource).toContain("uses: dtolnay/rust-toolchain@stable");
  });

  it("packages only hook.exe into a versioned zip and publishes it to Releases", () => {
    expect(existsSync(packageScriptPath)).toBe(true);

    const workflowSource = readFileSync(workflowPath, "utf8");
    const packageScriptSource = readFileSync(packageScriptPath, "utf8");

    expect(workflowSource).toContain("package-release-zip.ps1");
    expect(workflowSource).toContain("gh release create");
    expect(workflowSource).toContain("gh release upload");
    expect(workflowSource).toContain("hook-windows-x64-");

    expect(packageScriptSource).toContain("hook.exe");
    expect(packageScriptSource).toContain("hook-windows-x64-");
    expect(packageScriptSource).toContain("Compress-Archive");
    expect(packageScriptSource).not.toContain("start-hook.bat");
    expect(packageScriptSource).not.toContain("start-hook.vbs");
    expect(packageScriptSource).not.toContain("stop-hook.bat");
    expect(packageScriptSource).not.toContain("launch-config.cmd");
  });
});
