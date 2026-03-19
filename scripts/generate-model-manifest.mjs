#!/usr/bin/env node
/**
 * Scan WarcraftModels/ for *.mdx files
 * Convert each MDX to GLB for browser viewing (with BLP textures and UVs)
 * Write manifest.json with model list
 */
import fs from 'fs';
import path from 'path';
import { parseMDX, decodeBLP, getBLPImageData } from 'war3-model';
import UPNG from 'upng-js';

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

    const primitives = [];
    const accessors = [];
    const bufferViews = [];
    const images = [];
    const samplers = [{ wrapS: 10497, wrapT: 10497 }];
    const gltfTextures = [];
    const gltfMaterials = [];

    let bufferOffset = 0;
    const bufferChunks = [];

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
                }
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

    for (const geoset of geosets) {
        if (!geoset.Vertices || !geoset.Faces) continue;

        const vCount = geoset.Vertices.length / 3;
        const positions = geoset.Vertices;
        let normals = geoset.Normals && geoset.Normals.length >= vCount * 3
            ? geoset.Normals
            : null;
        if (!normals) {
            normals = new Float32Array(vCount * 3);
            for (let i = 0; i < vCount; i++) normals[i * 3 + 1] = 1;
        }

        const uvs = geoset.TVertices && geoset.TVertices[0] && geoset.TVertices[0].length >= vCount * 2
            ? geoset.TVertices[0]
            : null;
        if (!uvs) {
            const fallback = new Float32Array(vCount * 2);
            for (let i = 0; i < vCount; i++) {
                fallback[i * 2] = 0;
                fallback[i * 2 + 1] = 0;
            }
            // use fallback as typed array for writing
            const uvsArr = Array.from(fallback);
            // will write below
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
        const normArr = normals instanceof Float32Array ? normals : new Float32Array(normals);
        for (let i = 0; i < normArr.length; i++) normBuf.writeFloatLE(normArr[i], i * 4);

        const uvSrc = uvs || (() => {
            const a = new Float32Array(vCount * 2);
            a.fill(0);
            return a;
        })();
        const uvArr = uvSrc instanceof Float32Array ? uvSrc : new Float32Array(uvSrc);
        const uvBuf = Buffer.alloc(uvArr.length * 4);
        for (let i = 0; i < uvArr.length; i++) uvBuf.writeFloatLE(uvArr[i], i * 4);

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
        accessors.push(
            { bufferView: nBV, componentType: 5126, count: vCount, type: 'VEC3', min: posMin, max: posMax },
            { bufferView: nBV + 1, componentType: 5126, count: vCount, type: 'VEC3' },
            { bufferView: nBV + 2, componentType: 5126, count: vCount, type: 'VEC2' },
            { bufferView: nBV + 3, componentType: 5123, count: indices.length, type: 'SCALAR' }
        );

        primitives.push({
            attributes: { POSITION: nAcc, NORMAL: nAcc + 1, TEXCOORD_0: nAcc + 2 },
            indices: nAcc + 3,
            material: matIndex
        });
    }

    if (primitives.length === 0) {
        throw new Error('No geometry');
    }

    const totalBuffer = Buffer.concat(bufferChunks);

    const gltf = {
        asset: { version: '2.0', generator: 'MDXtoGLTF+BLP' },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ name: model.Info?.Name || 'Model', mesh: 0 }],
        meshes: [{ name: model.Info?.Name || 'Model', primitives }],
        accessors,
        bufferViews,
        buffers: [{ byteLength: totalBuffer.length }],
        materials: gltfMaterials,
        textures: gltfTextures,
        images: images,
        samplers: images.length ? samplers : undefined
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
