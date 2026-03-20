/**
 * WARCRAFT III Model Browser
 * Loads model list from models/manifest.json
 * Displays model list, supports search/category filter, plays real WC3 animations from GLB
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const MANIFEST_URL = 'models/manifest.json';

let scene, camera, renderer, controls;
let modelGroup, groundGrid, currentModel, mixer, clock;
/** @type {THREE.AnimationClip[]} Clips from the last loaded GLB (for button handlers) */
let currentClips = [];
let ambientLight, directionalLight;
let allModels = [];
let filteredModels = [];
let activeCategory = 'all';
let searchQuery = '';
let animationSpeed = 1;
/** When true, skip updating the address bar (initial load / popstate sync). */
let applyingUrlQuery = false;
const DEBUG_HIDE_BACKDROP = new URLSearchParams(window.location.search).get('debugHideBackdrop') === '1';

/** MDX timelines are long in wall-clock seconds; ~25× matches typical WC3 in-engine speed at slider 1×. */
const MDX_ANIM_BASE_SCALE = 25;

/**
 * WC3 MDX is Z-up, while glTF / Three.js is Y-up.
 * Rotate models so "up" lines up with the browser camera intuition.
 */
/** Neutral grey backdrop so heroes read clearly vs pure black. */
const VIEWER_BACKGROUND = 0xa8a8b0;

/** Reference height (world Y) for the ground grid — lines only, no solid fill. */
const GROUND_Y = 0;
/** Small gap between mesh lowest point and grid so feet don’t z-fight with lines. */
const GROUND_CLEARANCE = 0.02;
/** Multiply auto-framing camera distance so the model is smaller in view with more margin (2 ≈ 2× zoom out). */
const FRAMING_ZOOM_OUT = 2;
/** Used before first load / after clear for Front–Side presets (`8` base × zoom-out). */
const DEFAULT_MODEL_FRAME_DISTANCE = 8 * FRAMING_ZOOM_OUT;
/** Lift orbit target along +Y (world) so the model sits lower in the frame (~bottom third). */
const FRAMING_TARGET_Y_FACTOR = 0.32;

/**
 * Line grid on XZ (no opaque plane) for spatial reference on the grey backdrop.
 */
function createGroundGrid() {
  const size = 400;
  const divisions = 80;
  const colorCenter = 0x6a6a74;
  const colorGrid = 0x8c8c96;
  const grid = new THREE.GridHelper(size, divisions, colorCenter, colorGrid);
  grid.position.y = GROUND_Y;
  grid.name = 'GroundGrid';
  grid.frustumCulled = false;
  return grid;
}

/**
 * After centering/scaling, the AABB center is at the origin but feet can still sit below y=0.
 * Shift the model up so the lowest visible point rests slightly above the ground grid.
 */
function alignModelBottomToGround(root, groundY) {
  const box = new THREE.Box3();
  computeVisibleMeshesWorldBox(root, box);
  if (box.isEmpty()) return;
  const minY = box.min.y;
  const want = groundY + GROUND_CLEARANCE;
  if (minY >= want) return;
  root.position.y += want - minY;
  root.updateMatrixWorld(true);
}

function isPortraitModelEntry(model) {
  if (!model) return false;
  if (model.category === 'Portrait') return true;
  // Some models don't have reliable categories in the manifest; also fall back to id/name.
  return /portrait/i.test(String(model.id || '')) || /portrait/i.test(String(model.name || ''));
}

/**
 * WC3 portrait MDX includes a camera-facing backdrop quad (4 verts, huge thin bbox) used by the
 * in-game portrait compositor. In a generic viewer it draws as a full diffuse-atlas square behind
 * the bust; hide it so only the head mesh remains visible.
 */
function hidePortraitEngineBackdrop(root, { allowSkinnedPlanes = true } = {}) {
  const debugCandidates = [];
  root.traverse((obj) => {
    if (!obj.isMesh || !obj.geometry) return;
    const pos = obj.geometry.attributes.position;
    if (!pos) return;
    if (!obj.geometry.boundingBox) obj.geometry.computeBoundingBox();
    const size = obj.geometry.boundingBox.getSize(new THREE.Vector3());
    const sorted = [size.x, size.y, size.z].sort((a, b) => a - b);

    // Strongly biased toward the portrait backdrop "card":
    // - extremely thin (or very small thickness ratio)
    // - large in the other 2 axes
    // - low-vertex mesh (usually a single card made of 2 triangles)
    // - not skinned (backdrop cards are static)
    // - has a bound texture map (diffuse atlas)
    const thickness = sorted[0];
    const mid = sorted[1];
    const large = sorted[2];
    const thicknessRatio = thickness / Math.max(mid, large, 1e-6);

    const hasSkin =
      Boolean(obj.geometry.attributes.skinIndex) || Boolean(obj.geometry.attributes.skinWeight);

    const name = String(obj.name || '').toLowerCase();
    const isNamedBackplate = /portrait|backdrop|backplate/i.test(name);
    // Plane-like: one axis is much thinner than the other two.
    // Plane/backdrop-like card detection.
    // Many WC3 "portrait cards" show up as very low-vertex meshes with a small bbox thickness.
    const extremelyThin = thicknessRatio < 0.12 || thickness < 30;
    const wideEnough = mid > 60 && large > 60;
    const veryLowVertCount = pos.count <= 200;

    const mats = obj.material ? (Array.isArray(obj.material) ? obj.material : [obj.material]) : [];
    const materialHasTexture = mats.some((m) => m && m.map);

    // If the mesh is explicitly named, hide it even if vertex/size thresholds drift.
    if (isNamedBackplate) {
      if (DEBUG_HIDE_BACKDROP) {
        // eslint-disable-next-line no-console
        console.log('[hideBackdrop] named', obj.name, { posCount: pos.count, size: { x: size.x, y: size.y, z: size.z } });
      }
      obj.visible = false;
      return;
    }

    const aspect = large / Math.max(thickness, 1e-6);
    // Some cards have moderate aspect (e.g. 6–20), so don't require a huge aspect ratio.
    const extremeAspect = aspect > 120;

    // Hide plane-like backdrop cards:
    // - very large in 2 axes (mid/large big)
    // - very thin in 3rd axis
    // - low vertex count (avoid nuking real geosets)
    // Texture isn't always bound (older exports), so allow either texture-map or extreme thinness.
    const skinnedAllowed = allowSkinnedPlanes ? true : !hasSkin;
    const skinnedExtraGuard = !hasSkin || veryLowVertCount;

    if (
      extremelyThin &&
      wideEnough &&
      veryLowVertCount &&
      skinnedAllowed &&
      skinnedExtraGuard &&
      (materialHasTexture || extremelyThin)
    ) {
      if (DEBUG_HIDE_BACKDROP) {
        // eslint-disable-next-line no-console
        console.log('[hideBackdrop] plane', obj.name, { posCount: pos.count, size: { x: size.x, y: size.y, z: size.z }, thicknessRatio, aspect });
      }
      obj.visible = false;
    } else if (DEBUG_HIDE_BACKDROP) {
      // Collect plane-likeness so we can tune thresholds.
      if (extremelyThin && wideEnough) {
        debugCandidates.push({
          name: obj.name,
          posCount: pos.count,
          size: { x: size.x, y: size.y, z: size.z },
          thicknessRatio,
          aspect,
          hasSkin,
          materialHasTexture,
        });
      }
    }
  });

  if (DEBUG_HIDE_BACKDROP) {
    debugCandidates
      .sort((a, b) => b.aspect - a.aspect)
      .slice(0, 15)
      .forEach((c) => {
        // eslint-disable-next-line no-console
        console.log('[hideBackdrop][candidate]', c.name, {
          posCount: c.posCount,
          size: c.size,
          thicknessRatio: c.thicknessRatio,
          aspect: c.aspect,
          hasSkin: c.hasSkin,
          materialHasTexture: c.materialHasTexture,
        });
      });
  }
}

const WC3_Z_UP_TO_Y_UP = -Math.PI / 2; // rotate around X

/** Fixed yaw offset so the initial view looks at the model's "front". */
const CAMERA_YAW_CORRECTION = Math.PI / 2; // rotate around Y (left -> right)

function rotateAroundY(x, z, yaw) {
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  return {
    x: x * cos + z * sin,
    z: -x * sin + z * cos,
  };
}

/** Last camera distance used for Front / Side presets */
let modelFrameDistance = DEFAULT_MODEL_FRAME_DISTANCE;
/** Orbit `controls.target.y` so Front/Side presets match auto-framing composition. */
let framingTargetY = 0;

const CONTROLS_MIN_DIST = 0.5;
const CONTROLS_MAX_DIST_INIT = 50;

/** Reused when reading world scale from matrix columns */
const _mxCol0 = new THREE.Vector3();
const _mxCol1 = new THREE.Vector3();
const _mxCol2 = new THREE.Vector3();
const _tmpBox = new THREE.Box3();

const LIGHT_PRESETS = {
  default: { ambient: 0.4, directional: 0.8 },
  dark: { ambient: 0.2, directional: 0.4 },
  bright: { ambient: 0.6, directional: 1.2 },
};
let lightPreset = 'default';

function init() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(VIEWER_BACKGROUND);

  camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
  camera.position.set(0, 2, 5);

  const canvas = document.getElementById('canvas');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  controls.minDistance = CONTROLS_MIN_DIST;
  controls.maxDistance = CONTROLS_MAX_DIST_INIT;
  controls.target.set(0, 0, 0);

  modelGroup = new THREE.Group();
  scene.add(modelGroup);

  ambientLight = new THREE.AmbientLight(0xffffff, LIGHT_PRESETS.default.ambient);
  scene.add(ambientLight);

  directionalLight = new THREE.DirectionalLight(0xffffff, LIGHT_PRESETS.default.directional);
  directionalLight.position.set(5, 10, 7);
  directionalLight.castShadow = true;
  directionalLight.shadow.mapSize.width = 2048;
  directionalLight.shadow.mapSize.height = 2048;
  directionalLight.shadow.bias = -0.0002;
  directionalLight.shadow.normalBias = 0.02;
  const sh = 120;
  directionalLight.shadow.camera.left = -sh;
  directionalLight.shadow.camera.right = sh;
  directionalLight.shadow.camera.top = sh;
  directionalLight.shadow.camera.bottom = -sh;
  directionalLight.shadow.camera.near = 1;
  directionalLight.shadow.camera.far = 400;
  scene.add(directionalLight);

  groundGrid = createGroundGrid();
  scene.add(groundGrid);

  const env = new RoomEnvironment();
  const pmremGenerator = new THREE.PMREMGenerator(renderer);
  scene.environment = pmremGenerator.fromScene(env).texture;

  clock = new THREE.Clock();

  resize();
  window.addEventListener('resize', resize);
  new ResizeObserver(() => resize()).observe(document.getElementById('viewer'));
}

function resize() {
  const viewer = document.getElementById('viewer');
  let w = viewer.clientWidth;
  let h = viewer.clientHeight;
  if (w <= 0 || h <= 0) {
    w = Math.max(w, 100);
    h = Math.max(h, 100);
  }
  renderer.setSize(w, h);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

function loadManifest() {
  return fetch(MANIFEST_URL)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error('Manifest not found'))))
    .then((data) => {
      allModels = (data.models || []).map((m) => ({
        id: m.id || m.file?.replace(/\.(mdx|glb)$/i, '') || m.name,
        name: m.name || m.id || 'Unknown',
        category: m.category || 'Unit',
        path: m.path || m.glb || `models/${(m.id || m.file || m.name).replace(/\.(mdx|glb)$/i, '')}.glb`,
      }));

      // Keep model ordering stable and human-friendly: sort alphabetically by display name.
      // This ensures that within each Type/category, the list and the model <select> are sorted by name.
      allModels.sort((a, b) => {
        const an = (a.name || '').toLowerCase();
        const bn = (b.name || '').toLowerCase();
        const cmp = an.localeCompare(bn, undefined, { sensitivity: 'base' });
        return cmp !== 0 ? cmp : String(a.id).localeCompare(String(b.id), undefined, { sensitivity: 'base' });
      });

      return allModels;
    });
}

function renderModelList() {
  filteredModels = allModels.filter((m) => {
    const matchCategory = activeCategory === 'all' || m.category === activeCategory;
    const matchSearch = !searchQuery || m.name.toLowerCase().includes(searchQuery.toLowerCase()) || m.id.toLowerCase().includes(searchQuery.toLowerCase());
    return matchCategory && matchSearch;
  });

  const listEl = document.getElementById('model-list');
  listEl.innerHTML = filteredModels
    .map(
      (m) =>
        `<div class="model-item" data-id="${m.id}">
          <div class="name">${escapeHtml(m.name)}</div>
          <div class="category">${escapeHtml(m.category)}</div>
        </div>`
    )
    .join('');

  listEl.querySelectorAll('.model-item').forEach((el) => {
    el.addEventListener('click', () => loadModel(el.dataset.id));
  });

  document.getElementById('model-count').textContent = `${filteredModels.length} models`;
}

/** Play a clip from t=0 with looping (MDX clips are now exported with 0-based times). */
function playClipAtIndex(clips, index) {
  if (!mixer || !clips?.length) return;
  const clip = clips[index];
  if (!clip) return;
  mixer.stopAllAction();
  const action = mixer.clipAction(clip);
  action.reset();
  action.setLoop(THREE.LoopRepeat, Infinity);
  action.clampWhenFinished = false;
  action.enabled = true;
  action.play();

  const animationSel = document.getElementById('animation-select');
  if (animationSel) animationSel.value = String(index);

  // Keep desktop button highlight in sync (even if hidden on mobile).
  document.querySelectorAll('#animation-buttons .animation-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.index === String(index));
  });
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function readUrlQuery() {
  const p = new URLSearchParams(window.location.search);
  return {
    categoryParam: p.get('category'),
    modelParam: p.get('model'),
  };
}

function resolveCategoryFromParam(param) {
  if (!param) return 'all';
  const lower = param.toLowerCase();
  const found = getCategories().find((c) => c.toLowerCase() === lower);
  return found || 'all';
}

function modelMatchesActiveCategory(m) {
  return activeCategory === 'all' || m.category === activeCategory;
}

/** Sync ?category= (lowercase) and optional &model= (manifest id). */
function writeUrlQuery(modelId) {
  if (applyingUrlQuery) return;
  const u = new URL(window.location.href);
  if (activeCategory === 'all' && !modelId) {
    u.searchParams.delete('category');
    u.searchParams.delete('model');
  } else {
    u.searchParams.set('category', activeCategory === 'all' ? 'all' : activeCategory.toLowerCase());
    if (modelId) u.searchParams.set('model', modelId);
    else u.searchParams.delete('model');
  }
  const next = `${u.pathname}${u.search}${u.hash}`;
  if (next !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
    history.replaceState(null, '', next);
  }
}

function clearViewerSelection() {
  clearCurrentModel();
  document.getElementById('current-model').textContent = 'Select a model';
  document.querySelectorAll('.model-item').forEach((el) => el.classList.remove('active'));
  const modelSel = document.getElementById('model-select');
  if (modelSel) modelSel.value = '';
}

function onCategorySelectChange(e) {
  activeCategory = e.target.value;
  clearViewerSelection();
  renderModelList();
  renderModelSelect();
  writeUrlQuery(null);
}

function onModelSelectChange(e) {
  const id = e.target.value;
  if (!id) {
    clearViewerSelection();
    writeUrlQuery(null);
    return;
  }
  loadModel(id);
}

function renderModelSelect() {
  const sel = document.getElementById('model-select');
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = '';
  const ph = document.createElement('option');
  ph.value = '';
  ph.textContent = '— Select model —';
  sel.appendChild(ph);
  for (const m of filteredModels) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.name;
    sel.appendChild(opt);
  }
  if (prev && filteredModels.some((x) => x.id === prev)) sel.value = prev;
}

/** Max axis scale from world matrix (detects geoset nodes scaled to 0 for hide). */
function maxWorldAxisScale(matrixWorld) {
  _mxCol0.setFromMatrixColumn(matrixWorld, 0);
  _mxCol1.setFromMatrixColumn(matrixWorld, 1);
  _mxCol2.setFromMatrixColumn(matrixWorld, 2);
  return Math.max(_mxCol0.length(), _mxCol1.length(), _mxCol2.length());
}

/**
 * World-space AABB from mesh geometry only, skipping near-zero-scale meshes.
 * `Box3.setFromObject` can still include hidden MDX geosets (e.g. ground gibs at x≈-185) and pulls the center off-screen.
 */
function computeVisibleMeshesWorldBox(root, targetBox) {
  targetBox.makeEmpty();
  root.updateMatrixWorld(true);
  root.traverse((obj) => {
    if (!obj.isMesh) return;
    if (maxWorldAxisScale(obj.matrixWorld) < 1e-5) return;
    const geom = obj.geometry;
    if (!geom?.getAttribute('position')) return;
    if (!geom.boundingBox) geom.computeBoundingBox();
    _tmpBox.copy(geom.boundingBox).applyMatrix4(obj.matrixWorld);
    targetBox.union(_tmpBox);
  });
}

/**
 * Some exports keep all geoset nodes at scale 0 until the first visibility key (e.g. a few
 * frames into the clip). Framing at t≈0 then yields an empty "visible" AABB; falling back to
 * `setFromObject` can center on hidden/collision geometry far from the real mesh → empty viewport.
 * Step along the timeline until at least one mesh passes the visibility scale threshold.
 */
function seekMixerForVisibleBounds(mixer, root) {
  if (!mixer || typeof mixer.setTime !== 'function') return;
  const fps = 30;
  const maxSec = 10;
  const maxFrame = Math.ceil(maxSec * fps);
  for (let f = 0; f <= maxFrame; f++) {
    const t = f / fps;
    // setTime() resets internal clocks and applies that absolute time (Three.js r160+).
    mixer.setTime(t);
    root.updateMatrixWorld(true);
    const probe = new THREE.Box3();
    computeVisibleMeshesWorldBox(root, probe);
    if (!probe.isEmpty()) return t;
  }
  mixer.setTime(0);
  root.updateMatrixWorld(true);
  return 0;
}

/**
 * Fit `root` in view: center on origin, scale to target size, place camera (not top-down).
 * Call after mixer.update(0) so geoset visibility matches the first animation frame.
 */
function frameModelAndCamera(root) {
  controls.enableDamping = false;
  controls.minDistance = CONTROLS_MIN_DIST;
  controls.maxDistance = CONTROLS_MAX_DIST_INIT;

  const box = new THREE.Box3();
  computeVisibleMeshesWorldBox(root, box);
  if (box.isEmpty()) {
    box.setFromObject(root);
  }
  if (box.isEmpty()) {
    root.position.set(0, 0, 0);
    root.scale.setScalar(1);
    modelFrameDistance = DEFAULT_MODEL_FRAME_DISTANCE;
    framingTargetY = 0;
    camera.position.set(4.5 * FRAMING_ZOOM_OUT, 3.2 * FRAMING_ZOOM_OUT, 7.5 * FRAMING_ZOOM_OUT);
    controls.target.set(0, 0, 0);
    camera.near = 0.1;
    camera.far = 1000;
    camera.updateProjectionMatrix();
    controls.update();
    controls.enableDamping = true;
    return;
  }

  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z, 0.001);

  const targetSize = 6;
  const scale = Math.min(targetSize / maxDim, 1000);
  root.scale.setScalar(scale);
  root.position.set(-center.x * scale, -center.y * scale, -center.z * scale);
  root.updateMatrixWorld(true);

  const box2 = new THREE.Box3();
  computeVisibleMeshesWorldBox(root, box2);
  if (box2.isEmpty()) box2.setFromObject(root);
  const center2 = box2.getCenter(new THREE.Vector3());
  root.position.sub(center2);
  root.updateMatrixWorld(true);

  alignModelBottomToGround(root, GROUND_Y);

  const box3 = new THREE.Box3();
  computeVisibleMeshesWorldBox(root, box3);
  if (box3.isEmpty()) box3.setFromObject(root);
  const size2 = box3.getSize(new THREE.Vector3());
  const maxDim2 = Math.max(size2.x, size2.y, size2.z, maxDim * scale, 0.001);

  const vFov = (camera.fov * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
  const distV = maxDim2 / 2 / Math.tan(vFov / 2);
  const distH = maxDim2 / 2 / Math.tan(hFov / 2);
  const dist = Math.max(distV, distH, 1.5) * 1.15 * FRAMING_ZOOM_OUT;
  modelFrameDistance = dist;
  controls.maxDistance = Math.max(CONTROLS_MAX_DIST_INIT, dist * 4);

  // Front-quarter (Y-up): mostly +Z toward model, moderate elevation — avoids “top-down” feel.
  const dir = new THREE.Vector3(0.52, 0.42, 0.74).normalize();
  // Align horizontal orientation with expected "front".
  dir.applyAxisAngle(new THREE.Vector3(0, 1, 0), CAMERA_YAW_CORRECTION);
  // Raise look-at above model origin so the subject reads in the lower ~third of the viewport.
  framingTargetY = size2.y * FRAMING_TARGET_Y_FACTOR;
  controls.target.set(0, framingTargetY, 0);
  camera.position.copy(controls.target).add(dir.clone().multiplyScalar(dist));
  camera.near = Math.max(0.01, dist * 0.002);
  camera.far = Math.max(500, dist * 80);
  camera.updateProjectionMatrix();
  controls.update();
  controls.enableDamping = true;
}

function getCategories() {
  const cats = new Set(allModels.map((m) => m.category));
  return ['all', ...Array.from(cats).sort()];
}

function renderCategorySelect() {
  const container = document.getElementById('category-filter');
  const categories = getCategories();
  container.innerHTML = `
    <div class="filter-row">
      <label for="category-select">Type</label>
      <select id="category-select">
        ${categories
          .map(
            (c) =>
              `<option value="${escapeAttr(c)}">${c === 'all' ? 'All' : escapeHtml(c)}</option>`
          )
          .join('')}
      </select>
    </div>
    <div class="filter-row">
      <label for="model-select">Model</label>
      <select id="model-select"></select>
    </div>
  `;
  const catSel = document.getElementById('category-select');
  catSel.value = activeCategory;
  catSel.addEventListener('change', onCategorySelectChange);
  document.getElementById('model-select').addEventListener('change', onModelSelectChange);
}

function syncFromUrl() {
  applyingUrlQuery = true;
  const { categoryParam, modelParam } = readUrlQuery();
  activeCategory = resolveCategoryFromParam(categoryParam);
  const catSel = document.getElementById('category-select');
  if (catSel) catSel.value = activeCategory;
  renderModelList();
  renderModelSelect();
  if (modelParam) {
    const m = allModels.find((x) => x.id === modelParam);
    if (m && modelMatchesActiveCategory(m)) {
      loadModel(modelParam);
    } else {
      clearViewerSelection();
    }
  } else {
    clearViewerSelection();
  }
  applyingUrlQuery = false;
}

function loadModel(id) {
  const model = allModels.find((m) => m.id === id);
  if (!model) return;

  writeUrlQuery(id);

  clearCurrentModel();
  document.getElementById('current-model').textContent = model.name;
  document.querySelectorAll('.model-item').forEach((el) => el.classList.toggle('active', el.dataset.id === id));
  const modelSel = document.getElementById('model-select');
  if (modelSel && filteredModels.some((x) => x.id === id)) modelSel.value = id;

  const loader = new GLTFLoader();
  loader.load(
    model.path,
    (gltf) => {
      currentModel = gltf.scene;
      // Align WC3 models' up-axis to Three.js' Y-up.
      currentModel.rotateX(WC3_Z_UP_TO_Y_UP);
      currentModel.traverse((obj) => {
        if (!obj.isMesh) return;
        obj.frustumCulled = false;
        obj.castShadow = true;
        obj.receiveShadow = true;
        const mats = obj.material ? (Array.isArray(obj.material) ? obj.material : [obj.material]) : [];
        for (const m of mats) {
          if (!m) continue;
          // glTF `baseColorFactor` alpha can be 0 while `baseColorTexture` still carries the
          // real albedo + cutout. Three.js multiplies map by `opacity` → mesh disappears entirely
          // (seen on some units like Acolyte when MDX layer alpha is 0 but texture binds).
          if (m.map && typeof m.opacity === 'number' && m.opacity <= 1e-5) {
            m.opacity = 1;
          }
          if (!m.transparent) {
            m.side = THREE.DoubleSide;
          } else {
            // Avoid invisible transparent planes causing depth-fighting artifacts
            // (common for portrait background quads that may be alpha=0).
            m.depthWrite = false;
          }
        }
      });
      // WC3 models sometimes include a giant portrait-like backdrop card/plane.
      // It may be mis-tagged as skinned depending on the exporter, so we allow skinned planes.
      hidePortraitEngineBackdrop(currentModel, { allowSkinnedPlanes: true });
      modelGroup.add(currentModel);

      mixer = new THREE.AnimationMixer(currentModel);
      currentClips = gltf.animations || [];
      renderAnimationButtons(currentClips);

      if (currentClips.length > 0) {
        playClipAtIndex(currentClips, 0);
        const seekTime = seekMixerForVisibleBounds(mixer, currentModel);
        // frameModelAndCamera uses the seeked mixer state to pick correct bounds.
        // Later we may restore time to 0 depending on whether the model is visible.
        currentModel.userData._seekTime = seekTime ?? 0;
      } else if (mixer) {
        if (typeof mixer.setTime === 'function') mixer.setTime(0);
        else mixer.update(1e-4);
        currentModel.updateMatrixWorld(true);
      }

      frameModelAndCamera(currentModel);
      // Some exports keep geoset nodes at scale 0 until the first visibility key.
      // If we restored to t=0 unconditionally, the viewport can become empty (even grid).
      // Restore to t=0 only if something is still visible; otherwise keep the seeked time.
      if (mixer && typeof mixer.setTime === 'function') {
        const tmpBox = new THREE.Box3();
        const soughtT = currentModel.userData._seekTime ?? 0;
        mixer.setTime(0);
        currentModel.updateMatrixWorld(true);
        computeVisibleMeshesWorldBox(currentModel, tmpBox);
        if (tmpBox.isEmpty()) {
          mixer.setTime(soughtT);
          currentModel.updateMatrixWorld(true);
        }
      }
      const viewSel = document.getElementById('view-select');
      if (viewSel) viewSel.value = 'front';
      controls.saveState();
    },
    undefined,
    (err) => console.error('Failed to load model:', err)
  );
}

function clearCurrentModel() {
  currentClips = [];
  renderAnimationButtons(currentClips);
  if (mixer) {
    mixer.stopAllAction();
    mixer.uncacheRoot(currentModel);
    mixer = null;
  }
  if (currentModel) {
    modelGroup.remove(currentModel);
    currentModel.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
        else o.material.dispose();
      }
    });
    currentModel = null;
  }
  // Clear OrbitControls damping accumulators so the next model is not affected by orbit inertia
  // from the previous selection (fixes persistent black viewport when switching models).
  if (controls && camera) {
    controls.enableDamping = false;
    controls.minDistance = CONTROLS_MIN_DIST;
    controls.maxDistance = CONTROLS_MAX_DIST_INIT;
    camera.position.set(0, 2, 5);
    controls.target.set(0, 0, 0);
    camera.near = 0.1;
    camera.far = 1000;
    camera.updateProjectionMatrix();
    controls.update();
    controls.enableDamping = true;
    modelFrameDistance = DEFAULT_MODEL_FRAME_DISTANCE;
    framingTargetY = 0;
  }
}

function renderAnimationButtons(clips) {
  const container = document.getElementById('animation-buttons');
  const animationSel = document.getElementById('animation-select');

  if (clips.length === 0) {
    if (container) container.innerHTML = '<p style="color:#666;font-size:12px;">No animations</p>';
    if (animationSel) {
      animationSel.innerHTML = '<option value="" disabled selected>No animations</option>';
      animationSel.disabled = true;
    }
    return;
  }

  if (container) {
    container.innerHTML = clips
      .map(
        (clip, i) =>
          `<button class="animation-btn" data-index="${i}">${escapeHtml(clip.name || `Anim ${i}`)}</button>`
      )
      .join('');

    container.querySelectorAll('.animation-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (!mixer || !currentModel) return;
        const idx = parseInt(btn.dataset.index, 10);
        playClipAtIndex(clips, idx);
        mixer.update(0);
      });
    });
  }

  if (animationSel) {
    animationSel.disabled = false;
    animationSel.innerHTML = clips
      .map((clip, i) => `<option value="${i}">${escapeHtml(clip.name || `Anim ${i}`)}</option>`)
      .join('');
  }
}

function animate() {
  requestAnimationFrame(animate);
  // Tab backgrounding / devtools pauses can yield multi-second deltas and explode mixer time.
  const delta = Math.min(clock.getDelta(), 0.1);
  if (mixer) mixer.update(delta * animationSpeed * MDX_ANIM_BASE_SCALE);
  controls.update();
  renderer.render(scene, camera);
}

function applyViewPreset(preset) {
  const d = modelFrameDistance || DEFAULT_MODEL_FRAME_DISTANCE;
  if (!controls) return;

  if (preset === 'reset') {
    controls.reset();
    return;
  }

  if (preset === 'front') {
    controls.enableDamping = false;
    const baseX = 0;
    const baseZ = d * 0.92;
    const r = rotateAroundY(baseX, baseZ, CAMERA_YAW_CORRECTION);
    const ty = framingTargetY;
    controls.target.set(0, ty, 0);
    camera.position.set(r.x, ty + d * 0.38, r.z);
    controls.update();
    controls.enableDamping = true;
    return;
  }

  if (preset === 'side') {
    controls.enableDamping = false;
    const baseX = d * 0.95;
    const baseZ = d * 0.12;
    const r = rotateAroundY(baseX, baseZ, CAMERA_YAW_CORRECTION);
    const ty = framingTargetY;
    controls.target.set(0, ty, 0);
    camera.position.set(r.x, ty + d * 0.35, r.z);
    controls.update();
    controls.enableDamping = true;
  }
}

function setupUI() {
  document.getElementById('search-input').addEventListener('input', (e) => {
    searchQuery = e.target.value;
    renderModelList();
    renderModelSelect();
  });

  window.addEventListener('popstate', () => syncFromUrl());

  document.getElementById('btn-reset').addEventListener('click', () => applyViewPreset('reset'));
  document.getElementById('btn-front').addEventListener('click', () => applyViewPreset('front'));
  document.getElementById('btn-side').addEventListener('click', () => applyViewPreset('side'));

  const viewSel = document.getElementById('view-select');
  if (viewSel) {
    viewSel.addEventListener('change', (e) => {
      applyViewPreset(e.target.value);
    });
  }

  document.getElementById('speed-slider').addEventListener('input', (e) => {
    animationSpeed = parseFloat(e.target.value);
    document.getElementById('speed-display').textContent = `${animationSpeed < 10 ? animationSpeed.toFixed(1) : animationSpeed.toFixed(0)}x`;
  });

  document.getElementById('btn-light-default').addEventListener('click', () => setLightPreset('default'));
  document.getElementById('btn-light-dark').addEventListener('click', () => setLightPreset('dark'));
  document.getElementById('btn-light-bright').addEventListener('click', () => setLightPreset('bright'));

  const lightingSel = document.getElementById('lighting-select');
  if (lightingSel) {
    lightingSel.addEventListener('change', (e) => setLightPreset(e.target.value));
  }

  const animationSel = document.getElementById('animation-select');
  if (animationSel) {
    animationSel.addEventListener('change', (e) => {
      if (!mixer || !currentModel) return;
      const idx = parseInt(e.target.value, 10);
      if (Number.isNaN(idx)) return;
      playClipAtIndex(currentClips, idx);
      mixer.update(0);
    });
  }
}

function setLightPreset(name) {
  lightPreset = name;
  const p = LIGHT_PRESETS[name];
  ambientLight.intensity = p.ambient;
  directionalLight.intensity = p.directional;
  document.querySelectorAll('#controls button[id^="btn-light"]').forEach((b) => b.classList.toggle('active', b.id === `btn-light-${name}`));

  const lightingSel = document.getElementById('lighting-select');
  if (lightingSel) lightingSel.value = name;
}

async function main() {
  init();
  setupUI();

  try {
    await loadManifest();
    applyingUrlQuery = true;
    const { categoryParam, modelParam } = readUrlQuery();
    activeCategory = resolveCategoryFromParam(categoryParam);
    renderCategorySelect();
    renderModelList();
    renderModelSelect();
    if (modelParam) {
      const m = allModels.find((x) => x.id === modelParam);
      if (m && modelMatchesActiveCategory(m)) loadModel(modelParam);
    }
    applyingUrlQuery = false;
  } catch (e) {
    document.getElementById('model-count').textContent = 'Failed to load manifest';
    document.getElementById('model-list').innerHTML = '<p style="color:#666;padding:15px;">Run: node scripts/generate-model-manifest.mjs</p>';
  }

  document.getElementById('loading').classList.add('hidden');
  requestAnimationFrame(() => {
    resize();
    animate();
  });
}

main();
