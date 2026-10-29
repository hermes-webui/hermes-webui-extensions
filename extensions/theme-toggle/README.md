# Theme Toggle

A Hermes WebUI extension that adds a sun/moon theme toggle button directly
**under the Settings cog** — in the desktop icon rail and the mobile sidebar
nav — for instant light/dark switching without opening Settings.

## What It Does

- Injects one toggle button below the Settings cog in the desktop icon rail
  (`.rail`) and one in the mobile sidebar nav (`.sidebar-nav`). Both use the
  WebUI's own `rail-btn` / `nav-tab` + `has-tooltip` styling, so they look
  like native buttons (tooltip: "Theme").
- Clicking flips between light and dark. It applies the WebUI's own theme
  helpers (`_normalizeAppearance` / `_applyTheme` / `_syncThemePicker`) and
  persists the choice with a **theme-only POST** to `/api/settings`
  (`{theme}`) — the same partial-merge pattern the WebUI's own boot path
  uses — so **Settings → Appearance** stays in sync and no other saved
  appearance setting can be affected by a click.
- The icon is CSS-driven: **sun** in dark mode (click to go light), **moon**
  in light mode (click to go dark). It tracks the effective (`.dark` class)
  theme, so it also behaves sensibly when "system" mode is selected.
- Tooltip/aria text updates automatically when the theme changes from any
  source (the toggle itself, the Settings picker, or a `/theme` command).

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

This version replicates only the safe parts of `_pickTheme()` (the core
theme/skin helper calls) and persists with the same partial-merge POST the
core's own boot path makes: the server merges only the keys present in the
payload, so a theme click can never modify any other setting. The Settings
pane's own autosave remains the writer for every non-theme appearance key.

## Version History

- **2.2.0** — clobber-safe persistence: theme-only `{theme}` POST to
  `/api/settings` instead of `_pickTheme()`'s full-pane autosave (fixes the
  "settings keep reverting" bug in tabs where the Settings tab was never
  opened); no localStorage access, no fetch/XHR, no URL literals; inert
  no-op if the core theme helpers are absent.
- **2.1.0** — registry version: the legacy-core fallback (direct
  localStorage / Prism-link writes) is removed; against a core without
  `_pickTheme` the button now degrades to an inert no-op instead.
- **2.0.0** — moved from a floating button to the rail / sidebar nav, under
  the Settings cog (the floating button covered the chat input area).
- **1.0.0** — floating sun/moon button (top-right).

## Who It Is For

Anyone who switches between light and dark more than once a session. It
replaces the Settings → Appearance round-trip with a one-click toggle that
lives next to the cog, and it works on both the desktop rail and the mobile
sidebar nav. It complements (not replaces) skin extensions such as
`e-ink-skin`, `skin-pack`, and `theme-creator`: those register full skins,
while this is only the built-in light/dark pair.

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
  set, legacy-name mapping). Read-only; the skin argument is a read-only
  reference to the pane's `#settingsSkin` input (or `'default'`) used for
  validation only — this extension never writes a skin.
- `window._applyTheme(theme)` / `window._syncThemePicker(theme)` — the
  core's built-in theme setter and picker sync (the same functions the
  Settings → Appearance picker uses).
- `window.api('/api/settings', {method: 'POST', body: '{"theme": ...}'})` —
  the core's own API helper, used once per click with a **theme-only**
  payload. The server partial-merges: only the `theme` key is written,
  exactly the pattern the WebUI's boot path uses at startup.
- `#settingsTheme` — the pane's hidden theme input; its value is kept in
  sync after a click so a later pane-originated save (Settings tab opened
  in the same tab) reads the current value.
- `.dark` class on `<html>` — read to determine the effective theme and
  drive the icon.
- `.rail [data-panel="settings"]` and `.sidebar > .sidebar-nav
  [data-panel="settings"]` — read-only location lookups for button
  placement (inserted as the next sibling of the Settings cog).
- A scoped `MutationObserver` on `document.documentElement` (attribute
  filter: `class`) to keep the icon and tooltip text in sync no matter what
  changed the theme.
- Two injected `<button>` elements with extension-scoped ids
  (`hermes-rtt-rail`, `hermes-rtt-mobile`). They carry no `data-panel`, so
  the WebUI's tab order / tab visibility logic ignores them.
- If the core theme helpers are unavailable (a core older than the theme
  system), the button degrades to an inert no-op with a single console
  warning — this entry requires the theme API and deliberately has no
  fallback that writes state on the core's behalf. If `window.api` is
  unavailable, the click still applies the theme visually for the page's
  lifetime and the core's own boot write persists it on the next load.

## Trust Model And Permissions

This is trusted local code. The injected JavaScript runs in the Hermes WebUI
browser origin against the authenticated session.

Disclosed behavior:

- calls the core theme helpers `_normalizeAppearance` / `_applyTheme` /
  `_syncThemePicker` (the same functions the Settings → Appearance picker
  uses) — deliberately not `_pickTheme()`, whose trailing full-pane
  autosave can clobber other saved appearance settings (see above)
- one same-origin `POST /api/settings` per click, made through the core's
  own `api()` helper with a `{"theme": "light"|"dark"}` body (partial
  merge; no other key can be written by this code)
- reads the effective theme via the `.dark` class on `<html>`; read-only
  reference to the `#settingsSkin` input for validation; value-sync of the
  `#settingsTheme` input
- observes `document.documentElement` class mutations (attribute-filtered)
  to keep tooltips in sync
- creates two small DOM buttons with extension-scoped ids
- no `fetch`/`XMLHttpRequest` in this code, no external URL literals, and
  no storage (localStorage/sessionStorage) reads or writes — persistence
  happens in the WebUI's own settings store, via the core's API helper
- no sidecar, native host, or OS integration of any kind

## Sidecar / Native Host

None. `loopback_sidecar: false`, `native_host: false`.

## Known Limitations

- Only toggles between the two built-in themes. Selecting a custom skin is
  done in Settings → Appearance (or via a skin extension); this button
  deliberately does not enumerate skins.
- If a WebUI redesign moves or renames the Settings cog (the
  `[data-panel="settings"]` anchor in `.rail` / `.sidebar-nav`) or the
  theme helper globals, the button either will not appear or degrades to
  an inert no-op with a console warning — it never breaks or hides other
  UI, and never writes state on the core's behalf.
- Selecting the toggle switches "system" mode to an explicit choice. That
  is intentional: the button represents the current effective theme, and a
  round trip always lands on the other explicit mode.

## Compatibility And Verification Notes

- API surface used: manifest-bundle loading (core requirement for all
  entries), the `window._normalizeAppearance` / `_applyTheme` /
  `_syncThemePicker` globals, the core `window.api` helper
  (`POST /api/settings`, theme-only partial merge), the `.rail` /
  `.sidebar-nav` DOM, and the `.dark` class on `<html>`. No sidecar
  contract, no theme-registration API, no CSP knobs, no direct
  fetch/XHR, no storage access.
- Verified 2026-10-29 against the bunglejuice mirror of `nesquena/hermes-webui`
  (commit `687d80333`): all five theme helpers present in `static/boot.js`;
  a theme-only `POST /api/settings` with the current values returns 200 and
  a before/after fingerprint of the saved settings file shows **no other
  key changed** (partial merge confirmed live). Click-path behavior
  (helpers called with the resolved theme, exact `{theme}` body, no
  storage access, inert no-op when the helpers are absent) verified in a
  headless Node DOM harness.
- No WebUI restart is required after install, update, or uninstall; a page
  reload is sufficient (the loader re-reads the install manifest per
  request).
