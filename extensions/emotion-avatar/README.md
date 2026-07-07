# Emotion Avatar

A complete animated companion avatar extension for Hermes WebUI. Renders a character in the bottom-right corner with emotional expressions driven by voice interaction (FAC), LLM response tags, and agent state.

**All in one extension** — no separate emotion bridge needed.

## Features

- **5 characters** — Pixel, Neko, Yuki, Robot, Monster (SVG path-based, 192×192)
- **Custom colors** — per-character color picker, saved to localStorage
- **Mouse tracking** — eyes follow cursor, with curious float animation
- **Avoid behavior** — mouse hover pushes character away; click makes it flee
- **Settings panel** — double-click to open, gear icon in titlebar
- **Expression system** — 5 expressions: idle, happy, speaking, thinking, surprised

## Emotion Sources (priority order)

| Priority | Source | Expression Trigger |
|----------|--------|-------------------|
| 1 (highest) | FAC `hermes:fac:emotion` event | Voice-detected emotion from FAC pipeline |
| 2 | External `hermes:avatar:emotion` event | Any extension can dispatch this |
| 3 | LLM response tags | `[happy]`, `[surprised]`, `[thinking]` etc. scanned from latest message |
| 4 | Agent state polling | `thinking` → thinking mouth, `speaking` → animated mouth, `idle` → idle |
| 5 | Default | idle (with rare random happy) |

## Expression reference

| Expression | Visual | Trigger sources |
|------------|--------|-----------------|
| `idle` | Rest mouth, normal eyes | Default idle state |
| `happy` | Smiling mouth, cheek blush | LLM `[happy]`, random 1.5% |
| `speaking` | Animated open/close mouth | `speechSynthesis.speaking` |
| `thinking` | Puckered mouth | S.busy, active stream |
| `surprised` | Open circle mouth | Mouse click, cursor proximity |

## Integration: other extensions

### Consuming (any extension can set the avatar expression)

```javascript
// Option A: Use the public API
window.HermesEmotionAvatar.setExpression('happy');

// Option B: Emit the emotion event
window.dispatchEvent(new CustomEvent('hermes:avatar:emotion', {
  detail: { expression: 'surprised', source: 'my-ext' }
}));
```

### Extending (any extension can read the current expression)

```javascript
// Poll the shared state
window.__avatarExpression // → 'happy'

// Or listen for events
window.addEventListener('hermes:avatar:expression', function(e) {
  console.log('Avatar shows:', e.detail.expression, 'from', e.detail.source);
});
```

### FAC integration (Fun-Audio-Chat)

The FAC plugin should emit `hermes:fac:emotion` events:

```javascript
window.dispatchEvent(new CustomEvent('hermes:fac:emotion', {
  detail: { emotion: 'happy', confidence: 0.92 }
}));
```

When this fires, the avatar overrides its default state polling to show the FAC-detected emotion.

### VTuber component reuse (reference)

| Project | License | Component |
|---------|---------|-----------|
| [Open-LLM-VTuber](https://github.com/Snowfork/Open-LLM-VTuber) | MIT | Expression keywords in LLM responses → avatar expressions |
| [Airi](https://github.com/moeru-ai/airi) | MIT | 2D/3D avatar rendering, eye tracking, lip sync |
| [three-vrm](https://github.com/pixiv/three-vrm) | MIT | VRM avatar loader for Three.js (future 3D upgrade path) |
| [face-api.js](https://github.com/justadudewhohacks/face-api.js) | MIT | Webcam emotion mirroring (future) |

## Public API

```javascript
window.HermesEmotionAvatar = {
  version: '0.5.0',
  setExpression(expr),       // Force an expression
  getExpression(),           // { current, target, tween }
  hide(), show(),            // Toggle visibility
  getConfig(),               // Current color config
  setConfig(partial),        // Update color config
  resetConfig(),             // Reset colors to defaults
  openSettings(),            // Open settings panel
  switchPreset(name),        // Switch character
  setMouseTracking(bool),    // Enable/disable eye tracking
  emotionBridge: {           // Direct emit access
    emit(expr, source),
    emitDirectly(expr, source)
  },
  destroy()                  // Clean up
};
```

## Files

```
extensions/emotion-avatar/
├── extension.json           # Extension metadata
├── manifest.json            # Install manifest
├── README.md                # This file
└── assets/
    ├── emotion-avatar.js    # Combined renderer + emotion bridge
    └── emotion-avatar.css   # Styles
```
