# Model Favorites

Model Favorites is a trusted local Hermes WebUI extension that lets you star the
models you use most in the composer model picker. Favorited models are promoted
to a **★ Favorites** group at the top of the dropdown for one-click switching.

## What It Does

- Adds a star toggle to each model row in the composer model picker (visible on
  hover, and always visible once a model is favorited).
- Promotes favorited models into a **★ Favorites** group pinned to the top of
  the dropdown.
- **Provider-aware**: the same model id offered by two providers is two distinct
  favorites, so you can favorite exactly the one you mean.
- Persists favorites locally (`localStorage`), so they survive reloads.
- Re-applies after the picker re-renders (open / search / select) via a
  `MutationObserver`.

## Current Shape

```text
Hermes WebUI page
  -> manifest-bundled extension assets
  -> /extensions/assets/model-favorites.js + .css
  -> decorates #composerModelDropdown .model-opt rows with a star
  -> injects a "★ Favorites" group at the top
  -> localStorage: hermes-ext-model-favorites
```

This extension is `static-ui` / manifest-bundle only. It does not add backend
routes, start a sidecar, access external networks, read or write files, or use
native host APIs.

## Capabilities

- `manifest-bundle`

## Install For Local Testing

```bash
cd /path/to/hermes-webui
HERMES_WEBUI_EXTENSION_DIR=/path/to/hermes-webui-extensions/extensions/model-favorites HERMES_WEBUI_EXTENSION_MANIFEST=manifest.json ./start.sh
```

Open the composer model picker, hover a model, and click the star. It appears in
the Favorites group at the top.

## Disable And Uninstall

Restart Hermes WebUI without `HERMES_WEBUI_EXTENSION_DIR` /
`HERMES_WEBUI_EXTENSION_MANIFEST`, or remove the `extensions/model-favorites/`
directory. Your favorites live under the `hermes-ext-model-favorites` localStorage
key.

## Trust And Permissions

This is trusted local code. Current disclosed behavior:

- creates extension-owned DOM (a star button per model row + a Favorites group)
  inside the existing model dropdown
- reads each row's model id / name / provider from the existing
  `.model-opt-id` / `.model-opt-name` / `.model-opt-provider` elements
- selects a favorite by calling the existing `window.selectModelFromDropdown(...)`
- reads and writes `localStorage` under the single key
  `hermes-ext-model-favorites`
- does not call WebUI HTTP APIs
- does not access cookies
- does not contact loopback or external network services
- does not use arbitrary filesystem or native host APIs

All rendered text (model names/ids/providers) is inserted via escaped HTML.

## Compatibility

- manifest-bundled extension assets + same-origin serving under `/extensions/`
- the composer model dropdown `#composerModelDropdown` with `.model-opt` rows
  carrying `.model-opt-id` / `.model-opt-name` / `.model-opt-provider` (the
  integration contract; if core renames these, the extension needs updating)

## Verification

```bash
node scripts/validate-extensions.mjs
node scripts/scan-extension-safety.mjs
node scripts/generate-registry.mjs --out dist/registry.json
node --check extensions/model-favorites/assets/model-favorites.js
python3 -m json.tool extensions/model-favorites/extension.json
python3 -m json.tool extensions/model-favorites/manifest.json
```

Manual verification:

- hovering a model row shows a star; clicking it adds the model to a Favorites
  group at the top of the dropdown and the star fills in
- the same model under a different provider is favorited independently
- clicking a favorite selects that model
- un-starring (from either the row or the Favorites group) removes it
- favorites persist across a reload and across reopening the dropdown

## Known Limitations

- Relies on the current model-picker DOM (`.model-opt*` classes); a core rename
  would require an update — standard for a DOM-injection extension.
- Credit: the provider-aware favorite design follows closed core PR #3578
  (@starship-s); this is a lighter client-side extension over the current
  grouped picker rather than the original core implementation.
