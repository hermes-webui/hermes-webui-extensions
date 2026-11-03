# Theme Toggle

A Hermes WebUI extension that adds a sun/moon theme toggle button in the
desktop icon rail, directly **above the Settings cog**, with a matching copy
in the mobile sidebar nav — for instant light/dark switching without opening
Settings.

## What It Does

- Injects one toggle button in the desktop icon rail (`.rail`), inserted
  immediately above the Settings cog (the cog is the rail's fixed bottom
  anchor and the last item in core's tab order). It uses the WebUI's own
  `rail-btn nav-tab has-tooltip` styling, so it looks like a native button.
- The mobile sidebar copy is created by **core's own mirror system**
  (`_syncNavActionMirrors()`): any rail `.nav-tab` with an id and no
  `data-panel` is cloned into the mobile nav with click-forwarding and
  visibility tracking. There is no hand-built twin to drift out of sync.
- Clicking flips between light and dark using the WebUI's own theme helpers
  (`_normalizeAppearance` / `_applyTheme` / `_applySkin`), and persists
  exactly the way the WebUI's own `/theme` slash command does: it writes
  the shared `hermes-theme` / `hermes-skin` storage keys and sends a
  **partial-merge POST** of `{"theme", "skin"}` to `/api/settings` — the
  server merges only the keys present, so no other saved setting can be
  affected by a click. **Settings → Appearance** stays in sync, and the
  choice survives a reload (boot reads the same storage keys).
- The icon is CSS-driven: **sun** in dark mode (click to go light), **moon**
  in light mode (click to go dark). It tracks the effective (`.dark` class)
  theme, so it also behaves sensibly when "system" mode is selected.
- **Skin lock**: while a scheme-forcing skin is active (a skin registered
  with `registerHermesSkin({scheme})`, e.g. an e-ink skin forcing light),
  the base theme is not in effect — so the button disables itself with a
  tooltip naming the locking skin instead of clicking into the void. The
  lock is re-evaluated whenever the theme *or* the active skin changes.
- Tooltip and aria-label use one action wording ("Switch to light theme" /
  "Switch to dark theme"), updated automatically when the theme changes
  from any source (the toggle itself, the Settings picker, or a `/theme`
  command). There is no native `title` attribute — core's custom tooltip
  would render next to it as a second tooltip.
- The theme switch is instant, like core's own — no page-wide transition
  rule (a global `transition: … !important` costs ~300 ms of synchronous
  style recalculation per click on a long transcript, and ignores
  reduced-motion preferences).

## Why Not `_pickTheme()` Directly?

The v2.1.0 registry build called `window._pickTheme()`. That applies the
theme, but `_pickTheme()` ends with the core's appearance autosave, which
POSTs the **full** appearance payload built from the settings-pane DOM.
Those checkbox controls are static HTML that is only hydrated from the
server when the Settings tab is opened — in any tab where it has never been
opened they hold template defaults, so the autosave silently overwrote the
user's real saved appearance settings (session jump buttons, large-text
paste-as-attachment, structured code view, …) on every theme toggle.
Symptom as seen by the user: "my WebUI settings keep reverting".

The v2.2.0 build dropped `_pickTheme()` but persisted only via a `{theme}`
POST. Core's boot code prefers an explicit `hermes-theme` storage key over
the server's value, and boot writes that key on every load — so after a
reload the stale key won and the choice visibly reverted.

This version mirrors the core's own `/theme` slash command exactly
(`static/commands.js`): normalize against the current skin, write both
shared storage keys, apply theme + skin, then partial-merge POST
`{theme, skin}`. The full-pane autosave is never involved, and both
persistence stores agree, so the choice survives reloads.

## Version History

- **2.3.0** — review round: reload-safe persistence via the `/theme`
  command idiom (both shared storage keys + `{theme, skin}` partial POST);
  global fade-transition rule removed (instant switch, like core);
  scheme-forcing skins lock the button with a naming tooltip; button
  inserted *above* the cog with `rail-btn nav-tab has-tooltip`; mobile
  copy delegated to core's `_syncNavActionMirrors()`; single label wording
  with no native `title`; icons at core's stroke width 1.5;
  `network_external: true` declared for the inherited Prism stylesheet
  swap; the one POST passes `redirect401: false` so a 401 can never
  navigate to the login page.
- **2.2.0** — clobber-safe persistence: theme-only `{theme}` POST to
  `/api/settings` instead of `_pickTheme()`'s full-pane autosave (fixes the
  "settings keep reverting" bug in tabs where the Settings tab was never
  opened).
- **2.1.0** — registry version: the legacy-core fallback (direct
  localStorage / Prism-link writes) is removed; against a core without the
  theme helpers the button degrades to an inert no-op instead.
- **2.0.0** — moved from a floating button to the rail / sidebar nav (the
  floating button covered the chat input area).
- **1.0.0** — floating sun/moon button (top-right).

## Who It Is For

Anyone who switches between light and dark more than once a session. It
replaces the Settings → Appearance round-trip with a one-click toggle that
lives next to the cog, and it works on both the desktop rail and the mobile
sidebar nav. It complements (not replaces) skin extensions such as
`e-ink-skin`, `skin-pack`, and `theme-creator`: those register full skins,
while this is only the built-in light/dark pair — and while such a skin
forces a scheme, this button steps aside and says so instead of pretending.

## Install

### One-click (gallery)

Open **Settings → Extensions**, find **Theme Toggle**, and click **Install**.

### Manual

The extension lives in the WebUI-managed extensions directory
(`~/.hermes/webui/extensions/theme-toggle/`) and is registered in
`~/.hermes/webui/extension-install-manifest.json`. Reloading the page loads
it; no WebUI restart is required.

## Disable And Uninstall

Disable from **Settings → Extensions** (toggle), or remove the
`theme-toggle/` directory and its entry from `extension-install-manifest.json`.
Reload the page. Either way the button disappears; the last chosen theme
stays in the WebUI's own settings store, untouched by the extension.

## WebUI APIs And DOM Surfaces Used

- `window._normalizeAppearance(theme, skin)` — core validator (valid theme
  set, legacy-name mapping), called with the next theme and the current
  `hermes-skin` storage value.
- `window._applyTheme(theme)` / `window._applySkin(skin)` — the core's
  built-in theme/skin appliers (the same functions the Settings →
  Appearance pickers use).
- `window._activeSkinScheme()` — read-only check for a scheme-forcing skin,
  driving the disabled state.
- `window._syncThemePicker` / `window._syncSkinPicker` — keep the Settings
  pane pickers consistent after a click; `#settingsTheme` / `#settingsSkin`
  hidden inputs are value-synced for the same reason.
- `window.api('/api/settings', {method:'POST', redirect401:false,
  body:'{"theme":…, "skin":…}'})` — the core's own API helper, used once
  per click with a partial body (the `/theme` command's exact call).
  `redirect401:false` means a 401 can never navigate to the login page.
- `localStorage` — reads/writes the two shared WebUI keys `hermes-theme`
  and `hermes-skin` (the same keys the `/theme` command and core boot
  read/write). No other storage is touched, and no extension-owned keys
  are created.
- `.dark` class and `data-skin` attribute on `<html>` — read to determine
  the effective theme and the active skin; watched by a scoped
  `MutationObserver` (attribute-filtered) so the icon, labels and lock
  state stay in sync no matter what changed them.
- `.rail [data-panel="settings"]` — read-only location lookup; the button
  is inserted immediately before the Settings cog.
- One injected `<button>` (`hermes-rtt-rail`), plus the mobile clone core's
  `_syncNavActionMirrors()` creates from it. Neither carries `data-panel`,
  so the WebUI's tab order / tab visibility logic ignores them.
- If the core theme helpers are unavailable (a core older than the theme
  system), the button degrades to an inert no-op with a single console
  warning — this entry requires the theme API and deliberately has no
  fallback that writes state on the core's behalf.

## Trust Model And Permissions

This is trusted local code. The injected JavaScript runs in the Hermes WebUI
browser origin against the authenticated session.

Disclosed behavior:

- calls the core theme/skin helpers `_normalizeAppearance` / `_applyTheme`
  / `_applySkin` / `_syncThemePicker` / `_syncSkinPicker` and reads
  `_activeSkinScheme()` — deliberately not `_pickTheme()`, whose trailing
  full-pane autosave can clobber other saved appearance settings (see
  above)
- reads and writes the shared WebUI storage keys `hermes-theme` and
  `hermes-skin` — the exact keys, with the exact values, that the core's
  own `/theme` command writes (declared in both
  `storage.shared_webui_keys` and `storage.owned`); no other storage
  (sessionStorage, cookies, a private namespace) is touched
- one same-origin `POST /api/settings` per click, made through the core's
  own `api()` helper with a `{"theme","skin"}` body (partial merge; no
  other key can be written by this code) and `redirect401: false`, so no
  navigation can ever result from this extension
- reads the effective theme via the `.dark` class and the active skin via
  the `data-skin` attribute on `<html>`; observes both (attribute-filtered
  `MutationObserver`) to keep labels and the skin lock in sync
- creates one small DOM button (plus core's own mobile mirror of it) with
  an extension-scoped id
- no `fetch`/`XMLHttpRequest` in this code and no external URL literals.
  The one external network effect is **inherited core behaviour**: the
  core's `_applyTheme()` swaps the `#prism-theme` stylesheet link to
  cdn.jsdelivr.net, exactly as it does when the theme is changed from
  Settings — `network_external: true` is declared for that inherited
  behaviour, not for anything this code does itself
- no sidecar, native host, or OS integration of any kind

## Sidecar / Native Host

None. `loopback_sidecar: false`, `native_host: false`.

## Known Limitations

- Only toggles between the two built-in themes. Selecting a custom skin is
  done in Settings → Appearance (or via a skin extension); this button
  deliberately does not enumerate skins.
- While a scheme-forcing skin is active, the button is disabled by design
  (the skin decides light/dark); switch the skin off in Settings to
  re-enable the toggle.
- The mobile sidebar copy relies on core's `_syncNavActionMirrors()`; a
  core older than that system gets the desktop button only.
- If a WebUI redesign moves or renames the Settings cog (the
  `[data-panel="settings"]` anchor in `.rail`) or the theme helper
  globals, the button either will not appear or degrades to an inert
  no-op with a console warning — it never breaks or hides other UI, and
  never writes state on the core's behalf.
- Selecting the toggle switches "system" mode to an explicit choice. That
  is intentional: the button represents the current effective theme, and a
  round trip always lands on the other explicit mode.

## Compatibility And Verification Notes

- API surface used: manifest-bundle loading (core requirement for all
  entries), the `window._normalizeAppearance` / `_applyTheme` / `_applySkin`
  / `_activeSkinScheme` / `_syncThemePicker` / `_syncSkinPicker` globals,
  the core `window.api` helper (`POST /api/settings`, partial merge,
  `redirect401:false`), core's `_syncNavActionMirrors()`, the shared
  `hermes-theme` / `hermes-skin` storage keys, and the `.rail` DOM. No
  sidecar contract, no theme-registration API, no CSP knobs, no direct
  fetch/XHR.
- Verified against the bunglejuice mirror of `nesquena/hermes-webui`
  (commit `687d80333`, one of the two cores the review was checked
  against): placement above the cog, click round-trip writing both
  storage keys and surviving a reload, picker/hidden-input sync, mobile
  mirror creation, disabled state under a scheme-forcing skin, and
  instant switch with no page-wide transition rule — all exercised in a
  live browser; see `screenshots/`.
- No WebUI restart is required after install, update, or uninstall; a page
  reload is sufficient (the loader re-reads the install manifest per
  request).