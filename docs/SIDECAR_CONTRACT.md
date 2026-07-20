# Sidecar contract (proxy → sidecar authentication)

Authoritative spec for **loopback-sidecar extensions** — a local HTTP server on
`127.0.0.1:<port>`. A `token-v1` adapter reaches it through WebUI's same-origin
proxy; an explicitly legacy external adapter may still use direct loopback
access. The wire/authentication contract is language-neutral. A runtime committed
to this repository must use the canonical Python scaffold in
[`examples/sidecar-scaffold/`](../examples/sidecar-scaffold/); a runtime owned by
an external repository may implement the same contract in Node, Rust, or another
language.

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

## Manifest and runtime ownership

Every library entry declares whether its sidecar runtime is **vendored** in this
repository or **external**. Discovery comes from this metadata, never from the
presence of `sidecar_base.py`.

### Repository-vendored runtime

```json
"sidecar": {
  "type": "loopback",
  "origin": "http://127.0.0.1:17790",
  "health_path": "/health",
  "proxy_auth": "token-v1",
  "runtime": {
    "kind": "vendored",
    "path": "sidecar"
  }
}
```

Vendored runtimes must use `token-v1`. CI requires `sidecar_base.py`,
`sidecar.py`, `sidecar.json`, and `routes_impl.py`; byte-compares the two
protected scaffold files; and verifies that `sidecar.json` agrees with
`extension.json` on id, port, and auth mode. Because the canonical scaffold
serves plain HTTP on IPv4 loopback with a fixed liveness route, vendored metadata
must use `http://127.0.0.1:<explicit-port>` and `health_path: "/health"`.

### External runtime

```json
"sidecar": {
  "type": "loopback",
  "origin": "http://127.0.0.1:17787",
  "health_path": "/health",
  "proxy_auth": "legacy",
  "runtime": {
    "kind": "external",
    "repository": "https://github.com/example/sidecar-runtime"
  }
}
```

External runtimes do not vendor the Python scaffold. `token-v1` external
runtimes must implement the language-neutral conformance contract below. A
runtime that has not migrated must declare `proxy_auth: "legacy"` explicitly;
the validator reports that status rather than treating it as scaffold-compliant.
Desktop Companion is the current external/legacy compatibility case.

The runtime `manifest.json` repeats `type`, `origin`, `health_path`, and
`proxy_auth` but omits the library-only `runtime` ownership object. CI requires
the repeated fields to match `extension.json` exactly.

### Auth modes

- **`token-v1`** — required for any sidecar that mutates state or exposes
  sensitive reads. WebUI injects `X-Hermes-Sidecar-Token`; the sidecar validates.
- **`legacy`** — no token. Allowed only for an explicitly external runtime that
  has not migrated yet. New sidecars should use `token-v1`.
- **unknown value** — fails closed (the sidecar declaration is rejected by core).

Core treats an omitted mode as legacy for backward compatibility. This library
requires the field explicitly so legacy status cannot be mistaken for token-v1
conformance.

## The token

- **Provisioned by core**, minted per-extension at
  `STATE_DIR/sidecar-auth/<id>.token` (mode `0600`) when the operator grants
  sidecar-proxy consent. Proxy resolution reads the current persisted token and
  calls the same atomic provisioner if the file is missing. If the token cannot
  be persisted and re-read, consent or resolution fails closed with `503`. The
  sidecar never mints the token — it only reads it.
- **Header:** `X-Hermes-Sidecar-Token`, injected by the proxy on every forwarded
  request. Core strips any client-supplied `x-hermes-*` inbound (so the browser
  can't forge it) and strips it from responses (so a sidecar can't echo it back).
- **Resolution order** (the scaffold does this for you):
  `HERMES_EXT_SIDECAR_TOKEN_FILE` → `$HERMES_WEBUI_STATE_DIR/sidecar-auth/<id>.token`
  → `$HERMES_HOME/webui/sidecar-auth/<id>.token` → platform default
  (`~/.hermes/webui/...`, `%LOCALAPPDATA%\hermes\webui\...` on Windows).
- **Rotation:** re-read the token per request (the scaffold does),
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
4. **No secrets in the `.service` file.** The token lives in the state dir; the
   unit only points at the state dir. `WorkingDirectory` must resolve to
   `<extension-id>/<runtime.path>`, and `ExecStart` must run only that directory's
   byte-compared `sidecar.py` as `/usr/bin/python3 -S [-u] sidecar.py`, with no
   trailing command tokens. The mandatory `-S` prevents `sitecustomize` and `.pth`
   startup hooks from bypassing the byte-compared modules. The `[Service]`
   section uses a small directive allowlist; auxiliary `Exec*`, environment files,
   root/image overrides, and other execution-context directives are forbidden because
   they could execute outside the authenticated scaffold. Direct shebang execution,
   arbitrary Python-looking executables, `/usr/bin/env` wrappers, and Quadlet
   `.container` units are rejected because they cannot prove the interpreter or
   image entrypoint; model those runtimes as externally maintained instead.
5. **One required route hook, one optional daemon hook.** `routes_impl.register(app)`
   is required, and `routes_impl.py` must be a regular file that defines exactly
   one top-level synchronous `register(app)` binding callable with that one
   argument. It must apply at least one reachable `@app.route(...)` decorator (or
   the equivalent direct decorator application) to a handler. A bare
   `app.route(...)` call registers nothing and is rejected. Later rebinding is
   rejected. `routes_impl.start_background(app)` is called only when the module
   defines it.
6. **The declared vendored tree is the artifact that executes.** Every component
   of `runtime.path` must be a real directory, not a symlink. Protected scaffold,
   entrypoint, config, and route files must be real regular files. Python import
   collisions next to them (`sidecar_base/`, `routes_impl/`, compiled or bytecode
   variants) are rejected so another module cannot shadow a byte-compared file.

## Auth-off posture

WebUI authentication is optional and **off by default**, but `token-v1` is
fail-closed in that posture. Both consent and proxy-target resolution return
`403` until WebUI authentication is configured, regardless of whether the
sidecar origin is loopback. This prevents an unauthenticated caller from using
WebUI as a token-bearing forwarding oracle. The extensions status payload uses
`posture: "local_unprotected"` to prompt the operator; once authentication is
enabled it reports `posture: "protected"`. Enabling auth is one field in
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

- [ ] declare `sidecar.runtime.kind` as `vendored` or `external`
- [ ] declare `proxy_auth` explicitly in both metadata and runtime manifest
- [ ] for vendored: use `token-v1` and vendor `sidecar_base.py` + `sidecar.py`
      byte-identical from the reference
- [ ] `runtime.path` contains no symlink and no canonical-module import collision
- [ ] for external token-v1: implement the same header, health, status, rotation,
      and fail-closed behavior in the external runtime's language
- [ ] routes only in `routes_impl.py`; no `HTTPServer`/framework server anywhere else
- [ ] `sidecar.json` = `{id, port, proxy_auth}`
- [ ] `.service` uses `/usr/bin/python3 -S [-u] sidecar.py`; no token in the unit
- [ ] long ops use start-job + poll; nothing relies on streaming
- [ ] README states the same-UID scope honestly and the docker limitation
- [ ] `node scripts/sync-sidecar-base.mjs --check` and
      `node scripts/check-sidecar-usage.mjs` pass
