#!/usr/bin/env node
/**
 * Scan WarcraftModels/ for *.mdx files
 * Convert each MDX to GLB for browser viewing
 * Write manifest.json with model list
 */
import fs from 'fs';
import path from 'path';
import { parseMDX } from 'war3-model';

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

        const result = convertToGLB(model);
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

function convertToGLB(model) {
    const allPositions = [];
    const allNormals = [];
    const allIndices = [];
    let vertexOffset = 0;

    for (const geoset of model.Geosets) {
        if (!geoset.Vertices || !geoset.Faces) continue;

        for (let i = 0; i < geoset.Vertices.length; i += 3) {
            allPositions.push(geoset.Vertices[i], geoset.Vertices[i + 1], geoset.Vertices[i + 2]);
        }

        if (geoset.Normals && geoset.Normals.length > 0) {
            for (let i = 0; i < geoset.Normals.length; i += 3) {
                allNormals.push(geoset.Normals[i], geoset.Normals[i + 1], geoset.Normals[i + 2]);
            }
        } else {
            for (let i = 0; i < geoset.Vertices.length / 3; i++) {
                allNormals.push(0, 1, 0);
            }
        }

        for (let i = 0; i < geoset.Faces.length; i += 3) {
            allIndices.push(
                geoset.Faces[i] + vertexOffset,
                geoset.Faces[i + 1] + vertexOffset,
                geoset.Faces[i + 2] + vertexOffset
            );
        }

        vertexOffset += geoset.Vertices.length / 3;
    }

    if (allPositions.length === 0) {
        throw new Error('No geometry');
    }

    const positionsBuf = Buffer.alloc(allPositions.length * 4);
    for (let i = 0; i < allPositions.length; i++) {
        positionsBuf.writeFloatLE(allPositions[i], i * 4);
    }

    const normalsBuf = Buffer.alloc(allNormals.length * 4);
    for (let i = 0; i < allNormals.length; i++) {
        normalsBuf.writeFloatLE(allNormals[i], i * 4);
    }

    const indicesBuf = Buffer.alloc(allIndices.length * 2);
    for (let i = 0; i < allIndices.length; i++) {
        indicesBuf.writeUInt16LE(allIndices[i], i * 2);
    }

    const totalBuffer = Buffer.concat([positionsBuf, normalsBuf, indicesBuf]);

    const gltf = {
        asset: { version: "2.0", generator: "MDXtoGLTF" },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ name: model.Info.Name || 'Model', mesh: 0 }],
        meshes: [{
            name: model.Info.Name || 'Model',
            primitives: [{ mode: 4, attributes: { POSITION: 0, NORMAL: 1 }, indices: 2 }]
        }],
        accessors: [
            {
                bufferView: 0, componentType: 5126, count: allPositions.length / 3, type: "VEC3",
                min: [Math.min(...allPositions.filter((_, i) => i % 3 === 0)), Math.min(...allPositions.filter((_, i) => i % 3 === 1)), Math.min(...allPositions.filter((_, i) => i % 3 === 2))],
                max: [Math.max(...allPositions.filter((_, i) => i % 3 === 0)), Math.max(...allPositions.filter((_, i) => i % 3 === 1)), Math.max(...allPositions.filter((_, i) => i % 3 === 2))]
            },
            { bufferView: 1, componentType: 5126, count: allNormals.length / 3, type: "VEC3" },
            { bufferView: 2, componentType: 5123, count: allIndices.length, type: "SCALAR" }
        ],
        bufferViews: [
            { buffer: 0, byteOffset: 0, byteLength: positionsBuf.length, target: 34962 },
            { buffer: 0, byteOffset: positionsBuf.length, byteLength: normalsBuf.length, target: 34962 },
            { buffer: 0, byteOffset: positionsBuf.length + normalsBuf.length, byteLength: indicesBuf.length, target: 34963 }
        ],
        buffers: [{ byteLength: totalBuffer.length }]
    };

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