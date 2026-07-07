# Docker & Tunnel Manager

View and manage Docker containers, images, and system resource usage directly inside Hermes WebUI. Start, stop, and restart containers. Prune unused Docker resources. Monitor Cloudflare tunnel status with health checks against every ingress backend.

## What it does

- **Containers** — list all containers with status, ports, uptime, CPU/memory usage. Start, stop, restart individual containers. Prune stopped containers.
- **Images** — list images with size, age, and how many containers reference them. Prune dangling images.
- **System** — Docker disk usage breakdown (images, containers, volumes, build cache) with total reclaimable space.
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

The **sidecar** is a single-file Python HTTP server (`sidecar/docker-tunnel-sidecar.py`) that uses `docker-py` for Docker operations and `cloudflared` via subprocess for tunnel status. It binds only to `127.0.0.1:17900` and carries CORS headers so the WebUI extension can reach it.

## Installation

### 1. Install the sidecar service

```bash
# Copy the sidecar
mkdir -p ~/repos/hermes-webui-extensions/extensions/docker-tunnel-manager

# Install systemd user service
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/docker-tunnel-sidecar.service << 'SERVICE'
[Unit]
Description=Docker & Tunnel Manager sidecar
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=python3 /home/sc/workspace/hermes-webui-extensions/extensions/docker-tunnel-manager/sidecar/docker-tunnel-sidecar.py
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
SERVICE

systemctl --user daemon-reload
systemctl --user enable --now docker-tunnel-sidecar.service
```

### 2. Verify the sidecar is running

```bash
curl -s http://127.0.0.1:17900/api/health
# → {"status":"ok"}
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

## Usage

Click the **container icon** in the left rail to open the Docker & Tunnel Manager panel.

The panel has four tabs:

| Tab | Content |
|-----|---------|
| **Containers** | Table of all containers. Green/yellow/red status dots. Port mappings. Start/stop/restart buttons per row. Bulk prune button. |
| **Images** | Table of images with size, created date, container usage count. Prune dangling images. |
| **System** | Docker disk usage as bar charts. Shows reclaimable space per category. |
| **Tunnel** | Cloudflare tunnel status (connector count, uptime). Ingress route table where each row shows the hostname, backend port, and last health-check result (200/green, timeout/red). |

Destructive actions (prune, stop) show a confirmation dialog.

## Sidecar API

| Endpoint | Description |
|----------|-------------|
| `GET /api/health` | Sidecar is alive |
| `GET /api/containers` | List all containers |
| `POST /api/containers/<id>/start` | Start a container |
| `POST /api/containers/<id>/stop` | Stop a container |
| `POST /api/containers/<id>/restart` | Restart a container |
| `POST /api/containers/prune` | Prune stopped containers |
| `GET /api/images` | List all images |
| `POST /api/images/prune` | Prune dangling images |
| `GET /api/system/df` | Docker disk usage |
| `POST /api/system/prune` | Full system prune |
| `GET /api/tunnels` | Cloudflare tunnel info + ingress |
| `GET /api/tunnels/health` | Ping all ingress backends |
| `GET /api/tunnels/logs?lines=N` | Tail tunnel service logs |

## Trust model

The extension runs **trusted local code** in the WebUI origin. The sidecar:
- Binds to `127.0.0.1` only (no network exposure)
- Talks to the Docker socket (requires `docker` group membership)
- Reads the Cloudflare tunnel config at `~/.cloudflared/config.yml`
- Executes `cloudflared` CLI and `journalctl` for tunnel logs

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

- [ ] Tunnel adapter interface for ngrok/localtunnel support
- [ ] Container log streaming (tail -f in panel)
- [ ] Compose project view (docker compose ps)
- [ ] Image history and layers explorer
- [ ] Volume management
