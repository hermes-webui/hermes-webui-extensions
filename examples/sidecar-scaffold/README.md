# Sidecar scaffold (reference)

The **canonical, drop-in scaffold** every repository-vendored loopback sidecar uses. It
makes the secure path the only path: the scaffold owns the HTTP dispatch loop and
validates the WebUI-injected `X-Hermes-Sidecar-Token` **deny-by-default** — you
cannot write an unauthenticated route by accident. See
[`docs/SIDECAR_CONTRACT.md`](../../docs/SIDECAR_CONTRACT.md) for the full contract.

## Files

| File | Vendored? | You edit it? |
|---|---|---|
| `sidecar_base.py` | byte-identical (CI-checked) | **no** |
| `sidecar.py` (entrypoint) | byte-identical (CI-checked) | **no** |
| `sidecar.json` | per-extension config | yes — `{id, port, proxy_auth}` |
| `routes_impl.py` | per-extension | yes — your routes live here |

`sidecar_base.py` and `sidecar.py` are kept identical across every vendored
sidecar extension by `scripts/sync-sidecar-base.mjs --check` in CI. To adopt or
update:

```bash
cp examples/sidecar-scaffold/sidecar_base.py extensions/<id>/sidecar/
cp examples/sidecar-scaffold/sidecar.py       extensions/<id>/sidecar/
# then write extensions/<id>/sidecar/sidecar.json + routes_impl.py
node scripts/sync-sidecar-base.mjs --check   # confirm byte-identity
node scripts/check-sidecar-usage.mjs         # confirm no rogue server
```

External runtimes declare `sidecar.runtime.kind: "external"` plus their source
repository and implement the language-neutral token-v1 contract in their own
language. They do not copy this Python scaffold. See the contract's runtime
ownership section before choosing a mode.

## Writing routes

Only `routes_impl.py` is yours. Everything auth-related is handled for you:

```python
def register(app):
    @app.route("GET", "/api/items/{item_id}")   # path params
    def get_item(req):
        return app.json({"id": req.params["item_id"]})

    @app.route("POST", "/api/upload")
    def upload(req):
        return (200, {"Content-Type": "image/png"}, req.body)   # binary ok
```

- `req.params` (path), `req.query` / `req.query_one("x")` (query string),
  `req.body` (raw bytes — multipart etc.), `req.headers`.
- Return `app.json(obj)`, `app.gzip_json(obj)`, or a raw
  `(status, headers, bytes)` tuple.
- Background threads are fine — the scaffold owns the *dispatch loop*, not the
  *process*. Define the optional `start_background(app)` hook when you need
  daemons; route-only sidecars can omit it.
- **No streaming/SSE** — the WebUI proxy buffers responses (≤512 KiB, ~10 s). For
  long work use start-job + poll (see the contract doc).

## Running

The `.service` unit's `ExecStart` must use
`/usr/bin/python3 -S [-u] sidecar.py` (CI enforces this). The pinned interpreter
and mandatory `-S` keep PATH, `sitecustomize`, and `.pth` startup hooks from
bypassing the checked scaffold. The token file is provisioned by WebUI; point the
sidecar at the same state dir (the default resolution matches core, so a standard
install needs no extra config).
