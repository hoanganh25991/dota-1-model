# Runtime Spec (`js/viewer.js`)

This document specifies how the browser viewer loads `WarcraftModels/manifest.json`, loads a selected `models/<id>.glb`, centers/scales it, and plays the embedded glTF animation clips.

## High-level responsibilities
The runtime is responsible for:
1. Fetching the manifest and building a model list UI
2. Parsing URL query parameters for category + selected model
3. Loading the selected GLB via `THREE.GLTFLoader`
4. Converting axes (WC3 Z-up -> Three.js Y-up)
5. Playing animation clips via `THREE.AnimationMixer`
6. Centering/scaling the model and placing the camera based on visible geometry
7. Handling view presets (front/side/reset) and speed/lighting controls

## Manifest contract

The viewer expects a JSON file at:
- `WarcraftModels/manifest.json` (relative to the site root)

Expected shape:
- `{ "models": [ { id, name, category, path }, ... ] }`

For backward compatibility, the loader attempts to infer missing fields:
- `id` can be `m.id` or derived from `m.file` or `m.name`
- `path` can be `m.path` or `m.glb` or derived from `models/<id>.glb`

The viewer sorts `allModels` by `name` (case-insensitive), then by `id`.

## URL query parameters

Viewer reads:
- `?category=<lowercase category>` (optional)
- `&model=<manifest id>` (optional)

It updates the URL using `history.replaceState` in response to:
- category selection changes
- model selection changes

On browser back/forward:
- `popstate` triggers `syncFromUrl()`

## Scene initialization (`init()`)

Creates:
- `scene = new THREE.Scene()`
  - `scene.background = Color(0x0a0a0f)`
- `camera = new THREE.PerspectiveCamera(45, aspect, 0.1, 1000)`
- `renderer = new THREE.WebGLRenderer({ canvas, antialias: true })`
  - pixel ratio capped at 2
  - output color space set to SRGB
  - ACES tone mapping enabled
  - shadow mapping enabled
- `controls = new OrbitControls(camera, canvas)`
  - damping enabled
  - min/max distance set
  - `controls.target = (0,0,0)`

Lighting and environment:
- adds `AmbientLight` and `DirectionalLight` (with shadows)
- adds `RoomEnvironment` + PMREM to `scene.environment`

Resize:
- `resize()` reads `#viewer` size and updates:
  - renderer size
  - camera aspect
  - projection matrix

## Model loading (`loadModel(id)`)

### Lookup and UI synchronization
`id` is resolved from the manifest list `allModels`.
The viewer updates:
- `#current-model` text
- active model highlight in `.model-item`
- selected value in `#model-select` if present
- URL query parameters via `writeUrlQuery(id)`

### glTF loading
Uses:
- `new GLTFLoader()`
- `loader.load(model.path, onLoad)`

On load:
1. `currentModel = gltf.scene`
2. Axis conversion:
   - `currentModel.rotateX(WC3_Z_UP_TO_Y_UP)`
   - constant: `WC3_Z_UP_TO_Y_UP = -Math.PI / 2`
3. Traverse and material adjustments:
   - for each `obj.isMesh`:
     - `obj.frustumCulled = false`
     - if `obj.material` exists:
       - if array, use the first material `obj.material[0]`
       - if `!m.transparent`:
         - `m.side = THREE.DoubleSide`
       - else:
         - set `m.depthWrite = false`
4. Add to scene container:
   - `modelGroup.add(currentModel)`

### Mixer + clip discovery
Creates:
- `mixer = new THREE.AnimationMixer(currentModel)`
- `currentClips = gltf.animations || []`

It then:
- builds the animation UI for these clips (`renderAnimationButtons`)
- plays clip index `0` if clips exist (`playClipAtIndex`)

### Ensure frame 0 is evaluated before centering
Geoset visibility can be authored as scale 0/1 driven by geoset alpha animation channels.
To center based on visible geometry, the viewer forces mixer evaluation at start:
1. if `typeof mixer.setTime === 'function'`: `mixer.setTime(0)`
2. `mixer.update(1e-4)`
3. `currentModel.updateMatrixWorld(true)`

Then it calls:
- `frameModelAndCamera(currentModel)`

### Animation UI integration
Clip names:
- Buttons and dropdown use `clip.name` when available, otherwise `Anim <i>`.

Click behavior:
- When a button is clicked:
  - `playClipAtIndex(currentClips, idx)`
  - `mixer.update(0)`

Dropdown selection:
- Similar: parses `idx` from the `<select>` and plays that clip.

## Animation playback loop (`animate()`)

Runs via `requestAnimationFrame(animate)`.

Each frame:
- `delta = clock.getDelta()`
- if `mixer` exists:
  - `mixer.update(delta * animationSpeed * MDX_ANIM_BASE_SCALE)`

Constants:
- `MDX_ANIM_BASE_SCALE = 25`
  - used as an empirical scaling factor to approximate “WC3 in-game speed”

After updating:
- `controls.update()`
- `renderer.render(scene, camera)`

## Centering and camera fitting (`frameModelAndCamera(root)`)

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

Fallback:
- if box empty: `box.setFromObject(root)`
- if still empty:
  - reset transforms and use a default camera position

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
- distV and distH from trig
- `dist = max(distV, distH, 1.5) * 1.15`

Sets:
- `modelFrameDistance = dist`
- `controls.maxDistance = max(controls.maxDistance, dist * 4)`
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
- `#btn-reset`
- `#btn-front`
- `#btn-side`

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

UI controls:
- `#btn-light-default`
- `#btn-light-dark`
- `#btn-light-bright`

Implementation:
- adjusts intensities of `ambientLight` and `directionalLight`
- toggles `.active` classes on buttons
- updates `#lighting-select` value if present

## Cleanup (`clearCurrentModel()`)

When switching models:
- stops and uncaches mixer:
  - `mixer.stopAllAction()`
  - `mixer.uncacheRoot(currentModel)`
- disposes geometry and materials:
  - `o.geometry.dispose()`
  - `o.material.dispose()` (or each element if array)
- removes `currentModel` from `modelGroup`

## Practical implementation checklist (if you reimplement)

If you want to replicate the same viewer behavior, ensure:
1. You apply the axis correction from WC3 Z-up to Three Y-up
2. You evaluate animation time 0 before computing bounds
3. You skip hidden meshes (scale near 0) during bounding box computation
4. You fit camera distance based on FOV and actual model size
5. You run a per-frame mixer update with:
   - `delta * animationSpeed * MDX_ANIM_BASE_SCALE`
6. You apply transparent-material depthWrite rules to avoid artifacts

