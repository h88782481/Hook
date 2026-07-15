# Hook UIAccess Distribution Notes

This document explains why Hook now distinguishes between a **portable** package
and an **installer** package.

## The short version

- **Portable** is still the fastest way to try Hook.
- **Installer** is the recommended package when you need the most stable desktop
  interaction behavior on Windows.

The difference is not cosmetic. It comes from how Windows enforces **UIAccess**
 and foreground-window security rules.

## Why the installer package exists

Hook uses a transparent desktop overlay and needs to stay interactive even when
special Windows foreground windows are active.

One concrete example is **Task Manager**:

- a normal portable Hook build can still work for most everyday capture and
  sticker workflows;
- but when Task Manager is the foreground window, Windows may stop a portable
  build from receiving the same level of input/interaction that the installed
  UIAccess path can keep.

This is a Windows policy boundary, not just a frontend bug.

## Why portable and installer are not equivalent

For Windows to honor a UIAccess desktop application, the executable must be all
of the following:

1. built with a `uiAccess=true` manifest;
2. **digitally signed**;
3. installed into a **trusted location** such as `Program Files`.

Because of that:

- a **portable** package cannot promise the same behavior in every
  foreground/elevation scenario;
- an **installer** package is the correct path for users who want the best
  compatibility in scenarios like Task Manager foreground interaction.

## User-facing guidance

### Installer (recommended)

Choose the installer package when:

- you plan to use Hook as a long-running desktop tool;
- you want the best chance of reliable interaction under special foreground
  windows such as Task Manager;
- you want the binary installed into `Program Files`, which is part of the
  trusted-location requirement for UIAccess.

### Portable

Choose the portable package when:

- you want a no-install trial;
- you only need the ordinary screenshot/sticker workflow quickly;
- you accept that some Windows foreground/elevation combinations may still
  limit interaction.

If you must stay on the portable package and hit one of those Windows
restrictions, a fallback is to try launching Hook as **administrator**. That is
only a fallback, not the preferred long-term distribution model.

## Install and uninstall notes

### Installer / UIAccess package

- install by extracting the installer zip and running `install-hook.ps1` from an
  elevated PowerShell session;
- the helper installs `hook.exe` into `Program Files\yamiyu\Hook`;
- uninstall by closing Hook and removing the installed `Program Files\yamiyu\Hook`
  directory and any shortcuts you created for it.

### Portable package

- install by extracting the zip anywhere you control;
- uninstall by closing Hook and deleting the extracted portable folder.

## Maintainer notes

The repository now treats dual distribution as a first-class release concern:

- **portable zip** is the baseline public artifact;
- **installer zip** is the signed UIAccess-oriented package;
- the installer package stages:
  - `hook.exe`
  - `install-hook.ps1`
  - `install-hook-uiaccess.ps1`

## GitHub Actions requirements

Portable releases can be generated without signing.

Installer/UIAccess releases require a real code-signing certificate in GitHub
Actions. The current workflow contract expects these secrets:

- `HOOK_WINDOWS_UIACCESS_PFX_BASE64`
- `HOOK_WINDOWS_UIACCESS_PFX_PASSWORD`

Without those secrets, GitHub Actions should still produce the portable build,
but the installer/UIAccess release lane must be skipped rather than pretending
that an unsigned loose exe is equivalent.
