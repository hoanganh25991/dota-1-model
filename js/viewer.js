/**
 * Warcraft 3 Model Browser
 * Loads models from WarcraftModels/manifest.json
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

// GLOBAL PATCH: Override SkinnedMesh.computeBoundingSphere to prevent crashes
// This runs before any models are loaded
const originalComputeBoundingSphere = THREE.SkinnedMesh.prototype.computeBoundingSphere;
THREE.SkinnedMesh.prototype.computeBoundingSphere = function() {
    try {
        // Check if skeleton has all required bones
        if (this.skeleton && this.skeleton.bones) {
            const bones = this.skeleton.bones;
            const skinIndexAttr = this.geometry?.attributes?.skinIndex;
            if (skinIndexAttr) {
                const arr = skinIndexAttr.array;
                let maxJoint = 0;
                for (let i = 0; i < arr.length; i++) {
                    if (arr[i] > maxJoint) maxJoint = arr[i];
                }
                // If bones array doesn't have all referenced joints, return default sphere
                if (bones.length <= maxJoint) {
                    if (!this.geometry.boundingSphere) {
                        this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.5, 0), 2);
                    }
                    return this.geometry.boundingSphere;
                }
                // Check for undefined bones
                for (let i = 0; i <= maxJoint; i++) {
                    if (!bones[i] || !bones[i].matrixWorld) {
                        if (!this.geometry.boundingSphere) {
                            this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.5, 0), 2);
                        }
                        return this.geometry.boundingSphere;
                    }
                }
            }
        }
        return originalComputeBoundingSphere.call(this);
    } catch (e) {
        // Return default bounding sphere on any error
        if (!this.geometry.boundingSphere) {
            this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.5, 0), 2);
        }
        return this.geometry.boundingSphere;
    }
};

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
    console.log('fitCameraToObject - box:', box.min.x.toFixed(2), box.min.y.toFixed(2), box.min.z.toFixed(2), 'to', box.max.x.toFixed(2), box.max.y.toFixed(2), box.max.z.toFixed(2));

    if (!Number.isFinite(box.min.x) || box.isEmpty()) {
        console.log('fitCameraToObject - empty or invalid box, returning');
        return;
    }

    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    console.log('fitCameraToObject - size:', size.x.toFixed(2), size.y.toFixed(2), size.z.toFixed(2));
    console.log('fitCameraToObject - center:', center.x.toFixed(2), center.y.toFixed(2), center.z.toFixed(2));

    controls.target.copy(center);
    controls.update();

    const maxDim = Math.max(size.x, size.y, size.z);
    const fov = THREE.MathUtils.degToRad(camera.fov);
    let distance = (maxDim / 2) / Math.tan(fov / 2);
    distance *= padding;
    console.log('fitCameraToObject - maxDim:', maxDim.toFixed(2), 'distance:', distance.toFixed(2));

    // Default camera direction (from front)
    const dir = new THREE.Vector3(0, 0, 1);
    camera.position.copy(center).addScaledVector(dir, distance);
    camera.lookAt(center);

    console.log('fitCameraToObject - camera position:', camera.position.x.toFixed(2), camera.position.y.toFixed(2), camera.position.z.toFixed(2));

    // Prevent near-plane clipping artifacts when orbiting close to skinned models.
    camera.near = 0.01;
    // Reduce far/near ratio to avoid depth precision artifacts.
    camera.far = Math.max(1000, distance * 50);
    camera.updateProjectionMatrix();
    // Keep orbiting/zooming far enough to avoid near-plane slice artifacts.
    controls.minDistance = 0.1;
    controls.maxDistance = distance * 20;
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

        // Apply patches BEFORE adding to scene to avoid computeBoundingSphere crashes
        patchSkinnedMeshSkeleton(currentModel);

        scene.add(currentModel);
        centerModel();
        setupAnimations({
            hasAnimations: cached.animations && cached.animations.length > 0,
            animationNames: cached.animations ? cached.animations.map(a => a.name) : []
        });
        if (cached.animations && cached.animations.length > 0) {
            // Clone the animation clips so they work with the cloned scene
            const clonedAnimations = cached.animations.map(clip => {
                // Create a new clip with the same data
                const newClip = clip.clone();
                return newClip;
            });

            mixer = new THREE.AnimationMixer(currentModel);
            clipActions.clear();
            clonedAnimations.forEach((clip) => {
                const action = mixer.clipAction(clip);
                // Some models name clips like "Death 2" or "Death - X".
                const isDeath = /death/i.test(clip.name);
                action.setLoop(isDeath ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
                action.clampWhenFinished = isDeath;
                clipActions.set(clip.name, action);
                clipActions.set(clip.name.toLowerCase(), action);
            });
            const stand = clipActions.get('stand') || clipActions.get('Stand') || clipActions.get(clonedAnimations[0].name);
            if (stand) {
                stand.reset();
                stand.play();
            }
        }
        return;
    }

    try {
        loadingEl.querySelector('p').textContent = `Loading ${modelInfo.name}...`;
        loadingEl.classList.remove('hidden');

        const loader = new GLTFLoader();
        const gltf = await loader.loadAsync(modelPath);

        currentModel = gltf.scene;

        // Apply patches BEFORE adding to scene
        patchSkinnedMeshSkeleton(currentModel);

        scene.add(currentModel);

        modelCache.set(modelInfo.name, { scene: currentModel.clone(), animations: gltf.animations || [] });

        setupAnimations({ hasAnimations: gltf.animations && gltf.animations.length > 0 });
        if (gltf.animations && gltf.animations.length > 0) {
            console.log('Loading animations:', gltf.animations.map(a => a.name));

            mixer = new THREE.AnimationMixer(currentModel);

            // Set up callback to update skeleton matrices before each frame
            mixer.addEventListener('loop', (e) => {
                // Ensure skeletons are updated when animations loop
                currentModel.traverse((obj) => {
                    if (obj.isSkinnedMesh && obj.skeleton) {
                        obj.skeleton.update();
                    }
                });
            });

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
            if (stand) {
                stand.reset();
                stand.play();
                console.log('Playing stand animation');
            }
        }

        loadingEl.classList.add('hidden');

        // Debug: Check what we loaded
        console.log('Model loaded:', modelInfo.name);
        console.log('Scene children:', currentModel.children.length);
        let meshCount = 0;
        let skinnedMeshCount = 0;
        let materialInfo = [];
        currentModel.traverse((o) => {
            if (o.isMesh) {
                meshCount++;
                if (Array.isArray(o.material)) {
                    o.material.forEach((m, i) => {
                        materialInfo.push({
                            mesh: o.name,
                            index: i,
                            type: m.type,
                            hasMap: !!m.map,
                            color: m.color ? m.color.getHexString() : 'none'
                        });
                    });
                } else if (o.material) {
                    materialInfo.push({
                        mesh: o.name,
                        index: 0,
                        type: o.material.type,
                        hasMap: !!o.material.map,
                        color: o.material.color ? o.material.color.getHexString() : 'none'
                    });
                }
            }
            if (o.isSkinnedMesh) skinnedMeshCount++;
        });
        console.log('Mesh count:', meshCount, 'SkinnedMesh count:', skinnedMeshCount);
        console.log('Materials:', materialInfo);

        requestAnimationFrame(() => {
            centerModel();

            // Debug camera position after centering
            console.log('Camera position after centering:', camera.position.x.toFixed(2), camera.position.y.toFixed(2), camera.position.z.toFixed(2));
            console.log('Controls target:', controls.target.x.toFixed(2), controls.target.y.toFixed(2), controls.target.z.toFixed(2));
        });
    } catch (error) {
        console.error('Failed to load model:', error);
        loadingEl.querySelector('p').textContent = 'Failed to load: ' + modelInfo.name;
        setTimeout(() => loadingEl.classList.add('hidden'), 2000);
    }
}

function patchSkinnedMeshSkeleton(root) {
    const dummyBone = new THREE.Bone();
    dummyBone.name = 'dummy_fallback_bone';
    dummyBone.updateMatrix();
    dummyBone.updateMatrixWorld();

    root.traverse((obj) => {
        if (obj.isSkinnedMesh) {
            // Disable frustum culling to avoid bounding sphere computations
            obj.frustumCulled = false;

            // Set up valid bounding sphere/box and prevent recalculation
            if (obj.geometry) {
                // Create a generous bounding sphere that encompasses the model
                obj.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.5, 0), 2);
                obj.geometry.boundingBox = new THREE.Box3(
                    new THREE.Vector3(-2, -1, -2),
                    new THREE.Vector3(2, 3, 2)
                );

                // Override computeBoundingSphere to prevent crashes
                obj.geometry.computeBoundingSphere = function() {
                    if (!this.boundingSphere) {
                        this.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.5, 0), 2);
                    }
                    return this.boundingSphere;
                };

                // Also override computeBoundingBox
                obj.geometry.computeBoundingBox = function() {
                    if (!this.boundingBox) {
                        this.boundingBox = new THREE.Box3(
                            new THREE.Vector3(-2, -1, -2),
                            new THREE.Vector3(2, 3, 2)
                        );
                    }
                    return this.boundingBox;
                };
            }

            // Ensure skeleton exists and is valid
            if (!obj.skeleton) {
                console.warn('SkinnedMesh without skeleton:', obj.name);
                return;
            }

            const skeleton = obj.skeleton;
            const bones = skeleton.bones;

            // Find the max joint index referenced by skinIndex attribute
            let maxJointIndex = 0;
            if (obj.geometry && obj.geometry.attributes.skinIndex) {
                const skinIndexArray = obj.geometry.attributes.skinIndex.array;
                for (let i = 0; i < skinIndexArray.length; i++) {
                    maxJointIndex = Math.max(maxJointIndex, skinIndexArray[i]);
                }
            }

            // Ensure bones array has entries for all referenced joints
            while (bones.length <= maxJointIndex) {
                const newBone = new THREE.Bone();
                newBone.name = 'auto_bone_' + bones.length;
                newBone.copy(dummyBone);
                bones.push(newBone);
            }

            // Replace any undefined/null bones with the dummy bone
            for (let i = 0; i < bones.length; i++) {
                if (!bones[i]) {
                    const replacement = new THREE.Bone();
                    replacement.name = 'replacement_bone_' + i;
                    replacement.copy(dummyBone);
                    bones[i] = replacement;
                }
            }

            // Ensure boneInverses array matches bones length
            if (!skeleton.boneInverses) {
                skeleton.boneInverses = [];
            }

            const identityMatrix = new THREE.Matrix4();
            while (skeleton.boneInverses.length < bones.length) {
                skeleton.boneInverses.push(identityMatrix.clone());
            }

            // Recalculate inverse matrices if needed
            skeleton.calculateInverses();

            // Force skeleton update
            skeleton.update();
        }
    });
}

function getBoundsSafe(obj) {
    const fallback = new THREE.Box3();
    const _v = new THREE.Vector3();

    // Sample from all meshes
    // For skinned meshes, we need to be careful not to trigger computeBoundingSphere
    // We'll read the position data directly from the buffer attribute
    const SAMPLE_TARGET = 5000;
    obj.traverse((child) => {
        if (!child.isMesh || !child.geometry) return;

        const pos = child.geometry.attributes?.position;
        if (!pos || !pos.count) return;

        const count = pos.count;
        const step = Math.max(1, Math.floor(count / SAMPLE_TARGET));
        const arr = pos.array;

        // Get the mesh's world matrix
        // For skinned meshes, we need to manually update the matrix without triggering bounding sphere calc
        if (child.isSkinnedMesh) {
            // Update the matrix without calling the full updateMatrixWorld
            // which might trigger computeBoundingSphere
            child.matrixWorld.copy(child.matrix);
            if (child.parent) {
                child.matrixWorld.premultiply(child.parent.matrixWorld);
            }
        } else {
            child.updateMatrixWorld();
        }

        for (let i = 0; i < count; i += step) {
            const ix = i * 3;
            _v.set(arr[ix], arr[ix + 1], arr[ix + 2]);
            _v.applyMatrix4(child.matrixWorld);
            fallback.expandByPoint(_v);
        }
    });

    // If we couldn't get bounds, use a default
    if (fallback.isEmpty()) {
        fallback.setFromCenterAndSize(new THREE.Vector3(0, 0.5, 0), new THREE.Vector3(2, 2, 2));
    }
    return fallback;
}

function centerModel() {
    if (!currentModel) return;

    console.log('Centering model...');

    const preBox = getBoundsSafe(currentModel);
    const preSize = preBox.getSize(new THREE.Vector3());
    console.log('Pre-scale bounds size:', preSize.x.toFixed(2), preSize.y.toFixed(2), preSize.z.toFixed(2));

    const preMaxDim = Math.max(preSize.x, preSize.y, preSize.z);
    const scale = preMaxDim > 0 ? 2.0 / preMaxDim : 1.0;
    console.log('Applying scale:', scale.toFixed(3));

    currentModel.scale.setScalar(scale);

    const box = getBoundsSafe(currentModel);
    const center = box.getCenter(new THREE.Vector3());
    console.log('Post-scale center:', center.x.toFixed(2), center.y.toFixed(2), center.z.toFixed(2));
    console.log('Post-scale bounds min:', box.min.x.toFixed(2), box.min.y.toFixed(2), box.min.z.toFixed(2));
    console.log('Post-scale bounds max:', box.max.x.toFixed(2), box.max.y.toFixed(2), box.max.z.toFixed(2));

    currentModel.position.x -= center.x;
    currentModel.position.z -= center.z;
    currentModel.position.y -= box.min.y;

    console.log('Final position:', currentModel.position.x.toFixed(2), currentModel.position.y.toFixed(2), currentModel.position.z.toFixed(2));

    currentModel.traverse(child => {
        if (child.isMesh) {
            child.castShadow = true;
            child.receiveShadow = true;
        }
    });

    fitCameraToObject(currentModel, { padding: 1.35 });
}

function setupAnimations({ hasAnimations = false, animationNames = [] } = {}) {
    animButtonsEl.innerHTML = '';

    if (!hasAnimations || animationNames.length === 0) {
        animButtonsEl.textContent = 'No animations in this model';
        return;
    }

    // Use unique animation names (some models have duplicates like multiple "Stand" sequences)
    const uniqueAnims = [...new Set(animationNames.map(a => a.replace(/\s*-\s*\d+$/, '').trim()))];

    // Sort to prioritize common animations first
    const priorityOrder = ['Stand', 'Walk', 'Attack', 'Death', 'Spell', 'Sleep', 'Decay'];
    uniqueAnims.sort((a, b) => {
        const aIndex = priorityOrder.findIndex(p => a.toLowerCase().includes(p.toLowerCase()));
        const bIndex = priorityOrder.findIndex(p => b.toLowerCase().includes(p.toLowerCase()));
        if (aIndex !== -1 && bIndex === -1) return -1;
        if (bIndex !== -1 && aIndex === -1) return 1;
        if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
        return a.localeCompare(b);
    });

    uniqueAnims.forEach((anim, index) => {
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

    // Stop all current animations
    mixer.stopAllAction();

    const key = animName.toLowerCase();
    let action = clipActions.get(key);

    // Try to find matching animation with fuzzy matching
    if (!action) {
        for (const [name, a] of clipActions) {
            if (name.toLowerCase().startsWith(key) || name.toLowerCase().includes(key)) {
                action = a;
                break;
            }
        }
    }

    if (action) {
        // Reset animation to start
        action.reset();
        action.timeScale = animationSpeed;
        action.play();
        console.log('Playing animation:', action.getClip().name);
    } else {
        console.warn('Animation not found:', animName, 'Available:', Array.from(clipActions.keys()).filter((_, i) => i % 2 === 0));
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

        // Ensure skeleton matrices are updated after animation update
        // Wrap in try-catch to prevent crashes from bad bone references
        if (currentModel) {
            try {
                currentModel.traverse((obj) => {
                    if (obj.isSkinnedMesh && obj.skeleton) {
                        try {
                            obj.skeleton.update();
                        } catch (e) {
                            // Silent fail for individual skeleton updates
                        }
                    }
                });
            } catch (e) {
                // Silent fail for traversal
            }
        }
    }
    controls.update();
    renderer.render(scene, camera);
}

init();
