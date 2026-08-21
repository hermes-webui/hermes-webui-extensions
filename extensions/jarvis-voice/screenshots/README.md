# Jarvis Voice screenshots

Captured from a **running Hermes WebUI** with this extension installed, not from a
mock page. The panel, the surrounding chrome, and the theme colours are all the
real application.

| File | Viewport | Theme |
| --- | --- | --- |
| `jarvis-voice-desktop-light.png` | 1440×900 @2x | light |
| `jarvis-voice-desktop-dark.png` | 1440×900 @2x | dark |
| `jarvis-voice-mobile-light.png` | 390×844 @3x, touch | light |
| `jarvis-voice-mobile-dark.png` | 390×844 @3x, touch | dark |

The conversation shown was started by `run_hermes`, so these images double as
evidence that a voice-initiated task leaves no correlation marker behind: the
message bubble, the sidebar entry, and the tab title all read exactly
`summarise the deploy status`. An earlier revision appended
`<!-- jarvis_request_id:... -->` to the prompt, which core rendered as literal
text in all three places.

## What is real and what is staged

Real: the WebUI, the sidebar and composer, core's theme variables, the extension
loaded through core's own extension loader, and the panel built by the
extension's own `render()`.

Staged: the transcript lines inside the panel are written by the capture script so
the panel is shown in its normal in-use state. Reaching that state for real needs
a Gemini Live connection, which would put a live provider session and a real API
key into a screenshot.

Not present: no Gemini connection, no token sidecar, and the Hermes agent backend
was deliberately absent in the capture instance, so nothing in these images
depended on a working model provider.

## Reproducing

```bash
# 1. Run core with an isolated state directory
HERMES_WEBUI_STATE_DIR=/tmp/webui-state HERMES_WEBUI_PORT=8791 python server.py

# 2. Install this extension into that state directory
mkdir -p /tmp/webui-state/extensions
cp -R extensions/jarvis-voice /tmp/webui-state/extensions/
printf '{"version":1,"installed":{"jarvis-voice":{"version":"0.1.0","source":"local"}}}' \
  > /tmp/webui-state/extension-install-manifest.json

# 3. Open http://127.0.0.1:8791/ and click the J button
```

Add `document.documentElement.classList.add('dark')` for the dark variants. The
mobile images need touch emulation on, which is what triggers the
`pointer: coarse` rule raising the action buttons to the 44px floor.

## Measured from the live layout

Read from `getBoundingClientRect()` and `getComputedStyle()` on the rendered
panel in the running app, not eyeballed from the images:

| Property | Desktop | Mobile (touch) |
| --- | --- | --- |
| Panel `z-index` | 1000 | 1000 |
| Toggle size | 48×48 | 48×48 |
| Talk / Stop / Disconnect height | 31px | **44px** |
| Card overflows right edge | no | no |
| Card overflows bottom edge | no | no |
| Card background, light / dark | `rgb(243,238,227)` / `rgb(26,26,46)` | same |
| Card text, light / dark | `rgb(26,22,16)` / `rgb(255,248,220)` | same |
