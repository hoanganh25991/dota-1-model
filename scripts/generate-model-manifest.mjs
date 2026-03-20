#!/usr/bin/env node
/**
 * Scan WarcraftModels/ for *.mdx files
 * Convert each MDX to GLB for browser viewing (with BLP textures, UVs, skeleton, and animations)
 * Write manifest.json with model list
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseMDX, decodeBLP, getBLPImageData } from 'war3-model';
import UPNG from 'upng-js';
import { Document, NodeIO } from '@gltf-transform/core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const WC3_MODELS = path.join(ROOT, 'WarcraftModels');
const MODELS_OUT = path.join(ROOT, 'models');

const WC3_FPS = 30; // Warcraft 3 model animation frame rate
/** MDX layer shading: TwoSided */
const LAYER_TWO_SIDED = 16;
/** If a texture has lots of transparent pixels, `OPAQUE` ignores its alpha and can cause artifacts. */
const TEXTURE_TRANSPARENT_RATIO_THRESHOLD = 0.01; // 1% pixels with alpha < 255
/** For `alphaMode='MASK'`: discard pixels with alpha below this threshold. */
const TEXTURE_ALPHA_CUTOFF = 0.01; // ~2/255

/** Infer category from filename */
function inferCategory(basename) {
  const lower = basename.toLowerCase();
  if (lower.includes('hero') || lower.includes('dreadlord') || lower.includes('archmage')) return 'Hero';
  if (lower.includes('portrait')) return 'Portrait';
  if (lower.includes('effect') || lower.includes('missile') || lower.includes('spell')) return 'Effect';
  if (lower.includes('particle') || lower.includes('fire') || lower.includes('smoke')) return 'Particle';
  if (lower.includes('blood')) return 'Blood';
  if (lower.includes('spirit') || lower.includes('ghost')) return 'Spirit';
  if (lower.includes('camera') || lower.includes('cinematic')) return 'Cinematic';
  return 'Unit';
}

/** Format name for display */
function formatName(basename) {
  return basename
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Resolve texture path (BLP) relative to model */
function resolveTexturePath(modelDir, texPath) {
  const normalized = texPath.replace(/\\/g, '/');
  const candidates = [
    path.join(modelDir, normalized),
    path.join(WC3_MODELS, normalized),
    path.join(WC3_MODELS, path.basename(normalized)),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** BLP to PNG bytes */
function blpToPngBytes(blpPath) {
  try {
    const buf = fs.readFileSync(blpPath);
    // Important: `buf.buffer` is the underlying ArrayBuffer and may include extra bytes.
    // Slice to the actual file range so `decodeBLP()` always sees the correct header/payload.
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const blp = decodeBLP(ab);
    const imgData = getBLPImageData(blp, 0);
    const { width, height, data } = imgData;
    // Decide whether the texture contains transparency.
    // If we later mark the glTF material as `OPAQUE`, the texture alpha gets ignored,
    // which can produce visible "square" artifacts around geosets that use masked edges.
    const totalPixels = data.length / 4;
    const transparentThreshold = Math.max(1, Math.ceil(totalPixels * TEXTURE_TRANSPARENT_RATIO_THRESHOLD));
    let transparentCount = 0;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] < 255) {
        transparentCount++;
        if (transparentCount >= transparentThreshold) break;
      }
    }
    const hasAlpha = transparentCount >= transparentThreshold;
    const rgbaBytes = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    const png = UPNG.encode([rgbaBytes], width, height, 0);
    return { pngBytes: Buffer.from(png), hasAlpha };
  } catch (e) {
    return null;
  }
}

/**
 * Sample AnimVector at given frame, restricted to keys within [seqStart, seqEnd].
 * Returns null when no keys exist in the sequence range (bone stays at bind pose).
 */
function sampleAnimVector(anim, frame, seqStart, seqEnd) {
  if (!anim || !anim.Keys || anim.Keys.length === 0) return null;
  // Only consider keyframes that belong to this sequence's range
  // Treat seqEnd as exclusive so looping clips don't double-sample the boundary frame.
  const keys = anim.Keys.filter(k => k.Frame >= seqStart && k.Frame < seqEnd);
  if (keys.length === 0) return null;
  if (keys.length === 1) return Array.from(keys[0].Vector);

  let i = 0;
  while (i < keys.length && keys[i].Frame < frame) i++;
  if (i === 0) return Array.from(keys[0].Vector);
  if (i >= keys.length) return Array.from(keys[keys.length - 1].Vector);

  const k0 = keys[i - 1];
  const k1 = keys[i];
  const t = (frame - k0.Frame) / (k1.Frame - k0.Frame);
  const len = k0.Vector.length;
  const out = new Array(len);
  for (let j = 0; j < len; j++) {
    out[j] = k0.Vector[j] + t * (k1.Vector[j] - k0.Vector[j]);
  }
  return out;
}

/**
 * Geoset alpha at global MDX frame (full timeline, not clipped to one sequence).
 * Before the first key: if that key turns visibility ON (alpha>0.5), start hidden; else start visible.
 */
function sampleGeosetAlphaAtFrame(geosetAnim, frame) {
  if (!geosetAnim) return 1;
  const a = geosetAnim.Alpha;
  if (typeof a === 'number') return a;
  const keys = a.Keys;
  if (!keys || keys.length === 0) return 1;
  const sorted = [...keys].sort((x, y) => x.Frame - y.Frame);
  const VIS_EPS = 0.02;
  // Single key at global frame 0 with ~0 alpha: WC3 often stores a placeholder; treating it as
  // real "hide forever" combined with `frame >= lastKey` made every frame > 0 invisible (Acolyte).
  if (sorted.length === 1) {
    const k = sorted[0];
    if (k.Frame === 0 && k.Vector[0] <= VIS_EPS) return 1;
  }
  if (frame < sorted[0].Frame) {
    const v0 = sorted[0].Vector[0];
    return v0 > 0.5 ? 0 : 1;
  }
  // Only clamp after the last key when there are multiple keys; a single key must fall through
  // to interpolation/hold below (otherwise any frame >= 0 used the last key for all time).
  if (sorted.length > 1 && frame > sorted[sorted.length - 1].Frame) {
    return sorted[sorted.length - 1].Vector[0];
  }
  let i = 0;
  while (i < sorted.length && sorted[i].Frame < frame) i++;
  if (i === 0) return sorted[0].Vector[0];
  if (i === sorted.length) return sorted[sorted.length - 1].Vector[0];
  const k0 = sorted[i - 1];
  const k1 = sorted[i];
  const t = (frame - k0.Frame) / (k1.Frame - k0.Frame);
  return k0.Vector[0] + t * (k1.Vector[0] - k0.Vector[0]);
}

/** Map GeosetId -> GeosetAnim */
function mapGeosetAnimsByGeosetId(model) {
  const m = new Map();
  for (const ga of model.GeosetAnims || []) {
    if (ga.GeosetId != null && ga.GeosetId >= 0) m.set(ga.GeosetId, ga);
  }
  return m;
}

/** First non-replaceable texture path (team-color / empty Image slots fall back to this). */
function findFallbackTextureImage(model) {
  for (const t of model.Textures || []) {
    const img = t.Image && String(t.Image).trim();
    if (t.ReplaceableId === 0 && img) return t.Image;
  }
  return null;
}

/**
 * Rotate vec3 v by quaternion q using Rodrigues formula.
 * q is [x, y, z, w] (glTF / WC3 convention).
 */
function rotateByQuat(v, q) {
  const vx = v[0], vy = v[1], vz = v[2];
  const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  return [
    vx + qw * tx + qy * tz - qz * ty,
    vy + qw * ty + qz * tx - qx * tz,
    vz + qw * tz + qx * ty - qy * tx,
  ];
}

/**
 * WC3 local bone matrix = T(trans) * T(pivot) * R(rot) * T(-pivot) * S(scale)
 * Decomposed into glTF TRS:
 *   t_gltf = trans + pivot - rotate(rot, pivot)
 *   r_gltf = rot
 *   s_gltf = scale
 * In bind pose (trans=0, rot=identity, scale=1) → t_gltf = (0,0,0)  ✓
 */
function wc3TrsToGltf(trans, rot, scale, pivot) {
  const t = trans || [0, 0, 0];
  const r = rot || [0, 0, 0, 1];
  const s = scale || [1, 1, 1];
  const p = pivot ? [pivot[0], pivot[1], pivot[2]] : [0, 0, 0];
  const rp = rotateByQuat(p, r);
  return {
    t: [t[0] + p[0] - rp[0], t[1] + p[1] - rp[1], t[2] + p[2] - rp[2]],
    r,
    s,
  };
}

/** Recursively collect all nodes (Bones, Helpers) in hierarchy order */
function collectNodes(model) {
  const nodes = [];
  const byId = new Map();
  const all = [...(model.Bones || []), ...(model.Helpers || [])];
  for (let i = 0; i < all.length; i++) {
    const n = all[i];
    n._index = i;
    byId.set(n.ObjectId, n);
  }
  function add(node, parentIdx) {
    const idx = nodes.length;
    nodes.push({ node, parentIdx });
    for (const child of all) {
      if (child.Parent === node.ObjectId) add(child, idx);
    }
  }
  for (const n of all) {
    if (n.Parent == null || n.Parent === -1 || !byId.has(n.Parent)) add(n, -1);
  }
  return nodes;
}

/** Build skinning data for a geoset */
function buildSkinData(geoset, boneIndexMap) {
  const vCount = geoset.Vertices.length / 3;
  const joints = new Uint16Array(vCount * 4);
  const weights = new Float32Array(vCount * 4);

  const hasSkinWeights = geoset.SkinWeights && geoset.SkinWeights.length > 0;
  const groups = geoset.Groups || [];
  const vertexGroup = geoset.VertexGroup || new Uint8Array(vCount);

  for (let i = 0; i < vCount; i++) {
    const groupIdx = vertexGroup[i];
    const boneIndices = (groups[groupIdx] && groups[groupIdx].length) ? groups[groupIdx] : [0];

    let w0 = 1, w1 = 0, w2 = 0, w3 = 0;
    if (hasSkinWeights && geoset.SkinWeights.length >= (i + 1) * 8) {
      const base = i * 8;
      w0 = (geoset.SkinWeights[base] ?? 255) / 255;
      w1 = (geoset.SkinWeights[base + 2] ?? 0) / 255;
      w2 = (geoset.SkinWeights[base + 4] ?? 0) / 255;
      w3 = (geoset.SkinWeights[base + 6] ?? 0) / 255;
      const sum = w0 + w1 + w2 + w3;
      if (sum > 0) { w0 /= sum; w1 /= sum; w2 /= sum; w3 /= sum; }
    }

    const j0 = boneIndexMap.get(boneIndices[0]) ?? 0;
    const j1 = boneIndices[1] != null ? (boneIndexMap.get(boneIndices[1]) ?? 0) : 0;
    const j2 = boneIndices[2] != null ? (boneIndexMap.get(boneIndices[2]) ?? 0) : 0;
    const j3 = boneIndices[3] != null ? (boneIndexMap.get(boneIndices[3]) ?? 0) : 0;

    joints[i * 4] = j0;
    joints[i * 4 + 1] = j1;
    joints[i * 4 + 2] = j2;
    joints[i * 4 + 3] = j3;
    weights[i * 4] = w0;
    weights[i * 4 + 1] = w1;
    weights[i * 4 + 2] = w2;
    weights[i * 4 + 3] = w3;
  }
  return { joints, weights };
}

/** Convert MDX to GLB with animations */
async function convertMdxToGlb(mdxPath, outPath, modelDir) {
  const buf = fs.readFileSync(mdxPath);
  let model;
  try {
    model = parseMDX(buf.buffer);
  } catch (e) {
    throw new Error(e.message || 'Not a mdx model');
  }
  const doc = new Document();

  const root = doc.getRoot();
  const buffer = doc.createBuffer();

  const boneIndexMap = new Map();
  const collected = collectNodes(model);
  for (let i = 0; i < collected.length; i++) {
    boneIndexMap.set(collected[i].node.ObjectId, i);
  }

  const gltfNodes = [];
  for (let i = 0; i < collected.length; i++) {
    const { node, parentIdx } = collected[i];
    const gltfNode = doc.createNode(node.Name || `Node_${i}`);

    // Bind pose: all bones at identity (trans=0, rot=identity, scale=1).
    // inverseBindMatrices default to identity, which is correct when bind pose = identity.
    gltfNode.setTranslation([0, 0, 0]);
    gltfNode.setRotation([0, 0, 0, 1]);
    gltfNode.setScale([1, 1, 1]);

    if (parentIdx >= 0) {
      gltfNodes[parentIdx].addChild(gltfNode);
    }
    gltfNodes.push(gltfNode);
  }

  const scene = doc.createScene('Scene');
  for (let i = 0; i < collected.length; i++) {
    if (collected[i].parentIdx === -1) scene.addChild(gltfNodes[i]);
  }

  const textureCache = new Map();
  const materials = [];
  const fallbackTextureImage = findFallbackTextureImage(model);
  for (const mat of model.Materials || []) {
    const layers = mat.Layers || [];

    // Pick the first layer that actually resolves to a usable texture.
    // Some WC3 materials store the visible base texture in layer[1..], while layer[0]
    // can be a replaceable texture (missing Image) -> would render as white otherwise.
    let tex = null;
    let textureHasAlpha = false;
    let selectedLayer = null;
    let alpha = 1;
    let doubleSided = false;

    for (const layer of layers) {
      if (layer?.Shading & LAYER_TWO_SIDED) doubleSided = true;

      const texId = typeof layer?.TextureID === 'number' ? layer.TextureID : 0;
      const texEntry = model.Textures?.[texId];

      let texPath = texEntry?.Image && String(texEntry.Image).trim();
      // Preserve layer alpha even if this specific layer doesn't have a concrete image.
      // We'll use a fallback texture later (when we would otherwise export an invisible material).
      if (!texPath) {
        if (typeof layer?.Alpha === 'number') alpha = layer.Alpha;
        // If it's replaceable (missing Image), skip it. Otherwise we'd "invent" a
        // texture and produce large white artifacts for effects/overlays.
        if (texEntry?.ReplaceableId > 0) continue;
        continue;
      }

      const resolved = resolveTexturePath(modelDir, texPath);
      if (!resolved) continue;

      const ext = path.extname(resolved).toLowerCase();
      let imgBytes = null;
      let imgHasAlpha = false;
      if (ext === '.blp') {
        const converted = blpToPngBytes(resolved);
        if (!converted) continue;
        imgBytes = converted.pngBytes;
        imgHasAlpha = converted.hasAlpha;
      } else if (['.png', '.jpg', '.jpeg'].includes(ext)) {
        imgBytes = fs.readFileSync(resolved);
      }
      if (!imgBytes) continue;

      const cacheKey = resolved;
      if (!textureCache.has(cacheKey)) {
        const texture = doc.createTexture().setImage(imgBytes).setMimeType('image/png');
        textureCache.set(cacheKey, { texture, hasAlpha: imgHasAlpha });
      }
      tex = textureCache.get(cacheKey).texture;
      textureHasAlpha = textureCache.get(cacheKey).hasAlpha;
      selectedLayer = layer;
      alpha = typeof layer?.Alpha === 'number' ? layer.Alpha : alpha;
      break;
    }

    // If the material only referenced replaceable slots with missing `Image`,
    // we would otherwise export an "invisible" material (no texture + alpha=0).
    // Use a safe fallback texture from the model to avoid holes in the mesh.
    if (!tex && fallbackTextureImage) {
      const resolved = resolveTexturePath(modelDir, fallbackTextureImage);
      if (resolved) {
        const ext = path.extname(resolved).toLowerCase();
        let imgBytes = null;
        let imgHasAlpha = false;
        if (ext === '.blp') {
          const converted = blpToPngBytes(resolved);
          if (converted) {
            imgBytes = converted.pngBytes;
            imgHasAlpha = converted.hasAlpha;
          }
        } else if (['.png', '.jpg', '.jpeg'].includes(ext)) {
          imgBytes = fs.readFileSync(resolved);
          imgHasAlpha = false;
        }
        if (imgBytes) {
          const cacheKey = resolved;
          if (!textureCache.has(cacheKey)) {
            const texture = doc.createTexture().setImage(imgBytes).setMimeType('image/png');
            textureCache.set(cacheKey, { texture, hasAlpha: imgHasAlpha });
          }
          tex = textureCache.get(cacheKey).texture;
          textureHasAlpha = textureCache.get(cacheKey).hasAlpha;
          selectedLayer = selectedLayer || { _fallback: true };
        }
      }
    }

    let alphaClamped = Math.max(0, Math.min(1, alpha));
    // If we couldn't resolve a real texture, hide the geometry instead of rendering
    // a white/opaque fallback.
    if (!tex) alphaClamped = 0;
    // Layer alpha 0 with a resolved texture would export baseColorFactor.a = 0; viewers multiply
    // texture by that factor and draw nothing. When a texture is present, treat 0 as "use texture".
    else if (alphaClamped === 0) alphaClamped = 1;
    const pbr = doc.createMaterial().setBaseColorFactor([1, 1, 1, alphaClamped]);
    if (tex) pbr.setBaseColorTexture(tex);
    if (doubleSided) pbr.setDoubleSided(true);
    // `BLEND` materials are rendered with transparency which disables depth writing in
    // most realtime engines and can make the whole model look "see-through".
    // WC3 textures are usually cutout (alpha=0 background, alpha=255 foreground),
    // so prefer `MASK` whenever the texture has transparency.
    if (textureHasAlpha) {
      pbr.setAlphaMode('MASK');
      pbr.setAlphaCutoff(TEXTURE_ALPHA_CUTOFF);
    } else {
      pbr.setAlphaMode(alphaClamped < 1 ? 'BLEND' : 'OPAQUE');
    }
    materials.push(pbr);
  }

  let skin = null;
  if (collected.length > 0) {
    skin = doc.createSkin();
    for (const n of gltfNodes) skin.addJoint(n);
  }

  const geosetAnimById = mapGeosetAnimsByGeosetId(model);
  const geosetNodes = [];
  for (let g = 0; g < (model.Geosets || []).length; g++) {
    const geoset = model.Geosets[g];
    const { joints, weights } = buildSkinData(geoset, boneIndexMap);

    const posAcc = doc.createAccessor().setArray(new Float32Array(geoset.Vertices)).setType('VEC3').setBuffer(buffer);
    const normAcc = doc.createAccessor().setArray(new Float32Array(geoset.Normals)).setType('VEC3').setBuffer(buffer);
    const uvAcc = doc.createAccessor()
      .setArray(new Float32Array(geoset.TVertices[0] || []))
      .setType('VEC2')
      .setBuffer(buffer);
    const jointsAcc = doc.createAccessor().setArray(joints).setType('VEC4').setBuffer(buffer);
    const weightsAcc = doc.createAccessor().setArray(weights).setType('VEC4').setBuffer(buffer);

    const prim = doc.createPrimitive()
      .setAttribute('POSITION', posAcc)
      .setAttribute('NORMAL', normAcc)
      .setAttribute('TEXCOORD_0', uvAcc)
      .setAttribute('JOINTS_0', jointsAcc)
      .setAttribute('WEIGHTS_0', weightsAcc)
      .setMode(4)
      .setIndices(doc.createAccessor().setArray(geoset.Faces).setBuffer(buffer));

    const matId = Math.min(geoset.MaterialID ?? 0, materials.length - 1);
    prim.setMaterial(materials[matId >= 0 ? matId : 0]);

    const mesh = doc.createMesh().addPrimitive(prim);
    const geoNode = doc.createNode(`Geoset_${g}`);
    geoNode.setMesh(mesh);
    if (skin) geoNode.setSkin(skin);
    geoNode.setTranslation([0, 0, 0]);
    geoNode.setRotation([0, 0, 0, 1]);
    geoNode.setScale([1, 1, 1]);
    scene.addChild(geoNode);
    geosetNodes.push(geoNode);
  }

  const fps = WC3_FPS;
  for (const seq of model.Sequences || []) {
    const interval = seq.Interval || new Uint32Array([0, 0]);
    const startFrame = interval[0];
    const endFrame = interval[1];
    if (endFrame <= startFrame) continue;

    const anim = doc.createAnimation(seq.Name || `Anim_${seq.Interval[0]}`);

    // glTF / Three.js expect keyframe times relative to clip start (0 … duration).
    // MDX uses a global frame timeline (e.g. Walk at 3333–4333); using f/fps would put
    // the first key at ~111s so AnimationMixer at t=0 clamps to frame 0 pose → "no walk".
    const times = [];
    const frames = [];
    // Treat endFrame as exclusive. This prevents a visible “pop” on LoopRepeat when
    // the last sampled boundary pose differs from the first pose.
    for (let f = startFrame; f < endFrame; f++) {
      times.push((f - startFrame) / fps);
      frames.push(f);
    }

    for (let i = 0; i < collected.length; i++) {
      const { node } = collected[i];
      const gltfNode = gltfNodes[i];

      const translations = [];
      const rotations = [];
      const scales = [];

      const pivot = node.PivotPoint ? Array.from(node.PivotPoint) : [0, 0, 0];
      for (const f of frames) {
        // Only sample keyframes within this sequence's range to prevent bleed-over
        const t = sampleAnimVector(node.Translation, f, startFrame, endFrame) ?? [0, 0, 0];
        const r = sampleAnimVector(node.Rotation, f, startFrame, endFrame) ?? [0, 0, 0, 1];
        const s = sampleAnimVector(node.Scaling, f, startFrame, endFrame) ?? [1, 1, 1];
        const gltf = wc3TrsToGltf(t, r, s, pivot);
        translations.push(...gltf.t);
        rotations.push(...gltf.r);
        scales.push(...gltf.s);
      }

      // Since the viewer plays every clip with `LoopRepeat`, ensure the last sampled keyframe
      // matches the first sampled keyframe. This avoids boundary pops on skeletal/geo nodes
      // that are not authored as perfectly seamless loops.
      if (frames.length > 1) {
        const lastFrameIdx = frames.length - 1;
        translations[(lastFrameIdx * 3) + 0] = translations[0];
        translations[(lastFrameIdx * 3) + 1] = translations[1];
        translations[(lastFrameIdx * 3) + 2] = translations[2];

        rotations[(lastFrameIdx * 4) + 0] = rotations[0];
        rotations[(lastFrameIdx * 4) + 1] = rotations[1];
        rotations[(lastFrameIdx * 4) + 2] = rotations[2];
        rotations[(lastFrameIdx * 4) + 3] = rotations[3];

        scales[(lastFrameIdx * 3) + 0] = scales[0];
        scales[(lastFrameIdx * 3) + 1] = scales[1];
        scales[(lastFrameIdx * 3) + 2] = scales[2];
      }

      // Only create channels for nodes that actually animate in this sequence
      const hasTransInSeq = (node.Translation?.Keys || []).some(k => k.Frame >= startFrame && k.Frame < endFrame);
      const hasRotInSeq = (node.Rotation?.Keys || []).some(k => k.Frame >= startFrame && k.Frame < endFrame);
      const hasScaleInSeq = (node.Scaling?.Keys || []).some(k => k.Frame >= startFrame && k.Frame < endFrame);

      if (hasTransInSeq || hasRotInSeq) {
        const inputAcc = doc.createAccessor().setArray(new Float32Array(times)).setType('SCALAR').setBuffer(buffer);

        const tOut = doc.createAccessor().setArray(new Float32Array(translations)).setType('VEC3').setBuffer(buffer);
        const tSampler = doc.createAnimationSampler().setInput(inputAcc).setOutput(tOut);
        const tChannel = doc.createAnimationChannel().setTargetNode(gltfNode).setTargetPath('translation').setSampler(tSampler);
        anim.addChannel(tChannel).addSampler(tSampler);

        const rOut = doc.createAccessor().setArray(new Float32Array(rotations)).setType('VEC4').setBuffer(buffer);
        const rSampler = doc.createAnimationSampler().setInput(inputAcc).setOutput(rOut);
        const rChannel = doc.createAnimationChannel().setTargetNode(gltfNode).setTargetPath('rotation').setSampler(rSampler);
        anim.addChannel(rChannel).addSampler(rSampler);
      }
      if (hasScaleInSeq) {
        const inputAcc = doc.createAccessor().setArray(new Float32Array(times)).setType('SCALAR').setBuffer(buffer);
        const sOut = doc.createAccessor().setArray(new Float32Array(scales)).setType('VEC3').setBuffer(buffer);
        const sSampler = doc.createAnimationSampler().setInput(inputAcc).setOutput(sOut);
        const sChannel = doc.createAnimationChannel().setTargetNode(gltfNode).setTargetPath('scale').setSampler(sSampler);
        anim.addChannel(sChannel).addSampler(sSampler);
      }
    }

    // Geoset alpha (death/decay gibs): drive node scale 0/1 so hidden geosets don't show in Stand/Walk.
    const VIS_ALPHA_EPS = 0.02;
    for (let g = 0; g < geosetNodes.length; g++) {
      const ga = geosetAnimById.get(g);
      const geoScales = [];
      for (const f of frames) {
        const alpha = sampleGeosetAlphaAtFrame(ga, f);
        const s = alpha > VIS_ALPHA_EPS ? 1 : 0;
        geoScales.push(s, s, s);
      }
      // Same seamless-loop fix: force the last geoset visibility state to match frame 0.
      if (frames.length > 1 && geoScales.length >= 3) {
        geoScales[geoScales.length - 3 + 0] = geoScales[0];
        geoScales[geoScales.length - 3 + 1] = geoScales[1];
        geoScales[geoScales.length - 3 + 2] = geoScales[2];
      }
      let allOne = true;
      for (let k = 0; k < geoScales.length; k++) {
        if (geoScales[k] !== 1) {
          allOne = false;
          break;
        }
      }
      if (allOne) continue;

      const inputAcc = doc.createAccessor().setArray(new Float32Array(times)).setType('SCALAR').setBuffer(buffer);
      const sOut = doc.createAccessor().setArray(new Float32Array(geoScales)).setType('VEC3').setBuffer(buffer);
      const sSampler = doc.createAnimationSampler().setInput(inputAcc).setOutput(sOut);
      const sChannel = doc.createAnimationChannel()
        .setTargetNode(geosetNodes[g])
        .setTargetPath('scale')
        .setSampler(sSampler);
      anim.addChannel(sChannel).addSampler(sSampler);
    }
  }

  const io = new NodeIO();
  await io.write(outPath, doc);
}

/** Main */
async function main() {
  const onlyIdx = process.argv.indexOf('--only');
  const onlyId = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : null;
  const noManifest = process.argv.includes('--no-manifest');

  if (!fs.existsSync(WC3_MODELS)) {
    fs.mkdirSync(WC3_MODELS, { recursive: true });
    console.log('Created WarcraftModels/ (empty). Add MDX files and run again.');
    writeManifest([]);
    return;
  }

  if (!fs.existsSync(MODELS_OUT)) fs.mkdirSync(MODELS_OUT, { recursive: true });

  const mdxFiles = [];
  let foundOnly = null;
  function scan(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (onlyId && foundOnly) return;
        scan(full);
      } else if (e.name.toLowerCase().endsWith('.mdx')) {
        const basename = path.basename(e.name, '.mdx');
        if (onlyId) {
          if (basename === onlyId) {
            foundOnly = full;
            return;
          }
        } else {
          mdxFiles.push(full);
        }
      }
    }
  }
  scan(WC3_MODELS);

  // Fast path: convert a single model and exit (optionally without touching manifest.json).
  if (onlyId) {
    if (!foundOnly) {
      console.error(`No MDX found for id: ${onlyId}`);
      process.exit(1);
    }
    const mdxPath = foundOnly;
    const basename = path.basename(mdxPath, '.mdx');
    const modelDir = path.dirname(mdxPath);
    const glbName = basename + '.glb';
    const outPath = path.join(MODELS_OUT, glbName);
    await convertMdxToGlb(mdxPath, outPath, modelDir);
    console.log(`Converted ${basename} -> ${path.relative(ROOT, outPath)}`);
    // Intentionally does not rewrite manifest.json (unless you re-run the full script).
    return;
  }

  const manifest = [];
  for (let i = 0; i < mdxFiles.length; i++) {
    const mdxPath = mdxFiles[i];
    const rel = path.relative(WC3_MODELS, mdxPath);
    const basename = path.basename(mdxPath, '.mdx');
    const modelDir = path.dirname(mdxPath);
    const glbName = basename + '.glb';
    const outPath = path.join(MODELS_OUT, glbName);

    const entry = {
      id: basename,
      name: formatName(basename),
      category: inferCategory(basename),
      path: `models/${glbName}`,
    };

    try {
      if (fs.existsSync(outPath)) {
        manifest.push(entry);
        console.log(`[${i + 1}/${mdxFiles.length}] ${basename} (skip, glb exists)`);
        continue;
      }
      await convertMdxToGlb(mdxPath, outPath, modelDir);
      manifest.push(entry);
      console.log(`[${i + 1}/${mdxFiles.length}] ${basename}`);
    } catch (err) {
      console.error(`Failed ${basename}:`, err.message);
    }
  }

  writeManifest(manifest);
  console.log(`Done. ${manifest.length} models, manifest written.`);
}

function writeManifest(manifest) {
  const outPath = path.join(WC3_MODELS, 'manifest.json');
  fs.writeFileSync(outPath, JSON.stringify({ models: manifest }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
