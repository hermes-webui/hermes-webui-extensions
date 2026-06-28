# External App Tab

External App Tab is a trusted local Hermes WebUI extension that pins any
self-hosted web app — Grafana, Vaultwarden, Linkwarden, a personal dashboard —
as a tab inside the WebUI via an `<iframe>`. It adds a button to the left rail
that opens a full-area panel framing a URL you configure.

## What It Does

- Adds a rail button (with the content tabs, above Settings).
- Clicking it opens a full-area overlay with a top bar (title, **Configure**,
  **Open ↗**, **Close**) and the framed app below.
- **Configure** dialog: set a label + an `http(s)` URL; stored locally.
- Falls back to a "no app configured" prompt until you set a URL.
- Escape or the ✕ closes the overlay; the rail stays accessible.

## ⚠️ CSP dependency (read this)

The WebUI's Content-Security-Policy only allows framing **same-origin** content
by default. To frame an **external** origin, the operator must allow it via the
core knob (added in `nesquena/hermes-webui` **PR #5091**):

```bash
export HERMES_WEBUI_CSP_FRAME_EXTRA="https://your-app.example.com"
```

- A **same-origin** or **loopback-reverse-proxied** URL works with **no** core
  change.
- If the configured URL is blocked by CSP, the browser refuses to load the frame
  (it stays blank). The overlay shows a hint with the exact
  `HERMES_WEBUI_CSP_FRAME_EXTRA` value to set.
- On a WebUI build **without** PR #5091, only same-origin URLs can be framed.

## Current Shape

```text
Hermes WebUI page
  -> manifest-bundled extension assets
  -> /extensions/assets/external-app-tab.js + .css
  -> rail button -> full-area overlay -> <iframe src="<your URL>">
  -> localStorage: hermes-ext-external-app  ({ url, label })
```

This extension is `static-ui` / manifest-bundle only. It does not add backend
routes, start a sidecar, or use native host APIs. It does not fetch anything
itself; it only sets an `<iframe src>`, which the browser loads subject to the
page's CSP.

## Capabilities

- `manifest-bundle`

## Install For Local Testing

```bash
cd /path/to/hermes-webui
# allow your app's origin to be framed (external origins only):
HERMES_WEBUI_CSP_FRAME_EXTRA="https://your-app.example.com" \
HERMES_WEBUI_EXTENSION_DIR=/path/to/hermes-webui-extensions/extensions/external-app-tab \
HERMES_WEBUI_EXTENSION_MANIFEST=manifest.json \
./start.sh
```

Click the new rail button, **Configure**, enter the URL, and Save.

## Controls

Also on `window.HermesExternalAppTabExtension`:

- `.getConfig()` → `{ url, label }`
- `.setConfig(url, label)` — set (rejects non-http(s) URLs)
- `.open()` / `.close()` — toggle the overlay

## Disable And Uninstall

Restart Hermes WebUI without `HERMES_WEBUI_EXTENSION_DIR` /
`HERMES_WEBUI_EXTENSION_MANIFEST`, or remove the `extensions/external-app-tab/`
directory. Config lives under the `hermes-ext-external-app` localStorage key.

## Trust And Permissions

This is trusted local code. Current disclosed behavior:

- creates extension-owned DOM (a rail button, a full-area overlay, a config
  dialog)
- embeds a **user-configured external URL** in an `<iframe>`
  (`permissions.network_external: true`) — this is the whole point of the
  extension; the URL is whatever the operator sets and is subject to the page CSP
- reads and writes `localStorage` under the single key `hermes-ext-external-app`
- does NOT call WebUI HTTP APIs
- does NOT access cookies, loopback sidecars, the filesystem, or native hosts
- does NOT itself `fetch()` any remote resource — it only sets an iframe `src`

The embedded app runs in its own `<iframe>` with an explicit `sandbox`
allow-list: `allow-scripts allow-forms allow-popups
allow-popups-to-escape-sandbox allow-same-origin allow-downloads`. This lets a
real web app function (run its scripts, submit forms, open links/downloads)
while still being a sandboxed frame. **Honest tradeoff:** a functional app
generally needs both `allow-scripts` and `allow-same-origin`, and that pairing
relaxes the sandbox's origin barrier — so for a **same-origin** target the frame
is effectively trusted browser content, not strongly isolated. Treat any app you
embed as trusted: you opt in per-origin by allow-listing it via
`HERMES_WEBUI_CSP_FRAME_EXTRA`, and cross-origin targets remain bounded by the
same-origin policy. All user-supplied strings (label, URL) are escaped where
rendered.

## Compatibility

- manifest-bundled extension assets + same-origin serving under `/extensions/`
- the left rail (`.rail`) to host the button
- for external origins: the core `HERMES_WEBUI_CSP_FRAME_EXTRA` knob (PR #5091)

## Verification

```bash
node scripts/validate-extensions.mjs
node scripts/scan-extension-safety.mjs
node scripts/generate-registry.mjs --out dist/registry.json
node --check extensions/external-app-tab/assets/external-app-tab.js
python3 -m json.tool extensions/external-app-tab/extension.json
python3 -m json.tool extensions/external-app-tab/manifest.json
```

Manual verification:

- the rail button appears; clicking it opens the overlay
- with no URL set, the empty-state prompt + Configure appear
- configuring a same-origin URL frames it immediately
- configuring an external URL frames it when `HERMES_WEBUI_CSP_FRAME_EXTRA`
  allows that origin; otherwise the frame is blank and the CSP hint is shown
- Open ↗ opens the URL in a new tab; Close / Escape closes the overlay
- the config (label + URL) persists across a reload

## Known Limitations

- External origins require the operator to allow them via
  `HERMES_WEBUI_CSP_FRAME_EXTRA` (PR #5091) — a deliberate security boundary.
- Some sites send `X-Frame-Options: DENY` / their own `frame-ancestors` and
  refuse to be embedded by anyone; those can't be framed (open them in a new tab
  instead). This is the remote site's choice, not a WebUI limitation.
- One app at a time (single configured URL).
