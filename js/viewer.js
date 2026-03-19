/**
 * Warcraft 3 Model Browser
 * Loads models from WarcraftModels/manifest.json
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const MODEL_DIR = '';
const MANIFEST_URL = 'WarcraftModels/manifest.json';

const canvas = document.getElementById('canvas');
const loadingEl = document.getElementById('loading');
const modelListEl = document.getElementById('model-list');
const searchInput = document.getElementById('search-input');
const modelCountEl = document.getElementById('model-count');
const currentModelEl = document.getElementById('current-model');
const animButtonsEl = document.getElementById('animation-buttons');
const speedSlider = document.getElementById('speed-slider');
const speedDisplay = document.getElementById('speed-display');
const categoryFilterEl = document.getElementById('category-filter');

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.35;
renderer.physicallyCorrectLights = true;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0a0f);
scene.fog = new THREE.Fog(0x0a0a0f, 10, 50);

// Environment (helps PBR / untextured materials not render black)
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(0, 1, 3);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.minDistance = 0.1;
controls.maxDistance = 100;
controls.target.set(0, 0, 0);

const lightingPresets = {
    default: { ambient: 0x404060, main: { color: 0xffffff, intensity: 1.2, pos: [5, 10, 5] }, fill: { color: 0x00ff88, intensity: 0.2, pos: [-5, 5, -5] } },
    dark: { ambient: 0x202030, main: { color: 0x8888aa, intensity: 0.8, pos: [5, 10, 5] }, fill: { color: 0x4444ff, intensity: 0.1, pos: [-5, 5, -5] } },
    bright: { ambient: 0x606080, main: { color: 0xffffff, intensity: 1.5, pos: [10, 15, 10] }, fill: { color: 0xffffee, intensity: 0.3, pos: [-10, 10, -10] } }
};

let lights = {};

function setupLighting(preset = 'default') {
    Object.values(lights).forEach(l => l && scene.remove(l));
    const p = lightingPresets[preset];
    lights.hemi = new THREE.HemisphereLight(0xbfd7ff, 0x0a0a0f, 0.9);
    lights.hemi.position.set(0, 10, 0);
    scene.add(lights.hemi);
    lights.ambient = new THREE.AmbientLight(p.ambient, 0.6);
    scene.add(lights.ambient);
    lights.main = new THREE.DirectionalLight(p.main.color, p.main.intensity);
    lights.main.position.set(...p.main.pos);
    lights.main.castShadow = true;
    lights.main.shadow.mapSize.width = 2048;
    lights.main.shadow.mapSize.height = 2048;
    lights.main.shadow.camera.near = 0.5;
    lights.main.shadow.camera.far = 100;
    lights.main.shadow.camera.left = -20;
    lights.main.shadow.camera.right = 20;
    lights.main.shadow.camera.top = 20;
    lights.main.shadow.camera.bottom = -20;
    scene.add(lights.main);
    lights.fill = new THREE.DirectionalLight(p.fill.color, p.fill.intensity);
    lights.fill.position.set(...p.fill.pos);
    scene.add(lights.fill);
}

const groundGeo = new THREE.PlaneGeometry(50, 50);
const groundMat = new THREE.MeshStandardMaterial({ color: 0x111118, roughness: 0.8, metalness: 0.2 });
const ground = new THREE.Mesh(groundGeo, groundMat);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const gridHelper = new THREE.GridHelper(50, 50, 0x1a1a22, 0x111118);
gridHelper.position.y = 0.001;
scene.add(gridHelper);

let currentModel = null;
let mixer = null;
let clipActions = new Map();
let clock = new THREE.Clock();
let animationSpeed = 1.0;
let modelCache = new Map();
let allModels = [];
let filteredModels = [];
let currentCategory = 'All';

const categories = ['All', 'Unit', 'Hero', 'Portrait', 'Effect', 'Particle', 'Blood', 'Spirit', 'Cinematic'];

function disposeObject3D(root) {
    if (!root) return;
    root.traverse((child) => {
        if (!child) return;
        if (child.geometry) child.geometry.dispose();
        if (child.material) {
            if (Array.isArray(child.material)) child.material.forEach((m) => m?.dispose?.());
            else child.material.dispose();
        }
    });
}

function fitCameraToObject(object3d, { padding = 1.25 } = {}) {
    const box = getBoundsSafe(object3d);
    if (!Number.isFinite(box.min.x) || box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    controls.target.copy(center);
    controls.update();
    const maxDim = Math.max(size.x, size.y, size.z);
    const fov = THREE.MathUtils.degToRad(camera.fov);
    let distance = (maxDim / 2) / Math.tan(fov / 2);
    distance *= padding;
    const dir = new THREE.Vector3().subVectors(camera.position, controls.target).normalize();
    camera.position.copy(center).addScaledVector(dir, distance);
    // Prevent near-plane clipping artifacts when orbiting close to skinned models.
    camera.near = 0.001;
    // Reduce far/near ratio to avoid depth precision artifacts.
    camera.far = Math.max(100, distance * 30);
    camera.updateProjectionMatrix();
    // Keep orbiting/zooming far enough to avoid near-plane slice artifacts.
    controls.minDistance = distance * 0.2;
    controls.maxDistance = distance * 10;
    controls.update();
}

async function init() {
    setupLighting('default');

    function updateSize() {
        const viewer = document.getElementById('viewer');
        const w = viewer.clientWidth;
        const h = viewer.clientHeight;
        renderer.setSize(w, h);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
    }

    window.addEventListener('resize', updateSize);
    updateSize();
    setupControls();
    await loadManifest();
    loadingEl.classList.add('hidden');
    animate();
}

async function loadManifest() {
    try {
        const response = await fetch(MANIFEST_URL);
        if (!response.ok) {
            throw new Error('Manifest not found');
        }
        const manifest = await response.json();
        allModels = manifest.models || [];
        const convertedText = manifest.converted != null ? ` (${manifest.converted} converted)` : '';
        modelCountEl.textContent = `${allModels.length} models${convertedText}`;
    } catch (err) {
        console.error('Failed to load manifest:', err);
        modelCountEl.textContent = 'Manifest not found. Run: node scripts/generate-model-manifest.mjs';
        allModels = [];
    }

    // Set Unit as default
    currentCategory = 'Unit';
    filteredModels = allModels.filter(m => m.category === currentCategory);
    renderCategoryFilter();
    renderModelList();

    if (filteredModels.length > 0) {
        loadModel(filteredModels[0]);
    }
}

function renderCategoryFilter() {
    categoryFilterEl.innerHTML = '';

    categories.forEach(cat => {
        const count = cat === 'All' ? allModels.length : allModels.filter(m => m.category === cat).length;
        if (count === 0) return;

        const btn = document.createElement('button');
        btn.className = 'category-btn' + (cat === currentCategory ? ' active' : '');
        btn.textContent = `${cat} (${count})`;
        btn.addEventListener('click', () => selectCategory(cat));
        categoryFilterEl.appendChild(btn);
    });
}

function selectCategory(category) {
    currentCategory = category;
    filteredModels = category === 'All' ? allModels : allModels.filter(m => m.category === category);

    document.querySelectorAll('.category-btn').forEach(btn => {
        btn.classList.toggle('active', btn.textContent.startsWith(category));
    });

    renderModelList();

    if (filteredModels.length > 0) {
        loadModel(filteredModels[0]);
    }
}

function renderModelList() {
    modelListEl.innerHTML = '';

    if (filteredModels.length === 0) {
        modelListEl.innerHTML = '<div style="padding: 20px; color: #666; text-align: center;">No models found</div>';
        return;
    }

    filteredModels.forEach((model, index) => {
        const item = document.createElement('div');
        item.className = 'model-item';
        item.dataset.index = index;

        item.innerHTML = `
            <div class="name">${model.name}</div>
            <div class="category">${model.category}</div>
        `;

        item.addEventListener('click', () => selectModel(index));
        modelListEl.appendChild(item);
    });
}

function selectModel(index) {
    document.querySelectorAll('.model-item').forEach((item, i) => {
        item.classList.toggle('active', i === index);
    });
    loadModel(filteredModels[index]);
}

async function loadModel(modelInfo) {
    currentModelEl.textContent = modelInfo.name;

    const modelPath = MODEL_DIR + modelInfo.glb;

    if (currentModel) {
        scene.remove(currentModel);
        disposeObject3D(currentModel);
    }

    if (mixer) {
        mixer.stopAllAction();
        mixer = null;
        clipActions.clear();
    }

    if (modelCache.has(modelInfo.name)) {
        const cached = modelCache.get(modelInfo.name);
        currentModel = cached.scene.clone();
        scene.add(currentModel);
        patchSkinnedMeshSkeleton(currentModel);
        centerModel();
        setupAnimations({ hasAnimations: cached.animations && cached.animations.length > 0 });
        if (cached.animations && cached.animations.length > 0) {
            mixer = new THREE.AnimationMixer(currentModel);
            clipActions.clear();
            cached.animations.forEach((clip) => {
                const action = mixer.clipAction(clip);
                // Some models name clips like "Death 2" or "Death - X".
                const isDeath = /death/i.test(clip.name);
                action.setLoop(isDeath ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
                action.clampWhenFinished = isDeath;
                clipActions.set(clip.name, action);
                clipActions.set(clip.name.toLowerCase(), action);
            });
            const stand = clipActions.get('stand') || clipActions.get('Stand') || clipActions.get(cached.animations[0].name);
            if (stand) stand.play();
        }
        return;
    }

    try {
        loadingEl.querySelector('p').textContent = `Loading ${modelInfo.name}...`;
        loadingEl.classList.remove('hidden');

        const loader = new GLTFLoader();
        const gltf = await loader.loadAsync(modelPath);

        currentModel = gltf.scene;
        scene.add(currentModel);
        patchSkinnedMeshSkeleton(currentModel);

        modelCache.set(modelInfo.name, { scene: currentModel.clone(), animations: gltf.animations || [] });

        setupAnimations({ hasAnimations: gltf.animations && gltf.animations.length > 0 });
        if (gltf.animations && gltf.animations.length > 0) {
            mixer = new THREE.AnimationMixer(currentModel);
            clipActions.clear();
            gltf.animations.forEach((clip) => {
                const action = mixer.clipAction(clip);
                const isDeath = /death/i.test(clip.name);
                action.setLoop(isDeath ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
                action.clampWhenFinished = isDeath;
                clipActions.set(clip.name, action);
                clipActions.set(clip.name.toLowerCase(), action);
            });
            const stand = clipActions.get('stand') || clipActions.get('Stand') || clipActions.get(gltf.animations[0].name);
            if (stand) stand.play();
        }

        loadingEl.classList.add('hidden');

        requestAnimationFrame(() => {
            centerModel();
        });
    } catch (error) {
        console.error('Failed to load model:', error);
        loadingEl.querySelector('p').textContent = 'Failed to load: ' + modelInfo.name;
        setTimeout(() => loadingEl.classList.add('hidden'), 2000);
    }
}

function patchSkinnedMeshSkeleton(root) {
    root.traverse((obj) => {
        if (obj.isSkinnedMesh && obj.skeleton && obj.skeleton.bones) {
            // Avoid frustum culling / bounding-sphere computations that can touch invalid bones.
            obj.frustumCulled = false;
            // Prevent Three.js from computing bounding spheres from skinned vertices on every frame.
            // That code path calls into SkinnedMesh vertex skinning in JS and can crash if any joint/bone mapping is off.
            if (obj.geometry) {
                if (!obj.geometry.boundingSphere) {
                    obj.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1);
                }
                if (!obj.geometry.boundingBox) {
                    obj.geometry.boundingBox = new THREE.Box3(
                        new THREE.Vector3(-1, -1, -1),
                        new THREE.Vector3(1, 1, 1)
                    );
                }
            }
            const bones = obj.skeleton.bones;
            const fallback = bones.find((b) => b != null) || bones[0];

            // If Three.js failed to create all bones referenced by the skinIndex attribute,
            // ensure bones/boneInverses are defined up to the maximum referenced index.
            if (fallback && obj.geometry?.attributes?.skinIndex) {
                const skinIndexAttr = obj.geometry.attributes.skinIndex;
                const arr = skinIndexAttr.array;
                let maxJoint = 0;
                for (let i = 0; i < arr.length; i++) {
                    if (arr[i] > maxJoint) maxJoint = arr[i];
                }

                for (let i = 0; i <= maxJoint; i++) {
                    if (bones[i] == null) bones[i] = fallback;
                }

                if (obj.skeleton.boneInverses) {
                    const inverses = obj.skeleton.boneInverses;
                    const fallbackInv = inverses.find((m) => m != null) || inverses[0];
                    if (fallbackInv) {
                        for (let i = 0; i <= maxJoint; i++) {
                            if (inverses[i] == null) inverses[i] = fallbackInv;
                        }
                    }
                }
            }
        }
    });
}

function getBoundsSafe(obj) {
    obj.updateMatrixWorld(true);
    let useFallback = false;
    obj.traverse((c) => { if (c.isSkinnedMesh) useFallback = true; });
    if (!useFallback) {
        try {
            const box = new THREE.Box3().setFromObject(obj);
            if (!box.isEmpty()) return box;
        } catch (_) {}
    }
    const fallback = new THREE.Box3();
    const _v = new THREE.Vector3();

    // IMPORTANT: do not call geometry.computeBoundingBox() here.
    // On some skinned models (like Ogre), that can block the main thread for a long time.
    // Instead, sample a subset of vertices from the position attribute.
    const SAMPLE_TARGET = 5000;
    obj.traverse((child) => {
        if (!child.isMesh || !child.geometry) return;
        const pos = child.geometry.attributes?.position;
        if (!pos || !pos.count) return;

        const count = pos.count;
        const step = Math.max(1, Math.floor(count / SAMPLE_TARGET));
        const arr = pos.array;

        for (let i = 0; i < count; i += step) {
            const ix = i * 3;
            _v.set(arr[ix], arr[ix + 1], arr[ix + 2]);
            _v.applyMatrix4(child.matrixWorld);
            fallback.expandByPoint(_v);
        }
    });
    if (fallback.isEmpty()) fallback.setFromCenterAndSize(new THREE.Vector3(0, 0, 0), new THREE.Vector3(2, 2, 2));
    return fallback;
}

function centerModel() {
    if (!currentModel) return;

    const preBox = getBoundsSafe(currentModel);
    const preSize = preBox.getSize(new THREE.Vector3());
    const preMaxDim = Math.max(preSize.x, preSize.y, preSize.z);
    const scale = preMaxDim > 0 ? 2.0 / preMaxDim : 1.0;
    currentModel.scale.setScalar(scale);
    currentModel.rotation.x = -Math.PI / 2;

    const box = getBoundsSafe(currentModel);
    const center = box.getCenter(new THREE.Vector3());
    currentModel.position.x -= center.x;
    currentModel.position.z -= center.z;
    currentModel.position.y -= box.min.y;

    currentModel.traverse(child => {
        if (child.isMesh) {
            child.castShadow = true;
            child.receiveShadow = true;
        }
    });

    fitCameraToObject(currentModel, { padding: 1.35 });
}

function setupAnimations({ hasAnimations = false } = {}) {
    animButtonsEl.innerHTML = '';

    if (!hasAnimations) {
        animButtonsEl.textContent = 'No animations in this model';
        return;
    }

    const defaultAnims = ['Stand', 'Walk', 'Attack', 'Death', 'Spell'];

    defaultAnims.forEach((anim, index) => {
        const btn = document.createElement('button');
        btn.className = 'animation-btn' + (index === 0 ? ' active' : '');
        btn.textContent = anim;
        btn.addEventListener('click', () => playAnimation(anim));
        animButtonsEl.appendChild(btn);
    });
}

function playAnimation(animName) {
    document.querySelectorAll('.animation-btn').forEach(btn => {
        btn.classList.toggle('active', btn.textContent === animName);
    });
    if (!mixer || !clipActions.size) return;
    mixer.stopAllAction();
    const key = animName.toLowerCase();
    let action = clipActions.get(key);
    if (!action) {
        for (const [name, a] of clipActions) {
            if (name.toLowerCase().startsWith(key) || name.toLowerCase().includes(key)) {
                action = a;
                break;
            }
        }
    }
    if (action) {
        action.timeScale = animationSpeed;
        action.play();
    }
}

function setupControls() {
    // Search - searches across all models
    searchInput.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase().trim();

        if (query === '') {
            filteredModels = currentCategory === 'All' ? allModels : allModels.filter(m => m.category === currentCategory);
        } else {
            filteredModels = allModels.filter(m =>
                m.name.toLowerCase().includes(query) &&
                (currentCategory === 'All' || m.category === currentCategory)
            );
        }

        renderModelList();

        if (filteredModels.length > 0) {
            loadModel(filteredModels[0]);
        }
    });

    // Speed slider
    speedSlider.addEventListener('input', (e) => {
        animationSpeed = parseFloat(e.target.value);
        speedDisplay.textContent = animationSpeed.toFixed(2) + 'x';
    });

    // View buttons
    document.getElementById('btn-reset').addEventListener('click', () => {
        if (currentModel) fitCameraToObject(currentModel, { padding: 1.35 });
        else { camera.position.set(0, 1, 3); controls.target.set(0, 0, 0); }
    });
    document.getElementById('btn-front').addEventListener('click', () => {
        if (!currentModel) return;
        const box = getBoundsSafe(currentModel);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const d = Math.max(size.x, size.y, size.z) * 0.8;
        controls.target.copy(center);
        camera.position.set(center.x, center.y, center.z + d);
        camera.lookAt(center);
    });
    document.getElementById('btn-side').addEventListener('click', () => {
        if (!currentModel) return;
        const box = getBoundsSafe(currentModel);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const d = Math.max(size.x, size.y, size.z) * 0.8;
        controls.target.copy(center);
        camera.position.set(center.x + d, center.y, center.z);
        camera.lookAt(center);
    });

    // Lighting buttons
    document.querySelectorAll('[id^="btn-light"]').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('[id^="btn-light"]').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            setupLighting(btn.id.replace('btn-light-', ''));
        });
    });

    canvas.addEventListener('contextmenu', e => e.preventDefault());
}

function animate() {
    requestAnimationFrame(animate);
    const delta = clock.getDelta();
    if (mixer) {
        mixer.timeScale = animationSpeed;
        mixer.update(delta);
    }
    controls.update();
    renderer.render(scene, camera);
}

init();
