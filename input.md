# Requirements: Runtime MDX+BLP Renderer (WASM + Three.js)

## Goal
Render Warcraft 3 MDX models with their referenced BLP textures **at runtime in the browser** (no GLB export / no GLTF conversion step), using:
- **WASM (Rust)** for MDX parsing and BLP decoding (performance + fewer binary parsing bugs)
- **Three.js** for WebGL rendering, skinning, and animation playback

Correctness must match the existing spec contract:
- `docs/MDX_TO_GLB_SPEC.md`
- `docs/VIEWER_RUNTIME_SPEC.md` (behavioral expectations for animation + framing)

## Constraints / Assumptions
1. The browser viewer currently loads `WarcraftModels/manifest.json` and fetches `models/<id>.glb` via `GLTFLoader`.
2. Three.js does not natively load `.mdx` or `.blp`; therefore a custom runtime loader is required.
3. Runtime mode must still support the same animation playback UX (clip selection + looping) and the same WC3-like timing assumptions used in the exporter.

## Deliverables
1. New runtime entry JS file (separate from the GLB viewer):
   - `js/viewer_runtime.js`
2. WASM build output + JS glue:
   - `pkg/war3_codec/` (or similar wasm-pack output folder)
   - includes `pkg/..._bg.wasm` and the wasm-bindgen JS glue
3. Runtime-compatible manifest fields:
   - update `WarcraftModels/manifest.json` generation so each model row includes enough information to fetch the source `.mdx` and resolve texture paths.
4. Runtime loader module(s):
   - `js/runtime/mdx_loader.js` (or equivalent) that converts parsed MDX data into Three.js objects.
   - `js/runtime/blp_loader.js` (or equivalent) that creates `THREE.Texture` from decoded BLP pixels.

## Architecture (High Level)
### A) Browser runtime flow
1. Fetch `WarcraftModels/manifest.json`
2. When user selects a model in the UI:
   - fetch `.mdx` bytes from `WarcraftModels/<relative-mdx-path>.mdx`
   - decode MDX into structured model data (WASM output)
3. For each material layer:
   - fetch referenced `.blp` bytes from disk (using MDX texture path + resolver)
   - decode BLP -> RGBA pixels (WASM output)
   - create Three.js textures and assign them to materials
4. Build scene graph:
   - create bones/helpers hierarchy (glTF-like node order) using MDX skeleton data
   - build a skinned mesh per geoset (geometry + `JOINTS_0`/`WEIGHTS_0`)
   - animate bones via `THREE.AnimationMixer` and `AnimationClip`s (sampling and loop seam fix)
   - animate geoset visibility by scaling geoset nodes based on `model.GeosetAnims`

### B) WASM responsibilities (Rust)
Provide exported functions (via `wasm-bindgen`) for:
1. `decode_blp_to_rgba(blpBytes: Uint8Array, mipLevel: u32) -> { width, height, rgbaBytes, hasAlpha }`
2. `parse_mdx(mdxBytes: Uint8Array) -> structured data for:
   - bones/helpers and parent relationships
   - geosets: positions/normals/uvs/faces, vertex group indices, skin weights, material indices
   - materials/layers: texture IDs, shading flags (two-sided), alpha parameters
   - sequences: translation/rotation/scaling keys with frame ranges
   - geoset animations for visibility alpha over frames

Important: runtime sampling and alpha rules must follow `docs/MDX_TO_GLB_SPEC.md` exactly.

## Manifest Requirements
The manifest must include runtime fields per model. Keep backward compatibility if possible.

At minimum, add:
1. `mdxPath`: relative URL from the site root to the source MDX file (e.g. `WarcraftModels/<relative>.mdx`)
2. (Optional but strongly recommended) `modelDir` or `mdxBaseDir`:
   - the MDX directory used for texture path resolution

## Spec Compliance Requirements (Must Match)
### 1) Texture alpha handling
1. BLP transparency detection uses the same threshold logic as `blpToPngBytes`:
   - transparency present if `transparentCount >= ceil(totalPixels * TEXTURE_TRANSPARENT_RATIO_THRESHOLD)`
2. Materials export rules follow:
   - base color factor alpha and `alphaMode` selection
   - `alphaMode = MASK` when `textureHasAlpha` is true
   - `alphaCutoff = TEXTURE_ALPHA_CUTOFF`
   - otherwise `alphaMode = BLEND` when alphaClamped < 1, else `OPAQUE`

### 2) Animation sampling
1. Convert frames to clip-relative time with:
   - `fps = 30`
   - `timeSeconds = (f - startFrame) / fps`
2. The sequence end frame is treated as **exclusive** (`f < endFrame`).
3. Interpolation only occurs between surrounding keys sorted by `Frame`.
4. Loop seam fix:
   - for each sampled channel, copy the first sample to the last sample (translation/rotation/scale)

### 3) Geoset visibility animation
1. For each geoset node, drive scale based on geoset alpha:
   - `s = alpha > VIS_ALPHA_EPS ? 1 : 0`
2. If geoset visibility is constant for all frames, skip emitting that visibility animation.
3. Apply loop seam fix to visibility scale samples as well.

## UI/Viewer Integration Requirements
1. Add a separate JS file so the existing GLB viewer remains unchanged:
   - `js/viewer_runtime.js`
2. The runtime viewer must provide:
   - category/model filtering using the same manifest fields
   - animation clip buttons/select
   - same animation speed slider behavior
3. Ensure the viewer forces evaluation at time 0 before centering:
   - call mixer time update / update(1e-4) before camera framing
4. Cleanup/dispose logic:
   - dispose geometries, materials, and textures when switching models

## MVP Scope (Order)
1. MVP-1: Single MDX load with textures
   - MDX parsing + geosets rendering + textures visible
2. MVP-2: Skeleton + skinning correctness
   - bind pose correct, vertices deform with one test sequence
3. MVP-3: Animations
   - bone translation/rotation/scale channels via sampled clips
   - loop seam fix visible on a looping animation
4. MVP-4: Geoset visibility (alpha -> scale)
   - models that hide/show geosets (e.g. death/decay gibs) behave as expected

## Acceptance Criteria
1. Runtime mode loads at least one real model from `WarcraftModels/` with visible geometry and correct textures.
2. At least one long animation clip plays without obvious time offset vs the GLB exporter (based on frame sampling behavior).
3. Loop seam fix works (no visible pose snap at loop boundary).
4. At least one model that relies on geoset visibility shows/hides the correct parts during animation.
5. Switching models disposes old GPU resources (no runaway memory growth).

## Non-Goals (for MVP)
1. Perfect parity for every material edge-case that exists in the exporter (unless it breaks visibility/animations).
2. Supporting every niche MDX feature not covered by `docs/MDX_TO_GLB_SPEC.md`.

