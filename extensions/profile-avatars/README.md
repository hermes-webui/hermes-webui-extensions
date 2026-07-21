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
  panel for every profile. PNG / JPEG / WebP, up to 512 KiB, magic-byte sniffed
  server-side.
- **Colored-initial fallback** — profiles without an image get a deterministic
  colored initial bubble.

## Why server-side storage

| | localStorage approaches | Profile Avatars |
|---|---|---|
| Sync across devices | ✗ per-browser | ✓ one upload, every device |
| Browser storage used | data-URLs eat the quota | none — in-memory only |
| Image quality | heavily downscaled | up to 512 KiB, full quality |
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
     -> SQLite at $HERMES_WEBUI_STATE_DIR/avatars.db
Reads (same-origin WebUI API): /api/profiles (roster + active),
  /api/sessions?all_profiles=1 (session → profile map, throttled, in-memory)
```

## Supported WebUI version / API surface

Requires a Hermes WebUI build that contains the `token-v1` sidecar-proxy
contract (core [nesquena/hermes-webui#6331](https://github.com/nesquena/hermes-webui/pull/6331),
first shipped in `exp-v0.52.129`). An older build has no per-extension sidecar
token, so every protected sidecar call fails closed. A stable-channel minimum
will be documented once #6331 promotes to a `v*` release. Required surface:

- manifest-bundled asset injection (`manifest.json` scripts/stylesheets)
- `token-v1` sidecar proxy at `/api/extensions/<id>/sidecar/*` (core injects
  `X-Hermes-Sidecar-Token`; approve the sidecar in **Settings → Extensions**)
- same-origin JSON APIs: `GET /api/profiles`, `GET /api/sessions?all_profiles=1`
- DOM integration contract (all optional; each degrades to native rendering
  when absent):
  - `.app-titlebar-profile-icon`, `.composer-profile-icon` (profile chips)
  - `.role-icon.assistant` (transcript badge)
  - `.session-item[data-sid] .session-title-row` (session rows)

**Coexistence:** if the separate `custom-avatar` extension has an assistant
transcript image active, that extension keeps ownership of `.role-icon.assistant`.
Profile Avatars still owns profile chips, profile-aware session rows, and the
manager, and resumes transcript badges if the custom assistant avatar is removed.

## Sidecar (token-v1 scaffold)

Built on the canonical Hermes sidecar scaffold. `sidecar/sidecar.py` and
`sidecar/sidecar_base.py` are vendored **byte-identical** from
`examples/sidecar-scaffold/` (CI: `scripts/sync-sidecar-base.mjs --check`); this
extension's own code is `sidecar/routes_impl.py` (routes) + `sidecar/avatars.py`
(SQLite storage). `sidecar/sidecar.json` declares `{id, port, proxy_auth}`. Routes:
`GET /api/avatars` (map), `GET/POST/DELETE /api/avatars/<profile>`; `GET /health`
(liveness only — the sole tokenless route).

**Proxy auth — `token-v1`.** The loopback port is reachable by any local process
and the WebUI proxy strips inbound credentials, so the sidecar can't tell a
proxied request from a direct one. Core mints a per-extension secret and injects
`X-Hermes-Sidecar-Token`; the scaffold validates it **deny-by-default** at one
dispatch chokepoint (every route but `/health`). Missing token file → `503`,
wrong token → `401`. **Honest scope:** this protects against callers that can't
read the user's state dir (other-UID users, host containers, sandboxed
processes) — the same level as WebUI's own auth. It does **not** defend against
arbitrary same-UID code, which can read the token file directly. Auth is
fail-closed while WebUI auth is off — enable it in **Settings → Password**, then
approve the sidecar in **Settings → Extensions**.

| Setting | Source | Default |
|---|---|---|
| Port | `sidecar/sidecar.json` | `17798` |
| State dir (avatars.db + token) | `HERMES_WEBUI_STATE_DIR` | `~/.hermes/webui` |

Install the systemd user unit — it runs `/usr/bin/python3 -S -u sidecar.py` with
no token in the unit (core provisions it in the state dir):

```bash
cp sidecar/profile-avatars-sidecar.service ~/.config/systemd/user/
systemctl --user enable --now profile-avatars-sidecar
```

**Health:** `GET http://127.0.0.1:17798/health` returns
`{"ok": true, "sidecar_base_version": N}`. The WebUI diagnostics card probes this
cross-origin (credentials omitted); the token-bearing proxy path is what serves
real traffic.

**Docker limitation:** a bridge-networked WebUI container cannot reach a host-run
sidecar's `127.0.0.1:17798` (loopback is namespace-local). Sidecars work only
where core and the sidecar share a network namespace and the state dir.

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
  validates type by magic bytes and caps size at 512 KiB (matching the core sidecar-proxy response cap).
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
6. Upload a >512 KiB file or a non-image → rejected with a message, nothing applied.

## Future CI checks

- `node --check assets/avatars.js`
- JSON validity of `extension.json` / `manifest.json`
- `python3 -m py_compile sidecar/*.py`
- Sidecar contract test: `POST` a 1×1 PNG → `GET` returns it with `ETag`;
  `GET /health` returns `{"ok": true}`.
