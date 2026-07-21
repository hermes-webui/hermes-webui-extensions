# Docker & Tunnel Manager

View and manage Docker containers, images, and system resource usage directly inside Hermes WebUI. Start, stop, and restart containers. Prune unused Docker resources. Monitor Cloudflare tunnel status with health checks against every ingress backend.

## What it does

- **Containers** — list all containers with status, ports, uptime, CPU/memory usage. Start, stop, restart individual containers. Prune stopped containers.
- **Images** — list images with size, age, and how many containers reference them. Prune dangling images. View image history and layers.
- **Volumes** — list all volumes with name, driver, mountpoint, and creation date. Delete individual volumes or prune all unused volumes.
- **Compose** — project view showing services grouped by Compose project with per-service status, ports, and replica counts.
- **System** — Docker disk usage breakdown (images, containers, volumes, build cache) with total reclaimable space.
- **Logs** — live polling log viewer for any container, with auto-scroll, pause/resume, and line count controls.
- **Tunnel** — Cloudflare tunnel info (name, ID, connectors, uptime). Ingress route table with per-backend health status (green/red, response time). Tail tunnel logs.

## Architecture

```
WebUI Extension (IIFE)  ──fetch()──▶  Sidecar (port 17900)
                                          │
                                     ┌────┴────┐
                                  docker-py   cloudflared CLI
                                     │            │
                                  docker.sock   config.yml
```

The **sidecar** is an external Python HTTP server ([ChonSong/docker-tunnel-sidecar](https://github.com/ChonSong/docker-tunnel-sidecar)) that uses `docker-py` for Docker operations and `cloudflared` via subprocess for tunnel status. It binds only to `127.0.0.1:17900` and implements the `token-v1` sidecar contract — WebUI mints a per-extension token and injects it as `X-Hermes-Sidecar-Token` on every proxied request.

## Installation

### 1. Install the sidecar service

```bash
git clone https://github.com/ChonSong/docker-tunnel-sidecar.git ~/docker-tunnel-sidecar
cd ~/docker-tunnel-sidecar
pip3 install docker

# Install systemd user service
mkdir -p ~/.config/systemd/user
cp sidecar.service ~/.config/systemd/user/docker-tunnel-sidecar.service
systemctl --user daemon-reload
systemctl --user enable --now docker-tunnel-sidecar.service
```

### 2. Verify the sidecar is running

```bash
curl -s http://127.0.0.1:17900/health
# → {"ok":true}
```

### 3. Install the extension via WebUI

In Hermes WebUI, go to **Settings → Extensions** and install from the gallery. If the gallery hasn't been rebuilt, copy the files manually:

```bash
mkdir -p ~/.hermes/webui-dev/extensions/docker-tunnel-manager/assets
cp extensions/docker-tunnel-manager/manifest.json ~/.hermes/webui-dev/extensions/docker-tunnel-manager/
cp extensions/docker-tunnel-manager/extension.json ~/.hermes/webui-dev/extensions/docker-tunnel-manager/
cp extensions/docker-tunnel-manager/README.md ~/.hermes/webui-dev/extensions/docker-tunnel-manager/
cp extensions/docker-tunnel-manager/assets/* ~/.hermes/webui-dev/extensions/docker-tunnel-manager/assets/
```

Then restart the WebUI:

```bash
systemctl --user restart hermes-webui.service
```

### 4. Enable WebUI authentication (required for token-v1)

The `token-v1` sidecar contract is fail-closed until WebUI authentication is enabled. In WebUI, go to **Settings → Password** and set a password (or set `HERMES_WEBUI_PASSWORD`). Once enabled, WebUI provisions the per-extension token and the sidecar starts accepting requests.

## Usage

Click the **container icon** in the left rail to open the Docker & Tunnel Manager panel.

The panel has seven tabs:

| Tab | Content |
|-----|---------|
| **Containers** | Table of all containers. Green/yellow/red status dots. Port mappings. Start/stop/restart buttons per row. Bulk prune button. Log viewer per container. |
| **Images** | Table of images with size, created date, container usage count. Prune dangling images. History and layers explorer per image. |
| **Volumes** | Table of all volumes with name, driver, mountpoint, and age. Delete individual volumes. Prune all unused volumes. |
| **Compose** | Project view showing Compose stacks. Each project expands to show services with status, ports, and replica count. |
| **System** | Docker disk usage as bar charts. Shows reclaimable space per category. |
| **Logs** | Live polling log stream for a selected container. Auto-scroll toggle, pause/resume, configurable line count history. |
| **Tunnel** | Cloudflare tunnel status (connector count, uptime). Ingress route table where each row shows the hostname, backend port, and last health-check result (200/green, timeout/red). |

Destructive actions (prune, stop) show a confirmation dialog.

## Sidecar contract

This extension uses an **external token-v1** sidecar runtime. The sidecar:

- Binds to `127.0.0.1:17900` only (no network exposure)
- Validates `X-Hermes-Sidecar-Token` on every route except `GET/HEAD /health`
- Re-reads the token per request for live rotation
- Uses constant-time comparison (`hmac.compare_digest`)
- Returns 401 for missing/wrong token, 503 when the token file is unreadable
- `/health` is the only tokenless route (liveness only, `ACAO: *`, `Cache-Control: no-store`)
- Returns bounded log snapshots (no SSE/streaming — WebUI's proxy buffers and times out around 10s)
- Talks to the Docker socket (requires `docker` group membership)
- Reads the Cloudflare tunnel config at `~/.cloudflared/config.yml`

No data leaves the machine. The extension does not make external network requests.

## Requirements

- Docker Engine (with `docker` group membership for the running user)
- `cloudflared` CLI installed and configured
- Python 3.8+ with `docker-py` (`pip install docker`)
- Hermes WebUI with extension API support (manifest bundles + loopback sidecar)

## Compatibility

Tested with:
- Hermes WebUI (extension API: manifest-bundle + loopback-sidecar)
- Docker Engine 28.x
- cloudflared 2026.x

## Uninstall

```bash
systemctl --user stop docker-tunnel-sidecar.service
systemctl --user disable docker-tunnel-sidecar.service
rm ~/.config/systemd/user/docker-tunnel-sidecar.service
systemctl --user daemon-reload
```

Then remove the extension via WebUI Settings → Extensions, or delete the files:
```bash
rm -rf ~/.hermes/webui-dev/extensions/docker-tunnel-manager
```

## TODO / Future

- [x] Volume management
- [x] Container log viewer (live polling)
- [x] Compose project view (docker compose ps)
- [x] Image history and layers explorer
- [ ] Tunnel adapter interface for ngrok/localtunnel support
