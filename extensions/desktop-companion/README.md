# Desktop Companion

Desktop Companion is a trusted local companion extension for Hermes WebUI. It
watches session attention state, forwards lightweight snapshots to a local
loopback sidecar, and executes trusted local desktop-pet commands in the
authenticated WebUI browser session. It does not render a browser pet or WebUI
overlay.

This entry is the first sidecar-class extension candidate for the Hermes WebUI
extension library. It keeps the WebUI-facing assets in this repository and keeps
the sidecar/native host source in:

```text
https://github.com/franksong2702/hermes-webui-desktop-companion
```

## Current Shape

```text
Hermes WebUI page
  -> manifest-bundled extension assets
  -> /extensions/assets/companion-adapter.js
  -> http://127.0.0.1:17787 loopback sidecar
  -> native desktop pet host
```

The extension can run in WebUI without the sidecar. In that mode it stays
invisible and quietly fails closed. When the sidecar is running, the extension
posts snapshots to `POST /api/webui/snapshot` so the desktop pet can react.
The sidecar and native desktop pet host are required for the user-visible
desktop pet experience; the WebUI adapter alone is only the browser bridge.

This bridge is bidirectional. The browser adapter sends attention snapshots to
the sidecar, and it also polls the local sidecar for commands that the adapter
executes inside the authenticated WebUI origin.

The bundled `assets/pets/` resources are consumed by the native desktop pet
host through the sidecar/source project. They are not a browser overlay and do
not mean Hermes WebUI core renders a pet inside the page.

## Capabilities

This entry declares only capabilities already available to extension entries:

- `manifest-bundle`
- `loopback-sidecar`

Direct browser-to-loopback access is the current integration model. Its sidecar
runtime is owned by the external source
repository above and is declared `proxy_auth: "legacy"`; it is not treated as a
copy of this repository's canonical Python scaffold. Migration to the core
same-origin proxy requires the external runtime to implement the language-neutral
`token-v1` contract first.

## Install From Gallery

In Hermes WebUI, open Settings -> Extensions -> Gallery and install
Desktop Companion.

Gallery install enables the WebUI bridge only. To show and use the desktop pet,
open the Desktop Companion source repo and run the local start command:

```bash
git clone https://github.com/franksong2702/hermes-webui-desktop-companion
cd hermes-webui-desktop-companion
npm install
npm run start:pet
```

The setup guide link opens the source repo's `After Gallery install` section,
which starts with the same command for an existing local clone.

## Install For Local Testing

Start Hermes WebUI with this extension directory:

```bash
cd /path/to/hermes-webui
HERMES_WEBUI_EXTENSION_DIR=/path/to/hermes-webui-extensions/extensions/desktop-companion \
HERMES_WEBUI_EXTENSION_MANIFEST=manifest.json \
./start.sh
```

If you are testing without Gallery install, start the companion sidecar from the
source repo when desktop behavior is needed:

```bash
git clone https://github.com/franksong2702/hermes-webui-desktop-companion
cd hermes-webui-desktop-companion
npm install
npm run dev
```

Then start the native desktop pet host from the same source repo to show and use
the desktop pet surface:

```bash
npm install --prefix desktop-pet
npm run desktop:dev
```

## Disable And Uninstall

To disable the WebUI extension, restart Hermes WebUI without:

```text
HERMES_WEBUI_EXTENSION_DIR
HERMES_WEBUI_EXTENSION_MANIFEST
HERMES_WEBUI_EXTENSION_STYLESHEET_URLS
HERMES_WEBUI_EXTENSION_SCRIPT_URLS
```

To stop desktop behavior, stop the loopback sidecar and native host processes.
To uninstall the standalone source project, remove its local clone after those
processes are stopped.

## Trust And Permissions

This is trusted local code. The injected adapter runs in the Hermes WebUI
browser origin and can use the logged-in browser session.

Current disclosed behavior:

- reads the authenticated WebUI sessions API via `/api/sessions`
- reads authenticated session detail via `/api/session`
- reads authenticated pending approval and clarification details via
  `/api/approval/pending` and `/api/clarify/pending`
- writes authenticated WebUI APIs for desktop-pet commands:
  `/api/session/draft`, `/api/approval/respond`, and `/api/clarify/respond`
- reads guarded Hermes WebUI browser globals for live session state while no
  formal extension runtime API exists (`S`, `_allSessions`, `INFLIGHT`,
  `_currentPanel`, `switchPanel`, `_saveComposerDraftNow`, and `send`)
- reads existing WebUI localStorage keys for viewed/unread session state
- writes extension-owned localStorage markers for consumed desktop-pet commands:
  `hermes-pet-navigation-last-id` and `hermes-pet-action-last-id`
- talks to a loopback sidecar at `http://127.0.0.1:17787`
- sends the local sidecar page URL/title, companion state, and current session
  attention summaries, including session titles and status text
- polls the local sidecar for trusted commands and can switch sessions, inject
  composer drafts, optionally autosend a draft, and respond to approval or
  clarification prompts in the logged-in WebUI session
- uses a native host for transparent windows, menus, drag behavior, and restart
  behavior when the desktop pet is launched
- serves bundled pet assets
- does not need external network access
- does not need arbitrary filesystem access

The adapter endpoint can be overridden with trusted local configuration via
`window.HERMES_DESKTOP_COMPANION_CONFIG` before the adapter loads. Do not point
that override at an untrusted remote origin, because the adapter sends
authenticated WebUI attention state and executes queued desktop-pet actions.

The autosend path is intentionally limited to commands delivered by the local
loopback sidecar the user starts. It is not exposed to remote origins or
third-party script loaders by this extension entry.

Desktop Companion treats user-acting commands as explicit local permissions.
Draft injection and navigation are available by default. Direct autosend and
inline approval/clarify responses are default-off in the source sidecar/native
host and require user opt-in from the desktop pet confirmation card or its
right-click `Permission control` menu.

## Sidecar Contract

The sidecar binds to `127.0.0.1:17787` by default.

Health check:

```text
GET http://127.0.0.1:17787/health
```

Expected response shape:

```json
{
  "ok": true,
  "status": "ok",
  "service": "hermes-webui-desktop-companion",
  "name": "Hermes WebUI Desktop Companion",
  "version": "0.1.0",
  "sidecar": {
    "type": "loopback",
    "health_path": "/health"
  }
}
```

The sidecar metadata is descriptive. It does not imply that Hermes WebUI core
can install, auto-start, proxy, or manage the native process yet.

## Compatibility

Required WebUI surface:

- manifest-bundled extension assets
- same-origin extension asset serving under `/extensions/`
- browser access to authenticated WebUI session APIs
- authenticated WebUI write APIs for session drafts, approval responses, and
  clarification responses
- authenticated WebUI read APIs for pending approval and clarification context
- browser navigation/session-loading hooks for desktop-pet jump and quick-reply
  flows
- loopback CSP allowance for `http://127.0.0.1:17787`
- guarded access to the current WebUI browser globals listed in the trust
  section until WebUI core exposes an equivalent extension runtime API

Current lifecycle declaration:

```json
{
  "webui_restart_required": false,
  "sidecar_start_required": true,
  "native_host_start_required": true,
  "native_host_autostart": "extension_owned"
}
```

Manual env-var setup may still require restarting WebUI so it rereads its
configured extension manifest. The lifecycle declaration describes the extension
capability model rather than today's manual startup mechanics.

## Verification

From this repository:

```bash
node scripts/validate-desktop-companion.mjs
python3 -m json.tool extensions/desktop-companion/extension.json
python3 -m json.tool extensions/desktop-companion/manifest.json
node --check extensions/desktop-companion/assets/companion-adapter.js
```

From the Desktop Companion source repo:

```bash
npm test
```

Manual verification should confirm:

- WebUI loads the adapter from `manifest.json`
- no browser pet or WebUI overlay appears
- the sidecar receives `POST /api/webui/snapshot` when it is running
- `GET /health` returns `status: "ok"`
- the native desktop pet host can load from the sidecar

## Known Limitations

- No one-click install path is available yet.
- WebUI settings do not yet manage sidecar lifecycle.
- Hermes WebUI core's consent-gated sidecar proxy is shipped, but this external
  runtime remains explicitly `legacy` and its adapter still uses direct loopback.
  Moving it to the proxy requires the external runtime to adopt `token-v1`.
- The native host source is linked, not vendored, in this extension entry.
