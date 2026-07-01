# Mobile Haptics

Mobile Haptics is a trusted local Hermes WebUI extension that gives your phone a
short vibration when an assistant turn finishes — so if you fire off a long task
and set the device down, you get a physical "it's done" cue.

## What It Does

- Watches for the end of an assistant turn and triggers a short
  `navigator.vibrate()` buzz.
- Opt-in preference stored locally (`hermes-ext-haptics-enabled`); on by default
  where vibration is supported.
- Ignores sub-100ms flickers; the real "a turn happened" gate is observing a
  genuine busy action (stop/steer/interrupt), so only real turns buzz.

## Platform support (important)

`navigator.vibrate` is a **mobile** API:

- ✅ **Android / Android-PWA (Chrome, Edge, etc.)** — works.
- ⛔ **Desktop browsers** — the call is a silent no-op (no vibration hardware).
- ⛔ **iOS Safari / iOS PWA** — Apple does not support `navigator.vibrate`, so
  this has no effect on iPhone/iPad.

The extension detects support and degrades silently (it logs an informational
note in the console when vibration isn't available). This is, by design, an
Android-leaning feature.

## How it detects "turn complete"

Extensions can't see the server's streaming (SSE) events, so this reads the DOM
instead: the composer send button (`#btnSend`) carries a busy action
(`stop` / `steer` / `interrupt`) while the assistant is generating and returns
to the idle `send` action when the turn finishes. A `MutationObserver` on that
button's `class` / `data-action` catches the busy → idle transition and fires
the buzz.

## Current Shape

```text
Hermes WebUI page
  -> manifest-bundled extension assets
  -> /extensions/assets/mobile-haptics.js
  -> MutationObserver on #btnSend (busy -> idle) -> navigator.vibrate()
  -> localStorage: hermes-ext-haptics-enabled
```

This extension is `static-ui` / manifest-bundle only. It does not add backend
routes, start a sidecar, access external networks, read or write files, or use
native host APIs. It creates no DOM.

## Capabilities

- `manifest-bundle`

## Install For Local Testing

```bash
cd /path/to/hermes-webui
HERMES_WEBUI_EXTENSION_DIR=/path/to/hermes-webui-extensions/extensions/mobile-haptics HERMES_WEBUI_EXTENSION_MANIFEST=manifest.json ./start.sh
```

Open the WebUI on an Android device (or Android-PWA), send a message, and feel a
short buzz when the reply completes.

## Controls

A small JS control surface is exposed on `window.HermesMobileHapticsExtension`:

- `.supported` — whether `navigator.vibrate` exists on this device
- `.isEnabled()` — current opt-in state
- `.setEnabled(true|false)` — toggle and persist
- `.test()` — fire a test buzz (returns false if unsupported)

## Disable And Uninstall

Set `HermesMobileHapticsExtension.setEnabled(false)` to turn off buzzing while
keeping the extension installed, or restart Hermes WebUI without
`HERMES_WEBUI_EXTENSION_DIR` / `HERMES_WEBUI_EXTENSION_MANIFEST`, or remove the
`extensions/mobile-haptics/` directory.

## Trust And Permissions

This is trusted local code. Current disclosed behavior:

- calls `navigator.vibrate()` when an assistant turn completes (if enabled +
  supported)
- observes the `#btnSend` button's `class` / `data-action` via a
  `MutationObserver` (read-only)
- reads and writes `localStorage` under the single key
  `hermes-ext-haptics-enabled`
- creates NO DOM
- does not call WebUI HTTP APIs
- does not access cookies
- does not contact loopback or external network services
- does not use arbitrary filesystem or native host APIs

## Compatibility

- manifest-bundled extension assets + same-origin serving under `/extensions/`
- the composer send button `#btnSend` with its `data-action` / busy-class
  contract (used to detect turn completion)
- a device with `navigator.vibrate` (Android) for any actual effect

## Verification

```bash
node scripts/validate-extensions.mjs
node scripts/scan-extension-safety.mjs
node scripts/generate-registry.mjs --out dist/registry.json
node --check extensions/mobile-haptics/assets/mobile-haptics.js
python3 -m json.tool extensions/mobile-haptics/extension.json
python3 -m json.tool extensions/mobile-haptics/manifest.json
```

Functional verification (the busy → idle detection is the testable core; the
actual vibration only fires on Android hardware):

- on a desktop browser, `HermesMobileHapticsExtension.supported` is `false` and
  no error occurs
- sending a message flips `#btnSend` to a busy action and back; the extension's
  state machine logs/triggers on the idle transition
- on an Android device, completing a turn produces a short buzz when enabled

## Known Limitations

- No effect on desktop or iOS (platform limitation of `navigator.vibrate`).
- Detects turn completion from the send-button state, so it relies on the
  current `#btnSend` `data-action` / busy-class contract.
- Browsers may suppress vibration until the user has interacted with the page
  (a standard mobile-browser gesture requirement); sending a message satisfies
  that.
