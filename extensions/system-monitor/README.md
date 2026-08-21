# System Monitor

Inline system resource monitor for the Hermes WebUI titlebar. Shows CPU,
RAM, Disk, and Network usage as compact curved bars with percentage
labels. Clicking the widget opens an expanded popup with sparkline
history graphs. A settings panel lets you toggle modules, pick colors,
and set the refresh rate.

## What It Does

- Embeds a horizontal resource monitor directly inside the `.app-titlebar`
  strip (between the app title and the action buttons).
- Polls `GET /api/system/health` at a configurable interval and renders
  curved bars with a sine-wave overlay for each enabled metric.
- Clicking the widget opens a popup showing sparkline history graphs
  for each metric.
- A Settings button in the popup opens a configuration panel.

## Controls

- **Widget (titlebar):** click to open the expanded popup.
- **Popup:** shows sparkline history for CPU, RAM, Disk, Network.
  - `✕` closes the popup.
  - `Settings` opens the settings panel.
- **Settings panel:**
  - Toggle CPU / RAM / Disk / Network on/off.
  - Pick a color for each module.
  - Refresh rate slider (0.5s – 5s).
  - Reset Defaults button.

All settings persist to `localStorage` under `hwx-monitor-config`.

## Trust

This is a manifest-bundled client-side extension. It does not talk to
any external origin and does not execute any sidecar or native host
process. It only calls the already-existing authenticated
`GET /api/system/health` endpoint that ships with Hermes WebUI.

Current disclosed behavior:

- reads `GET /api/system/health` (authenticated, same-origin) at the
  configured interval.
- writes extension-owned `localStorage` key `hwx-monitor-config`.
- injects a `<div>` + `<canvas>` into `.app-titlebar-inner` and two
  popup `<div>`s into `document.body`.
- does not read any guarded WebUI globals.
- does not need external network access.
- does not need arbitrary filesystem access.
- does not serve bundled assets beyond its own script/css.

## Compatibility

Required WebUI surface:

- manifest-bundled extension assets
- same-origin extension asset serving under `/extensions/`
- authenticated `GET /api/system/health` endpoint
- `.app-titlebar-inner` DOM slot for widget injection

Uses only Canvas 2D and `fetch` — no third-party dependencies.

## Verification

```bash
cd /path/to/hermes-webui
HERMES_WEBUI_EXTENSION_DIR=/path/to/hermes-webui-extensions/extensions/system-monitor \
HERMES_WEBUI_EXTENSION_MANIFEST=manifest.json \
./start.sh
```

Manual verification:

1. Titlebar shows `[CPU ██░░ 32%] [RAM ████░ 58%] ...` inline.
2. Numbers update every refresh interval (default 2s).
3. Click the widget → popup with sparkline graphs appears below titlebar.
4. Click `Settings` → panel with toggles, color pickers, refresh slider.
5. Toggle CPU off → CPU module disappears from titlebar and popup.
6. Change refresh rate → updates happen at the new interval.
7. Reload page → settings persist.
8. Click outside popup → popup closes.
9. Zero console errors on page load (`node --check assets/monitor.js`).

## Known Limitations

- Stats come from the backend `/api/system/health` endpoint — if that
  endpoint is unavailable, the widget shows `—%` and a small warning
  triangle until it recovers.
- Popup sparklines fill gradually — history is capped at 60 samples.
- The widget is hidden on narrow (mobile) widths via CSS.
