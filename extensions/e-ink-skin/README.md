# E-Ink Skin

E-Ink Skin is a trusted local Hermes WebUI extension that adds a
maximum-contrast, near-monochrome light skin tuned for **e-ink displays**
(Kindle, Boox, reMarkable, and similar). It registers into the native
**Settings → Appearance** skin picker, so you select it exactly like a built-in
skin.

## What It Does

- Registers an **E-Ink** skin via the core theme-registration capability
  (`window.registerHermesSkin`), so it appears in the built-in Appearance skin
  picker (no parallel switcher).
- Applies a pure-white background, near-black text, hard black borders, no
  gray-on-gray, and flattened surfaces — optimized for the washed-out,
  low-refresh, near-monochrome panels e-ink screens use.
- Selectable and persisted exactly like any built-in skin; switch back to any
  other skin at any time.

## Dependency

This extension requires the core **theme-registration capability**
(`window.registerHermesSkin`), added in `nesquena/hermes-webui` **PR #5100**. On
an older WebUI build without it, the extension **no-ops gracefully** (the skin is
simply unavailable; nothing errors). Once that capability ships, the skin
registers automatically on load.

## Current Shape

```text
Hermes WebUI page
  -> manifest-bundled extension assets
  -> /extensions/assets/e-ink-skin.js
  -> window.registerHermesSkin({ name:'E-Ink', tokens:{...} })
  -> native Settings -> Appearance skin picker
```

This extension is `static-ui` / manifest-bundle only. It does not add backend
routes, start a sidecar, access external networks, read or write files/storage,
or use native host APIs. It registers a single skin and otherwise does nothing.

## Capabilities

- `manifest-bundle`

It does not require `loopback-sidecar` or sidecar proxy support.

## Install For Local Testing

Start Hermes WebUI with this extension directory:

```bash
cd /path/to/hermes-webui
HERMES_WEBUI_EXTENSION_DIR=/path/to/hermes-webui-extensions/extensions/e-ink-skin HERMES_WEBUI_EXTENSION_MANIFEST=manifest.json ./start.sh
```

Then open Settings → Appearance and pick **E-Ink** from the skin picker.

## Disable And Uninstall

Restart Hermes WebUI without `HERMES_WEBUI_EXTENSION_DIR` /
`HERMES_WEBUI_EXTENSION_MANIFEST` (etc.), or remove the
`extensions/e-ink-skin/` directory from the local extensions checkout. If E-Ink
was the selected skin, switch to another skin in Appearance first (a removed
skin falls back to the default).

## Trust And Permissions

This is trusted local code. The injected JavaScript runs in the Hermes WebUI
browser origin.

Current disclosed behavior:

- calls `window.registerHermesSkin(...)` once with a static color-token set
- creates NO DOM (no buttons, panels, or message-row mutations)
- does not call WebUI HTTP APIs
- does not read or write localStorage / sessionStorage / cookies
- does not contact loopback or external network services
- does not use arbitrary filesystem or native host APIs

The skin's color values are also sanitized by the core registration API before
they are applied, so the extension cannot inject anything other than valid
color tokens.

## Compatibility

Required WebUI surface:

- manifest-bundled extension assets + same-origin serving under `/extensions/`
- the core theme-registration capability (`window.registerHermesSkin`, PR #5100)

## Verification

From this repository:

```bash
node scripts/validate-extensions.mjs
node scripts/scan-extension-safety.mjs
node scripts/generate-registry.mjs --out dist/registry.json
node --check extensions/e-ink-skin/assets/e-ink-skin.js
python3 -m json.tool extensions/e-ink-skin/extension.json
python3 -m json.tool extensions/e-ink-skin/manifest.json
```

Manual verification (on a WebUI build with PR #5100):

- Settings → Appearance shows **E-Ink** in the skin picker
- selecting it applies the high-contrast monochrome palette across the app
- the choice persists across a reload
- switching to another skin restores the previous look

## Known Limitations

- Requires the core theme-registration capability (PR #5100); no-ops without it.
- E-ink panels vary; this is a general high-contrast tuning, not per-device
  calibration.
- A single light palette by design — e-ink screens are effectively monochrome,
  so there is no separate dark variant.
- The Hermes brand logo (the caduceus glyph in the empty-state hero and the
  titlebar) keeps its gold gradient. That mark is a hardcoded inline-SVG
  gradient in core, not driven by any theme token, so no skin — built-in or
  extension — recolors it. Everything the theme-token system controls (text,
  surfaces, borders, accents, chips, bubbles, controls) is fully monochrome.
