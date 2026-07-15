# Hook Maintainer Signing Guide

This document is maintainer-facing. It complements the public policy documents:

- `docs/CODE_SIGNING_POLICY.md`
- `docs/PRIVACY_POLICY.md`
- `UIACCESS_DISTRIBUTION.md`
- `docs/SIGNPATH_APPLICATION_CHECKLIST.md`
- `docs/SIGNPATH_APPLICATION_DRAFT.md`

Its purpose is to keep Hook ready for SignPath Foundation review or another
Windows signing provider without relying on tribal memory.

For a pre-filled application-oriented working sheet, use
`docs/SIGNPATH_APPLICATION_CHECKLIST.md`.

For fuller copy-ready English submission answers, use
`docs/SIGNPATH_APPLICATION_DRAFT.md`.

## Current release model

Hook currently maintains two Windows release lanes:

1. **portable**
   - baseline public artifact
   - useful for normal trial and daily screenshot workflows
2. **installer / UIAccess-oriented**
   - intended for trusted-location installation
   - requires real signing material before publication

## Public docs that must stay in sync

Before applying for or maintaining a signing program, keep these docs current:

- `README.md`
- `README.zh-CN.md`
- `UIACCESS_DISTRIBUTION.md`
- `docs/CODE_SIGNING_POLICY.md`
- `docs/PRIVACY_POLICY.md`
- `docs/README.md`

## SignPath-oriented readiness checklist

### Repository hygiene

- public repository is active and not an empty placeholder
- OSI-approved license is present
- release tags and release assets are visible
- public docs explain what the product does and how packages differ

### Maintainer account hygiene

- GitHub maintainer accounts use MFA
- signing-provider accounts use MFA
- only intended approvers can approve signing requests

### Policy hygiene

- code signing policy is public
- privacy policy is public
- installer behavior and uninstall path are documented

### Release hygiene

- signed artifacts come from hosted CI, not ad-hoc local rebuilds
- the installer lane is skipped when signing material is absent
- release notes do not blur portable and installer/UIAccess semantics

## Current GitHub workflow contract

The repository workflows already distinguish:

- portable build/publication
- UIAccess installer build/publication

The current secret contract is the PFX-compatible fallback model:

- `HOOK_WINDOWS_UIACCESS_PFX_BASE64`
- `HOOK_WINDOWS_UIACCESS_PFX_PASSWORD`

If the project later moves to SignPath Foundation, DigiCert, SSL.com, Azure
Artifact Signing, or another hosted signer, the workflow can change while the
public policy documents remain largely the same.

## Maintainer approval checklist for a signed release

Before approving a signed release:

1. confirm the tag matches the intended public version;
2. confirm the workflow ran from the correct repository and tag;
3. confirm the signed artifact belongs only to the installer/UIAccess lane;
4. confirm README and UIAccess docs still describe package differences
   accurately;
5. confirm no local hotfix binary was manually substituted into the release;
6. confirm the public privacy and code-signing documents are still accurate.

## If Hook uses SignPath Foundation

Additional operating reminders:

- expect manual approval in the release flow;
- keep release provenance obvious from the public GitHub repo;
- avoid undocumented side-loading of binaries;
- be prepared for the publisher name to reflect the signing provider rather than
  the Hook brand alone.

## If Hook uses a commercial provider instead

The same governance still applies:

- keep the public policy docs;
- keep release approvals manual for signed Windows installer output;
- do not weaken the distinction between portable and trusted installer builds.
