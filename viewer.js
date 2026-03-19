/**
 * Warcraft 3 Model Browser
 * Loads models from WarcraftModels/manifest.json
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

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
renderer.toneMappingExposure = 1.2;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0a0f);
scene.fog = new THREE.Fog(0x0a0a0f, 10, 50);

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
    Object.values(lights).forEach(l => scene.remove(l));
    const p = lightingPresets[preset];
    lights.ambient = new THREE.AmbientLight(p.ambient, 0.5);
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
let clock = new THREE.Clock();
let animationSpeed = 1.0;
let modelCache = new Map();
let allModels = [];
let filteredModels = [];
let currentCategory = 'All';

const categories = ['All', 'Unit', 'Hero', 'Portrait', 'Effect', 'Particle', 'Blood', 'Spirit', 'Cinematic'];

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
        modelCountEl.textContent = `${allModels.length} models (${manifest.converted} converted)`;
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
        currentModel.traverse(child => {
            if (child.geometry) child.geometry.dispose();
            if (child.material) {
                if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
                else child.material.dispose();
            }
        });
    }

    if (mixer) {
        mixer.stopAllAction();
        mixer = null;
    }

    if (modelCache.has(modelInfo.name)) {
        currentModel = modelCache.get(modelInfo.name).clone();
        scene.add(currentModel);
        centerModel();
        setupAnimations();
        return;
    }

    try {
        loadingEl.querySelector('p').textContent = `Loading ${modelInfo.name}...`;
        loadingEl.classList.remove('hidden');

        const loader = new GLTFLoader();
        const gltf = await loader.loadAsync(modelPath);

        currentModel = gltf.scene;
        scene.add(currentModel);

        modelCache.set(modelInfo.name, currentModel.clone());

        centerModel();
        setupAnimations();

        loadingEl.classList.add('hidden');
    } catch (error) {
        console.error('Failed to load model:', error);
        loadingEl.querySelector('p').textContent = 'Failed to load: ' + modelInfo.name;
        setTimeout(() => loadingEl.classList.add('hidden'), 2000);
    }
}

function centerModel() {
    if (!currentModel) return;

    const box = new THREE.Box3().setFromObject(currentModel);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const scale = 2 / maxDim;

    currentModel.position.sub(center);
    currentModel.position.y = -box.min.y * scale;
    currentModel.scale.setScalar(scale);

    currentModel.traverse(child => {
        if (child.isMesh) {
            child.castShadow = true;
            child.receiveShadow = true;
        }
    });
}

function setupAnimations() {
    animButtonsEl.innerHTML = '';
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
        camera.position.set(0, 1, 3);
        controls.target.set(0, 0, 0);
    });
    document.getElementById('btn-front').addEventListener('click', () => {
        camera.position.set(0, 1, 3);
        controls.target.set(0, 0, 0);
    });
    document.getElementById('btn-side').addEventListener('click', () => {
        camera.position.set(3, 1, 0);
        controls.target.set(0, 0, 0);
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

    if (currentModel) {
        const activeBtn = document.querySelector('.animation-btn.active');
        const animName = activeBtn ? activeBtn.textContent : 'Stand';
        const time = Date.now() * 0.001 * animationSpeed;

        currentModel.traverse(child => {
            if (child.isMesh) {
                switch (animName) {
                    case 'Stand':
                        child.position.y = Math.sin(time * 2) * 0.02;
                        child.rotation.y = Math.sin(time * 0.5) * 0.1;
                        break;
                    case 'Walk':
                        child.position.y = Math.abs(Math.sin(time * 8)) * 0.05;
                        child.rotation.y = Math.sin(time * 4) * 0.15;
                        break;
                    case 'Attack':
                        child.rotation.x = Math.sin(time * 10) * 0.5;
                        break;
                    case 'Spell':
                        child.position.y = Math.sin(time * 5) * 0.1;
                        child.rotation.z = Math.sin(time * 3) * 0.2;
                        break;
                    case 'Death':
                        child.rotation.x = Math.PI / 2 * Math.min(1, (time % 5) / 2);
                        child.position.y = -0.5 + Math.max(0, ((time % 5) - 2)) * 0.1;
                        break;
                }
            }
        });
    }

    controls.update();
    renderer.render(scene, camera);
}

init();