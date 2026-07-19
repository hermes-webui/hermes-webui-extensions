# Profile Avatars

Profile Avatars is a Hermes WebUI extension that gives every profile its own
avatar image and renders it everywhere the profile appears. Avatars are stored
**server-side** (a loopback sidecar with SQLite), so one upload syncs across
all your devices and browsers — and each image is downloaded **once per page
load** into a shared in-memory object URL. Nothing is written to
`localStorage` or any other persistent browser storage.

## What It Does

- **Native profile chips** — the titlebar and composer profile chips show the
  active profile's real image instead of the generic person icon.
- **Chat transcript** — assistant role badges (`.role-icon.assistant`) show the
  active profile's avatar. The native letter glyph is preserved and restored
  when no image is set (or on load failure) — the built-in fallback is never
  destroyed.
- **Session list** — every chat row carries its owning profile's avatar next
  to the title, so with "Show N from other profiles" you can see at a glance
  which agent each chat belongs to. Re-renders live when you switch profiles.
- **Manager modal** — a button at the top of the **Profiles** tab opens an upload / replace / remove
  panel for every profile. PNG / JPEG / WebP, up to 1 MiB, magic-byte sniffed
  server-side.
- **Colored-initial fallback** — profiles without an image get a deterministic
  colored initial bubble.

## Why server-side storage

| | localStorage approaches | Profile Avatars |
|---|---|---|
| Sync across devices | ✗ per-browser | ✓ one upload, every device |
| Browser storage used | data-URLs eat the quota | none — in-memory only |
| Image quality | heavily downscaled | up to 1 MiB, full quality |
| Scope | one assistant image | one avatar **per profile** |
| Downloads per render | re-read every render | once per page load (shared blob) |

## Current Shape

```text
Hermes WebUI page
  -> assets/avatars.js     render + observers (chips, badges, session rows)
  -> assets/avatars.css    avatar primitive + manager styles
WebUI sidecar proxy (after consent)
  -> /api/extensions/profile-avatars/sidecar/api/avatars[...]
  -> loopback sidecar on 127.0.0.1:17798 (sidecar/sidecar.py)
     -> SQLite at $HERMES_AVATARS_STATE_DIR/avatars.db
Reads (same-origin WebUI API): /api/profiles (roster + active),
  /api/sessions?all_profiles=1 (session → profile map, throttled, in-memory)
```

## Supported WebUI version / API surface

Built and tested against Hermes WebUI ≥ 0.16 (the current extension gallery /
sidecar-proxy API). Required surface:

- manifest-bundled asset injection (`manifest.json` scripts/stylesheets)
- consented sidecar proxy at `/api/extensions/<id>/sidecar/*` and
  `POST /api/extensions/sidecar-proxy-consent`
- same-origin JSON APIs: `GET /api/profiles`, `GET /api/sessions?all_profiles=1`
- DOM integration contract (all optional; each degrades to native rendering
  when absent):
  - `.app-titlebar-profile-icon`, `.composer-profile-icon` (profile chips)
  - `.role-icon.assistant` (transcript badge)
  - `.session-item[data-sid] .session-title-row` (session rows)

## Sidecar

`sidecar/sidecar.py` is stdlib-only Python (no dependencies). Routes:
`GET /api/avatars` (map), `GET/POST/DELETE /api/avatars/<profile>`,
`GET /health`.

| Setting | Env var | Default |
|---|---|---|
| Port | `HERMES_AVATARS_SIDECAR_PORT` | `17798` |
| State dir (avatars.db) | `HERMES_AVATARS_STATE_DIR` | `~/.hermes/webui` |

Run it manually:

```bash
python3 sidecar/sidecar.py
```

or install the provided systemd user unit (`sidecar/profile-avatars-sidecar.service`):

```bash
cp sidecar/profile-avatars-sidecar.service ~/.config/systemd/user/
systemctl --user enable --now profile-avatars-sidecar
```

**Sidecar health expectations:** `GET http://127.0.0.1:17798/health` returns
`{"ok": true}`. The WebUI diagnostics card probes this URL from the browser
with credentials omitted — when you browse from a different machine than the
one running the WebUI, that probe reads "unreachable / blocked" by design; the
consented proxy path is what actually serves traffic.

## Install, disable, uninstall

- **Install**: copy the extension into the WebUI's gallery extension dir
  (`$HERMES_WEBUI_STATE_DIR/extensions/`, default `~/.hermes/webui/extensions/`),
  enable it in **Settings → Extensions**, start the sidecar, reload. The
  extension requests sidecar-proxy consent on first load; consent can be
  granted or revoked anytime in **Settings → Extensions**.
- **Disable**: toggle off in **Settings → Extensions** — assets stop being
  injected on the next render; all chips/badges/rows revert to native
  rendering. No restart required.
- **Uninstall**: remove it in **Settings → Extensions** (or delete the
  directory). Avatar images remain in `avatars.db` under the state dir; delete
  that file to remove all stored images.

## Trust and permissions

- Creates extension-owned DOM (avatar `<img>`/initial spans inside existing
  slots, a manager modal, a launcher banner in the Profiles tab).
- Reads `GET /api/profiles` and `GET /api/sessions?all_profiles=1` (same-origin,
  session-authenticated) to know the roster and which profile owns each session.
- Talks to its loopback sidecar only through the WebUI's consented proxy path.
- Uploads go to the sidecar; images never leave the machine. The sidecar
  validates type by magic bytes and caps size at 1 MiB.
- No localStorage, no cookies read, no external network access, no native host.

## Manual verification

1. Open the manager (Profiles tab → “Profile avatars” banner) → upload an image for a profile →
   the chip, transcript badges, and manager preview update immediately.
2. Reload — the avatar persists (server-side) and each image is fetched once
   (check DevTools Network: one request per avatar, then blob: URLs).
3. Every session row carries its owner's avatar; "Show N from other profiles"
   reveals rows carrying the other agents' avatars.
4. Switch profiles via the native chip → chip, badges, and session-row
   decorations update within ~1s without a reload.
5. Remove the avatar → everything reverts to the colored initial / native glyph.
6. Upload a >1 MiB file or a non-image → rejected with a message, nothing applied.

## Future CI checks

- `node --check assets/avatars.js`
- JSON validity of `extension.json` / `manifest.json`
- `python3 -m py_compile sidecar/*.py`
- Sidecar contract test: `POST` a 1×1 PNG → `GET` returns it with `ETag`;
  `GET /health` returns `{"ok": true}`.
