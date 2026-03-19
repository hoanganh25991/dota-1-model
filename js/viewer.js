/**
 * Warcraft 3 Model Browser
 * Loads models from WarcraftModels/manifest.json
 * Displays model list, supports search/category filter, plays real WC3 animations from GLB
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const MANIFEST_URL = 'WarcraftModels/manifest.json';

let scene, camera, renderer, controls;
let modelGroup, currentModel, mixer, clock;
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

/** MDX timelines are long in wall-clock seconds; ~25× matches typical WC3 in-engine speed at slider 1×. */
const MDX_ANIM_BASE_SCALE = 25;

/**
 * WC3 MDX is Z-up, while glTF / Three.js is Y-up.
 * Rotate models so "up" lines up with the browser camera intuition.
 */
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
let modelFrameDistance = 8;

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
  scene.background = new THREE.Color(0x0a0a0f);

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
  controls.minDistance = 0.5;
  controls.maxDistance = 50;
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
  scene.add(directionalLight);

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
 * Fit `root` in view: center on origin, scale to target size, place camera (not top-down).
 * Call after mixer.update(0) so geoset visibility matches the first animation frame.
 */
function frameModelAndCamera(root) {
  const box = new THREE.Box3();
  computeVisibleMeshesWorldBox(root, box);
  if (box.isEmpty()) {
    box.setFromObject(root);
  }
  if (box.isEmpty()) {
    root.position.set(0, 0, 0);
    root.scale.setScalar(1);
    modelFrameDistance = 8;
    camera.position.set(4.5, 3.2, 7.5);
    controls.target.set(0, 0, 0);
    camera.near = 0.1;
    camera.far = 1000;
    camera.updateProjectionMatrix();
    controls.update();
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

  const box3 = new THREE.Box3();
  computeVisibleMeshesWorldBox(root, box3);
  if (box3.isEmpty()) box3.setFromObject(root);
  const size2 = box3.getSize(new THREE.Vector3());
  const maxDim2 = Math.max(size2.x, size2.y, size2.z, maxDim * scale, 0.001);

  const vFov = (camera.fov * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
  const distV = maxDim2 / 2 / Math.tan(vFov / 2);
  const distH = maxDim2 / 2 / Math.tan(hFov / 2);
  const dist = Math.max(distV, distH, 1.5) * 1.15;
  modelFrameDistance = dist;
  controls.maxDistance = Math.max(controls.maxDistance, dist * 4);

  // Front-quarter (Y-up): mostly +Z toward model, moderate elevation — avoids “top-down” feel.
  const dir = new THREE.Vector3(0.52, 0.42, 0.74).normalize();
  // Align horizontal orientation with expected "front".
  dir.applyAxisAngle(new THREE.Vector3(0, 1, 0), CAMERA_YAW_CORRECTION);
  camera.position.copy(dir.multiplyScalar(dist));
  controls.target.set(0, 0, 0);
  camera.near = Math.max(0.01, dist * 0.002);
  camera.far = Math.max(500, dist * 80);
  camera.updateProjectionMatrix();
  controls.update();
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
        if (obj.isMesh) {
          obj.frustumCulled = false;
          if (obj.material) {
            const m = Array.isArray(obj.material) ? obj.material[0] : obj.material;
            if (m && !m.transparent) m.side = THREE.DoubleSide;
          }
        }
      });
      modelGroup.add(currentModel);

      mixer = new THREE.AnimationMixer(currentModel);
      currentClips = gltf.animations || [];
      renderAnimationButtons(currentClips);

      if (currentClips.length > 0) {
        playClipAtIndex(currentClips, 0);
        document.querySelector('#animation-buttons .animation-btn')?.classList.add('active');
      }
      // Geoset hide/show + bones: must run before bounding box / centering
      if (typeof mixer.setTime === 'function') mixer.setTime(0);
      // Force the mixer to evaluate frame 0 channels (some rigs only apply on update()).
      mixer.update(1e-4);
      currentModel.updateMatrixWorld(true);

      frameModelAndCamera(currentModel);
      controls.saveState();
    },
    undefined,
    (err) => console.error('Failed to load model:', err)
  );
}

function clearCurrentModel() {
  currentClips = [];
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
}

function renderAnimationButtons(clips) {
  const container = document.getElementById('animation-buttons');
  if (clips.length === 0) {
    container.innerHTML = '<p style="color:#666;font-size:12px;">No animations</p>';
    return;
  }

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
      container.querySelectorAll('.animation-btn').forEach((b) => b.classList.toggle('active', b.dataset.index === btn.dataset.index));
    });
  });
}

function animate() {
  requestAnimationFrame(animate);
  const delta = clock.getDelta();
  if (mixer) mixer.update(delta * animationSpeed * MDX_ANIM_BASE_SCALE);
  controls.update();
  renderer.render(scene, camera);
}

function setupUI() {
  document.getElementById('search-input').addEventListener('input', (e) => {
    searchQuery = e.target.value;
    renderModelList();
    renderModelSelect();
  });

  window.addEventListener('popstate', () => syncFromUrl());

  document.getElementById('btn-reset').addEventListener('click', () => {
    controls.reset();
  });

  document.getElementById('btn-front').addEventListener('click', () => {
    const d = modelFrameDistance || 8;
    const baseX = 0;
    const baseZ = d * 0.92;
    const r = rotateAroundY(baseX, baseZ, CAMERA_YAW_CORRECTION);
    camera.position.set(r.x, d * 0.38, r.z);
    controls.target.set(0, 0, 0);
    controls.update();
  });

  document.getElementById('btn-side').addEventListener('click', () => {
    const d = modelFrameDistance || 8;
    const baseX = d * 0.95;
    const baseZ = d * 0.12;
    const r = rotateAroundY(baseX, baseZ, CAMERA_YAW_CORRECTION);
    camera.position.set(r.x, d * 0.35, r.z);
    controls.target.set(0, 0, 0);
    controls.update();
  });

  document.getElementById('speed-slider').addEventListener('input', (e) => {
    animationSpeed = parseFloat(e.target.value);
    document.getElementById('speed-display').textContent = `${animationSpeed < 10 ? animationSpeed.toFixed(1) : animationSpeed.toFixed(0)}x`;
  });

  document.getElementById('btn-light-default').addEventListener('click', () => setLightPreset('default'));
  document.getElementById('btn-light-dark').addEventListener('click', () => setLightPreset('dark'));
  document.getElementById('btn-light-bright').addEventListener('click', () => setLightPreset('bright'));
}

function setLightPreset(name) {
  lightPreset = name;
  const p = LIGHT_PRESETS[name];
  ambientLight.intensity = p.ambient;
  directionalLight.intensity = p.directional;
  document.querySelectorAll('#controls button[id^="btn-light"]').forEach((b) => b.classList.toggle('active', b.id === `btn-light-${name}`));
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
