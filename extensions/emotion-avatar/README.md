# Emotion Avatar

Modular companion avatar with 5 built-in SVG characters + **import your own Live2D (.moc3/.zip) or Spine (.skel) models**. FAC voice emotion detection, LLM tag scanning, agent state polling. Pluggable inputs, swappable renderers.

```
assets/
├── core/
│   ├── presets.js         # 5 built-in character definitions (Pixel, Neko, Yuki, Robot, Monster)
│   ├── visemes.js         # Phoneme → mouth shape mapping (7-class, lightweight)
│   ├── pipeline.js        # Expression priority engine — resolves conflicts, emits events
│   └── model-store.js     # IndexedDB-backed model registry for user-imported models
├── inputs/                # Pluggable emotion sources
│   ├── agent-state.js     # speechSynthesis + S.busy → speaking/thinking/idle
│   ├── llm-tags.js        # Scans messages for [happy] [surprised] etc.
│   └── fac-emotion.js     # Listens hermes:fac:emotion events from FAC
├── renderers/             # Swappable renderers
│   ├── canvas-2d.js       # 2D Canvas SVG path renderer with mouse tracking (for built-in presets)
│   ├── live2d.js          # Live2D model renderer (loads your .model3.json)
│   ├── spine.js           # Spine model renderer stub (loads your .skel)
│   └── model-manager.js   # Manages renderer switching based on active model type
├── emotion-avatar.js      # Bootstrap — inputs → pipeline → renderer, model import UI
└── emotion-avatar.css     # Styles
```

## Import Your Own Models

Open the ⚙ settings panel in the titlebar. You'll see:

### URL import
Paste a URL to your hosted model file:
- **Live2D**: `https://your-domain/models/my-avatar/model3.json`
- **VRM**: `https://your-domain/models/avatar.vrm`

### File upload
Click "Upload .moc3 / .zip" to import from your local machine:
- `model.moc3` — Live2D model binary
- `model.zip` — Live2D model archive (must contain `.model3.json`)
- `model.skel` — Spine skeleton file
- `model.json` / `model.atlas` — Spine atlas + skeleton

> **Note**: Live2D models require the Cubium runtime (auto-loaded from CDN). Spine models need the official Spine Canvas runtime (see Spine setup below).

### Model switching
Use the dropdown in the settings panel to switch between built-in presets and your imported models.

## License requirements for imported models

| Format | Runtime | License |
|---|---|---|
| **Live2D (.moc3/.model3.json)** | Cubism WebGL SDK (auto-loaded from CDN) | Free for non-commercial; requires Live2D license for commercial use |
| **Spine (.skel/.json + .atlas)** | Spine Canvas Runtime (user-provided) | Requires Spine license from esotericsoftware.com |
| **VRM (.vrm)** | @pixiv/three-vrm (MIT) | Planned — via the Three.js renderer plugin |
| **Built-in SVG presets** | Self-contained | MIT (included) |

## Architecture

```
inputs/agent-state ──┐
inputs/llm-tags    ──┤
inputs/fac-emotion ──┤   priority      ┌─ renderers/canvas-2d  (for built-in presets)
                       ├────────► pipeline ─┼─ renderers/live2d    (for Live2D .model3.json)
external dispatch ────┘   resolve      │└─ renderers/spine     (for Spine .skel)
                                        ├► hermes:avatar:expression event
                                        └► window.__avatarExpression
```

## Substitution guide

| Replace this | With this | How |
|---|---|---|
| `inputs/agent-state.js` | Custom state detector | Same `start()`/`stop()`, calls `__ea.pipe.pulse(expr, 'source')` |
| `inputs/fac-emotion.js` | Any voice emotion source | Listen for events, call `__ea.pipe.set(expr, 'fac')` |
| `renderers/canvas-2d.js` | VRM Three.js renderer | Subscribe to `hermes:avatar:expression`, render VRM blendshapes |
| `core/visemes.js` | wlipsync full profile | Replace with wlipsync npm + full MFCC profile for audio lip sync |

## VTuber component provenance (MIT licensed)

| Component | Origin | Usage |
|---|---|---|
| Viseme model (lightweight) | Airi (moeru-ai) `@proj-airi/model-driver-lipsync` | Reference — uses 7-class map instead of 37KB ML profile |
| Expression pipeline | Airi `@proj-airi/core-character` | Architectural pattern — priority-based resolution |
| LLM tag system | Open-LLM-VTuber (Snowfork) | Pattern — `[happy]` `[surprised]` in responses |
| Live2D rendering | pixi-live2d-display (MIT) | Loads user-supplied `model3.json` via CDN Cubism runtime |
| VRM rendering concept | @pixiv/three-vrm (MIT) | Future Three.js renderer for VRM models |

## Public API

```javascript
// Model management
window.HermesEmotionAvatar.switchModel('model_123456')     // Switch to imported model
window.HermesEmotionAvatar.importModel('My Model', url, 'live2d')  // Add model from URL
window.HermesEmotionAvatar.getModels()                      // List all models + presets
window.HermesEmotionAvatar.getActiveModel()                 // Current model definition

// Expression
window.HermesEmotionAvatar.setExpression('surprised')       // Force expression
window.HermesEmotionAvatar.getExpression()                  // Current resolved expression

// Lifecycle
window.HermesEmotionAvatar.destroy()                        // Clean shutdown
```

## Live2D setup

1. Get a Live2D model (`.model3.json` + textures + `.moc3`)
2. Host it on your own server (or local dev server)
3. Open ⚙ settings → paste the URL → "Add"
4. The extension auto-loads Cubism runtime from CDN and renders

To see expressions respond to emotion, your model needs `.exp3.json` files in an `expressions/` folder.

## Spine setup

1. Purchase Spine license (esotericsoftware.com)
2. Get Spine Canvas runtime JS files
3. Host them and configure via the settings
4. Upload your `.skel` + `.atlas` files

> Currently in stub state — drop in your own `renderers/spine.js` or wait for full implementation.

## Independent of assistant-avatar

Install `assistant-avatar` and `emotion-avatar` side by side — no conflicts. `emotion-avatar` provides model import and the emotion pipeline bridge; `assistant-avatar` is the simpler standalone renderer if you don't need model import.
