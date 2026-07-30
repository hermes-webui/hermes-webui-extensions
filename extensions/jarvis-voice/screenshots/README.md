# Jarvis Voice screenshots

**These are harness renders, not captures of a live Hermes WebUI.**

`harness.html` is a standalone page that loads this extension's real
`assets/jarvis-voice.css` and `assets/jarvis-voice.js`, so the panel in every
image is built by the extension's own `render()`. The theme variables are the
verbatim `:root` and `:root.dark` blocks from core `static/style.css`, inlined so
the colours are genuine core values rather than invented ones.

What the harness does **not** include: any core markup, any core behaviour, a
session, a sidecar, or a Gemini connection. The grey bars stand in for page
content, and the transcript lines are a fixture written by the page itself. No
part of these images demonstrates the extension working against a running
Hermes WebUI.

## Images

| File | Viewport | Theme |
| --- | --- | --- |
| `jarvis-voice-desktop-light.png` | 1280×800 @2x | light |
| `jarvis-voice-desktop-dark.png` | 1280×800 @2x | dark |
| `jarvis-voice-mobile-light.png` | 390×844 @3x, touch | light |
| `jarvis-voice-mobile-dark.png` | 390×844 @3x, touch | dark |

## Regenerating

```bash
cd extensions/jarvis-voice
python3 -m http.server 8898
# then open http://127.0.0.1:8898/screenshots/harness.html?theme=dark
```

Append `?theme=dark` for the dark variants. The mobile images were taken at
390×844 with touch emulation on, which is what triggers the `pointer: coarse`
rule that raises the action buttons to the 44px floor.

## Measured from the rendered layout

Taken from `getBoundingClientRect()` / `getComputedStyle()` on the real panel,
not read off the images:

| Property | Desktop | Mobile |
| --- | --- | --- |
| Panel `z-index` | 1000 | 1000 |
| Toggle size | 48×48 | 48×48 |
| Talk/Stop/Disconnect height | 31px | **44px** |
| Card overflows right edge | no | no |
| Card overflows bottom edge | no | no |
| Card background (light / dark) | `rgb(243,238,227)` / `rgb(26,26,46)` | same |
