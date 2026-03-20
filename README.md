# WARCRAFT III Model Browser

A Three.js browser for viewing WARCRAFT III MDX models.

## Quick Start

```bash
cd dota-1-model && python -m http.server 8000
open http://localhost:8000
```

Review Models

![model-animation-20260320-011854.gif](docs/model-animation-20260320-011854.gif)

## Project Structure

```
dota-1-model/
├── index.html              # Main viewer
├── css/styles.css          # Styling
├── js/viewer.js            # Three.js application
├── models/                 # Converted GLB files + manifest.json
├── docs/
│   ├── SPEC_INDEX.md       # Links to MDX→GLB and viewer specs
│   ├── MDX_TO_GLB_SPEC.md  # Converter: MDX, BLP, animations → GLB
│   └── VIEWER_RUNTIME_SPEC.md  # Viewer: load, center, animations, speed
├── scripts/
│   └── generate-model-manifest.mjs  # MDX to GLB converter
├── WarcraftModels/        # Source MDX files (3244 files)
└── README.md
```

## How It Works

1. **Source**: MDX files in `WarcraftModels/` (do not edit)
2. **Converted**: GLB files in `models/` (auto-generated)
3. **Manifest**: `models/manifest.json` lists all available models (generated next to the GLBs)

## Features

- **3055 models** searchable by name
- **Type & model selects**: Filter by category, then pick a model (same as the list below)
- **Shareable URL**: `?category=unit` for type only; `?category=unit&model=Abomination` for a specific model (`category` is lowercase; `model` is the manifest id)
- **Search**: Filter by name across all models
- **3D viewer** with orbit controls (drag/zoom/pan)
- **Animation buttons**: Plays clips from the GLB (WC3 sequences exported from MDX); see [docs/SPEC_INDEX.md](docs/SPEC_INDEX.md)
- **Speed slider**: Adjust playback on top of a built-in **~25× WC3 baseline** (slider `1×` ≈ in-game speed; long clips like *Decay Flesh* may still need a higher slider value)
- **Lighting presets**: Default, Dark, Bright

## Converting New Models

When you add new MDX files to `WarcraftModels/`, run:

```bash
node scripts/generate-model-manifest.mjs
```

This will:

1. Scan for new MDX files
2. Convert them to GLB in `models/` (skips MDX when `models/<name>.glb` already exists — delete a GLB to force reconvert). **Reconvert** after pipeline fixes (e.g. animation timing): animations use clip-relative times so Walk / Stand play correctly in Three.js.
3. Update `manifest.json`

If a model’s UI loads (animations listed) but the viewport stays **black**, the cached GLB may have been built with an older converter—especially **geoset visibility** (bad `GeosetAnim` sampling). Delete `models/<Name>.glb` and run the script again (use `--only <Name>` to rebuild one id).

## Model Names

Names are formatted for readability:

- `AncestralGuardian` → "Ancestral Guardian"
- `HeroDreadLord` → "Hero Dread Lord"
- `V2` → " v2"

## Categories


| Category  | Description                   |
| --------- | ----------------------------- |
| Unit      | Base units, buildings, troops |
| Hero      | Hero models                   |
| Portrait  | UI portraits                  |
| Effect    | Spell effects, missiles       |
| Particle  | Fire, smoke, dust, fog        |
| Blood     | Blood splats and effects      |
| Spirit    | Ghosts and spirits            |
| Cinematic | Camera and cinematic models   |

## License

Copyright © 2025 Monk Journey Team. All Rights Reserved.

This project is proprietary and confidential. Unauthorized reproduction, distribution, or disclosure is prohibited. No license, express or implied, to any intellectual property rights is granted by this document.

See the [LICENSE](LICENSE) file for full details.
