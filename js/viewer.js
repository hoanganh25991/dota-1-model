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

function getCategories() {
  const cats = new Set(allModels.map((m) => m.category));
  return ['all', ...Array.from(cats).sort()];
}

function renderCategoryFilter() {
  const container = document.getElementById('category-filter');
  const categories = getCategories();
  container.innerHTML = categories
    .map(
      (c) =>
        `<button class="category-btn ${c === activeCategory ? 'active' : ''}" data-cat="${c}">${c === 'all' ? 'All' : c}</button>`
    )
    .join('');

  container.querySelectorAll('.category-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeCategory = btn.dataset.cat;
      container.querySelectorAll('.category-btn').forEach((b) => b.classList.toggle('active', b.dataset.cat === activeCategory));
      renderModelList();
    });
  });
}

function loadModel(id) {
  const model = allModels.find((m) => m.id === id);
  if (!model) return;

  clearCurrentModel();
  document.getElementById('current-model').textContent = model.name;
  document.querySelectorAll('.model-item').forEach((el) => el.classList.toggle('active', el.dataset.id === id));

  const loader = new GLTFLoader();
  loader.load(
    model.path,
    (gltf) => {
      currentModel = gltf.scene;
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

      const box = new THREE.Box3().setFromObject(currentModel);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z, 0.001);

      const targetSize = 6;
      const scale = Math.min(targetSize / maxDim, 1000);
      currentModel.scale.setScalar(scale);
      // Position must account for scale: world_pos = position + scale * localVertex
      // To center, we need: position = -scale * center
      currentModel.position.set(
        -center.x * scale,
        -center.y * scale,
        -center.z * scale
      );

      const distance = targetSize * 1.5;
      camera.position.set(0, targetSize * 0.3, distance);
      controls.target.set(0, 0, 0);
      controls.update();

      mixer = new THREE.AnimationMixer(currentModel);
      currentClips = gltf.animations || [];
      renderAnimationButtons(currentClips);

      if (currentClips.length > 0) {
        playClipAtIndex(currentClips, 0);
        document.querySelector('#animation-buttons .animation-btn')?.classList.add('active');
      }
      // Apply first frame of active clip so skinned meshes match poses immediately
      mixer.update(0);
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
  if (mixer) mixer.update(delta * animationSpeed);
  controls.update();
  renderer.render(scene, camera);
}

function setupUI() {
  document.getElementById('search-input').addEventListener('input', (e) => {
    searchQuery = e.target.value;
    renderModelList();
  });

  document.getElementById('btn-reset').addEventListener('click', () => {
    controls.reset();
  });

  document.getElementById('btn-front').addEventListener('click', () => {
    camera.position.set(0, 0, 5);
    controls.target.set(0, 0, 0);
    controls.update();
  });

  document.getElementById('btn-side').addEventListener('click', () => {
    camera.position.set(5, 0, 0);
    controls.target.set(0, 0, 0);
    controls.update();
  });

  document.getElementById('speed-slider').addEventListener('input', (e) => {
    animationSpeed = parseFloat(e.target.value);
    document.getElementById('speed-display').textContent = `${animationSpeed.toFixed(1)}x`;
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
    renderCategoryFilter();
    renderModelList();
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
