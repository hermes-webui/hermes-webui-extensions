# Custom User Avatar

Custom User Avatar is a trusted local Hermes WebUI extension that shows an optional
avatar beside your own (**user**) messages in the chat transcript. Hermes WebUI gives
user turns no avatar — right alignment identifies the speaker — so this adds a purely
personal, **opt-in** decoration. It is **disabled by default**.

This is the user-turn complement to
[`custom-avatar`](../custom-avatar) (assistant avatar) and is independent of
[`profile-avatars`](../profile-avatars): it does not read, write, migrate, or shadow
either extension's storage, and it adds no assistant-avatar path.

## What It Does

- Adds an avatar to the left of each right-aligned user bubble when enabled.
- The image is **downscaled to a 96×96 square and stored locally** as a data-URL in the
  extension's own scoped storage namespace; it never leaves the browser.
- Re-applies to current and newly rendered user turns through a bounded, idempotent
  `MutationObserver` — no duplicate nodes, no observer loops.
- Fully reversible: disabling removes all decoration and the transcript is
  pixel-identical to stock. The enabled state and your image persist across reloads by
  design, so a reload keeps the decoration; **disabling** is what returns the transcript
  to stock. (Clearing the extension's storage removes the uploaded *image* but not the
  separate enabled setting, so an enabled extension falls back to the placeholder circle
  rather than going away.)

## Controls

Configure it in **Settings → Extensions → Custom User Avatar** (the Configure panel):

- **Show avatars on my messages** — the enable toggle (default off).
- **Upload image / Remove** — your avatar image (PNG / JPEG / WebP, per issue #63; SVG,
  GIF, and oversized/invalid files are rejected — see [Media bounds](#media-bounds)).
  Stored locally only.
- **Avatar size** — Small (24px), Medium (32px), Large (44px).
- **On narrow screens** — Hide (default) or Compact, so a phone keeps readable width.

The enable / size / narrow-screen options are also declared as native
`settings_schema` fields, so they appear directly in the extension's settings row;
the image lives in extension-owned storage (image blobs do not belong in settings).

Configure opens an **extension-owned modal**. Core invokes the handler with a single
`{opener, restoreFocus}` options object — never a DOM host — so the panel mounts its own
overlay with `role="dialog"`/`aria-modal`, traps Tab while open, closes on the X button,
Escape, or a backdrop click, and settles the Configure promise **exactly once** on close
or teardown. Core restores focus to the opener; the panel does not compete with it.

### Media bounds

One private canonicalization path bounds the source **before** any canvas work and
always emits a bounded square PNG/JPEG data-URL:

| Bound | Value |
| --- | --- |
| Accepted types | `image/png`, `image/jpeg`, `image/webp` |
| Source bytes | ≤ 8 MB |
| Decoded dimensions | ≤ 4096 px per side |
| Decoded pixels | ≤ 16 megapixels |
| Stored data-URL | ≤ 128 KiB, at most 96×96 |

The dimension and pixel caps match the Profile Avatars boundary and are checked on the
decoded bitmap, because a small compressed file can still decode to an enormous one.
There is **no raw synchronous image setter** on the public API — every write goes
through this path, and a refused write reports a real error and leaves the previous
image in place.

## Screenshots

Every image under `screenshots/` is produced by the real-browser visual track
(`tests/compatibility/user_avatar_smoke.py`), which boots a pinned Core
checkout, seeds a populated transcript through Core's own `renderMessages()`
pipeline, and measures the painted result — see
[docs/compatibility-smoke.md](../../docs/compatibility-smoke.md).

| Desktop (1440x1000) | |
| --- | --- |
| `desktop-disabled.png` | extension loaded but off — the transcript is pixel-identical to a page with no stored image (parity control) |
| `desktop-small.png` / `desktop-medium.png` / `desktop-large.png` | 24 / 32 / 44px, with the reserved gutter |
| `desktop-placeholder.png` | enabled with no image chosen yet |
| `desktop-light.png` | light theme |
| `desktop-large-font.png` | the `large` accessibility font size |
| `desktop-hover.png` | Core's `.msg-actions` hover controls over a decorated row |
| `desktop-layout-attachments.png` | a user turn with three image attachments — the strip shares the bubble's reserved gutter, no overlap |
| `desktop-layout-edit.png` | a user turn in edit mode — its avatar is hidden and the textarea uses the full row; other turns keep theirs |
| `desktop-configure.png` | the Configure modal, first control focused |
| `desktop-configure-keyboard.png` | Tab wrapped by the focus trap |
| `desktop-configure-error.png` | a rejected upload reporting the accepted formats |

| Mobile (390x844) | |
| --- | --- |
| `mobile-disabled.png` | off at 390px (parity control) |
| `mobile-hide.png` | narrow-screen **Hide** — avatar and gutter both collapse |
| `mobile-compact.png` | narrow-screen **Compact** — 20px avatar, bubble keeps width |
| `mobile-compact-light.png` | the same in light theme |
| `mobile-layout-attachments.png` | attachments at 390px in Compact mode |
| `mobile-layout-edit.png` | edit mode at 390px in Compact mode |
| `mobile-configure.png` | the Configure modal at 390px |
| `mobile-configure-keyboard.png` | the focus trap at 390px |
| `mobile-configure-error.png` | the rejected-upload state at 390px |

## How It Renders (and why it is safe against core re-renders)

Core rebuilds a user row's `innerHTML` whenever it changes and **skips** rows whose
markup is unchanged. Injecting a child node into a row would defeat that optimization
(forcing a rebuild every render) and be wiped on the next reconcile. So this extension
**never injects child nodes**. It sets only element-level state that core does not
reconcile:

- a per-row `data-hwx-uav` attribute (survives `innerHTML` rebuilds and row recycling);
- `--hwx-uav-img` / `--hwx-uav-size` custom properties and a `data-hwx-uav-on` flag on
  `:root`.

The avatar itself is drawn by a `::before` **pseudo-element** in the stylesheet, gated
on `:root[data-hwx-uav-on]`. User rows are `align-self:flex-end` inside a column flex
container, so the row box is shrink-to-fit around the bubble; combined with the row's
`position:relative`, `left:0` on the pseudo-element lands in the gutter reserved by the
bubble's `margin-left` (an intentional, small horizontal
cost). Because the decoration is attribute- and CSS-driven, the observer only has to
mark newly created user rows; a core `innerHTML` rebuild leaves the decoration intact.

This is an **explicitly unstable DOM-mutation contract**: it targets real, visible
`.msg-row[data-role="user"]` rows and no-ops harmlessly (no errors, no decoration) if
that markup ever changes.

## Current Shape

```text
Hermes WebUI page
  -> manifest-bundled extension assets
  -> /extensions/assets/user-avatar.js + .css
  -> marks .msg-row[data-role="user"] with data-hwx-uav; sets :root custom properties
  -> ::before pseudo-element renders the avatar (no child nodes injected)
  -> scoped ext storage: window.hermesExt.register('user-avatar').storage['image']
     (downscaled data-URL; cleared by Settings -> Clear extension storage)
  -> scalars via window.hermesExt settings when available
  -> hermes-ext-user-avatar-{enabled,size,mobile} localStorage fallbacks on older core
```

`static-ui` / manifest-bundle only. No backend routes, no sidecar, no external network,
no native host. Image processing is entirely in-browser (canvas downscale).

## Capabilities

- `manifest-bundle`

## Install For Local Testing

```bash
cd /path/to/hermes-webui
HERMES_WEBUI_EXTENSION_DIR=/path/to/hermes-webui-extensions/extensions/user-avatar \
  HERMES_WEBUI_EXTENSION_MANIFEST=manifest.json ./start.sh
```

Open **Settings → Extensions → Custom User Avatar → Configure**, turn it on, and upload
an image. Send a message — the avatar appears beside your turn.

Also exposed on `window.HermesUserAvatarExtension`:

- `.isEnabled()` / `.setEnabled(bool)`
- `.getImage()` / `.setImageFile(file)` (async, canonicalizing) / `.clearImage()`
- `.refresh()` — re-apply to current rows
- `.teardown()` — remove all decoration, observers, and listeners

## Disable And Uninstall

- **Disable:** turn off "Show avatars on my messages" — all decoration is removed
  immediately and the transcript is pixel-identical to stock.
- **Uninstall:** restart Hermes WebUI without the `HERMES_WEBUI_EXTENSION_DIR` /
  `HERMES_WEBUI_EXTENSION_MANIFEST` variables, or remove the
  `extensions/user-avatar/` directory. Note that **uninstalling only removes the
  extension's files and its manifest entry — it does not clear browser-local data.**
  Your image lives in the extension's scoped storage namespace, so **Settings →
  Clear extension storage** removes it. The enable/size/mobile scalars are
  *settings*, not storage: **Reset settings** returns the scoped values to their
  defaults, and switching the extension off only disables the decoration. On a
  Core without scoped settings the scalars live in `hermes-ext-user-avatar-*`
  localStorage keys instead. When you later upgrade to a Core that has scoped
  settings, those keys are folded in once on load and then deleted. A scoped value
  that differs from its default always wins over them. Core records a setting left
  at (or reset to) its default as "not set", so the older value is adopted over it
  that one time. Because the keys are deleted afterwards, a later native Save or
  Reset is never overridden by them. The migration is one-way: a choice made on a
  modern Core is not visible to an older Core that later reads the same browser.
  A pre-0.2.0 image stored under the raw `hermes-ext-user-avatar` key is migrated
  into scoped storage once on load and the raw key is then deleted.

## Trust And Permissions

Trusted local code. Disclosed behavior:

- sets extension-owned DOM state only: a `data-hwx-uav` attribute on user rows and
  custom properties / a flag on `:root`; the avatar is a CSS `::before` pseudo-element
  (no injected child nodes)
- reads the uploaded image locally (`FileReader`), downscales it via a `<canvas>`, and
  stores a small data-URL
- stores the image in the sanctioned scoped storage namespace (`permissions.storage.owned`
  is `true`), so Core's Clear-extension-storage removes it; note that *uninstalling* only
  removes the extension's files and manifest entry and does **not** clear browser-local
  data. It reads and writes `localStorage` only under its own `hermes-ext-user-avatar*`
  keys (the settings store on an older Core, and the one-time migrations described
  above)
- writes its scalar settings through `window.hermesExt` when available, and only
  there; on an older Core without scoped settings it writes its own localStorage keys
- does **not** call WebUI HTTP APIs, read cookies, contact loopback or external
  networks (the image never leaves the browser), or use native host / arbitrary
  filesystem APIs (the picker is a standard `<input type=file>`)
- does **not** read, write, migrate, or shadow `custom-avatar` or `profile-avatars`
  storage, and does **not** write profile, personality, memory, or core settings

Only validated `data:image/(png|jpeg|webp);base64,...` values within the byte cap are
ever applied, so a malformed or oversized stored value cannot inject anything.

## Known Limitations

- User-turn only (assistant avatars are `custom-avatar` / `profile-avatars`).
- Per-browser (browser-local storage), not synced across devices.
- Relies on `.msg-row[data-role="user"]` and the shrink-to-fit right-aligned user-row
  layout; a core rename would need an update (fails harmlessly until then).
- The avatar is the same image for every user turn (single user avatar), by design.
- When enabled with no image chosen yet, a neutral placeholder circle is shown.

## Compatibility

- Manifest-bundled extension assets served same-origin under `/extensions/`.
- User rows rendered as `.msg-row[data-role="user"]` with a `.msg-body` bubble.
- Native settings (`settings_schema` + `window.hermesExt` scoped settings) when present;
  degrades to localStorage fallback keys otherwise.

## Verification

```bash
node scripts/validate-extensions.mjs
node scripts/scan-extension-safety.mjs
node scripts/generate-registry.mjs --out dist/registry.json
node --check extensions/user-avatar/assets/user-avatar.js
node scripts/run-behavior-tests.mjs          # includes scripts/test-user-avatar.mjs

# Real-browser visual + Configure gate (needs a Core checkout and Playwright):
HERMES_CORE_DIR=/path/to/hermes-webui \
  python tests/compatibility/user_avatar_smoke.py \
  --screenshot-dir extensions/user-avatar/screenshots
python3 -m json.tool extensions/user-avatar/extension.json
python3 -m json.tool extensions/user-avatar/manifest.json
```

Manual verification (realistic desktop + 390px mobile):

- enabling decorates every current and newly streamed user turn; the assistant avatar
  and message content are unchanged
- disabling removes all decoration and the disabled transcript is pixel-identical
  to stock; reload deliberately PRESERVES the enabled state and image
- a non-image, SVG, or oversized file is rejected with a message, not applied
- narrow layout follows the Hide / Compact setting; the bubble stays readable at 390px
- repeated re-renders (streaming, scrolling) do not duplicate nodes or shift the avatar

## Attribution

Original user + assistant avatar request: **@kinower** in
[`nesquena/hermes-webui#2586`](https://github.com/nesquena/hermes-webui/issues/2586).
Wishlist and V2 scope: **@nesquena-hermes** in
[`hermes-webui-extensions#63`](https://github.com/hermes-webui/hermes-webui-extensions/issues/63).
Existing `custom-avatar` (assistant): **@nesquena-hermes**. Existing `profile-avatars`:
**@asorourx**. This user-turn V2 complements those without duplicating them.
