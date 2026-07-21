# Hook capture crates

Local capture backends used by Hook's screenshot and foreground capture path.

| Crate | Role |
|-------|------|
| `scap-targets` | Windows display / window enumeration (Windows-only) |
| `scap-direct3d` | Windows Graphics Capture + D3D11 capture backend |

Attribution for the CapSoftware / `scap-*` lineage lives in
[`CAPTURE_CRATES_SOURCE.md`](./CAPTURE_CRATES_SOURCE.md). Keep license and
source notes intact when modifying these crates.
