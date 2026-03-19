# MDX -> GLB Extraction Spec (`scripts/generate-model-manifest.mjs`)

This document specifies how this repo converts **Warcraft 3 MDX** + **BLP textures** into **GLB** files and `WarcraftModels/manifest.json`.

## High-level responsibilities
The script is responsible for:
1. Scanning `WarcraftModels/` for `*.mdx`
2. For each MDX:
   1. Export static geometry (meshes / UVs / normals)
   2. Export a skeleton (bones + helpers as glTF nodes)
   3. Export skinning (vertex groups -> joints/weights)
   4. Export animation clips (MDX Sequences -> glTF animations)
   5. Export materials with BLP texture conversion (BLP -> PNG -> glTF textures)
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
- Source MDX files exist under `WarcraftModels/`
- Converted GLBs are placed into `models/`
- Texture resolution is performed by searching:
  - relative to the MDX folder
  - and within `WarcraftModels/`

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
5. Encode PNG using `upng-js`
6. Return:
   - `{ pngBytes: Buffer.from(png), hasAlpha: boolean }`

### Non-BLP images
If an MDX layer references `.png` / `.jpg` / `.jpeg`, the script reads bytes directly and uses them as an image payload.

## Material export

For each `model.Materials[]` entry:
1. Iterate its `layers = mat.Layers || []`
2. Select the first layer whose:
   - resolves to an existing file
   - and is decodable/convertible into `imgBytes`
   - and is a usable texture type (BLP or image extension supported)
3. Also compute:
   - `doubleSided` if any layer has `layer.Shading & LAYER_TWO_SIDED`

### Replaceable texture skip rule
The converter treats replaceable slots (e.g. team colors / variants) carefully:
- If `texEntry.Image` is missing and `texEntry.ReplaceableId > 0`, that layer is skipped
- If `texEntry.Image` is missing and `ReplaceableId === 0`, that layer is effectively ignored by the “resolved texture” requirement

### Alpha and alphaMode export rules

The base material alpha uses:
- `alphaClamped = clamp(layer.Alpha, 0..1)`
- If no texture was resolved for the material, it forces `alphaClamped = 0` (geometry hidden)

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

## Geometry and skinning export

### Bone/node hierarchy
The script uses `collectNodes(model)` to build a deterministic node order:
- Start with all nodes from `model.Bones[]` + `model.Helpers[]`
- Record `ObjectId -> node`
- Recursively traverse parent-child relationships via `Parent` field
- Return a flat array where parents appear before children

For each node:
- Create a glTF node with name `node.Name` or `Node_<i>`
- Initialize bind pose transforms:
  - translation: `[0,0,0]`
  - rotation: `[0,0,0,1]`
  - scale: `[1,1,1]`

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
    - `sampleAnimVector(node.Translation, f, startFrame, endFrame) ?? [0,0,0]`
  - Rotation:
    - `sampleAnimVector(node.Rotation, f, startFrame, endFrame) ?? [0,0,0,1]`
  - Scaling:
    - `sampleAnimVector(node.Scaling, f, startFrame, endFrame) ?? [1,1,1]`

The sampling rule:
- `sampleAnimVector(anim, frame, seqStart, seqEnd)`:
  - filters keyframes with `k.Frame >= seqStart && k.Frame < seqEnd`
  - if keys length is 0: return null
  - if keys length is 1: return that vector
  - otherwise:
    - find surrounding keys and linearly interpolate each component

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
    - before first key uses a “visibility based on >0.5” rule
    - between keys does linear interpolation

## Manifest writing

After converting a full scan:
- For each MDX file discovered:
  - `basename = path.basename(mdxPath, '.mdx')`
  - `entry = { id: basename, name: formatName(basename), category: inferCategory(basename), path: 'models/<basename>.glb' }`

Skip optimization:
- If `models/<basename>.glb` already exists:
  - it does not reconvert
  - but still includes the entry in the manifest

