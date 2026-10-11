# Sigakhwa Bookmarks & TOC

Bookmark any message under a name you choose, jump back to it later, and get a table of contents of the
current conversation. Optional sync lets your PC and phone see the same bookmarks.

## What it does

- **Bookmark a message.** Hover a user or assistant message and press the bookmark icon in its action row,
  name it, save. The icon stays highlighted for bookmarked messages; press it again to rename or delete.
- **Jump back.** The bookmark button at the top right of the transcript opens a panel (bottom sheet on
  phones). Bookmarks are grouped by profile and conversation; pressing one opens that conversation and
  scrolls to the message (switching conversation when needed).
- **Table of contents.** The *목차* tab lists the current conversation's headings (`#`–`###`), tables and
  Mermaid diagrams found in assistant replies. Press an entry to scroll to its reply.
- **Honest sync state.** The panel shows *이 기기에만 저장됨* (this device only) whenever data lives only in
  this browser, and *동기화됨* (synced) only after the sidecar has answered.

Each bookmark records profile, conversation, message index and role, so identical text in different
conversations never collides.

## Storage and sync

| Mode | When | Where |
|---|---|---|
| Browser only (default) | no sidecar, or proxy consent not granted | `localStorage` key `hermes-viz-store:bookmarks` |
| Synced | sidecar running **and** proxy consent granted | the sidecar's JSON files on the WebUI host |

When sync is first enabled, bookmarks already saved in a browser are uploaded once; server data is never
silently overwritten from a browser.

### Enable PC ↔ phone sync (optional)

1. WebUI password authentication must be on (`token-v1` sidecars are refused when auth is off).
2. Start the bundled sidecar on the WebUI host, with the **same** state dir as WebUI:
   ```bash
   cd <STATE_DIR>/extensions/sigakhwa-bookmarks/sidecar
   HERMES_WEBUI_STATE_DIR=<STATE_DIR> python3 -S sidecar.py
   ```
   Optional `HERMES_VIZ_STORE_DIR=<dir>` sets where the JSON files go (default
   `~/.local/share/hermes-viz/store`, or `%LOCALAPPDATA%\hermes-viz\store` on Windows). On Linux,
   `sidecar/sidecar.service` is a ready systemd user unit. On Windows, a logon scheduled task running the
   same command works.
3. Settings → Extensions → **Diagnostics** → **Sidecars** → `sigakhwa-bookmarks` → **Approve proxy consent**.
4. Reload WebUI on each device.

The sidecar listens on `127.0.0.1:17831` only. Every route except `/health` requires the per-extension token
that WebUI injects through its consented proxy (missing token file → 503, wrong token → 401). Revoke consent
or stop the sidecar to go back to browser-only mode.

## Install

- **Gallery:** Settings → Extensions → Gallery → *Sigakhwa Bookmarks & TOC* → Install, then reload.
- **Manual:** copy this folder to `STATE_DIR/extensions/sigakhwa-bookmarks/` and add it to the install
  record, or serve it with `HERMES_WEBUI_EXTENSION_DIR` + a manifest.

## Disable / uninstall

Toggle it off or Uninstall in Settings → Extensions → Installed (effective on reload). Browser data stays in
`localStorage` (`hermes-viz-store:bookmarks`) until you clear site data; sidecar data stays in its JSON files
until you delete them. Stop the sidecar and revoke proxy consent if you enabled sync.

## WebUI surfaces used

- `hermesExt.register()` with one message action (icon `bookmark`); core allows **two** message actions per
  page, so this conflicts with other action-registering extensions such as *message-pins*.
- `GET /api/session?...&msg_limit=all` to read the transcript for the TOC and for jumping to older messages.
- Core `loadSession()` and `_switchProfileForSessionLoad()` (when present) to open another conversation;
  `showPromptDialog()` / `showConfirmDialog()` for rename and delete.
- Its own panel and buttons only; it does not modify core views.

## Trust and permissions

Trusted same-origin code with your WebUI session. Reads the transcript of conversations you open. Writes only
its own `localStorage` namespace, and — when sync is on — its own sidecar through WebUI's consented proxy.
No external network.

## Known limitations

- Message indexes are not stable across edit, regenerate or truncate; a bookmark then points at whatever
  message now sits at that position.
- Jumping into another profile's conversation needs WebUI's profile-switch helper; without it the panel says
  so instead of switching.
- The TOC lists headings, tables and diagrams; plain prose replies have no entries.

## Compatibility and verification

Tested against Hermes WebUI `7a74ae1b` (October 2026). Verified with unit tests (store, navigation, TOC
parser, sidecar routes and token handling), a real-browser fixture, an isolated WebUI instance (save →
reload → jump; two separate browser contexts sharing bookmarks through the consented sidecar), and
day-to-day use on a self-hosted install across a PC and an Android phone.
