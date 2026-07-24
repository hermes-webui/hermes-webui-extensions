# System Info

System Info is a Hermes WebUI extension that extends the **Insights → System
health** area with two operational cards, rendered directly under the native
panel: an **internet speed test** and a **Docker containers** card. Everything
is served by a bundled loopback sidecar. No core WebUI code is modified, but the
cards do inject relative to the core `#systemHealthPanel` in Insights, so a WebUI
update that restructures that area could require the injector to be adjusted — it
is decoupled, not update-proof.

## What It Does

**⚡ Speed test** (collapsible)
- On-demand runs via `speedtest-cli` (~15–40s) with animated ↓/↑ bars + ping.
- Last reading persisted server-side (`speedtest_last.json`) — shown on every
  device, survives restarts.
- Auto-schedule: every N hours or daily at HH:MM (daemon thread in the
  sidecar; config persisted server-side).

**Docker** (collapsible; appears only when the docker CLI is reachable)
- Opted-in inventory (running + stopped) with live CPU / RAM per container and a
  status dot (green pulse = running, amber = paused/restarting, grey = exited).
  Deny-by-default: only containers matching your configured allowlist are shown
  (see `MC_DOCKER_NAME_ALLOW` / `MC_DOCKER_WORKDIR_PREFIX` / `MC_DOCKER_SHOW_ALL`).
- Compose-project grouping into collapsible stacks, with per-stack
  Start / Restart / Stop-all actions.
- Custom display names for stacks and containers (rename via the ✎ button;
  persisted server-side so they stick across devices).
- Per-container actions (start / stop / restart) via a kebab menu.
- **Image updates**: "Check updates" flags containers whose remote image
  digest changed; update one container, a whole stack, or everything —
  dependency-first, on a background thread with progress toasts.

## Current Shape

```text
Hermes WebUI page (Insights panel)
  -> assets/sysinfo.js    injects a card after #systemHealthPanel; polls docker
  -> assets/sysinfo.css   card styles (self-contained, host CSS vars)
WebUI sidecar proxy (after consent)
  -> /api/extensions/sysinfo/sidecar/api/system/...
  -> loopback sidecar on 127.0.0.1:17796 (sidecar/sysinfo.py + docker_stats.py)
     -> `speedtest-cli --json`, `docker stats/ps/inspect`, compose pull+up
     -> state: $HERMES_SYSINFO_STATE_DIR/{speedtest_last.json, speedtest_auto.json, .docker_groups.json, .docker_updates.json}
```

## Supported WebUI version / API surface

Requires a WebUI build containing the `token-v1` sidecar-proxy authentication
boundary (core [#6331](https://github.com/nesquena/hermes-webui/pull/6331), first
in `exp-v0.52.129`) — not any `≥ 0.16` release. Until #6331 promotes to stable,
run an `exp-v0.52.129`+ build. Required surface:

- manifest-bundled asset injection (`manifest.json` scripts/stylesheets)
- `token-v1` sidecar proxy at `/api/extensions/<id>/sidecar/*` (core injects
  `X-Hermes-Sidecar-Token`; approve the sidecar in **Settings → Extensions**)
- DOM integration contract: `#systemHealthPanel` in the Insights panel (the
  card anchors after it; if absent, nothing is injected — graceful no-op)

## Sidecar (token-v1 scaffold)

Built on the canonical Hermes sidecar scaffold. `sidecar/sidecar.py` and
`sidecar/sidecar_base.py` are vendored **byte-identical** from
`examples/sidecar-scaffold/` (CI: `scripts/sync-sidecar-base.mjs --check`); this
extension's code is `sidecar/routes_impl.py` (routes) + `sidecar/sysinfo.py`
(speed test) + `sidecar/docker_stats.py` (Docker inventory + controls).
`sidecar/sidecar.json` declares `{id, port, proxy_auth}`. External tools (both
optional, feature-gating): `speedtest-cli` (or `speedtest`) for the speed test;
the `docker` CLI (+ compose plugin) for the Docker card.

**Proxy auth — `token-v1`.** The loopback port is reachable by any local process
and the WebUI proxy strips inbound credentials, so the sidecar can't tell a
proxied request from a direct one. Core mints a per-extension secret and injects
`X-Hermes-Sidecar-Token`; the scaffold validates it **deny-by-default** at one
dispatch chokepoint (every route but `/health`). Missing token file → `503`,
wrong token → `401`. Because these routes control Docker (start/stop/restart,
pull+recreate), the guard matters — auth is fail-closed while WebUI auth is off:
enable it in **Settings → Password**, then approve the sidecar in
**Settings → Extensions**. **Honest scope:** this protects against callers that
can't read the user's state dir (other-UID users, host containers, sandboxed
processes) — the same level as WebUI's own auth. It does **not** defend against
arbitrary same-UID code, which can read the token file (or run `docker`) directly.

Beyond auth, Docker mutations are additionally gated by an inventory **allowlist**
(a rename/action must name a container/project present in the filtered
inventory), and long operations (speed test, image update-check, bulk update) use
**start-job + poll** — the WebUI proxy buffers responses (~10s cap), so nothing
streams.

| Setting | Source | Default |
|---|---|---|
| Port | `sidecar/sidecar.json` | `17796` |
| State dir (token + json state) | `HERMES_WEBUI_STATE_DIR` | `~/.hermes/webui` |
| Show all containers | `MC_DOCKER_SHOW_ALL=1` | off (allow-list) |
| Container allow-list | `MC_DOCKER_NAME_ALLOW` | `cybersec-toolkit,searxng,freqtrade` |
| Compose workdir filter | `MC_DOCKER_WORKDIR_PREFIX` | off |

Install `speedtest-cli` (optional), then the systemd user unit — it runs
`/usr/bin/python3 -S -u sidecar.py` with no token in the unit (core provisions it
in the state dir):

```bash
pip install speedtest-cli        # optional, for the speed test
cp sidecar/sysinfo-sidecar.service ~/.config/systemd/user/
systemctl --user enable --now sysinfo-sidecar
```

**Health:** `GET http://127.0.0.1:17796/health` returns
`{"ok": true, "sidecar_base_version": N}`. The WebUI diagnostics card probes this
cross-origin (credentials omitted); the token-bearing proxy path serves real
traffic.

**Docker limitation:** a bridge-networked WebUI container cannot reach a host-run
sidecar's `127.0.0.1:17796` (loopback is namespace-local). Sidecars work only
where core and the sidecar share a network namespace and the state dir.

## Install, disable, uninstall

- **Install**: copy into the WebUI's gallery extension dir
  (`$HERMES_WEBUI_STATE_DIR/extensions/`, default `~/.hermes/webui/extensions/`),
  enable in **Settings → Extensions**, start the sidecar, reload.
- **Disable**: toggle off in **Settings → Extensions** — the card stops being
  injected on the next render. No restart required.
- **Uninstall**: remove it in **Settings → Extensions** (or delete the
  directory). Server state (`speedtest_last.json`, `speedtest_auto.json`,
  `.docker_groups.json`, `.docker_updates.json`) remains under the state dir; delete those files to
  clear it. Browser keys (`mc.docker.expanded`, `mc.docker.group.*`,
  `mc.docker.updates`) are small view-state strings, clearable from DevTools.

## Trust and permissions

- Creates extension-owned DOM (one `insights-card` section after the native
  System-health panel).
- Talks to its loopback sidecar through the WebUI's consented proxy path, and
  also reads `/api/extensions/status` (to check its own sidecar consent). Docker
  reads and every host-mutating route go through that proxy; `docker/updates`
  (the update sweep) and the action/update/bulk routes are **writes** — they
  start work and persist results.
- Deny-by-default inventory: no container is shown until the operator opts in via
  `MC_DOCKER_NAME_ALLOW` (name prefixes), `MC_DOCKER_WORKDIR_PREFIX` (a compose
  workdir root), or `MC_DOCKER_SHOW_ALL=1`. Docker updates run
  `docker compose pull/up` **from each stack's host-derived compose working_dir**,
  so the sidecar reads that stack's compose files/`.env` and uses whatever
  registry/Docker credentials the daemon has — hence `filesystem.arbitrary:true`
  and `network_external:true`. Constrain the workdir with `MC_DOCKER_WORKDIR_PREFIX`.
- The sidecar shells out to `speedtest-cli` (which reaches external speed-test
  servers) and the `docker` CLI **on the host it runs on** — container
  start/stop/restart/update are real operations, the same trust level as running
  `docker` in a terminal. Compose project/service refs are validated (list-form
  argv, no `shell=True`, leading-hyphen rejected); container ids must be hex and
  belong to the filtered inventory.
- No cookies read; no external network access **from the browser** (the speed
  test + registry calls run server-side in the sidecar); no native host.

## Manual verification

1. Open **Insights** → the ⚡ Speed test and Docker rows appear directly under
   the native System health card.
2. Expand Speed test → Run test → bars animate, reading persists across a
   reload and on other devices; "Auto:" button schedules recurring runs.
3. Expand Docker → containers appear grouped by compose stack with live
   CPU/RAM; start/stop/restart a container and watch its dot change.
4. "⟳ Check updates" flags outdated images; updating a container pulls and
   recreates just that service and reports the new version.
5. Disable the extension in Settings → Extensions → reload: the card is gone,
   the native System health panel is untouched.

## Future CI checks

- `node --check assets/sysinfo.js`
- JSON validity of `extension.json` / `manifest.json`
- `python3 -m py_compile sidecar/*.py`
- Sidecar contract test: `GET /health` returns `{"ok": true}`;
  `GET /api/system/docker` returns `{docker:{available:...}}` without docker
  installed (graceful degradation).
