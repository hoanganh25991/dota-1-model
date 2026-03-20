# Runtime Spec (`js/viewer.js`)

This document specifies how the browser viewer loads `WarcraftModels/manifest.json`, loads a selected `models/<id>.glb`, centers/scales it, and plays the embedded glTF animation clips. It is aligned with `js/viewer.js` so a reimplementation or audit can rely on this file.

## Module imports
- `three` (namespace `THREE`)
- `GLTFLoader` from `three/addons/loaders/GLTFLoader.js`
- `OrbitControls` from `three/addons/controls/OrbitControls.js`
- `RoomEnvironment` from `three/addons/environments/RoomEnvironment.js`

## Constants (must match code)

| Constant | Value | Purpose |
| -------- | ----- | ------- |
| `MANIFEST_URL` | `'WarcraftModels/manifest.json'` | Relative URL for `fetch()` |
| `MDX_ANIM_BASE_SCALE` | `25` | Multiplies animation delta × speed slider; tunes perceived WC3-like speed |
| `WC3_Z_UP_TO_Y_UP` | `-Math.PI / 2` | `rotateX` on loaded root to map MDX Z-up to Three.js Y-up |
| `CAMERA_YAW_CORRECTION` | `Math.PI / 2` | Y-axis rotation on camera direction presets |
| Initial `camera.position` (before framing) | `(0, 2, 5)` | Overridden after `frameModelAndCamera` for loaded models |
| `targetSize` (framing) | `6` | World units: max axis of AABB after scale |
| Scale cap | `min(targetSize/maxDim, 1000)` | Prevents extreme scales |
| Near-zero mesh skip | `maxWorldAxisScale < 1e-5` | Treats hidden/scaled-down geosets as invisible for bounds |

## Global state (module-level)

Key variables used across functions:
- `scene`, `camera`, `renderer`, `controls`, `clock`
- `modelGroup` — parent of loaded `gltf.scene`
- `currentModel`, `mixer`, `currentClips`
- `allModels`, `filteredModels`
- `activeCategory` (starts `'all'`), `searchQuery` (starts `''`)
- `animationSpeed` (starts `1`) — multiplied by `MDX_ANIM_BASE_SCALE` in `mixer.update`
- `applyingUrlQuery` — when `true`, `writeUrlQuery` is a no-op (initial URL hydration, `syncFromUrl`)
- `modelFrameDistance` — last computed camera distance for presets (default `8`)
- `lightPreset` — `'default'` | `'dark'` | `'bright'`

## High-level responsibilities
The runtime is responsible for:
1. Fetching the manifest and building a model list UI
2. Filtering by category and search (name + id)
3. Parsing URL query parameters for category + selected model
4. Loading the selected GLB via `THREE.GLTFLoader`
5. Converting axes (WC3 Z-up → Three.js Y-up)
6. Playing animation clips via `THREE.AnimationMixer`
7. Centering/scaling the model and placing the camera based on visible geometry
8. Handling view presets (front/side/reset) and speed/lighting controls
9. Disposing resources when switching models

## Manifest contract

The viewer expects a JSON file at:
- `WarcraftModels/manifest.json` (relative to the site root)

Expected shape:
- `{ "models": [ { id, name, category, path }, ... ] }`

For backward compatibility, the loader maps each manifest row to:
- `id`: `m.id || m.file?.replace(/\.(mdx|glb)$/i, '') || m.name`
- `name`: `m.name || m.id || 'Unknown'`
- `category`: `m.category || 'Unit'`
- `path`: `m.path || m.glb || \`models/${(m.id || m.file || m.name).replace(/\.(mdx|glb)$/i, '')}.glb\``

The viewer sorts `allModels` by `name` (case-insensitive, `localeCompare` with `sensitivity: 'base'`), then by `id` if names tie.

## URL query parameters

Viewer reads:
- `?category=<lowercase category>` (optional)
- `&model=<manifest id>` (optional)

`writeUrlQuery(modelId)` (skipped when `applyingUrlQuery === true`):
- If `activeCategory === 'all'` **and** `modelId` is falsy: removes both `category` and `model` query params.
- Otherwise: sets `category` to `'all'` (lowercase) when category is all, else `activeCategory.toLowerCase()`; sets or deletes `model` from `modelId`.
- Uses `history.replaceState` only when the resulting URL string differs.

On browser back/forward:
- `popstate` triggers `syncFromUrl()` which re-reads query, updates category UI, re-renders list/select, and loads/clears model per `model` param.

### Category resolution
- `resolveCategoryFromParam(param)`: if missing → `'all'`; else finds first category in `getCategories()` whose lowercase matches `param.toLowerCase()`, else `'all'`.
- `getCategories()`: `['all', ...sorted unique categories from allModels]`.

## Search and list filtering
- `searchQuery` is updated from `#search-input` input events.
- `renderModelList()` keeps `filteredModels` where:
  - category matches `activeCategory` (or all), **and**
  - search matches `m.name` or `m.id` (case-insensitive substring) or search is empty.
- `#model-count` shows `filteredModels.length`.

## Category + model dropdowns (`renderCategorySelect`, `renderModelSelect`)

- `#category-filter` inner HTML is replaced with a row for **Type** (`#category-select`) and **Model** (`#model-select`).
- `renderCategorySelect()` runs after manifest load: builds options from `getCategories()`, sets value to `activeCategory`, wires `change` → `onCategorySelectChange`.
- `onCategorySelectChange`: sets `activeCategory`, `clearViewerSelection()`, `renderModelList()`, `renderModelSelect()`, `writeUrlQuery(null)`.
- `renderModelSelect()`: placeholder option `— Select model —`, options from `filteredModels`; restores previous selection if still present.
- `onModelSelectChange`: empty value → `clearViewerSelection()` + `writeUrlQuery(null)`; else `loadModel(id)`.

## Scene initialization (`init()`)

Creates:
- `scene = new THREE.Scene()` with `scene.background = new THREE.Color(0xa8a8b0)` (neutral grey for hero preview)
- `camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000)` — initial aspect **1** until `resize()` runs
- `camera.position.set(0, 2, 5)` (overwritten after successful `frameModelAndCamera` on load)
- `renderer = new THREE.WebGLRenderer({ canvas: #canvas, antialias: true })`
  - `setPixelRatio(min(devicePixelRatio, 2))`
  - `outputColorSpace = SRGBColorSpace`
  - `toneMapping = ACESFilmicToneMapping`, `toneMappingExposure = 1`
  - `shadowMap.enabled = true`, `shadowMap.type = PCFSoftShadowMap`
- `controls = new OrbitControls(camera, canvas)`
  - `enableDamping = true`, `dampingFactor = 0.05`
  - `minDistance = 0.5`, `maxDistance = 50` (may increase after framing)
  - `controls.target.set(0, 0, 0)`

Lighting and environment:
- `AmbientLight(0xffffff, LIGHT_PRESETS.default.ambient)` — default ambient **0.4**
- `DirectionalLight(0xffffff, LIGHT_PRESETS.default.directional)` — default **0.8**, `position.set(5, 10, 7)`, `castShadow = true`, shadow map **2048×2048**, orthographic shadow frustum **±120** (covers the floor)
- `RoomEnvironment` → `PMREMGenerator(renderer).fromScene(env).texture` → `scene.environment`

Scene graph:
- `modelGroup = new THREE.Group()`, `scene.add(modelGroup)` — loaded GLB roots are parented here.
- Checkerboard **ground plane** (`createCheckerGround()`): **500×500** `PlaneGeometry`, `MeshStandardMaterial` with a canvas **checker** texture (`RepeatWrapping` ×48), rotated **−90°** around X (lies in **XZ**), `position.y = GROUND_Y` (**−0.02**), `receiveShadow = true`. Not parented under `modelGroup` so it persists across model changes.

`clock = new THREE.Clock()`.

Resize:
- Initial `resize()` call; `window` `resize` listener; `ResizeObserver` on `#viewer` → both call `resize()`
- `resize()`: reads `#viewer` client size; if `w` or `h` ≤ 0, sets each to `max(value, 100)`; updates renderer size, pixel ratio, `camera.aspect`, `camera.updateProjectionMatrix()`

## Model loading (`loadModel(id)`)

### Early exit
- If `allModels.find(m => m.id === id)` is undefined, **return** (no GLTF fetch).

### Order of operations (before GLTF)
1. `writeUrlQuery(id)` — updates URL unless `applyingUrlQuery`
2. `clearCurrentModel()` — dispose previous asset
3. `#current-model` text ← `model.name`
4. `.model-item` elements: toggle `.active` where `dataset.id === id`
5. `#model-select`: set `value` to `id` if `filteredModels` contains that id

### glTF loading
Uses:
- `new GLTFLoader()`
- `loader.load(model.path, onLoad, undefined, onError)`
- `onError`: logs `Failed to load model:` to console (no user-visible error UI)

On load:
1. `currentModel = gltf.scene`
2. Axis conversion:
   - `currentModel.rotateX(WC3_Z_UP_TO_Y_UP)`
   - constant: `WC3_Z_UP_TO_Y_UP = -Math.PI / 2`
3. Traverse and material adjustments:
   - for each `obj.isMesh`:
     - `obj.frustumCulled = false`
     - `obj.castShadow = true`, `obj.receiveShadow = true` (contact shadows on the checker floor)
     - normalize `obj.material` to an array and iterate **every** slot
     - for each material `m`:
       - if `m.map` exists and `m.opacity <= 1e-5`: set `m.opacity = 1` (fixes glTF exports where
         `baseColorFactor.a` is `0` but the diffuse map still defines appearance — otherwise Three.js
         multiplies the texture down to fully transparent)
       - if `!m.transparent`: `m.side = THREE.DoubleSide`
       - else: `m.depthWrite = false`
4. For **Portrait** models (`category === 'Portrait'` or id matches `/portrait/i`): `hidePortraitEngineBackdrop(currentModel)` — WC3 portrait MDX often has a **4-vertex** backdrop card (thin, huge bbox) used only by the in-game portrait compositor; it maps the full diffuse atlas and looks like a floating texture square in this viewer, so those meshes get `visible = false`.
5. Add to scene container:
   - `modelGroup.add(currentModel)`

### Mixer + clip discovery
Creates:
- `mixer = new THREE.AnimationMixer(currentModel)`
- `currentClips = gltf.animations || []`

It then:
- builds the animation UI for these clips (`renderAnimationButtons`)
- plays clip index `0` if clips exist (`playClipAtIndex`)

### `playClipAtIndex(clips, index)`
- No-op if `!mixer` or no clips / invalid index.
- `mixer.stopAllAction()`, `clipAction(clip)`, `reset()`, `setLoop(LoopRepeat, Infinity)`, `clampWhenFinished = false`, `play()`.
- Syncs `#animation-select` value to `index` if present.
- Sets `.active` on `#animation-buttons .animation-btn` where `data-index` matches.

### Ensure visible geometry exists before centering
Geoset visibility can be authored as scale 0/1 driven by geoset alpha animation channels.
Some GLBs keep every geoset at scale `0` until a few frames into the first clip; if the viewer
only samples `t≈0`, the “visible mesh” AABB is empty and the fallback `Box3.setFromObject(root)`
can center on hidden/collision geometry far from the real mesh (black viewport).

After `playClipAtIndex` for clip `0`, the viewer calls `seekMixerForVisibleBounds(mixer, root)`:
- Steps `t = 0, 1/30, 2/30, …` seconds up to `2s` (30 fps sampling).
- At each step: `mixer.setTime(t)` (Three.js applies that absolute time), `root.updateMatrixWorld(true)`,
  then probes `computeVisibleMeshesWorldBox`; stops at the first non-empty box.
- If still empty after the scan: `mixer.setTime(0)` and frame using existing fallbacks.

Models with **no** clips: `mixer.setTime(0)` if available, else `mixer.update(1e-4)`, then
`currentModel.updateMatrixWorld(true)`.

Then it calls:
- `frameModelAndCamera(currentModel)`

Post-framing:
- If `#view-select` exists, sets value to `'front'`.
- `controls.saveState()` — saved state is used by **Reset** (`applyViewPreset('reset')`).

### Animation UI integration (`renderAnimationButtons`)
- If `clips.length === 0`:
  - `#animation-buttons` shows a “No animations” paragraph; `#animation-select` disabled with a single option.
- Else:
  - Buttons: one per clip, `data-index`, label `clip.name` or `Anim ${i}`.
  - `#animation-select`: options `0..n-1`, same labels, enabled.

Click behavior:
- When a button is clicked:
  - `playClipAtIndex(currentClips, idx)`
  - `mixer.update(0)`

`#animation-select` `change`:
- Parses index, `playClipAtIndex(currentClips, idx)`, `mixer.update(0)`.

## Animation playback loop (`animate()`)

Runs via `requestAnimationFrame(animate)`.

Each frame:
- `delta = min(clock.getDelta(), 0.1)` — caps huge deltas after tab backgrounding / debugger pauses
- if `mixer` exists:
  - `mixer.update(delta * animationSpeed * MDX_ANIM_BASE_SCALE)`

Constants:
- `MDX_ANIM_BASE_SCALE = 25`
  - used as an empirical scaling factor to approximate “WC3 in-game speed”

After updating:
- `controls.update()`
- `renderer.render(scene, camera)`

## Centering and camera fitting (`frameModelAndCamera(root)`)

**OrbitControls + damping:** While `enableDamping` is true, OrbitControls keeps internal `sphericalDelta` from user input. Assigning `camera.position` directly does **not** clear that; the next `controls.update()` adds the leftover delta to the recomputed orbit angles, which can move the camera inside the mesh or far off-screen (black viewport until a full reload). The viewer sets `controls.enableDamping = false` for the duration of framing, runs `controls.update()` (which zeros the delta when damping is off), then sets `enableDamping` back to `true`. `controls.maxDistance` is reset to `50` at the start of framing and then set to `max(50, dist * 4)`.

`clearCurrentModel()` resets the camera to the initial `(0, 2, 5)` / target `(0,0,0)` with the same damping-off cycle so switching models does not inherit the previous orbit inertia.

Purpose:
- center the model around the origin
- scale it to a target size
- position camera in a stable direction (“front quarter”)

Key dependency:
- it computes bounding boxes using only visible meshes to avoid hidden geosets pulling the center off-screen.

### Visible AABB computation
Uses:
- `computeVisibleMeshesWorldBox(root, targetBox)`

Algorithm:
- `root.updateMatrixWorld(true)`
- traverse all descendants:
  - if not `obj.isMesh`: skip
  - if `maxWorldAxisScale(obj.matrixWorld) < 1e-5`: skip
    - `maxWorldAxisScale` measures the magnitude of world matrix columns
  - compute geometry bounding box (if missing)
  - transform bounding box by `obj.matrixWorld`
  - union into `targetBox`

### Fallback (empty bounds)
1. If `computeVisibleMeshesWorldBox` leaves the box empty: `box.setFromObject(root)`.
2. If **still** empty:
   - `root.position.set(0, 0, 0)`, `root.scale.setScalar(1)`
   - `modelFrameDistance = 8`
   - `camera.position.set(4.5, 3.2, 7.5)`, `controls.target.set(0, 0, 0)`
   - `camera.near = 0.1`, `camera.far = 1000`, `updateProjectionMatrix`, `controls.update`, **return** (no scaling / auto camera dir)

### Scaling
Once a non-empty `box` exists:
- `center = box.getCenter()`
- `size = box.getSize()`
- `maxDim = max(size.x, size.y, size.z, 0.001)`
- `targetSize = 6`
- `scale = min(targetSize / maxDim, 1000)`

Applies:
- `root.scale.setScalar(scale)`
- `root.position = -center * scale`
- updates matrices

### Center refinement
It re-computes visible boxes:
1. `box2` -> `center2` -> `root.position.sub(center2)`
2. `box3` -> `size2` -> `maxDim2` used for camera distance estimation

### Camera distance and placement
Computes vertical and horizontal FOV-based distances:
- uses `camera.fov`, `camera.aspect`
- `vFov = camera.fov` in radians; `hFov = 2 * atan(tan(vFov/2) * aspect)`
- `distV = (maxDim2/2) / tan(vFov/2)`, `distH = (maxDim2/2) / tan(hFov/2)`
- `dist = max(distV, distH, 1.5) * 1.15`
- `maxDim2 = max(size2.x, size2.y, size2.z, maxDim * scale, 0.001)` — keeps a floor from pre-scale size × scale

Sets:
- `modelFrameDistance = dist`
- `controls.maxDistance = max(50, dist * 4)` (baseline reset each frame)
- direction:
  - base dir = `(0.52, 0.42, 0.74)` normalized
  - rotated around Y by `CAMERA_YAW_CORRECTION`
  - constant: `CAMERA_YAW_CORRECTION = Math.PI / 2`
- `camera.position = dir * dist`
- `controls.target = (0,0,0)`
- `camera.near = max(0.01, dist * 0.002)`
- `camera.far = max(500, dist * 80)`
- `controls.update()`

## View presets (`applyViewPreset(preset)`)

Presets:
- `reset`:
  - `controls.reset()`
- `front`:
  - uses `modelFrameDistance` and sets:
    - camera position at moderately elevated front direction
    - `controls.target = (0,0,0)`
  - uses helper `rotateAroundY` and `CAMERA_YAW_CORRECTION`
- `side`:
  - similar but near the side direction

UI elements call this on button clicks:
- `#btn-reset` → `applyViewPreset('reset')`
- `#btn-front` → `'front'`
- `#btn-side` → `'side'`
- `#view-select` `change` → `applyViewPreset(e.target.value)` (same presets as buttons; values must be `reset` / `front` / `side` if used)

Helper `rotateAroundY(x, z, yaw)` rotates `(x,z)` in the XZ plane for preset camera bases.

## Material transparency handling (important for your GLBs)

When loading meshes:
- opaque materials:
  - forced `DoubleSide` (prevents missing faces for WC3 two-sided quads)
- transparent materials:
  - `depthWrite = false`
  - avoids invisible transparent planes causing depth-fighting artifacts

This assumes the GLB exporter sets:
- `material.transparent` correctly
- and uses alpha modes consistent with the BLP->GLTF alpha conversion.

## Lighting presets (`setLightPreset`)

`LIGHT_PRESETS`:
- `default`: ambient `0.4`, directional `0.8`
- `dark`: `0.2` / `0.4`
- `bright`: `0.6` / `1.2`

UI controls:
- `#btn-light-default`, `#btn-light-dark`, `#btn-light-bright`
- `#lighting-select` `change` → `setLightPreset(e.target.value)`

Implementation:
- sets `ambientLight.intensity` and `directionalLight.intensity`
- toggles `.active` on `#controls button[id^="btn-light"]` where `b.id === 'btn-light-${name}'`
- updates `#lighting-select` value if present

## Speed slider (`#speed-slider`)
- `input` sets `animationSpeed = parseFloat(e.target.value)`
- `#speed-display`: if `animationSpeed < 10` show one decimal, else integer, suffixed with `x`

## Startup (`main()`)
1. `init()` then `setupUI()`.
2. `await loadManifest()` inside `try`:
   - Sets `applyingUrlQuery = true`
   - Reads `category` + `model` from URL, `resolveCategoryFromParam`, `renderCategorySelect`, `renderModelList`, `renderModelSelect`
   - If `modelParam` present and model exists and matches category: `loadModel(modelParam)`
   - Sets `applyingUrlQuery = false`
3. On manifest failure: `#model-count` = “Failed to load manifest”, `#model-list` shows hint to run `node scripts/generate-model-manifest.mjs`.
4. Hides `#loading` (`classList.add('hidden')`).
5. `requestAnimationFrame`: `resize()` then starts `animate()` loop.

Note: `loadModel` calls `writeUrlQuery` during normal use; initial URL load uses `applyingUrlQuery` to avoid double history writes in some flows. `syncFromUrl` also sets `applyingUrlQuery` while syncing.

## Cleanup (`clearCurrentModel()`)

When switching models:
- stops and uncaches mixer:
  - `mixer.stopAllAction()`
  - `mixer.uncacheRoot(currentModel)`
- disposes geometry and materials:
  - `o.geometry.dispose()`
  - `o.material.dispose()` (or each element if array)
- removes `currentModel` from `modelGroup`

`clearViewerSelection()` additionally calls `clearCurrentModel()`, resets `#current-model` label, clears `.active` on items, clears `#model-select`.

## Implementation map (`viewer.js`)

| Function / block | Role |
| ---------------- | ---- |
| `init` | Scene, camera, renderer, controls, lights, environment, clock, resize listeners |
| `resize` | Match `#viewer` size to renderer + camera aspect |
| `loadManifest` | Fetch manifest, normalize rows, sort |
| `renderModelList` | Filter + render `#model-list`, wire clicks to `loadModel` |
| `playClipAtIndex` | Play clip by index, sync UI |
| `readUrlQuery` / `writeUrlQuery` / `syncFromUrl` | URL state |
| `renderCategorySelect` / `renderModelSelect` | Filters |
| `maxWorldAxisScale` / `computeVisibleMeshesWorldBox` | Bounds ignoring near-zero scaled meshes |
| `frameModelAndCamera` | Scale, center, place camera |
| `loadModel` | GLTF load, axis fix, materials, mixer, frame 0, frame camera |
| `clearCurrentModel` | Dispose + remove |
| `renderAnimationButtons` | Build buttons + select |
| `animate` | Mixer delta, controls, render |
| `applyViewPreset` | Reset / front / side camera |
| `setupUI` | Search, popstate, view/light/speed/animation listeners |
| `setLightPreset` | Light intensities + UI |
| `main` | Bootstrap |

## Practical implementation checklist (if you reimplement)

If you want to replicate the same viewer behavior, ensure:
1. You apply the axis correction from WC3 Z-up to Three Y-up
2. You evaluate animation time 0 before computing bounds
3. You skip hidden meshes (scale near 0) during bounding box computation
4. You fit camera distance based on FOV and actual model size
5. You run a per-frame mixer update with:
   - `delta * animationSpeed * MDX_ANIM_BASE_SCALE`
6. You apply transparent-material depthWrite rules to avoid artifacts
7. You match manifest field fallbacks and sort order if sharing `manifest.json` with this converter

## Related docs
- Converter / GLB contents: [`MDX_TO_GLB_SPEC.md`](MDX_TO_GLB_SPEC.md)
- Index: [`SPEC_INDEX.md`](SPEC_INDEX.md)

