# Hook Tag Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically publish a GitHub Release zip containing only `hook.exe` whenever a `V*.*.*` tag is pushed.

**Architecture:** Keep the existing development build workflow for ordinary pushes, and add a separate release workflow for version tags. Put zip packaging into a PowerShell helper script so the workflow stays small and the asset contract is testable.

**Tech Stack:** GitHub Actions, PowerShell, Tauri build pipeline, Vitest contract tests, GitHub CLI.

---

### Task 1: Add release workflow contracts

**Files:**
- Create: `<hook-repo-root>\__tests__\integration\HookReleaseWorkflowContract.test.ts`
- Modify: `<hook-repo-root>\__tests__\integration\HookWorkflowCompatibilityContract.test.ts`

- [ ] **Step 1: Write failing workflow release contract test**
- [ ] **Step 2: Run targeted Vitest command and verify the new assertions fail**
- [ ] **Step 3: Tighten existing workflow compatibility assertions if action versions change**
- [ ] **Step 4: Re-run targeted workflow contract tests**

### Task 2: Add minimal zip packaging script

**Files:**
- Create: `<hook-repo-root>\scripts\package-release-zip.ps1`
- Test: `<hook-repo-root>\__tests__\integration\HookReleaseWorkflowContract.test.ts`

- [ ] **Step 1: Add a script that zips only `hook.exe` into `hook-windows-x64-<tag>.zip`**
- [ ] **Step 2: Support deterministic dry-run style inspection where practical**
- [ ] **Step 3: Verify the script contract through the workflow test**

### Task 3: Add dedicated tag release workflow

**Files:**
- Create: `<hook-repo-root>\.github\workflows\release-hook-tag.yml`
- Modify: `<hook-repo-root>\.github\workflows\build-hook-exe.yml`

- [ ] **Step 1: Create a release-only workflow for `V*.*.*` tags**
- [ ] **Step 2: Build `hook.exe`, package the zip, and publish the GitHub Release asset**
- [ ] **Step 3: Restrict the ordinary build workflow to branch pushes if needed to avoid duplicate release-time work**
- [ ] **Step 4: Re-run targeted workflow contract tests**

### Task 4: Verify end-to-end repository state

**Files:**
- Verify only

- [ ] **Step 1: Run `npm run typecheck`**
- [ ] **Step 2: Run targeted workflow contract tests**
- [ ] **Step 3: Run `npm run build`**
- [ ] **Step 4: Inspect the git diff for only intended workflow / script / contract changes**

### Task 5: Deliver

**Files:**
- Verify only

- [ ] **Step 1: Commit with a release-workflow-specific message**
- [ ] **Step 2: Push to `origin/main`**
- [ ] **Step 3: Confirm the ordinary build workflow still triggers cleanly**
- [ ] **Step 4: Report how the user should create the next `Vx.x.x` tag to produce a Release asset**
