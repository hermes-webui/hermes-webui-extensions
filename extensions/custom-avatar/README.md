# Custom Assistant Avatar

Custom Assistant Avatar is a trusted local Hermes WebUI extension that lets you
give the assistant a custom avatar image in the chat transcript. The assistant's
role badge is normally a single-letter glyph; this swaps in an image of your
choice.

## What It Does

- Click any assistant avatar badge (`.role-icon.assistant`) to open a small
  picker: upload an image, or remove the current one.
- The image is **downscaled to a 64×64 square and stored locally** as a data-URL
  (`localStorage`), so it stays small and survives reloads.
- Re-applies after the transcript re-renders (streaming, scrolling, reload) via a
  `MutationObserver`, so the avatar persists on every assistant message.
- Falls back to the original letter glyph when no avatar is set or you remove it.

## Scope note (why assistant-only)

The Hermes WebUI deliberately renders **no avatar on user messages** — user
turns are right-aligned bubbles where position identifies the sender, so there is
no user-side avatar slot in the DOM to customize. This extension customizes the
**assistant** avatar badge, which is the avatar element that actually exists.

(Related: closed issue #2677 described "the assistant shows the user's avatar."
On current master there are no avatar *images* at all — both roles use letter
glyphs — so that bug does not reproduce on the current build. This extension adds
the personalization layer rather than fixing a non-present bug.)

## Current Shape

```text
Hermes WebUI page
  -> manifest-bundled extension assets
  -> /extensions/assets/custom-avatar.js + .css
  -> swaps .role-icon.assistant glyph for an <img> when an avatar is set
  -> localStorage: hermes-ext-assistant-avatar (a downscaled data-URL)
```

This extension is `static-ui` / manifest-bundle only. It does not add backend
routes, start a sidecar, access external networks, or use native host APIs. Image
processing happens entirely in the browser (canvas downscale); nothing is
uploaded anywhere.

## Capabilities

- `manifest-bundle`

## Install For Local Testing

```bash
cd /path/to/hermes-webui
HERMES_WEBUI_EXTENSION_DIR=/path/to/hermes-webui-extensions/extensions/custom-avatar HERMES_WEBUI_EXTENSION_MANIFEST=manifest.json ./start.sh
```

Send a message, then click the assistant's avatar badge on the left of its reply
and upload an image.

## Controls

Also exposed on `window.HermesCustomAvatarExtension`:

- `.get()` — current avatar data-URL (or empty)
- `.set(dataUrl)` — set a `data:image/...` avatar
- `.clear()` — remove it
- `.refresh()` — re-apply to current rows

## Disable And Uninstall

Restart Hermes WebUI without `HERMES_WEBUI_EXTENSION_DIR` /
`HERMES_WEBUI_EXTENSION_MANIFEST`, or remove the `extensions/custom-avatar/`
directory. Your avatar lives under the `hermes-ext-assistant-avatar` localStorage
key.

## Trust And Permissions

This is trusted local code. Current disclosed behavior:

- creates extension-owned DOM (an `<img>` inside the assistant role badge + a
  picker popover)
- reads the uploaded image file locally (`FileReader`) and downscales it via a
  `<canvas>`; the result is a small data-URL
- reads and writes `localStorage` under the single key
  `hermes-ext-assistant-avatar`
- does not call WebUI HTTP APIs
- does not access cookies
- does not contact loopback or external network services (the image never leaves
  the browser)
- does not use arbitrary filesystem or native host APIs (the file picker is the
  standard browser `<input type=file>`)

Only validated `data:image/(png|jpeg|gif|webp);base64,...` values are ever
applied, so a malformed stored value can't inject anything.

## Compatibility

- manifest-bundled extension assets + same-origin serving under `/extensions/`
- assistant role badge `.role-icon.assistant` in the transcript (the integration
  contract; a core rename would need an update)

## Verification

```bash
node scripts/validate-extensions.mjs
node scripts/scan-extension-safety.mjs
node scripts/generate-registry.mjs --out dist/registry.json
node --check extensions/custom-avatar/assets/custom-avatar.js
python3 -m json.tool extensions/custom-avatar/extension.json
python3 -m json.tool extensions/custom-avatar/manifest.json
```

Manual verification:

- clicking an assistant avatar opens the picker; uploading an image replaces the
  glyph with the image on every assistant message
- the image persists across a reload and re-applies as new replies stream in
- removing the avatar restores the letter glyph
- a non-image or oversized file is rejected with a message, not applied

## Known Limitations

- Assistant-only (the user role has no avatar slot in the WebUI by design).
- Avatars are per-browser (`localStorage`), not synced across devices.
- Relies on the `.role-icon.assistant` badge; a core rename would need an update.
- Images are downscaled to 64×64 to keep localStorage small.
