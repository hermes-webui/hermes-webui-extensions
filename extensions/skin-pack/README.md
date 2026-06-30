# Skin Pack

Skin Pack is a trusted local Hermes WebUI extension that adds a set of popular
editor-inspired color themes to the **native Settings → Appearance** skin
picker. Core keeps its built-in skin list deliberately curated; this extension
covers the long tail of "I want my editor's theme."

## Themes

- **Dracula**
- **Gruvbox**
- **One Dark**
- **Tokyo Night**
- **Rosé Pine**
- **Solarized Dark**

Each is a full dark palette (background, surfaces, text, accents, borders, code,
sidebar, bubbles), not just an accent tint.

## What It Does

- Registers each theme via the core theme-registration capability
  (`window.registerHermesSkin`), so they appear in the built-in Appearance skin
  picker — selectable and persisted exactly like a built-in skin (no parallel
  switcher).
- Creates no DOM; reads/writes no storage; no network. Each theme is a static
  color-token set.

## Dependency

This extension requires the core **theme-registration capability**
(`window.registerHermesSkin`), added in `nesquena/hermes-webui` **PR #5100**. On
an older WebUI without it, the extension **no-ops gracefully** (the themes are
simply unavailable; nothing errors).

## Current Shape

```text
Hermes WebUI page
  -> manifest-bundled extension assets
  -> /extensions/assets/skin-pack.js
  -> window.registerHermesSkin({...}) x6
  -> native Settings -> Appearance skin picker
```

This extension is `static-ui` / manifest-bundle only. It does not add backend
routes, start a sidecar, access external networks, read or write files/storage,
or use native host APIs.

## Capabilities

- `manifest-bundle`

## Install For Local Testing

```bash
cd /path/to/hermes-webui
HERMES_WEBUI_EXTENSION_DIR=/path/to/hermes-webui-extensions/extensions/skin-pack HERMES_WEBUI_EXTENSION_MANIFEST=manifest.json ./start.sh
```

Then open Settings → Appearance and pick one of the new themes from the skin
picker.

## Disable And Uninstall

Restart Hermes WebUI without `HERMES_WEBUI_EXTENSION_DIR` /
`HERMES_WEBUI_EXTENSION_MANIFEST`, or remove the `extensions/skin-pack/`
directory. If one of these themes was selected, switch to another skin in
Appearance first (a removed skin falls back to the default).

## Trust And Permissions

This is trusted local code. Current disclosed behavior:

- calls `window.registerHermesSkin(...)` once per bundled theme with static
  color-token sets
- creates NO DOM (no buttons, panels, or message-row mutations)
- does not call WebUI HTTP APIs
- does not read or write localStorage / sessionStorage / cookies
- does not contact loopback or external network services
- does not use arbitrary filesystem or native host APIs

The themes' color values are also sanitized by the core registration API before
they are applied, so the extension cannot inject anything other than valid color
tokens.

## Compatibility

- manifest-bundled extension assets + same-origin serving under `/extensions/`
- the core theme-registration capability (`window.registerHermesSkin`, PR #5100)

## Code / chat surface coverage

All six skins are dark editor palettes. The core `registerHermesSkin()` API only
accepts allowlisted tokens and emits a single `:root[data-skin="..."]` rule with
no dark-mode variant, and a few code/chat-surface tokens core uses (`--strong`,
`--code-inline-bg`, `--pre-text`, `--input-bg`) are not on that allowlist. On a
Light / System-Default-light base theme those keep their light base values
against the dark skin surfaces, so assistant inline code and code blocks render
nearly invisible. The bundled `assets/skin-pack.css` pins those tokens to each
skin's own dark palette under both `:root[data-skin]` and `:root.dark[data-skin]`,
so every skin stays readable in Light, Dark, and System Default base modes.

## Verification

```bash
node scripts/validate-extensions.mjs
node scripts/scan-extension-safety.mjs
node scripts/generate-registry.mjs --out dist/registry.json
node --check extensions/skin-pack/assets/skin-pack.js
python3 -m json.tool extensions/skin-pack/extension.json
python3 -m json.tool extensions/skin-pack/manifest.json
```

Manual verification (on a WebUI build with PR #5100):

- Settings → Appearance shows all six themes in the skin picker
- selecting each applies its full palette across the app
- the choice persists across a reload
- switching to another skin restores the previous look

## Known Limitations

- Requires the core theme-registration capability (PR #5100); no-ops without it.
- The Hermes brand logo glyph keeps its gold gradient (a hardcoded inline-SVG
  gradient in core, driven by no theme token, so no skin recolors it).
- All themes are dark palettes (the genre is editor dark themes); a light
  variant per theme could be added later.
