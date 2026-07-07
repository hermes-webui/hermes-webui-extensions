# Assistant Avatar — Cute companion character

A small Canvas 2D character face that floats in the bottom-right corner of the Hermes WebUI and scurries away from your cursor.

**v0.4.0** — SVG path-based characters, mouse tracking, and avoid/flee behavior.

## What's new in v0.4.0

- **5 SVG-defined characters** — Pixel, Neko (cat), Yuki (spirit), Robot, Monster. Each designed as layered SVG paths for independent eye animation.
- **Mouse tracking** — pupils follow your cursor around the screen.
- **Avoid mode** — the avatar scurries away from your cursor when you get close. Click it and it flees dramatically.
- **Eye tracking toggle** — in settings (double-click), you can toggle eye tracking on/off.

## Characters

| Name | Style | License |
|---|---|---|
| Pixel | Cute chibi human | MIT (procedural) |
| Neko | Cat girl with ears | MIT |
| Yuki | Snow spirit / ghost | MIT |
| Robot | Mechanical buddy | MIT |
| Monster | Cute monster | MIT |

Characters are rendered as SVG path data via Canvas `Path2D`, with separate layers for head, eye whites, iris, pupils, highlights, and mouth. Pupils are animated independently for mouse tracking.

## Mouse Tracking

The avatar's pupils follow your cursor by default. The movement is bounded (max ~4px offset) and smoothed with easing. You can toggle it in settings.

## Behavior

The avatar lives in the bottom-right corner and **scurries away from your cursor** when you move within ~120px of it. Click it and it makes a dramatic escape in a random direction. When you move your cursor away, it drifts back to its corner.

The avatar's pupils follow your cursor by default. Toggle eye tracking via **👀 Track ✓** in settings (double-click).

## Install (already done)

The extension lives at `~/.hermes/webui-dev/extensions/assistant-avatar/` and is registered in the install manifest.

## Verify it loaded

1. Open the Hermes WebUI
2. Open DevTools → Console
3. Type: `window.HermesAssistantAvatar.getExpression()`
4. You should see `{current: "idle", target: "idle", tween: 1}`

## Public API

```javascript
// Check current state
window.HermesAssistantAvatar.getExpression()

// Force an expression
window.HermesAssistantAvatar.setExpression('speaking')
window.HermesAssistantAvatar.setExpression('thinking')
window.HermesAssistantAvatar.setExpression('surprised')
window.HermesAssistantAvatar.setExpression('happy')
window.HermesAssistantAvatar.setExpression('idle')

// Toggle mouse tracking
window.HermesAssistantAvatar.setMouseTracking(false)  // disable
window.HermesAssistantAvatar.setMouseTracking(true)   // enable

// Show/hide
window.HermesAssistantAvatar.hide()
window.HermesAssistantAvatar.show()

// Remove entirely
window.HermesAssistantAvatar.destroy()

// List available presets
window.HermesAssistantAvatar.getPresets()

// Switch character
window.HermesAssistantAvatar.switchPreset('neko')
window.HermesAssistantAvatar.switchPreset('pixel')
window.HermesAssistantAvatar.switchPreset('yuki')
```

## Files

```
~/.hermes/webui-dev/extensions/assistant-avatar/
├── manifest.json
├── extension.json
├── README.md
└── assets/
    ├── avatar.js       # v0.4.0 — SVG paths + mouse tracking (~31 KB)
    └── avatar.css      # Positioning overlay with hover effects
```

## Architecture

Characters are defined as SVG path strings in the `PRESETS` object. Each character has independent path layers:

- **Static paths**: head, hair, ears, eye whites, iris, nose, whiskers, etc.
- **Mouth paths**: one per expression (idle, happy, speaking, thinking, surprised)
- **Dynamic pupils**: pupil paths are translated by mouse position at render time

All paths use the `Path2D` Canvas API for native performance.

The mouse tracking system normalizes cursor position to -1..1 relative to viewport center, clamps it, and applies the offset to pupil position with easing.
