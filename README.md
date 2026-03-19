# Warcraft 3 Model Browser

A Three.js browser for viewing Warcraft 3 MDX models.

## Quick Start

```bash
cd /Users/anhle/work-station/dota-1-model
python -m http.server 8000
```

Open `http://localhost:8000`

## Project Structure

```
dota-1-model/
├── index.html              # Main viewer
├── viewer.js              # Three.js application
├── styles.css             # Styling
├── models/                # Converted GLB files (3055 models)
├── scripts/
│   └── generate-model-manifest.mjs  # MDX to GLB converter
├── WarcraftModels/        # Source MDX files (3244 files)
│   └── manifest.json      # Model list with categories
└── README.md
```

## How It Works

1. **Source**: MDX files in `WarcraftModels/` (do not edit)
2. **Converted**: GLB files in `models/` (auto-generated)
3. **Manifest**: `WarcraftModels/manifest.json` lists all available models

## Features

- **3055 models** searchable by name
- **Category filter**: Unit, Hero, Portrait, Effect, Particle, Blood, Spirit, Cinematic
- **Search**: Filter by name across all models
- **3D viewer** with orbit controls (drag/zoom/pan)
- **Animations**: Stand, Walk, Attack, Death, Spell
- **Speed slider**: Adjust animation speed
- **Lighting presets**: Default, Dark, Bright

## Converting New Models

When you add new MDX files to `WarcraftModels/`, run:

```bash
node scripts/generate-model-manifest.mjs
```

This will:
1. Scan for new MDX files
2. Convert them to GLB in `models/`
3. Update `manifest.json`

## Model Names

Names are formatted for readability:
- `AncestralGuardian` → "Ancestral Guardian"
- `HeroDreadLord` → "Hero Dread Lord"
- `V2` → " v2"

## Categories

| Category | Description |
|---------|-------------|
| Unit | Base units, buildings, troops |
| Hero | Hero models |
| Portrait | UI portraits |
| Effect | Spell effects, missiles |
| Particle | Fire, smoke, dust, fog |
| Blood | Blood splats and effects |
| Spirit | Ghosts and spirits |
| Cinematic | Camera and cinematic models |