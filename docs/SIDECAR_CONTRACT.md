# Sidecar contract (proxy → sidecar authentication)

Authoritative spec for **loopback-sidecar extensions** — a stdlib HTTP server on
`127.0.0.1:<port>` that the WebUI proxies to on the extension's behalf. Read this
before writing a sidecar; use the reference scaffold in
[`examples/sidecar-scaffold/`](../examples/sidecar-scaffold/) rather than
hand-rolling.

## Why this exists

The loopback port is reachable by **any local process**, and the WebUI proxy
strips every inbound credential (cookies, `Authorization`, CSRF, `x-hermes-*`)
before forwarding — so a sidecar cannot, on its own, tell a request that came
through the authenticated WebUI proxy from one a random local process sent
directly. `proxy_auth: token-v1` closes that: WebUI mints a per-extension secret
and injects it as a header the sidecar validates.

### Threat model — be honest about scope

The token converts *"anyone who can send a loopback TCP packet"* (other-UID
users, host containers, sandboxed network-only processes) into *"processes that
can read the user's WebUI state dir"* — the same protection level WebUI's own
auth already has. It does **not** defend against arbitrary same-UID code: a
process running as the same user can read the token file, read WebUI's signing
key, or just run your sidecar's underlying tool directly. No mechanism available
here (token, HMAC, nonce, Unix socket with `0600`) changes that. Do not claim
otherwise in your README.

## The manifest field

```json
"sidecar": {
  "type": "loopback",
  "origin": "http://127.0.0.1:17790",
  "health_path": "/health",
  "proxy_auth": "token-v1"
}
```

- **`token-v1`** — required for any sidecar that mutates state or exposes
  sensitive reads. WebUI injects `X-Hermes-Sidecar-Token`; the sidecar validates.
- **absent** — explicit **legacy** mode (no token, unchanged behavior). Only for
  read-only, non-sensitive sidecars. New sidecars should use `token-v1`.
- **unknown value** — fails closed (the sidecar declaration is rejected by core).

## The token

- **Provisioned by core**, minted per-extension at
  `STATE_DIR/sidecar-auth/<id>.token` (mode `0600`), created eagerly and also on
  consent. The sidecar never mints it — it only reads it.
- **Header:** `X-Hermes-Sidecar-Token`, injected by the proxy on every forwarded
  request. Core strips any client-supplied `x-hermes-*` inbound (so the browser
  can't forge it) and strips it from responses (so a sidecar can't echo it back).
- **Resolution order** (the scaffold does this for you):
  `HERMES_EXT_SIDECAR_TOKEN_FILE` → `$HERMES_WEBUI_STATE_DIR/sidecar-auth/<id>.token`
  → `$HERMES_HOME/webui/sidecar-auth/<id>.token` → platform default
  (`~/.hermes/webui/...`, `%LOCALAPPDATA%\hermes\webui\...` on Windows).
- **Rotation:** re-read the token per request (the scaffold does — mtime-checked),
  so deleting/rotating the file takes effect with no restart, and a stale token
  stops validating immediately.

## Enforcement rules (what the scaffold guarantees, and you must not weaken)

1. **Deny-by-default at one chokepoint.** Every route except `/health` requires a
   valid token. Auth is *inherited* from the dispatch loop, never invoked
   per-route — a forgotten call cannot open a route.
2. **`/health` is the only tokenless route.** `GET/HEAD /health` returns liveness
   only (`{"ok": true}`-class), `Cache-Control: no-store`. WebUI probes it
   cross-origin, so it also carries `Access-Control-Allow-Origin: *`. Do **not**
   put stats or any sensitive data on `/health`. Accepted trade-off: `ACAO: *`
   health means any website can fingerprint which sidecars you run via a drive-by
   loopback probe — acceptable for liveness only.
3. **Missing token file → 503, wrong token → 401**, both fail closed.
4. **No secrets in the `.service`/unit file.** The token lives in the state dir;
   the unit only points at the state dir. `ExecStart` must run `sidecar.py`.

## Auth-off posture

WebUI authentication is optional and **off by default**. In that mode the consent
endpoint itself is unauthenticated, so a `token-v1` sidecar is proxied **only when
its origin is provably loopback** (`127.0.0.1`/`localhost`/`::1`); a non-loopback
`token-v1` origin returns `503` until a password/passkey is configured. The
extensions panel surfaces `auth_required` so the operator is prompted to enable
authentication before wiring up a sidecar. Enabling auth is one field in
**Settings → Password** (or `HERMES_WEBUI_PASSWORD`).

## The request/response envelope (do not fight it)

The proxy fully **buffers** both directions:

| Limit | Value |
|---|---|
| Response body | ≤ 512 KiB |
| Request body | ≤ the proxy cap (≈20 MiB) |
| Upstream timeout | ≈ 10 s |
| Streaming / SSE | **not supported** (buffered) |

For work longer than a few seconds, **do not hold the request open** — it will
502. Use **start-job + poll**:

```
POST /api/job        -> {"job_id": "..."}        # returns immediately
GET  /api/job/{id}   -> {"state": "running"|"done", "result": ...}
```

(This is exactly what a speed test / image pull / long scan needs, independent of
auth — the 10 s proxy timeout makes it mandatory.)

## Docker limitation

A bridge-networked WebUI container **cannot reach a host-run sidecar's
`127.0.0.1:<port>`** — loopback is namespace-local. Sidecars work only where core
and the sidecar share a network namespace and the state dir (sidecar inside the
WebUI container / shared `hermes-home` volume). **Sidecars are not supported with
bridge-networked docker installs.**

## Versioning

`sidecar_base.py` carries `SIDECAR_BASE_VERSION`, echoed in `/health` and error
bodies so an installed-copy drift (users copy directories by hand; CI can't see
that) is diagnosable from the extensions panel. When the canonical scaffold
changes, bump the version and re-sync every vendored copy
(`node scripts/sync-sidecar-base.mjs --write`); CI's `--check` enforces identity.

## Checklist for a new sidecar

- [ ] `proxy_auth: "token-v1"` in the manifest (unless genuinely read-only/legacy)
- [ ] vendor `sidecar_base.py` + `sidecar.py` byte-identical from the reference
- [ ] routes only in `routes_impl.py`; no `HTTPServer`/framework server anywhere else
- [ ] `sidecar.json` = `{id, port, proxy_auth}`
- [ ] `.service` `ExecStart` runs `sidecar.py`; no token in the unit
- [ ] long ops use start-job + poll; nothing relies on streaming
- [ ] README states the same-UID scope honestly and the docker limitation
- [ ] `node scripts/sync-sidecar-base.mjs --check` and
      `node scripts/check-sidecar-usage.mjs` pass
