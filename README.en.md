# Hook

<p align="center">
  <a href="README.md"><strong>简体中文</strong></a>
  ·
  <a href="README.en.md"><strong>English</strong></a>
</p>

<p align="center">
  Open-source Windows desktop screenshot tool.
</p>

<p align="center">
  Maintained by <strong>yamiyu</strong>
</p>

<p align="center">
  <a href="https://github.com/aiaimimi0920/Hook/actions/workflows/release-hook-tag.yml"><img src="https://github.com/aiaimimi0920/Hook/actions/workflows/release-hook-tag.yml/badge.svg" alt="Release Hook Tag" /></a>
  <img src="https://img.shields.io/badge/platform-Windows-0078D6" alt="Windows" />
  <img src="https://img.shields.io/badge/Tauri-v2-24C8DB" alt="Tauri v2" />
  <img src="https://img.shields.io/badge/SolidJS-TypeScript-2C4F7C" alt="SolidJS TypeScript" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-F4EA2A" alt="MIT License" /></a>
</p>

Hook works well for quick capture and light editing.

## Table of contents

- [Why Hook](#why-hook)
- [Core capabilities](#core-capabilities)
- [Release package](#release-package)
- [Contributing](#contributing)
- [License](#license)

## Why Hook

Hook focuses on the gap between a screenshot utility and a heavier design tool:

- you can keep editing and organizing after capture
- stickers, annotations, and reference images can stay in the same desktop workspace
- the recycle bin and reference list make assets reusable
- stickers can be linked so annotations propagate for comparison and transfer

## Core capabilities

- **Capture and long capture**
  - region capture
  - long-capture sessions
  - file-backed capture payloads for desktop performance
- **Sticker and annotation workspace**
  - crop, border, opacity, raster effects, color pick and copy
  - text, numbering, shapes, brush, highlighter
  - recycle bin and reference list
- **Desktop sticker canvas**
  - sticker links, groups, and session sync
  - editing-oriented top toolbar and context menu
  - local startup helpers and single-instance control

## Release package

The only public release is the **portable** zip (unzip and run).

If you hit Windows foreground/elevation limits with special windows such as
**Task Manager**, try launching Hook as **administrator**.

## Contributing

Issues, build feedback, and focused improvement suggestions are welcome:

- Issues: <https://github.com/aiaimimi0920/Hook/issues>
- Local verification: run `npm run verify:local` (typecheck + frontend build). Packaging is handled by GitHub Actions.
- Public bundle identifier: `com.yamiyu.hook`.

## License

MIT

## Friendly Links

- [linux.do](https://linux.do/) Thanks to the promotion from the linux.do community
