# MDX -> GLB Extraction Spec (`scripts/generate-model-manifest.mjs`)

This document specifies how this repo converts **WARCRAFT III MDX** + **texture files on disk** into **GLB** files and `WarcraftModels/manifest.json`. It is meant to stay aligned with `scripts/generate-model-manifest.mjs` so nothing important is missed when reimplementing or auditing the pipeline.

## MDX vs BLP (and other textures): what you need when

| Phase | What you need | Why |
| ----- | --------------- | --- |
| **Authoring / conversion** | **MDX** + **texture files** that the MDX references | The MDX stores **paths** to textures (`model.Textures[].Image`, used by material layers). It does **not** embed full bitmap payloads for typical WC3 assets. The script **reads** `.blp` (or `.png`/`.jpg`/`.jpeg`) from disk at those paths, decodes them, and embeds **PNG bytes** inside the glTF. |
| **After the GLB exists** | **Only the GLB** (and manifest for this app) | The exported GLB is **self-contained** for textures: images are stored as glTF images (PNG). The browser **does not** load `.blp` at runtime. |
| **If a referenced file is missing** | — | That material layer cannot be used; the script skips unresolved layers. End state can be: another layer wins, **fallback** texture (see below), or **no texture** → `alphaClamped = 0` → hidden geoset. |

**Summary:** Keep **BLP (or equivalent images)** in `WarcraftModels/` (or paths resolvable by `resolveTexturePath`) **while converting**. “MDX alone” is enough for geometry and animation data, but **not** for correct albedo unless every referenced texture file is present or you accept fallbacks / hidden materials.

## High-level responsibilities
The script is responsible for:
1. Scanning `WarcraftModels/` for `*.mdx`
2. For each MDX:
   1. Export static geometry (meshes / UVs / normals)
   2. Export a skeleton (bones + helpers as glTF nodes)
   3. Export skinning (vertex groups -> joints/weights)
   4. Export animation clips (MDX Sequences -> glTF animations)
   5. Export materials with texture conversion (BLP → PNG, or raw PNG/JPEG bytes → glTF textures)
3. Writing `WarcraftModels/manifest.json` (model list + category + display names)

## Entry points (CLI)

### Default run
`node scripts/generate-model-manifest.mjs`

Behavior:
- Recursively scans `WarcraftModels/` for `.mdx`
- Converts each MDX to `models/<basename>.glb` unless the target GLB already exists
- Writes `WarcraftModels/manifest.json`

### Single-model conversion
`node scripts/generate-model-manifest.mjs --only <id>`

Behavior:
- Finds a single MDX whose basename (without `.mdx`) equals `<id>`
- Converts it to `models/<basename>.glb`
- Does not rewrite `manifest.json` (unless you run the full script again)

### Notes about unsupported CLI flag
The script parses `--no-manifest` but does not use it to conditionally skip writing.

## Input data model (from `war3-model`)

The converter relies on the MDX parser from `war3-model`:
- `parseMDX(buf)` -> model object
- Textures:
  - `model.Textures[]` includes `Image` paths and `ReplaceableId`
- Materials:
  - `model.Materials[]` includes `Layers[]`
- Geometry:
  - `model.Geosets[]` includes vertex positions, normals, faces, UV sets, vertex group and skin weights
- Skeleton:
  - `model.Bones[]` and `model.Helpers[]` with parent/child relationships and transforms
- Animation:
  - `model.Sequences[]` defines clip intervals
  - Each node has optional animation tracks: `Translation.Keys`, `Rotation.Keys`, `Scaling.Keys`
  - `model.GeosetAnims[]` drives visibility via alpha over time

## Output files
For each MDX file:
- `models/<basename>.glb`

After a full scan:
- `WarcraftModels/manifest.json`
  - `{ "models": [ { id, name, category, path }, ... ] }`

## Folder layout expectations
The script assumes:
- Source MDX files exist under `WarcraftModels/` (may live in subfolders; scan is recursive)
- `ROOT` = repo root; `WC3_MODELS = <ROOT>/WarcraftModels`; `MODELS_OUT = <ROOT>/models`
- Converted GLBs are written to `models/<basename>.glb`
- Texture resolution is performed by searching:
  - relative to the MDX’s folder (`modelDir`)
  - and within `WarcraftModels/` (full normalized path)
  - and `WarcraftModels/<basename(Image)>` (flat fallback when subfolders differ)

## Dependencies (npm)
- `war3-model`: `parseMDX`, `decodeBLP`, `getBLPImageData`
- `upng-js`: encode RGBA → PNG for glTF `image/png` payloads
- `@gltf-transform/core`: `Document`, `NodeIO` — build glTF and write `.glb`

## Core constants

- `WC3_FPS = 30`
  - Used to convert MDX frame intervals into glTF animation clip time in seconds
- `LAYER_TWO_SIDED = 16`
  - Layer shading bit. If present, the material is marked double-sided
- `VIS_ALPHA_EPS = 0.02`
  - For geoset visibility: alpha > eps means visible, otherwise hidden (scale 0)

### Texture alpha handling constants
- `TEXTURE_TRANSPARENT_RATIO_THRESHOLD = 0.01`
  - Defines whether a BLP is considered to contain “enough transparency”
- `TEXTURE_ALPHA_CUTOFF = 0.01`
  - Alpha cutoff used when exporting `alphaMode="MASK"`

## Name and category mapping

### Category inference
`inferCategory(basename)` maps substrings:
- contains `hero` or `dreadlord` or `archmage` -> `Hero`
- contains `portrait` -> `Portrait`
- contains `effect` or `missile` or `spell` -> `Effect`
- contains `particle` or `fire` or `smoke` -> `Particle`
- contains `blood` -> `Blood`
- contains `spirit` or `ghost` -> `Spirit`
- contains `camera` or `cinematic` -> `Cinematic`
- otherwise -> `Unit`

### Display name formatting
`formatName(basename)`:
- `_` -> space
- camelCase boundary -> space
- normalize whitespace and trim

## Texture path resolution
`resolveTexturePath(modelDir, texPath)` tries these candidates:
1. `<modelDir>/<texPath>` (after normalizing `\` -> `/`)
2. `<WC3_MODELS>/<texPath>`
3. `<WC3_MODELS>/<basename(texPath)>`

It returns the first candidate for which `fs.existsSync(candidate)` is true.

## Texture conversion: BLP -> PNG -> glTF texture

### decode/encode steps (`blpToPngBytes`)
Input:
- `blpPath` resolved to an existing `.blp` file

Steps:
1. Read the file into a `Buffer`
2. Decode BLP using `war3-model`:
   - Critical detail: slice the underlying ArrayBuffer correctly
     - `buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)`
3. Extract RGBA pixels using `getBLPImageData(blp, 0)`
4. Determine whether the texture contains transparency:
   - Count pixels where alpha < 255
   - Transparency is considered present if:
     `transparentCount >= ceil(totalPixels * TEXTURE_TRANSPARENT_RATIO_THRESHOLD)`
5. Encode PNG using `upng-js` (pass a **sliced** RGBA buffer: `data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)` so the encoder sees exactly one image’s bytes)
6. Return:
   - `{ pngBytes: Buffer.from(png), hasAlpha: boolean }`
7. On any throw/decode failure: returns `null` (that layer is not usable)

### Non-BLP images
If an MDX layer references `.jpg` / `.jpeg`, the script reads file bytes with `fs.readFileSync` and assumes `imgHasAlpha = false`.

If an MDX layer references `.png`, the script reads file bytes and decodes the PNG (via `upng-js`) to detect whether it contains “enough” transparent pixels, so `alphaMode` can become `MASK` when appropriate.

## Material export

For each `model.Materials[]` entry:
1. Iterate its `layers = mat.Layers || []`
2. While iterating:
   - If `layer.Shading & LAYER_TWO_SIDED`: set `doubleSided = true` for the whole material (any layer can flip this)
3. For each layer, read `texEntry = model.Textures[layer.TextureID]` (default index `0` if missing)
4. Let `texPath = texEntry.Image` trimmed, or empty
5. **If `texPath` is empty:**
   - If `layer.Alpha` is a number, update working `alpha` (so replaceable-only layers can still contribute alpha before fallback)
   - If `texEntry.ReplaceableId > 0`: **continue** (skip this layer; do not invent a texture)
   - Else: **continue** (no image path)
6. **Else** (`texPath` non-empty):
   - `resolved = resolveTexturePath(modelDir, texPath)` — if null, continue
   - By extension:
     - `.blp` → `blpToPngBytes(resolved)`; if null, continue
    - `.png` → read bytes; detect `imgHasAlpha` from PNG transparency for cache
    - `.jpg`/`.jpeg` → read bytes; `imgHasAlpha` stays false for cache
   - **Texture cache:** key = resolved filesystem path string. Value = `{ texture, hasAlpha }`. Reuse if key already present.
   - Set `tex`, `textureHasAlpha`, `selectedLayer`, and `alpha` from the chosen layer; **break** (first winning layer wins)

### Alpha and alphaMode export rules

The base material alpha uses:
- A working `alpha` (default `1`), updated when a layer has no `Image` but has numeric `layer.Alpha`, and when a concrete layer is selected
- `alphaClamped = clamp(alpha, 0..1)`
- If no texture was resolved for the material (even after fallback), it forces `alphaClamped = 0` (geometry hidden)

Then it sets:
- `pbr.setBaseColorFactor([1,1,1,alphaClamped])`
- if texture exists: `pbr.setBaseColorTexture(tex)`
- `pbr.setDoubleSided(true)` if needed

Alpha mode selection:
- If `textureHasAlpha` is true:
  - `alphaMode = "MASK"`
  - `alphaCutoff = TEXTURE_ALPHA_CUTOFF`
- Else:
  - If `alphaClamped < 1`: `alphaMode = "BLEND"`
  - Otherwise: `alphaMode = "OPAQUE"`

### Fallback texture for “empty replaceable-only” materials
Some MDX materials can reference replaceable slots where `Image` is empty.
If no concrete texture was resolved, exporting a material would produce:
- no baseColorTexture
- alphaClamped forced to 0
- invisible mesh portions

To avoid “holes”, the script computes `fallbackTextureImage` once:
`findFallbackTextureImage(model)`:
- returns the first texture where:
  - `t.ReplaceableId === 0`
  - and `t.Image` is non-empty

Then for any material where `tex` is still null:
- it resolves this fallback texture path
- converts it (if `.blp`) or reads bytes (if `.png/.jpg/.jpeg`)
- uses it as the baseColorTexture
- same texture cache rules apply

### What ends up inside the GLB (textures)
- **No `.blp` binaries** are embedded: the converter decodes BLP to RGBA, encodes **PNG**, and stores that in the glTF buffer.
- The script sets the GLTF texture MIME type based on the resolved source:
  - `.blp` and `.png` → `image/png`
  - `.jpg`/`.jpeg` → `image/jpeg`
- **Texture deduplication:** the same resolved path only decodes once; subsequent materials reuse the cached glTF `Texture`.

## Geometry and skinning export

### Bone/node hierarchy
The script uses `collectNodes(model)` to build a deterministic node order:
- Start with all nodes from `model.Bones[]` + `model.Helpers[]`
- Record `ObjectId -> node`
- Recursively traverse parent-child relationships via `Parent` field
- Return a flat array where parents appear before children

For each node:
- Create a glTF node with name `node.Name` or `Node_<i>`
- Initialize bind pose transforms from WC3 `Translation`/`Rotation`/`Scaling` at the earliest keyframe (bind pose), including WC3 pivot correction via `wc3TrsToGltf(...)`.

### Mesh primitive per geoset
For each `model.Geosets[]` entry `g`:
- Build accessors for:
  - positions (VEC3)
  - normals (VEC3)
  - UVs (UV set 0 from `geoset.TVertices[0]`)
  - skin data:
    - joints: VEC4 (Uint16Array)
    - weights: VEC4 (Float32Array)
  - indices: faces array (passed to `.setIndices`)

Create a glTF mesh primitive:
- attributes:
  - `POSITION`
  - `NORMAL`
  - `TEXCOORD_0`
  - `JOINTS_0`
  - `WEIGHTS_0`

Each geoset becomes a glTF node:
- node name `Geoset_<g>`
- `setMesh(mesh)`
- if a skin exists: `setSkin(skin)`
- transform: identity

### Skin creation
If `collected.length > 0`:
- Create a skin
- Add all joints (`skin.addJoint(gltfNodes[i])`)
- Set `skin.skeleton` to the closest common ancestor of joints
- Compute and export `skin.inverseBindMatrices` from bind-pose global joint transforms (required for correct Three.js skinning)

Vertex group to joints/weights:
- `buildSkinData(geoset, boneIndexMap)`
  - reads `geoset.VertexGroup` to map vertex->group
  - uses `geoset.Groups` and optionally `geoset.SkinWeights` to compute up to 4 influences per vertex
  - normalizes weights by their sum when needed

## Animation export

Animations are exported per MDX sequence:
For each `seq` in `model.Sequences[]`:

### Clip interval
- `interval = seq.Interval || Uint32Array([0,0])`
- `startFrame = interval[0]`
- `endFrame = interval[1]`
- If `endFrame <= startFrame`, skip

### Clip name
- `seq.Name` if present, else `Anim_<startFrame>`

### Frame -> time conversion
The script uses:
- `fps = WC3_FPS = 30`
- for `f` from `startFrame` to `endFrame-1`:
  - `timeSeconds = (f - startFrame) / fps`
  - push into `times[]`

Important choice:
- `endFrame` is treated as exclusive, so:
  - clip duration corresponds to `(endFrame - startFrame) / fps`
  - avoids a boundary pop on loop

### Sampling translation/rotation/scaling
For each glTF node (bone/helper) and each frame f:
- Sample:
  - Translation:
    - `sampleAnimVector(node.Translation, f, startFrame, endFrame) ?? bindPoseTranslation`
  - Rotation:
    - `sampleAnimVector(node.Rotation, f, startFrame, endFrame) ?? bindPoseRotation`
  - Scaling:
    - `sampleAnimVector(node.Scaling, f, startFrame, endFrame) ?? bindPoseScale`

If a node has no keys inside a sequence interval, the exporter falls back to the node's bind pose transforms (not identity).

The sampling rule:
- `sampleAnimVector(anim, frame, seqStart, seqEnd)`:
  - filters keyframes with `k.Frame >= seqStart && k.Frame < seqEnd`
  - if keys length is 0: return null
  - if keys length is 1: return that vector
  - otherwise:
    - find surrounding keys and linearly interpolate each component

For `anim.LineType === DontInterp` (line type `0`), the sampler uses step interpolation (previous key wins) instead of blending.

### WC3 -> glTF transform conversion
The script uses node pivot:
- `pivot = node.PivotPoint || [0,0,0]`

Transform conversion uses:
- `wc3TrsToGltf(trans, rot, scale, pivot)`:
  - Computes glTF translation accounting for pivot:
    - `t_gltf = trans + pivot - rotate(rot, pivot)`
  - glTF rotation = WC3 rotation quaternion
  - glTF scale = WC3 scale

### Loop seam fix for skeleton channels
After sampling arrays for a sequence:
- If `frames.length > 1`:
  - it copies the first sample into the last sample for:
    - translation
    - rotation
    - scale

This ensures `LoopRepeat` has no visible pose jump.

### Channel emission decision
To avoid adding empty animation channels:
- it checks whether node has keys inside `[startFrame, endFrame)`:
  - `hasTransInSeq`
  - `hasRotInSeq`
  - `hasScaleInSeq`

Then it creates translation/rotation channels and/or scale channels accordingly.

### Geoset visibility animation
The script supports geoset hide/show driven by `model.GeosetAnims[]`:

Process:
1. Build map `geosetAnimById` using `GeosetId`
2. For each geoset node `Geoset_<g>`:
   - For each sequence frame `f`:
     - `alpha = sampleGeosetAlphaAtFrame(geosetAnim, f)`
     - `s = alpha > VIS_ALPHA_EPS ? 1 : 0`
   - force loop seam by copying first to last
   - if all frames are visible (`allOne === true`), skip emitting the channel
   - otherwise:
     - animate node scale using `setTargetPath('scale')`

Visibility sampling:
- `sampleGeosetAlphaAtFrame(geosetAnim, frame)`:
  - if `geosetAnim` absent: return 1
  - if `geosetAnim.Alpha` is a number: return it
  - if it is keyframed:
    - keys are sorted by `Frame`
    - **single key at global frame `0` with alpha ≤ `0.02`**: treated as a placeholder → return **1** (otherwise a lone key at `0` combined with `frame >= lastKey` made every later frame invisible, e.g. Acolyte)
    - before first key uses a “visibility based on >0.5” rule
    - between keys does linear interpolation
    - **after last key**: only when **more than one** key exists; hold the last key’s value (single-key tails use the interpolation loop / hold above)

## Manifest writing

After converting a full scan:
- For each MDX file discovered:
  - `basename = path.basename(mdxPath, '.mdx')`
  - `entry = { id: basename, name: formatName(basename), category: inferCategory(basename), path: 'models/<basename>.glb' }`

Skip optimization:
- If `models/<basename>.glb` already exists:
  - it does not reconvert
  - but still includes the entry in the manifest

### Failure handling (batch mode)
- Each `convertMdxToGlb` call is wrapped in `try/catch`.
- On failure: logs `Failed <basename>: <message>` to stderr; that model is **not** added to the manifest array for that run (entries already skipped due to existing GLB are still pushed).

### Empty `WarcraftModels/`
- If the directory does not exist, it is created and an **empty** `manifest.json` is written (`{ "models": [] }`), then the script exits early.

## MDX parse and GLB write

### `parseMDX`
- Input: `fs.readFileSync(mdxPath)` → `parseMDX(buf.buffer)` from `war3-model`.
- On parse error: throws; caught in `main` for batch mode.

### GLB serialization
- `const io = new NodeIO(); await io.write(outPath, doc);`
- Writes a standard binary glTF (`.glb`) containing the built `Document`.

## Implementation map (functions in `generate-model-manifest.mjs`)

| Symbol | Role |
| ------ | ---- |
| `inferCategory`, `formatName` | Manifest metadata |
| `resolveTexturePath` | Locate texture files on disk |
| `blpToPngBytes` | BLP → PNG + `hasAlpha` flag |
| `sampleAnimVector` | Keyframe sampling inside a sequence window |
| `sampleGeosetAlphaAtFrame`, `mapGeosetAnimsByGeosetId` | Geoset visibility animation |
| `findFallbackTextureImage` | First non-replaceable texture path for fallback |
| `rotateByQuat`, `wc3TrsToGltf` | WC3 bone TRS → glTF node TRS |
| `collectNodes` | Bone/helper hierarchy flattening |
| `buildSkinData` | Geoset → `JOINTS_0` / `WEIGHTS_0` |
| `convertMdxToGlb` | Full MDX → glTF document → `.glb` |
| `main` | CLI, scan, batch / `--only`, manifest |
| `writeManifest` | `JSON.stringify` to `WarcraftModels/manifest.json` |

## Related docs
- Runtime (load GLB, camera, playback): [`VIEWER_RUNTIME_SPEC.md`](VIEWER_RUNTIME_SPEC.md)
- Index: [`SPEC_INDEX.md`](SPEC_INDEX.md)

