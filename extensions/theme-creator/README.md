# Theme Creator

Theme Creator is a trusted local Hermes WebUI extension that lets you **build your
own theme**. Pick colors for the key design tokens, watch a live preview, name
it, and save — your custom theme registers into the **native Settings →
Appearance** skin picker, selectable and persisted like a built-in skin. Create,
edit, and delete as many themes as you like.

This is the extension form of the closed core PR #1589 ("user-defined custom
themes" by @Michaelyklam), which was declined for core on curation grounds —
custom user themes are exactly the kind of opt-in, local personalization the
extension system is for.

## What It Does

- Adds a rail button that opens the Theme Creator panel.
- A curated set of color inputs (background, surfaces, text, muted, accent,
  borders, your-message bubble), each with a color picker + hex field.
- **Live preview** applies the in-progress theme to the whole app; **Stop
  preview** reverts to your previous skin.
- **Save** registers the theme into the native Appearance picker and applies it.
- **Saved themes** list: apply / edit / delete each.
- Everything is stored locally (`hermes-ext-custom-themes`); nothing is uploaded.

## How it stays usable (and safe)

Rather than expose ~30 raw CSS tokens, the editor offers a handful of primary
colors and **derives** the rest (the full accent family, secondary surfaces,
borders, code background, etc.) with simple color math. Every derived value is
still sent through the core `registerHermesSkin` **sanitizer**, so an invalid or
malicious color value can never be applied — the core capability is the single
security chokepoint.

## Code / chat surface coverage

The core `registerHermesSkin()` allowlist excludes a few code/chat-surface tokens
(`--strong`, `--code-inline-bg`, `--pre-text`, `--input-bg`) and emits no
dark-mode variant, so on a mismatched base theme a custom theme's inline code and
code blocks would inherit the base-theme values and could render unreadable. To
cover that, the extension emits its own managed `<style>` (id
`hwxThemeCreatorCodeStyles`) with those tokens derived from each saved theme's
(and the live preview's) own palette, under both `:root[data-skin]` and
`:root.dark[data-skin]`, so a custom theme composes cleanly in Light, Dark, and
System Default base modes. The block is refreshed on register/save/preview/delete.

## Dependency

Requires the core **theme-registration capability** (`window.registerHermesSkin`),
added in `nesquena/hermes-webui` **PR #5100**. Without it, the panel still opens
and you can design a theme, but a notice explains it can't be applied yet (the
extension does nothing destructive).

## Current Shape

```text
Hermes WebUI page
  -> manifest-bundled extension assets
  -> /extensions/assets/theme-creator.js + .css
  -> rail button -> editor panel (color pickers + live preview)
  -> window.registerHermesSkin({...derived tokens...})  -> native Appearance picker
  -> localStorage: hermes-ext-custom-themes (your saved themes)
                   hermes-skin (the core skin-selection key, to apply a theme)
```

This extension is `static-ui` / manifest-bundle only — no backend, no sidecar,
no network, no native host. Color processing is pure in-browser math.

## Capabilities

- `manifest-bundle`

## Install For Local Testing

```bash
cd /path/to/hermes-webui
HERMES_WEBUI_EXTENSION_DIR=/path/to/hermes-webui-extensions/extensions/theme-creator HERMES_WEBUI_EXTENSION_MANIFEST=manifest.json ./start.sh
```

Click the Theme Creator rail button, design a theme, Live preview, then Save. It
appears in Settings → Appearance.

## Controls

Also on `window.HermesThemeCreatorExtension`:

- `.themes()` — your saved themes
- `.open()` — open the editor
- `.registerAll()` — re-register saved themes into the picker

## Disable And Uninstall

Restart Hermes WebUI without `HERMES_WEBUI_EXTENSION_DIR` /
`HERMES_WEBUI_EXTENSION_MANIFEST`, or remove the `extensions/theme-creator/`
directory. Your themes live under `hermes-ext-custom-themes`. If a custom theme
was the active skin, switch to another skin in Appearance (a removed skin falls
back to default).

## Trust And Permissions

This is trusted local code. Current disclosed behavior:

- creates extension-owned DOM (a rail button + the editor panel)
- calls `window.registerHermesSkin(...)` with derived, sanitized color tokens
- injects a small extension-managed `<style>` (`hwxThemeCreatorCodeStyles`) for
  per-theme code/chat token coverage, using validated hex/rgba values only
- reads/writes `localStorage`:
  - **owned:** `hermes-ext-custom-themes` (your saved themes; validated on read,
    capped at 50 themes / 256 KB)
  - **shared:** `hermes-skin` — the core skin-selection key, written to apply a
    theme (the same key the built-in Appearance picker uses)
- applies a theme through the core `window._pickSkin()` path when available, which
  commits the appearance change immediately — i.e. core **autosaves appearance via
  an authenticated `POST /api/settings`** as a side effect (disclosed as
  `webui_api.write: ["settings"]`). The extension itself issues no other HTTP calls.
- does NOT access cookies, contact any external network, or use the filesystem /
  native hosts
- all rendered text (theme names) is escaped; theme records are validated on read
  (key grammar + hex base colors); all colors are validated hex and re-sanitized by
  the core registration API

## Compatibility

- manifest-bundled extension assets + same-origin serving under `/extensions/`
- the left rail (`.rail`) to host the button
- the core theme-registration capability (`window.registerHermesSkin`, PR #5100)
- uses the core `_pickSkin()` to apply when available, falling back to setting
  `data-skin` + `hermes-skin` directly

## Verification

```bash
node scripts/validate-extensions.mjs
node scripts/scan-extension-safety.mjs
node scripts/generate-registry.mjs --out dist/registry.json
node --check extensions/theme-creator/assets/theme-creator.js
python3 -m json.tool extensions/theme-creator/extension.json
python3 -m json.tool extensions/theme-creator/manifest.json
```

Manual verification (on a WebUI build with PR #5100):

- the rail button opens the editor; color pickers + hex fields stay in sync
- Live preview applies the theme app-wide; Stop preview reverts
- Save registers the theme into Settings → Appearance and applies it
- saved themes can be applied / edited / deleted
- themes persist across a reload and re-register into the picker on load

## Known Limitations

- Requires the core theme-registration capability (PR #5100).
- Curated inputs with derived tokens (not every raw token is individually
  editable) — a deliberate usability trade-off.
- Themes are per-browser (`localStorage`), not synced across devices.
- The brand logo glyph keeps its gold gradient (hardcoded in core; no skin
  recolors it).
