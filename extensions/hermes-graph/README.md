# Hermes Graph

Hermes Graph adds an Obsidian-style graph view to Hermes WebUI: one canvas that shows the
workspace files **and** the Hermes "brain" — memory entries, skills, sessions, cron jobs and MCP
servers — as a single connected picture. Everything is indexed by a bundled read-only loopback
sidecar; no Hermes WebUI core file is modified.

## What It Does

A **Graph** button is added to the rail. It opens a full-area overlay with a force-directed canvas
where nodes are files, folders, tags, memory entries, skills, sessions, crons, MCP servers,
entities mentioned in memory (IPs, `CTnnn` container ids, domains) and credential **names**, and
edges are the relations between them: containment, markdown links, wiki-links, embeds, imports,
`exec`/`source` references, name mentions, token-similarity, tags, entities, session→skill,
cron→skill/script and MCP references.

Interaction: search with `/`, click a node for its detail card and neighbour list, expand an ego
network, filter by node and edge kind, switch scope, tune gravity/spread, drag with inertia
(neighbours get pushed). The bar is a single 44 px strip; filters, scope, colour and physics live
in a popover, which becomes a bottom sheet on narrow screens.

## Who It Is For

Self-hosted Hermes operators who want to navigate the relations between scripts, reports, skills
and memory without grepping. It is a read-only view — it never edits the files or state it shows.

## How It Works

```text
Browser (assets/graph.js: physics in a Web Worker, WebGL2 instanced renderer, Canvas2D fallback)
  -> /api/extensions/hermes-graph/sidecar/graph      (WebUI same-origin proxy, token-v1)
  -> sidecar 127.0.0.1:17803 (sidecar_base.py = canonical scaffold, deny-by-default token)
       routes_impl.py -> graph_service.py (background snapshot thread) -> graph_index.py
       SQLite cache: <state dir>/hermes-graph/index.sqlite3  (mtime_ns + size => incremental)
```

The sidecar builds the index on demand and caches it. `POST .../sidecar/reindex` forces a rebuild;
otherwise the snapshot is reused for `HERMES_GRAPH_TTL` seconds (default 120).

## Install

1. Install from **Settings → Extensions** (gallery), or copy this directory to
   `~/.hermes/webui/extensions/hermes-graph/`.
2. Install the sidecar unit:

   ```bash
   cp sidecar/hermes-graph-sidecar.service ~/.config/systemd/user/
   systemctl --user daemon-reload
   systemctl --user enable --now hermes-graph-sidecar
   ```

3. **Settings → Extensions → Diagnostics → Loopback sidecar** → approve the proxy consent.
   This is what mints the `token-v1` secret in `<state dir>/sidecar-auth/hermes-graph.token`.
   WebUI authentication must be enabled (`HERMES_WEBUI_PASSWORD`); in the auth-off posture the
   `token-v1` proxy fails closed with `403` by design.
4. Reload the WebUI. The **Graph** button appears in the rail.

Optional sidecar environment variables:

| Variable | Meaning |
|---|---|
| `HERMES_GRAPH_ROOTS` | Extra/override roots, e.g. `ws=/path/a,notes=/path/b` |
| `HERMES_GRAPH_TTL` | Snapshot reuse in seconds (default `120`) |
| `HERMES_GRAPH_CACHE` | SQLite cache path (default `<state dir>/hermes-graph/`) |

## Disable

```bash
systemctl --user disable --now hermes-graph-sidecar
```

Then disable the extension in **Settings → Extensions**. The rail button disappears; nothing else
in the WebUI changes.

## Uninstall

1. `systemctl --user disable --now hermes-graph-sidecar`
2. Remove the unit: `rm ~/.config/systemd/user/hermes-graph-sidecar.service && systemctl --user daemon-reload`
3. Uninstall the extension in **Settings → Extensions**.
4. Remove the leftover local state (optional, one SQLite file plus the token):
   `<state dir>/hermes-graph/` and `<state dir>/sidecar-auth/hermes-graph.token`.

## What the Graph Shows — and What It Does Not

Files whose names look sensitive (`*cred*`, `*token*`, `*.pem`, `.env`, key material) are **never
opened**, so they never become nodes. No file content leaves the sidecar: edges carry only the
relation kind, a weight and a line number. Memory and credential handling is name-level, so a
credential node is a label, never a value.

## WebUI APIs and DOM Surfaces Used

**APIs** (all through the authenticated same-origin sidecar proxy):

- read: `/api/extensions/status`, `/api/extensions/hermes-graph/sidecar/graph`,
  `/api/extensions/hermes-graph/sidecar/graph/ego`, `/api/extensions/hermes-graph/sidecar/status`
- write: `/api/extensions/hermes-graph/sidecar/reindex` (rebuilds the index; no user data is written)

**DOM**: a rail button (`#hwx-graph-rail`) and a full-area overlay (`#hwx-graph-overlay`). The
overlay lives in its own layer and does not mutate core views.

**Storage**: `settings_schema` (declared `storage.owned: true`: default scope and `max_nodes`), read
through `window.HermesExtensionSettings` with a graceful fallback when `.supported` is false.

## Permissions and Trust Model

Declared in `extension.json`: `webui_api.read` / `webui_api.write` (paths above),
`storage.owned: true`, `loopback_sidecar: true`, `dom.owned: true` with `mutates_core_views: false`,
`filesystem.serves_bundled_assets: true` with `arbitrary: false`, `network_external: false`,
`native_host: false`. No remote scripts are loaded at runtime — the assets are bundled.

The extension runs as trusted local code in the WebUI origin with full session authority. The
`token-v1` sidecar secret protects the loopback port against **other UIDs and sandboxed
network-only processes** — the same protection level WebUI's own auth has. It does **not** defend
against arbitrary same-UID code, which can read the token file or the indexed files directly. Do not
read more into it than that.

## Sidecar Behavior

- Binds `127.0.0.1:17803` only, plain HTTP. `GET/HEAD /health` is the single tokenless route
  (`{"ok": true}` liveness only, `Cache-Control: no-store`).
- Every other route requires the `X-Hermes-Sidecar-Token` header the WebUI proxy injects: missing
  token → `503`, wrong token → `401`. The token is re-read per request, so rotation needs no restart.
- Reads (read-only, never following symlinks): the configured workspace roots, `~/.hermes/skills`,
  `~/.hermes/memories`, `~/.hermes/webui/sessions`, `~/.hermes/cron/jobs.json`, and only the
  `mcp_servers` key names of `~/.hermes/config.yaml`.
- Writes exactly one file: the SQLite index cache under the state dir.
- Snapshots are requested, not streamed — the proxy buffers with a ~10 s upstream timeout, so the
  panel renders whatever the last build produced and refreshes on the next poll.
- If the WebUI extension API changes (proxy route shape, `token-v1` header, manifest bundle), the
  panel keeps rendering but shows its "sidecar unavailable" banner instead of data.

**Docker:** a bridge-networked WebUI container cannot reach a host-run sidecar's `127.0.0.1` —
loopback is namespace-local. Run the sidecar inside the same container/network namespace, or use a
native install.

## Known Limitations

- Force-directed layout only (plus the ego view); no hierarchical or timeline layout yet.
- Above roughly 20k nodes the layout needs tens of seconds to settle — drawing stays responsive, but
  a precomputed layout in the sidecar is future work.
- No inotify watch: freshness comes from the TTL and the **Reindex** button.
- No exact-line navigation into the native file browser; a node opens in the graph, not in the editor.
- Single-user by design. Multi-user profile isolation is a core concern; this extension renders
  whatever the authenticated session is already allowed to read.

## Compatibility and Verification

Requires the manifest-bundle extension contract, `settings_schema` with owned storage, and loopback
sidecar metadata with `token-v1`. Tested against Hermes WebUI `exp-v0.52.516` (commit `1a80cb05`)
with authentication enabled.

Verification notes:

- `curl -s http://127.0.0.1:17803/health` → `{"ok": true, ...}` proves the sidecar process is alive.
- `GET /api/extensions/hermes-graph/sidecar/health` without a session returns `401` (route exists),
  not `404` — a `404` would mean core is not loading the extension.
- A data call through the proxy with no token returns `503`: that is the fail-closed path, not a bug.
- `node scripts/test-hermes-graph-layout.mjs` covers the physics core: determinism, collision-free
  settle (zero overlapping disks), constant-magnitude gravity, drag inertia with neighbour push,
  inert hidden nodes, and the legacy `createSim` API.
