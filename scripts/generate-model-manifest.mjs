#!/usr/bin/env node
/**
 * Scan WarcraftModels/ for *.mdx files
 * Convert each MDX to GLB for browser viewing (with BLP textures, UVs, skeleton, and animations)
 * Write manifest.json with model list
 */
import fs from 'fs';
import path from 'path';
import { mat4, quat, vec3 } from 'gl-matrix';
import { parseMDX, decodeBLP, getBLPImageData } from 'war3-model';
import UPNG from 'upng-js';

const WC3_FRAME_RATE = 1000; // MDX frames are typically in millisecs; 1000 frames = 1 sec

// Warcraft 3 uses Z-up coordinate system, glTF uses Y-up
// Transform matrix to convert Z-up to Y-up
const Z_UP_TO_Y_UP = mat4.fromValues(
  1, 0, 0, 0,
  0, 0, 1, 0,
  0, -1, 0, 0,
  0, 0, 0, 1
);

const MODEL_DIR = path.join(process.cwd(), 'WarcraftModels');
const OUTPUT_DIR = path.join(process.cwd(), 'models');
const MANIFEST_PATH = path.join(MODEL_DIR, 'manifest.json');

if (!fs.existsSync(MODEL_DIR)) {
    console.error('WarcraftModels directory not found.');
    process.exit(1);
}

if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

const files = fs.readdirSync(MODEL_DIR)
    .filter((f) => f.toLowerCase().endsWith('.mdx'))
    .sort();

console.log(`Found ${files.length} MDX files`);

const models = [];
let converted = 0;
let skipped = 0;
let errors = 0;

for (const file of files) {
    const mdxPath = path.join(MODEL_DIR, file);
    const glbPath = path.join(OUTPUT_DIR, file.replace(/\.mdx$/i, '.glb'));

    const modelName = formatModelName(file.replace(/\.mdx$/i, ''));

    if (fs.existsSync(glbPath)) {
        skipped++;
        models.push({
            name: modelName,
            file: file,
            glb: 'models/' + file.replace(/\.mdx$/i, '.glb'),
            category: categorizeModel(file)
        });
        continue;
    }

    try {
        const buffer = fs.readFileSync(mdxPath);
        const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
        const model = parseMDX(arrayBuffer);

        const result = convertToGLB(model, MODEL_DIR);
        fs.writeFileSync(glbPath, result);
        converted++;

        models.push({
            name: modelName,
            file: file,
            glb: 'models/' + file.replace(/\.mdx$/i, '.glb'),
            category: categorizeModel(file)
        });

        if (converted % 50 === 0) {
            console.log(`Converted ${converted}/${files.length}...`);
        }
    } catch (err) {
        if (err.message === 'No geometry') {
            // Skip cameras, effects, etc. without counting as error
            continue;
        }
        errors++;
        console.error(`Error converting ${file}: ${err.message}`);
    }
}

// Sort by category then name
models.sort((a, b) => {
    if (a.category !== b.category) return a.category.localeCompare(b.category);
    return a.name.localeCompare(b.name);
});

const manifest = {
    generated: new Date().toISOString(),
    count: models.length,
    converted,
    skipped,
    errors,
    models
};

fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8');
console.log(`\nDone! Converted ${converted}, Skipped ${skipped}, Errors ${errors}`);
console.log(`Manifest written to ${MANIFEST_PATH}`);

function formatModelName(name) {
    return name
        .replace(/_/g, ' ')
        .replace(/V(\d+)/g, ' v$1')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/\s+/g, ' ')
        .trim();
}

// Convert Z-up (WC3) coordinates to Y-up (glTF)
function convertZupToYup(v) {
    if (!v || v.length < 3) return v;
    return [v[0], v[2], -v[1]];
}

// Get initial geoset visibility (alpha) for a given sequence
// Returns array of alpha values (1.0 = visible, 0.0 = hidden) per geoset
function getGeosetVisibilityForSequence(geosetAnims, sequence, geosetCount) {
    const alphas = new Array(geosetCount).fill(1.0);
    if (!geosetAnims || geosetAnims.length === 0) {
        return alphas;
    }

    const interval = sequence.Interval;
    const startFrame = interval ? interval[0] : 0;
    const endFrame = interval ? interval[1] : 1000;
    const midFrame = (startFrame + endFrame) / 2;

    for (const ga of geosetAnims) {
        const geosetId = ga.GeosetId;
        if (geosetId == null || geosetId < 0 || geosetId >= geosetCount) continue;

        // Get alpha at the middle of the sequence
        const alpha = getGeosetAlphaAtTime(ga, midFrame);
        alphas[geosetId] = Math.max(0, Math.min(1, alpha));
    }

    return alphas;
}

// Determine if a geoset should be visible by default (for 'Stand' sequence)
function getDefaultGeosetVisibility(model, geosetIndex) {
    const geosetAnims = model.GeosetAnims || [];
    const sequences = model.Sequences || [];

    // Find Stand sequence
    const standSeq = sequences.find(s => (s.Name || '').toLowerCase().includes('stand'));
    if (!standSeq) {
        return true; // Default to visible if no Stand sequence
    }

    const alphas = getGeosetVisibilityForSequence(geosetAnims, standSeq, model.Geosets.length);
    return alphas[geosetIndex] > 0.5;
}

// Get alpha value for a geoset at a specific time
// Warcraft 3 behavior: if no keys at/before the time, geoset is visible (alpha=1)
// Keys only affect visibility at and after their frame times
function getGeosetAlphaAtTime(geosetAnim, frame) {
    if (!geosetAnim || !geosetAnim.Alpha || !geosetAnim.Alpha.Keys || geosetAnim.Alpha.Keys.length === 0) {
        return 1.0; // Default to visible
    }

    const keys = geosetAnim.Alpha.Keys;

    // Sort by frame
    const sortedKeys = keys.slice().sort((a, b) => a.Frame - b.Frame);

    // Before first keyframe - default to visible (1.0)
    // The first key only takes effect AT that frame, not before
    if (frame < sortedKeys[0].Frame) {
        return 1.0;
    }

    // At or after first keyframe
    // Find the key that applies at this frame
    let currentValue = 1.0; // Default before any keys

    for (let i = 0; i < sortedKeys.length; i++) {
        const k = sortedKeys[i];
        const v = k.Value !== undefined ? k.Value : k.Vector[0];

        if (frame >= k.Frame) {
            // This key applies
            currentValue = v;
        } else {
            // We've gone past the query frame
            break;
        }
    }

    return currentValue;
}

function categorizeModel(filename) {
    const name = filename.toLowerCase();
    if (name.includes('portrait')) return 'Portrait';
    if (name.includes('hero')) return 'Hero';
    if (name.includes('missile') || name.includes('impact') || name.includes('special')) return 'Effect';
    if (name.includes('_cin') || name.includes('camera')) return 'Cinematic';
    if (name.includes('ghost') || name.includes('spirit')) return 'Spirit';
    if (name.includes('blood')) return 'Blood';
    if (name.includes('fire') || name.includes('smoke') || name.includes('fog') || name.includes('dust')) return 'Particle';
    return 'Unit';
}

function resolveTexturePath(modelDir, textureImage) {
    if (!textureImage || typeof textureImage !== 'string') return null;
    const normalized = textureImage.replace(/\\/g, path.sep).trim();
    if (!normalized.toLowerCase().endsWith('.blp')) return null;
    const candidates = [
        path.join(modelDir, normalized),
        path.join(modelDir, path.basename(normalized)),
        path.join(modelDir, path.basename(normalized.toLowerCase())),
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }
    return null;
}

function loadTextureAsPngBuffer(modelDir, textureImage) {
    const resolved = resolveTexturePath(modelDir, textureImage);
    if (!resolved) return null;
    try {
        const buf = fs.readFileSync(resolved);
        const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        const blp = decodeBLP(arrayBuffer);
        if (!blp.mipmaps || blp.mipmaps.length === 0) return null;
        const imageData = getBLPImageData(blp, 0);
        if (!imageData || !imageData.data || !imageData.width || !imageData.height) return null;
        const w = imageData.width;
        const h = imageData.height;
        const data = imageData.data;
        const rgba = data.byteOffset === 0 && data.byteLength === w * h * 4
            ? data.buffer
            : new Uint8Array(data).buffer;
        const pngAb = UPNG.encode([rgba], w, h, 0);
        return Buffer.from(pngAb);
    } catch (e) {
        return null;
    }
}

function convertToGLB(model, modelDir) {
    const textures = model.Textures || [];
    const materials = model.Materials || [];
    const geosets = model.Geosets || [];
    const bones = model.Bones || [];
    const geosetAnims = model.GeosetAnimations || [];

    const primitives = [];
    const accessors = [];
    const bufferViews = [];
    const images = [];
    const samplers = [{ wrapS: 10497, wrapT: 10497 }];
    const gltfTextures = [];
    const gltfMaterials = [];

    let bufferOffset = 0;
    const bufferChunks = [];

    // Build geoset visibility lookup for default (Stand) pose
    const geosetVisibility = [];
    for (let i = 0; i < geosets.length; i++) {
        geosetVisibility.push(getDefaultGeosetVisibility(model, i));
    }

    const textureCache = new Map();
    function getMaterialIndex(textureImage) {
        const key = (textureImage || '').trim();
        if (textureCache.has(key)) return textureCache.get(key);
        const pngBuf = loadTextureAsPngBuffer(modelDir, key);
        const matIndex = gltfMaterials.length;
        textureCache.set(key, matIndex);
        if (pngBuf && pngBuf.length > 0) {
            const viewIndex = bufferViews.length;
            bufferViews.push({
                buffer: 0,
                byteOffset: bufferOffset,
                byteLength: pngBuf.length
            });
            bufferChunks.push(pngBuf);
            bufferOffset += pngBuf.length;
            const imageIndex = images.length;
            images.push({ bufferView: viewIndex, mimeType: 'image/png' });
            const texIndex = gltfTextures.length;
            gltfTextures.push({ sampler: 0, source: imageIndex });
            gltfMaterials.push({
                pbrMetallicRoughness: {
                    baseColorTexture: { index: texIndex },
                    metallicFactor: 0,
                    roughnessFactor: 1
                },
                alphaMode: 'MASK',
                alphaCutoff: 0.5
            });
        } else {
            gltfMaterials.push({
                pbrMetallicRoughness: {
                    baseColorFactor: [0.5, 0.5, 0.5, 1],
                    metallicFactor: 0,
                    roughnessFactor: 1
                }
            });
        }
        return matIndex;
    }

    // Build bone to geoset mapping for skin weights
    // MDX uses vertex groups that map to bones, but we need to map correctly
    const boneGeosetMap = new Map(); // boneId -> Set of geoset indices
    const geosetBoneMap = new Map(); // geoset index -> Set of bone indices used

    for (let gi = 0; gi < geosets.length; gi++) {
        const geoset = geosets[gi];
        if (!geoset.VertexGroup || geoset.VertexGroup.length === 0) continue;

        const usedBones = new Set();
        for (let i = 0; i < geoset.VertexGroup.length; i++) {
            let boneIdx = geoset.VertexGroup[i];
            if (!Number.isFinite(boneIdx)) boneIdx = 0;
            boneIdx = Math.trunc(boneIdx);
            if (boneIdx < 0) boneIdx = 0;
            if (boneIdx >= bones.length) boneIdx = bones.length - 1;
            usedBones.add(boneIdx);
        }
        geosetBoneMap.set(gi, usedBones);
    }

    for (let geosetIdx = 0; geosetIdx < geosets.length; geosetIdx++) {
        const geoset = geosets[geosetIdx];
        if (!geoset.Vertices || !geoset.Faces) continue;

        // Skip geosets that are invisible by default (death geosets, etc.)
        const isVisible = geosetVisibility[geosetIdx];
        // Still include invisible geosets but mark them - they may be animated later
        // For now, skip them entirely to avoid visual artifacts
        if (!isVisible) {
            console.log(`  Skipping geoset ${geosetIdx} - hidden by default`);
            continue;
        }

        const vCount = geoset.Vertices.length / 3;

        // Convert positions from Z-up to Y-up
        const positions = new Float32Array(vCount * 3);
        for (let i = 0; i < vCount; i++) {
            const x = geoset.Vertices[i * 3];
            const y = geoset.Vertices[i * 3 + 1];
            const z = geoset.Vertices[i * 3 + 2];
            // Z-up to Y-up: (x, y, z) -> (x, z, -y)
            positions[i * 3] = x;
            positions[i * 3 + 1] = z;
            positions[i * 3 + 2] = -y;
        }

        // Convert normals from Z-up to Y-up
        let normals;
        if (geoset.Normals && geoset.Normals.length >= vCount * 3) {
            normals = new Float32Array(vCount * 3);
            for (let i = 0; i < vCount; i++) {
                const x = geoset.Normals[i * 3];
                const y = geoset.Normals[i * 3 + 1];
                const z = geoset.Normals[i * 3 + 2];
                // Z-up to Y-up for normals
                normals[i * 3] = x;
                normals[i * 3 + 1] = z;
                normals[i * 3 + 2] = -y;
            }
        } else {
            normals = new Float32Array(vCount * 3);
            for (let i = 0; i < vCount; i++) normals[i * 3 + 1] = 1;
        }

        // UVs - Warcraft 3 uses (0,0) at top-left, glTF uses (0,0) at bottom-left
        // Need to flip V coordinate: v' = 1 - v
        // Also clamp to [0, 1] to avoid texture wrapping issues
        let uvs;
        if (geoset.TVertices && geoset.TVertices[0] && geoset.TVertices[0].length >= vCount * 2) {
            uvs = new Float32Array(vCount * 2);
            for (let i = 0; i < vCount; i++) {
                // U stays the same, clamp to valid range
                let u = geoset.TVertices[0][i * 2];
                uvs[i * 2] = Math.max(0, Math.min(1, u));

                // Flip V and clamp to valid range
                let v = geoset.TVertices[0][i * 2 + 1];
                uvs[i * 2 + 1] = Math.max(0, Math.min(1, 1.0 - v));
            }
        } else {
            uvs = new Float32Array(vCount * 2);
            uvs.fill(0);
        }

        const materialId = (geoset.MaterialID != null && geoset.MaterialID >= 0 && materials[geoset.MaterialID])
            ? geoset.MaterialID
            : 0;
        const layer = materials[materialId]?.Layers?.[0];
        const textureId = (layer && layer.TextureID != null && layer.TextureID >= 0) ? layer.TextureID : 0;
        const textureImage = textures[textureId]?.Image;
        const matIndex = getMaterialIndex(textureImage);

        const posBuf = Buffer.alloc(positions.length * 4);
        for (let i = 0; i < positions.length; i++) posBuf.writeFloatLE(positions[i], i * 4);
        const normBuf = Buffer.alloc(normals.length * 4);
        for (let i = 0; i < normals.length; i++) normBuf.writeFloatLE(normals[i], i * 4);

        const uvBuf = Buffer.alloc(uvs.length * 4);
        for (let i = 0; i < uvs.length; i++) uvBuf.writeFloatLE(uvs[i], i * 4);

        const indices = geoset.Faces;
        const indicesBuf = Buffer.alloc(indices.length * 2);
        for (let i = 0; i < indices.length; i++) indicesBuf.writeUInt16LE(indices[i], i * 2);

        const posOffset = bufferOffset;
        bufferChunks.push(posBuf);
        bufferOffset += posBuf.length;
        const normOffset = bufferOffset;
        bufferChunks.push(normBuf);
        bufferOffset += normBuf.length;
        const uvOffset = bufferOffset;
        bufferChunks.push(uvBuf);
        bufferOffset += uvBuf.length;
        const indOffset = bufferOffset;
        bufferChunks.push(indicesBuf);
        bufferOffset += indicesBuf.length;

        const posMin = [
            Math.min(...Array.from(positions).filter((_, i) => i % 3 === 0)),
            Math.min(...Array.from(positions).filter((_, i) => i % 3 === 1)),
            Math.min(...Array.from(positions).filter((_, i) => i % 3 === 2))
        ];
        const posMax = [
            Math.max(...Array.from(positions).filter((_, i) => i % 3 === 0)),
            Math.max(...Array.from(positions).filter((_, i) => i % 3 === 1)),
            Math.max(...Array.from(positions).filter((_, i) => i % 3 === 2))
        ];

        const nBV = bufferViews.length;
        bufferViews.push(
            { buffer: 0, byteOffset: posOffset, byteLength: posBuf.length, target: 34962 },
            { buffer: 0, byteOffset: normOffset, byteLength: normBuf.length, target: 34962 },
            { buffer: 0, byteOffset: uvOffset, byteLength: uvBuf.length, target: 34962 },
            { buffer: 0, byteOffset: indOffset, byteLength: indicesBuf.length, target: 34963 }
        );

        const nAcc = accessors.length;
        const primAttrs = { POSITION: nAcc, NORMAL: nAcc + 1, TEXCOORD_0: nAcc + 2 };
        accessors.push(
            { bufferView: nBV, componentType: 5126, count: vCount, type: 'VEC3', min: posMin, max: posMax },
            { bufferView: nBV + 1, componentType: 5126, count: vCount, type: 'VEC3' },
            { bufferView: nBV + 2, componentType: 5126, count: vCount, type: 'VEC2' },
            { bufferView: nBV + 3, componentType: 5123, count: indices.length, type: 'SCALAR' }
        );

        // Improved skin weights with validation
        if (bones.length > 0 && geoset.VertexGroup && geoset.VertexGroup.length >= vCount) {
            const jointsBuf = Buffer.alloc(vCount * 4);
            const weightsBuf = Buffer.alloc(vCount * 4 * 4);

            for (let i = 0; i < vCount; i++) {
                // MDX VertexGroup can contain invalid indices (commonly -1 for "no bone").
                // glTF/Three.js expects joint indices in [0, bones.length - 1].
                let j = geoset.VertexGroup[i];
                if (!Number.isFinite(j)) j = 0;
                j = Math.trunc(j);
                if (j < 0) j = 0;
                j = Math.min(j, bones.length - 1);

                jointsBuf.writeUInt8(j, i * 4);
                jointsBuf.writeUInt8(0, i * 4 + 1);
                jointsBuf.writeUInt8(0, i * 4 + 2);
                jointsBuf.writeUInt8(0, i * 4 + 3);
                weightsBuf.writeFloatLE(1, i * 16);
                weightsBuf.writeFloatLE(0, i * 16 + 4);
                weightsBuf.writeFloatLE(0, i * 16 + 8);
                weightsBuf.writeFloatLE(0, i * 16 + 12);
            }
            const jOffset = bufferOffset;
            bufferChunks.push(jointsBuf);
            bufferOffset += jointsBuf.length;
            const wOffset = bufferOffset;
            bufferChunks.push(weightsBuf);
            bufferOffset += weightsBuf.length;
            bufferViews.push(
                { buffer: 0, byteOffset: jOffset, byteLength: jointsBuf.length, target: 34962 },
                { buffer: 0, byteOffset: wOffset, byteLength: weightsBuf.length, target: 34962 }
            );
            primAttrs.JOINTS_0 = accessors.length;
            primAttrs.WEIGHTS_0 = accessors.length + 1;
            accessors.push(
                { bufferView: bufferViews.length - 2, componentType: 5121, count: vCount, type: 'VEC4', normalized: true },
                { bufferView: bufferViews.length - 1, componentType: 5126, count: vCount, type: 'VEC4' }
            );
        }

        primitives.push({
            attributes: primAttrs,
            indices: nAcc + 3,
            material: matIndex
        });
    }

    if (primitives.length === 0) {
        throw new Error('No geometry');
    }

    const sequences = model.Sequences || [];
    const pivotPoints = model.PivotPoints || [];
    let gltfNodes = [];
    let gltfSkins = [];
    let gltfAnimations = [];
    let meshNodeIndex = 0;

    if (bones.length > 0) {
        const objectIdToIndex = new Map();
        bones.forEach((b, i) => { if (b.ObjectId != null) objectIdToIndex.set(b.ObjectId, i); });
        const nodeChildren = Array.from({ length: bones.length }, () => []);
        bones.forEach((b, i) => {
            const parentId = b.Parent;
            if (parentId != null && parentId >= 0) {
                const pIdx = objectIdToIndex.get(parentId);
                if (pIdx != null) nodeChildren[pIdx].push(i);
            }
        });

        for (let i = 0; i < bones.length; i++) {
            const b = bones[i];
            const pivot = pivotPoints[b.ObjectId] || b.PivotPoint || new Float32Array([0, 0, 0]);
            // Convert pivot from Z-up to Y-up
            const yUpPivot = convertZupToYup(pivot);
            const node = {
                name: b.Name || `Bone_${i}`,
                translation: [yUpPivot[0], yUpPivot[1], yUpPivot[2]],
                rotation: [0, 0, 0, 1],
                scale: [1, 1, 1]
            };
            if (nodeChildren[i].length > 0) node.children = nodeChildren[i];
            gltfNodes.push(node);
        }

        const worldMats = bones.map(() => mat4.create());
        const invBind = bones.map(() => mat4.create());
        const order = [];
        const visited = new Set();
        function visit(i) {
            if (visited.has(i)) return;
            visited.add(i);
            const pIdx = bones[i].Parent != null && bones[i].Parent >= 0 ? objectIdToIndex.get(bones[i].Parent) : null;
            if (pIdx != null) visit(pIdx);
            order.push(i);
        }
        for (let i = 0; i < bones.length; i++) visit(i);

        // Calculate world matrices with coordinate conversion
        for (const i of order) {
            const b = bones[i];
            const pivot = pivotPoints[b.ObjectId] || b.PivotPoint || new Float32Array([0, 0, 0]);
            const yUpPivot = convertZupToYup(pivot);

            mat4.identity(worldMats[i]);
            mat4.translate(worldMats[i], worldMats[i], [yUpPivot[0], yUpPivot[1], yUpPivot[2]]);

            const pIdx = b.Parent != null && b.Parent >= 0 ? objectIdToIndex.get(b.Parent) : null;
            if (pIdx != null) mat4.multiply(worldMats[i], worldMats[pIdx], worldMats[i]);
            mat4.invert(invBind[i], worldMats[i]);
        }

        const invBindFloats = new Float32Array(bones.length * 16);
        invBind.forEach((m, i) => { m.forEach((v, j) => { invBindFloats[i * 16 + j] = v; }); });
        const invBindBuf = Buffer.from(invBindFloats.buffer, invBindFloats.byteOffset, invBindFloats.byteLength);
        const ibOffset = bufferOffset;
        bufferChunks.push(invBindBuf);
        bufferOffset += invBindBuf.length;
        bufferViews.push({ buffer: 0, byteOffset: ibOffset, byteLength: invBindBuf.length, target: 34962 });
        accessors.push({ bufferView: bufferViews.length - 1, componentType: 5126, count: bones.length, type: 'MAT4' });
        gltfSkins.push({ joints: bones.map((_, i) => i), inverseBindMatrices: accessors.length - 1 });

        meshNodeIndex = bones.length;
        gltfNodes.push({ name: model.Info?.Name || 'Model', mesh: 0, skin: 0 });
        const rootNodeIndex = bones.length + 1;
        gltfNodes.push({ name: 'Root', children: [...bones.map((_, i) => i), meshNodeIndex] });
        meshNodeIndex = rootNodeIndex;
    } else {
        gltfNodes.push({ name: model.Info?.Name || 'Model', mesh: 0 });
    }

    if (bones.length > 0 && sequences.length > 0) {
        for (let seqIdx = 0; seqIdx < sequences.length; seqIdx++) {
            const seq = sequences[seqIdx];
            const interval = seq.Interval;
            const startFrame = interval ? interval[0] : 0;
            const endFrame = interval ? interval[1] : 1000;
            if (endFrame <= startFrame) continue;

            const timeSet = new Set();
            const transByNode = new Map();
            const rotByNode = new Map();
            const scaleByNode = new Map();

            for (let bi = 0; bi < bones.length; bi++) {
                const b = bones[bi];
                if (b.Translation && b.Translation.Keys) {
                    b.Translation.Keys.forEach(k => {
                        if (k.Frame >= startFrame && k.Frame <= endFrame) {
                            timeSet.add((k.Frame - startFrame) / WC3_FRAME_RATE);
                            if (!transByNode.has(bi)) transByNode.set(bi, []);
                            transByNode.get(bi).push({ t: (k.Frame - startFrame) / WC3_FRAME_RATE, v: k.Vector });
                        }
                    });
                }
                if (b.Rotation && b.Rotation.Keys) {
                    b.Rotation.Keys.forEach(k => {
                        if (k.Frame >= startFrame && k.Frame <= endFrame) {
                            timeSet.add((k.Frame - startFrame) / WC3_FRAME_RATE);
                            if (!rotByNode.has(bi)) rotByNode.set(bi, []);
                            rotByNode.get(bi).push({ t: (k.Frame - startFrame) / WC3_FRAME_RATE, v: k.Vector });
                        }
                    });
                }
                if (b.Scaling && b.Scaling.Keys) {
                    b.Scaling.Keys.forEach(k => {
                        if (k.Frame >= startFrame && k.Frame <= endFrame) {
                            timeSet.add((k.Frame - startFrame) / WC3_FRAME_RATE);
                            if (!scaleByNode.has(bi)) scaleByNode.set(bi, []);
                            scaleByNode.get(bi).push({ t: (k.Frame - startFrame) / WC3_FRAME_RATE, v: k.Vector });
                        }
                    });
                }
            }

            // Ensure sampler input covers full sequence range even if no bone keys
            // land exactly on the start/end interval boundaries.
            timeSet.add(0);
            timeSet.add((endFrame - startFrame) / WC3_FRAME_RATE);

            const times = Array.from(timeSet).sort((a, b) => a - b);
            if (times.length === 0) continue;

            const timeBuf = Buffer.alloc(times.length * 4);
            times.forEach((t, i) => timeBuf.writeFloatLE(t, i * 4));
            const tOff = bufferOffset;
            bufferChunks.push(timeBuf);
            bufferOffset += timeBuf.length;
            bufferViews.push({ buffer: 0, byteOffset: tOff, byteLength: timeBuf.length, target: 34962 });
            const timeAcc = accessors.length;
            accessors.push({ bufferView: bufferViews.length - 1, componentType: 5126, count: times.length, type: 'SCALAR' });

            const seqChannels = [];
            const seqSamplers = [];

            transByNode.forEach((keys, nodeIndex) => {
                keys.sort((a, b) => a.t - b.t);

                // Convert translation keys from Z-up to Y-up
                for (const key of keys) {
                    const converted = convertZupToYup(key.v);
                    key.v[0] = converted[0];
                    key.v[1] = converted[1];
                    key.v[2] = converted[2];
                }

                const vals = new Float32Array(times.length * 3);
                for (let i = 0; i < times.length; i++) {
                    const t = times[i];
                    const first = keys[0];
                    const last = keys[keys.length - 1];

                    if (t <= first.t) {
                        for (let c = 0; c < 3; c++) vals[i * 3 + c] = first.v[c];
                        continue;
                    }
                    if (t >= last.t) {
                        for (let c = 0; c < 3; c++) vals[i * 3 + c] = last.v[c];
                        continue;
                    }

                    let k0 = first, k1 = last;
                    for (let j = 0; j < keys.length - 1; j++) {
                        if (keys[j].t <= t && keys[j + 1].t >= t) {
                            k0 = keys[j];
                            k1 = keys[j + 1];
                            break;
                        }
                    }
                    const u = (t - k0.t) / (k1.t - k0.t);
                    for (let c = 0; c < 3; c++) vals[i * 3 + c] = k0.v[c] + u * (k1.v[c] - k0.v[c]);
                }
                const buf = Buffer.from(vals.buffer, vals.byteOffset, vals.byteLength);
                const vo = bufferOffset;
                bufferChunks.push(buf);
                bufferOffset += buf.length;
                bufferViews.push({ buffer: 0, byteOffset: vo, byteLength: buf.length, target: 34962 });
                const outAcc = accessors.length;
                accessors.push({ bufferView: bufferViews.length - 1, componentType: 5126, count: times.length, type: 'VEC3' });
                seqSamplers.push({ input: timeAcc, output: outAcc, interpolation: 'LINEAR' });
                seqChannels.push({ sampler: seqSamplers.length - 1, target: { node: nodeIndex, path: 'translation' } });
            });
            rotByNode.forEach((keys, nodeIndex) => {
                keys.sort((a, b) => a.t - b.t);

                // Normalize quaternion keys once (MDX quaternions are not guaranteed to be unit length).
                for (const key of keys) {
                    const v = key.v;
                    const q = quat.fromValues(v[0], v[1], v[2], v[3]);
                    quat.normalize(q, q);
                    v[0] = q[0];
                    v[1] = q[1];
                    v[2] = q[2];
                    v[3] = q[3];
                }

                const vals = new Float32Array(times.length * 4);
                const q0 = quat.create();
                const q1 = quat.create();
                const outQ = quat.create();
                for (let i = 0; i < times.length; i++) {
                    const t = times[i];
                    const first = keys[0];
                    const last = keys[keys.length - 1];

                    if (t <= first.t) {
                        for (let c = 0; c < 4; c++) vals[i * 4 + c] = first.v[c];
                        continue;
                    }
                    if (t >= last.t) {
                        for (let c = 0; c < 4; c++) vals[i * 4 + c] = last.v[c];
                        continue;
                    }

                    let k0 = first, k1 = last;
                    for (let j = 0; j < keys.length - 1; j++) {
                        if (keys[j].t <= t && keys[j + 1].t >= t) {
                            k0 = keys[j];
                            k1 = keys[j + 1];
                            break;
                        }
                    }
                    const u = (t - k0.t) / (k1.t - k0.t);
                    q0[0] = k0.v[0]; q0[1] = k0.v[1]; q0[2] = k0.v[2]; q0[3] = k0.v[3];
                    q1[0] = k1.v[0]; q1[1] = k1.v[1]; q1[2] = k1.v[2]; q1[3] = k1.v[3];
                    quat.slerp(outQ, q0, q1, u);
                    for (let c = 0; c < 4; c++) vals[i * 4 + c] = outQ[c];
                }
                const buf = Buffer.from(vals.buffer, vals.byteOffset, vals.byteLength);
                const vo = bufferOffset;
                bufferChunks.push(buf);
                bufferOffset += buf.length;
                bufferViews.push({ buffer: 0, byteOffset: vo, byteLength: buf.length, target: 34962 });
                const outAcc = accessors.length;
                accessors.push({ bufferView: bufferViews.length - 1, componentType: 5126, count: times.length, type: 'VEC4' });
                seqSamplers.push({ input: timeAcc, output: outAcc, interpolation: 'LINEAR' });
                seqChannels.push({ sampler: seqSamplers.length - 1, target: { node: nodeIndex, path: 'rotation' } });
            });
            scaleByNode.forEach((keys, nodeIndex) => {
                keys.sort((a, b) => a.t - b.t);
                const vals = new Float32Array(times.length * 3);
                for (let i = 0; i < times.length; i++) {
                    const t = times[i];
                    const first = keys[0];
                    const last = keys[keys.length - 1];

                    if (t <= first.t) {
                        for (let c = 0; c < 3; c++) vals[i * 3 + c] = first.v[c];
                        continue;
                    }
                    if (t >= last.t) {
                        for (let c = 0; c < 3; c++) vals[i * 3 + c] = last.v[c];
                        continue;
                    }

                    let k0 = first, k1 = last;
                    for (let j = 0; j < keys.length - 1; j++) {
                        if (keys[j].t <= t && keys[j + 1].t >= t) {
                            k0 = keys[j];
                            k1 = keys[j + 1];
                            break;
                        }
                    }
                    const u = (t - k0.t) / (k1.t - k0.t);
                    for (let c = 0; c < 3; c++) vals[i * 3 + c] = k0.v[c] + u * (k1.v[c] - k0.v[c]);
                }
                const buf = Buffer.from(vals.buffer, vals.byteOffset, vals.byteLength);
                const vo = bufferOffset;
                bufferChunks.push(buf);
                bufferOffset += buf.length;
                bufferViews.push({ buffer: 0, byteOffset: vo, byteLength: buf.length, target: 34962 });
                const outAcc = accessors.length;
                accessors.push({ bufferView: bufferViews.length - 1, componentType: 5126, count: times.length, type: 'VEC3' });
                seqSamplers.push({ input: timeAcc, output: outAcc, interpolation: 'LINEAR' });
                seqChannels.push({ sampler: seqSamplers.length - 1, target: { node: nodeIndex, path: 'scale' } });
            });

            if (seqChannels.length === 0) continue;
            const name = (seq.Name || `Sequence_${seqIdx}`).replace(/\s*-\s*\d+$/, '').trim();
            gltfAnimations.push({ name: name || `Anim_${seqIdx}`, channels: seqChannels, samplers: seqSamplers });
        }
    }

    const totalBuffer = Buffer.concat(bufferChunks);

    // Single root so loader creates bones then mesh in order (avoids undefined skeleton.bones)
    const sceneNodes = bones.length > 0 ? [meshNodeIndex] : [0];
    const gltf = {
        asset: { version: '2.0', generator: 'MDXtoGLTF+BLP+Anim' },
        scene: 0,
        scenes: [{ nodes: sceneNodes }],
        nodes: gltfNodes,
        meshes: [{ name: model.Info?.Name || 'Model', primitives }],
        accessors,
        bufferViews,
        buffers: [{ byteLength: totalBuffer.length }],
        materials: gltfMaterials,
        textures: gltfTextures,
        images: images,
        samplers: images.length ? samplers : undefined,
        skins: gltfSkins.length ? gltfSkins : undefined,
        animations: gltfAnimations.length ? gltfAnimations : undefined
    };
    if (!gltf.images.length) delete gltf.images;
    if (!gltf.samplers) delete gltf.samplers;

    const gltfJson = JSON.stringify(gltf);

    const header = Buffer.alloc(12);
    header.writeUInt32LE(0x46546C67, 0);
    header.writeUInt32LE(2, 4);
    const totalLength = 12 + 8 + Buffer.byteLength(gltfJson) + 8 + totalBuffer.length;
    header.writeUInt32LE(totalLength, 8);

    const jsonChunk = Buffer.alloc(8 + Buffer.byteLength(gltfJson));
    jsonChunk.writeUInt32LE(Buffer.byteLength(gltfJson), 0);
    jsonChunk.writeUInt32LE(0x4E4F534A, 4);
    jsonChunk.write(gltfJson, 8);

    const binChunk = Buffer.alloc(8 + totalBuffer.length);
    binChunk.writeUInt32LE(totalBuffer.length, 0);
    binChunk.writeUInt32LE(0x004E4942, 4);
    totalBuffer.copy(binChunk, 8);

    return Buffer.concat([header, jsonChunk, binChunk]);
}
