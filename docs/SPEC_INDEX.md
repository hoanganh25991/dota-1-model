# Spec Index (Re-implementation)

**Goals and measurable targets** (performance, size, scope): [`input.md`](input.md)

This folder contains the two main specs that describe this project end-to-end:

1. MDX/BLP/animation extraction pipeline:
   - [`MDX_TO_GLB_SPEC.md`](MDX_TO_GLB_SPEC.md)
2. Runtime viewer behavior:
   - [`VIEWER_RUNTIME_SPEC.md`](VIEWER_RUNTIME_SPEC.md)

If you reimplement the project in a different way, start with:
- `MDX_TO_GLB_SPEC.md` to reproduce GLB structure and animation clip timing (includes **when you need BLP/texture files on disk** vs self-contained GLB at runtime)
- `VIEWER_RUNTIME_SPEC.md` to reproduce model loading, centering, camera placement, and playback speed

