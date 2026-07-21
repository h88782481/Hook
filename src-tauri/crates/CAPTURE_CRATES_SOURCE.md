# Capture crates source attribution

The crates in this directory descend from CapSoftware's `scap-*` capture
family (previously vendored under a local `Cap/` tree).

Imported crates:

- `scap-targets`
- `scap-direct3d`

Notes:

- Upstream project family: Cap / CapSoftware
- The Cap `LICENSE` stated that code in the `cap-camera*` and `scap-*`
  families is MIT-licensed
- `scap-direct3d/Cargo.toml` declares `license = "MIT"`

These are Hook-owned implementation dependencies. Keep source attribution
and license metadata intact when modifying them.
