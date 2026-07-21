# Hook capture crates

This directory contains Hook-owned capture backend crates imported from the old
top-level `Cap/` source subset.

These crates are not a separate Neuro product. They are local implementation
dependencies for Hook's screenshot and foreground capture backend.

Current imported crates:

- `scap-targets` (Windows-only; macOS Cap platform code was removed)
- `scap-direct3d`

The former `drag` crate path dependency was removed with the OLE
native file-drag surface; sticker drag-out now uses HTML5 DnD plus
`save_sticker_drag_export*`.

`specta` was removed from `scap-targets` — Hook does not generate TypeScript
bindings from these crates.

Keep license/source attribution when changing these crates. If they later become
useful to multiple Neuro programs, move them to a shared capture package through
a separate planned migration.
