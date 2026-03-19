# Warcraft III animations and what you need

You extracted assets from `war.mpq` and have MDX + BLP. Here’s how animations are defined in WC3 and what’s missing for them to play in the viewer.

---

## How animations are defined in Warcraft III (MDX)

Everything is inside the **MDX** (or MDL) file:

### 1. **Sequences** (animation clips)

- Each sequence has a **name** (e.g. `"Stand"`, `"Stand - 1"`, `"Walk"`, `"Attack"`, `"Death"`, `"Spell"`) and an **interval** `[startFrame, endFrame]`.
- The game (and any viewer) picks a sequence by name or index and plays that frame range in a loop (or once if `NonLooping`).

### 2. **Bones / nodes**

- The model has a **skeleton**: a hierarchy of **Bones** (and Helpers, etc.).
- Each bone has:
  - **Pivot point** (position in bind pose)
  - Optional **keyframe tracks**: **Translation** (KGTR), **Rotation** (KGRT), **Scaling** (KGSC)
- Each track is an **AnimVector**: a list of **keyframes** (time/frame + value + optional tangents for smooth interpolation).

### 3. **Skinning**

- **Geosets** (meshes) reference a **VertexGroup**: each vertex is tied to one or more bones with weights.
- When a bone moves (from its keyframes), the mesh deforms accordingly.

### 4. **Other animated things**

- **GeosetAnims**: visibility/color per geoset over time.
- **Particle emitters**, **ribbons**, **lights**, etc. also have keyframe tracks.

So: **animations are fully defined in the MDX** (sequences + bone/keyframe data + skinning). You don’t need extra files from the MPQ for “animation definitions”; the MDX is the single source.

---

## What the current pipeline does

The script `scripts/generate-model-manifest.mjs`:

- Reads **MDX** and **BLP** (textures).
- Exports **static geometry**: positions, normals, UVs, materials (with BLP → PNG).
- Does **not** export:
  - Skeleton (bones/nodes)
  - Skinning (vertex → bone weights)
  - Sequences or keyframe animation data

So the **GLB is a static mesh**. The viewer’s “Stand / Walk / Attack” buttons are **not** driving real WC3 animations; they were only doing simple procedural motion. To see **real** WC3 animations, the converter must export skeleton, skinning, and animation clips.

---

## What you have to do to get real animations

You have two main options.

### Option A: Use a tool that already exports animated glTF/GLB

- **Retera’s Model Studio** and similar editors can open MDX and export to formats that support skeleton + animations (e.g. glTF/GLB or others).
- If you export **animated GLB** from such a tool and put it in `models/`, the current Three.js viewer can play it **if** we wire the UI to the GLB’s animation clips (see below).

### Option B: Extend the converter (recommended if you want to stay in this repo)

To get animations from **your** MDX → GLB pipeline, the converter needs to:

1. **Export the skeleton**
   - Map `model.Bones` (and any nodes) to glTF **nodes** with hierarchy (`parent`).
   - Use `PivotPoint` (and default Translation/Rotation/Scaling) for the bind pose.

2. **Export skinning**
   - From each **Geoset**: `VertexGroup` (and, if present, `SkinWeights`) → glTF **JOINTS_0** and **WEIGHTS_0**.
   - Add a **skin** with `joints` and inverse-bind matrices (from bind pose).

3. **Export animation clips**
   - For each **Sequence** in `model.Sequences`:
     - Use `Interval` (e.g. `[start, end]`) as the time range.
     - For each **Bone** (node) with Translation/Rotation/Scaling:
       - Sample or copy keyframes from the **AnimVector** `Keys` (each key has `Frame` and `Vector`).
       - Add glTF **animation channels** (node + path: `translation`/`rotation`/`scale`) and **samplers** (input: time, output: values).
   - Optionally: GeosetAnim visibility/color, and other animated objects (particles, etc.).

4. **Viewer**
   - Load the GLB and use **THREE.AnimationMixer** + `clipAction(animationClip).play()`.
   - Map the UI buttons (Stand, Walk, Attack, etc.) to clip names or indices from `gltf.animations`.

The **war3-model** parser already gives you `model.Sequences`, `model.Bones`, `bone.Translation` / `Rotation` / `Scaling` (each with `Keys[]`), and geoset vertex groups, so the data is there; the work is in writing the glTF/GLB skeleton, skin, and animation structures.

---

## Summary

| What                         | Where it lives        | In our pipeline        |
|-----------------------------|------------------------|-------------------------|
| Animation clip names/ranges | MDX **Sequences**      | Not exported            |
| Bone motion (keyframes)     | MDX **Bones** (KGTR/KGRT/KGSC) | Not exported |
| Skinning                    | MDX **Geosets** (VertexGroup, etc.) | Not exported |
| Textures                    | BLP files              | Exported (BLP → PNG in GLB) |

So: **animations are defined entirely in the MDX**. You don’t need to “do” anything else with the MPQ assets for *definition*; to *see* them in the viewer, you either use an external tool that exports animated GLB, or extend the converter (and viewer) as above.
