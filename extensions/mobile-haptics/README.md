# Mobile Haptics

Mobile Haptics is a trusted local Hermes WebUI extension that gives your phone a
short vibration when an assistant turn finishes. If you start a long task and
set the device down, the buzz is a physical "it's done" cue.

## What It Does

- Subscribes to the Core `turn:complete` lifecycle event and triggers a short
  `navigator.vibrate()` buzz.
- Vibrates only when the extension is enabled and the platform exposes
  `navigator.vibrate`.
- Keeps the preference in the native Settings → Extensions toggle through the
  scoped extension settings handle.

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

The extension uses the cooperative E0/B1 capability handle:

1. It calls `window.hermesExt.register('mobile-haptics')` to obtain its scoped
   handle.
2. It subscribes only to `ext.events.on('turn:complete', handler)`.
3. The handler reads `ext.settings.get('enabled')` and, when enabled on a
   supported device, calls `navigator.vibrate([18])` once.

The extension does not depend on Core's private implementation details. If the
scoped E0/B1 handle is unavailable (as on an older Core), it warns and fails
closed without subscribing or vibrating.

## Current Shape

```text
Hermes WebUI page
  -> manifest-bundled extension assets
  -> /extensions/assets/mobile-haptics.js
  -> scoped E0 handle (hermesExt.register)
  -> B1 turn:complete event -> navigator.vibrate([18])
  -> scoped ext.settings `enabled` preference
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

Open the WebUI on an Android device (or Android-PWA), send a message, and feel
a short buzz when the reply completes.

## Controls

The **on/off toggle renders natively in Settings → Extensions → Mobile Haptics**
(`settings_schema` + `permissions.storage.owned: true`). The extension reads and
writes this value only through the returned `ext.settings` handle.

A small JS control surface is also exposed on
`window.HermesMobileHapticsExtension`:

- `.supported` — whether `navigator.vibrate` exists on this device
- `.isEnabled()` — current opt-in state from the scoped settings handle
- `.setEnabled(true|false)` — toggle and persist through scoped settings
- `.test()` — fire a test buzz (returns false if unsupported or the lifecycle
  capability is unavailable)

## Disable And Uninstall

Set `HermesMobileHapticsExtension.setEnabled(false)` to turn off buzzing while
keeping the extension installed, or restart Hermes WebUI without
`HERMES_WEBUI_EXTENSION_DIR` / `HERMES_WEBUI_EXTENSION_MANIFEST`, or remove the
`extensions/mobile-haptics/` directory.

## Trust And Permissions

This is trusted local code. Current disclosed behavior:

- calls `navigator.vibrate([18])` when Core emits `turn:complete` and the
  extension is enabled on a supported device
- obtains the scoped E0 handle with `window.hermesExt.register('mobile-haptics')`
  and subscribes to the B1 `turn:complete` event
- reads/writes the `enabled` setting through the returned `ext.settings` handle
- creates NO DOM and does not inspect Core-owned DOM views
- does not call WebUI HTTP APIs
- does not access cookies, unscoped browser storage, loopback, or external
  network services
- does not use arbitrary filesystem or native host APIs

## Compatibility

The minimum lifecycle contract is **exp-v0.52.201 / Core #6924**, which provides
the cooperative E0 scoped identity handle and B1 turn-lifecycle events. Older
Core builds fail closed with a warning; this extension does not fall back to
private DOM state or legacy storage.

## Verification

```bash
node scripts/test-mobile-haptics.mjs
node scripts/validate-extensions.mjs
node scripts/scan-extension-safety.mjs
node scripts/generate-registry.mjs --out dist/registry.json
node --check extensions/mobile-haptics/assets/mobile-haptics.js
python3 -m json.tool extensions/mobile-haptics/extension.json
python3 -m json.tool extensions/mobile-haptics/manifest.json
```

Functional verification (the lifecycle handler is covered by the Node contract
test; the actual vibration only fires on Android hardware):

- on a desktop browser, `HermesMobileHapticsExtension.supported` is `false` and
  no error occurs
- with Core exp-v0.52.201 or newer, completing a turn emits one
  `turn:complete` event and produces a short buzz when enabled
- on an older Core without E0/B1, the extension logs a warning and remains
  inactive

## Known Limitations

- No effect on desktop or iOS (platform limitation of `navigator.vibrate`).
- Browsers may suppress vibration until the user has interacted with the page
  (a standard mobile-browser gesture requirement); sending a message satisfies
  that.
