# Hook Tag Release Design

## Goal

When a tag matching `V*.*.*` is pushed to the Hook repository, GitHub Actions should automatically:

1. build the Windows `hook.exe`
2. package a minimal zip that contains only `hook.exe`
3. create or update a GitHub Release for that tag
4. upload the zip as the release asset

Normal development pushes must keep using the existing CI build workflow and must not depend on the release workflow.

## Approved approach

Use **Scheme B**:

- keep the current `build-hook-exe.yml` workflow for ordinary development builds
- add a dedicated release workflow that only runs on `V*.*.*` tag pushes

## Release contract

### Trigger

- `push.tags: ['V*.*.*']`

### Release type

- immediately publish a normal GitHub Release
- do not create a draft

### Release asset

- exactly one zip asset
- zip contains only:
  - `hook.exe`

### Asset naming

- `hook-windows-x64-<tag>.zip`
- example:
  - `hook-windows-x64-V0.0.1.zip`

## Workflow boundaries

### Existing workflow

`/.github/workflows/build-hook-exe.yml`

- continues to build and upload Actions artifacts for day-to-day development
- should not be responsible for creating GitHub Releases
- branch pushes should stay supported

### New workflow

`/.github/workflows/release-hook-tag.yml`

- runs only for release tags
- builds the executable on `windows-latest`
- produces a minimal zip
- publishes the GitHub Release asset

## Implementation details

### Packaging

Add a dedicated PowerShell packaging script in `scripts/` so packaging logic is shared and explicit instead of being inlined in workflow YAML.

Expected behavior:

- input: built `hook.exe` path, output directory, tag name
- output: zip file named `hook-windows-x64-<tag>.zip`
- zip root contains only `hook.exe`

### Release publishing

Use a dedicated GitHub Release action in the workflow:

- if the release for the tag does not exist:
  - create it
  - attach the zip asset
- if it already exists:
  - update the release and replace the asset

This avoids brittle shell-driven release upload logic and keeps the release asset contract declarative inside workflow YAML.

### Permissions

The release workflow must request:

- `contents: write`

## Testing strategy

Add repository contract tests that verify:

1. the new release workflow exists
2. it triggers only on `V*.*.*` tags
3. it uses supported action versions
4. it creates the expected asset name
5. it publishes through a dedicated GitHub Release action with the expected minimal zip input

Also verify the packaging script directly if it exposes a dry-run or deterministic output contract.

## Non-goals

- no MSI / installer generation
- no portable multi-file release bundle
- no draft release approval step
- no cross-platform release assets
