# sigakhwa-bookmarks sidecar

Loopback HTTP service (`127.0.0.1:17831`) that stores bookmark/card items as one JSON file per
namespace so PC and phone see the same list through the WebUI's consented sidecar proxy
(`/api/extensions/sigakhwa-bookmarks/sidecar/...`). Auth is `token-v1`: the scaffold validates the
`X-Hermes-Sidecar-Token` the WebUI proxy injects; every route except `GET /health` fails closed.

| File | Origin | Edit? |
|---|---|---|
| `sidecar_base.py`, `sidecar.py` | byte-identical copies of the library scaffold `examples/sidecar-scaffold/` | **no** |
| `sidecar.json` | `{"id":"sigakhwa-bookmarks","port":17831,"proxy_auth":"token-v1"}` | per extension |
| `routes_impl.py` | the only file with logic (routes, storage, validation) | yes |

## Run

Run it from this directory with the **same** state dir as WebUI, so it finds the token WebUI mints when you
approve the proxy:

```bash
cd <STATE_DIR>/extensions/sigakhwa-bookmarks/sidecar
HERMES_WEBUI_STATE_DIR=<STATE_DIR> python3 -S sidecar.py
# optional: HERMES_VIZ_STORE_DIR=<dir>   (default ~/.local/share/hermes-viz/store,
#                                         %LOCALAPPDATA%\hermes-viz\store on Windows)
```

PowerShell:

```powershell
$env:HERMES_WEBUI_STATE_DIR = "<STATE_DIR>"
python -S sidecar.py
```

`sidecar.service` is a systemd user unit for Linux hosts. On Windows, a logon scheduled task that runs the
same command (hidden, e.g. through `conhost.exe --headless`) keeps it running across reboots.

Token resolution (scaffold, re-read on every request): `HERMES_EXT_SIDECAR_TOKEN_FILE` →
`$HERMES_WEBUI_STATE_DIR/sidecar-auth/sigakhwa-bookmarks.token` → `$HERMES_HOME/webui/sidecar-auth/…` →
`%LOCALAPPDATA%\hermes\webui\sidecar-auth\…`. Check that `GET /health` returns `{"ok": true}` using a browser or HTTP tool.
Data routes return 503 without a token file and 401 with a missing or wrong token.

Enabling sync in WebUI: password auth must be on, then Settings → Extensions → Diagnostics → Sidecars →
`sigakhwa-bookmarks` → **Approve proxy consent** (core mints the token file), then reload the page. The extension probes `GET <proxy>/health`; on 2xx it imports this browser's local
bookmarks to the server. It shows "Synced" only after successful data requests with no local leftovers; later request failures show "Sync unavailable".

## Routes (all under the proxy base; `ns` = `bookmarks` or `sigakhwa-vault`)

| Method | Path | Notes |
|---|---|---|
| GET | `/v1/{ns}/items?profile=&sessionId=&kind=&offset=` | newest first, ≤500 per page, pages ≤ ~400 KiB **as served**; `nextOffset` when truncated |
| GET | `/v1/{ns}/items/{id}` | 404 when missing |
| PUT | `/v1/{ns}/items/{id}` | create (201) / replace (200); 400 invalid, 409 `{"error":"immutable"}`, 413 `too_large` / `store_full` |
| PATCH | `/v1/{ns}/items/{id}` | `{name?, tags?}` metadata only — allowed for immutable items |
| DELETE | `/v1/{ns}/items/{id}` | `{"removed":true}` / 404 |
| GET | `/v1/{ns}/export?offset=` | `{v:1, namespace, items, total, nextOffset?}` |
| POST | `/v1/{ns}/import?merge=1\|0` | body `{items:[...]}` or `[...]`; merge skips existing ids; `merge=0` replaces |

Storage: `<HERMES_VIZ_STORE_DIR>/<ns>.json` = `{"v":1,"namespace":…,"updatedAt":…,"items":[…]}`,
written atomically (tmp + `os.replace`), serialized by a per-namespace lock, capped at 2 MiB per file
(413 beyond that), items ≤ 256 KiB each, ≤ 1,000 items per namespace. Ids: `^[A-Za-z0-9._:-]{1,128}$`.

Migration uses PUT with `?createOnly=1`: an existing id returns 409 without replacement,
and newly created items retain their imported timestamps. Conflicting local versions remain
visible and exportable. DELETE with `?ifUnchanged=1` and an expected item body only removes
that exact version, for cleanup of an upload deleted locally while migration was in flight.
Lone surrogate code points in incoming items are rejected with 400.

**Size accounting.** Every response leaves through the scaffold's `Sidecar.json` (`json.dumps` with the default
`ensure_ascii=True`), which writes each Hangul/CJK character as a 6-byte `\uXXXX` escape — twice its UTF-8 size.
Item and page caps are therefore measured with that same serializer (`_wire_size`), so a 256 KiB item is ≈43k
Hangul characters (or ≈256k ASCII) and a page of Korean items can never exceed the WebUI proxy's hard 512 KiB
response cap (`routes.py _EXTENSION_SIDECAR_PROXY_MAX_RESPONSE_BYTES` → 502 otherwise). The on-disk file stays
UTF-8 (never proxied). Directories use mode 0700 and new files mode 0600 on POSIX. Malformed files are moved to `<ns>.json.corrupt-<timestamp>` before recovery.

Stop: Ctrl+C for a foreground process, or stop the service/task you created.

## Honest scope

- Protects against callers that cannot read the WebUI state dir (other users, containers,
  sandboxed network-only processes). Does **not** protect against same-UID code, which can read the
  token file or the JSON files directly.
- Not reachable from a bridge-networked docker WebUI (loopback is namespace-local).
- Responses are buffered by the proxy (≤512 KiB, ~10 s); every route here is short and paginated, and sizes
  are measured as served (see Size accounting) so Korean content cannot overflow the buffer.
