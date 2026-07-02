# Hermes Desktop

A full Linux desktop inside Hermes WebUI. Drive GUI applications (Blender,
LibreOffice, Chromium, terminals) from your browser. The Hermes agent and
you share the same desktop — the agent opens apps via `docker exec`, you
watch and interact through a VNC panel.

## What It Does

- Ships a Docker container running **XFCE4** with **TigerVNC**
- Includes pre-installed desktop apps: Chromium, LibreOffice, Blender,
  ImageMagick, xdotool, xclip
- The agent drives the desktop through `docker exec` — no new agent tools
  needed (just `terminal` + `vision_analyze`)
- The WebUI extension adds a **🐧 sidebar button** that opens a desktop panel
  with a live VNC viewport (noVNC via iframe)
- A **Python sidecar** manages container lifecycle (start/stop/health) and
  provides a stable localhost API

## Who It Is For

- Users who want to run desktop Linux apps from within their Hermes workflow
- Developers who want the agent to visually iterate on GUI tasks (open
  Blender, model an object, screenshot for feedback)
- Anyone evaluating whether Hermes can match "Agent Zero"-style desktop
  integration without a separate full-stack framework

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   Browser (Hermes WebUI)                 │
│  ┌─────────────────────┐  ┌───────────────────────────┐ │
│  │      Chat Panel     │  │    Desktop Panel (ext)    │ │
│  │                     │  │  ┌─────────────────────┐  │ │
│  │  Agent runs         │  │  │  iframe → noVNC     │  │ │
│  │  docker exec ...    │  │  │  (localhost:6080)   │  │ │
│  └─────────────────────┘  │  └─────────────────────┘  │ │
│                           └───────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
                    │                     │
                    │ docker exec         │ HTTP (iframe)
                    ▼                     ▼
┌─────────────────────────────────────────────────────────┐
│  Host                                                    │
│  ┌──────────────────┐  ┌──────────────────────────────┐ │
│  │ Sidecar (Python) │  │ Docker container              │ │
│  │ :17887           │  │ ┌──────────────────────────┐ │ │
│  │ • lifecycle API  │  │ │ XFCE4 + TigerVNC         │ │ │
│  │ • health check   │  │ │ noVNC on :6080           │ │ │
│  └──────────────────┘  │ │ VNC on :5900             │ │ │
│                         │ │ Chromium, Blender, etc   │ │ │
│                         │ └──────────────────────────┘ │ │
│                         └──────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

## Installation

### 1. Install the Extension

In Hermes WebUI, open **Settings → Extensions → Gallery** and install
**Hermes Desktop**. (Once the entry is merged into the curated library.)

For local testing before gallery install:

```bash
cd hermes-desktop/extensions/hermes-desktop
HERMES_WEBUI_EXTENSION_DIR=. \
HERMES_WEBUI_EXTENSION_MANIFEST=manifest.json \
./start.sh
```

### 2. Clone the Companion Repo

The Docker image and sidecar live in a companion repository:

```bash
git clone https://github.com/ChonSong/hermes-desktop
cd hermes-desktop
```

### 3. Build the Docker Container

```bash
docker compose -f docker/docker-compose.yml build
```

First build pulls `ubuntu:24.04`, installs XFCE4, TigerVNC, noVNC, and
desktop tools. Expect 1-2 minutes (image size ~2.5 GB).

### 4. Start the Sidecar

```bash
python3 sidecar/sidecar.py
```

The sidecar binds to `127.0.0.1:17887`. It manages the container lifecycle
via `docker compose` and provides:

| Endpoint | Method | Purpose |
|---|---|---|
| `/health` | GET | Sidecar + container status |
| `/container/start` | POST | Start the desktop container |
| `/container/stop` | POST | Stop the desktop container |
| `/container/status` | GET | Container state detail |

### 5. Open the Desktop

Click the **🐧** button in the WebUI sidebar. If the sidecar is running and
the container is started, the panel shows a live VNC viewport of the XFCE
desktop.

## Agent-Driven Desktop Control

Once the container is running, the agent can control the desktop through
Hermes' existing `terminal` tool:

```bash
# Launch an app
docker exec hermes-desktop xfce4-terminal &
# Click at coordinates
docker exec hermes-desktop xdotool mousemove 400 300 click 1
# Type text
docker exec hermes-desktop xdotool type "Hello from Hermes"
# Take a screenshot
docker exec hermes-desktop import -window root /tmp/screenshot.png
# Copy screenshot back for vision analysis
docker cp hermes-desktop:/tmp/screenshot.png /tmp/screenshot.png
# The agent then runs vision_analyze(image_url="/tmp/screenshot.png")
```

No new Hermes tools are needed. The `terminal` + `vision_analyze` loop is
the same pattern the agent already uses for browser automation.

## Remote Access

The VNC iframe loads from `localhost:6080`, which works when the browser
runs on the same machine as Hermes. For remote access:

1. **Cloudflare Tunnel** — tunnel port 6080 alongside the WebUI tunnel
2. **SSH port forward** — `ssh -L 6080:localhost:6080 your-host`
3. **RustDesk** — connect to the host desktop directly (bypasses the
   WebUI panel but gives full desktop access)
4. **Future** — a `sidecar-proxy` capability (planned for WebUI core)
   would route VNC through the WebUI domain, making remote access
   work automatically

## Disable and Uninstall

**Disable** (keep installed, stop injecting):
1. Add `"hermes-desktop"` to `disabled_extensions` in
   `~/.hermes/webui/extension-overrides.json`
2. Restart WebUI: `systemctl --user restart hermes-webui.service`

**Stop the desktop container:**
```bash
docker compose -f hermes-desktop/docker/docker-compose.yml down
```

**Uninstall** (fully remove):
1. Stop the container as above
2. Remove the extension from `extension-install-manifest.json`
3. Delete the extension directory:
   `rm -rf ~/.hermes/webui/extensions/hermes-desktop/`
4. Remove the Docker image: `docker rmi hermes-desktop`
5. Restart WebUI

## Trust Model and Permissions

Hermes Desktop is **trusted local code**. The injected adapter runs in the
Hermes WebUI browser origin and can use the logged-in browser session.

**Current behavior:**
- Creates an owned DOM panel (does NOT mutate core WebUI views)
- Opens an iframe to `http://127.0.0.1:6080` (the container's noVNC page)
- Fetches sidecar health/status via `http://127.0.0.1:17887`
- Does NOT read authenticated WebUI APIs
- Does NOT write to WebUI session/approval/clarify endpoints
- Does NOT navigate WebUI sessions
- Stores extension-owned preferences in localStorage under its own prefix
- Does NOT access external networks
- Does NOT write to arbitrary filesystem paths

**The sidecar** (separate process, user-launched):
- Starts/stops a Docker container via `docker compose`
- Provides HTTP health + status responses on `127.0.0.1:17887`
- Does NOT proxy authenticated WebUI calls
- Does NOT serve WebSocket/VNC — noVNC runs inside the container

**The Docker container:**
- Binds VNC port 5900 to `127.0.0.1:5900` (host-only)
- Binds noVNC port 6080 to `127.0.0.1:6080` (host-only)
- Not reachable from the network — loopback only

## Known Limitations

- **Remote access requires manual port tunneling** — the VNC iframe
  connects to localhost, which only works for local browsers. This is
  the same constraint as Agent Zero's noVNC integration. Future
  `sidecar-proxy` support in WebUI core would solve this.

- **First container build is slow** — pulling Ubuntu 24.04 + installing
  XFCE4 + Tools takes ~2 minutes on first build. Subsequent starts
  are near-instant.

- **Image size** — the built image is approximately 2.5 GB.

- **Audio forwarding** — not included in v0.1. The desktop has no
  audio output path to the browser. PulseAudio bridge can be added
  in a future version.

- **Clipboard sync** — noVNC provides basic clipboard but bidirectional
  sync with Hermes' clipboard is not implemented.

- **No multi-user / multi-session** — one container, one desktop.
  Multiple concurrent users would need separate container instances.

## Compatibility

- **Hermes WebUI:** tested against WebUI with `manifest-bundle` and
  `loopback-sidecar` capabilities
- **Browser:** any browser that renders iframes and allows loopback
  CSP (`http://127.0.0.1:*`)
- **Host OS:** Linux with Docker 24+ and Python 3.10+
- **Agent model:** any model that can use `terminal` + `vision_analyze`
  tools (all Hermes models)

## Verification

After installation, verify each layer:

```bash
# 1. Sidecar health
curl http://127.0.0.1:17887/health
# → {"ok":true,"container":"stopped","message":"sidecar running"}

# 2. Start container
curl -X POST http://127.0.0.1:17887/container/start
# → {"status":"started"}

# 3. Container health
curl http://127.0.0.1:17887/health
# → {"ok":true,"container":"running","message":"sidecar running"}

# 4. noVNC accessible
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:6080/health
# → 200

# 5. Desktop running
docker exec hermes-desktop xdotool getdisplaygeometry
# → 1280 720
```

In the WebUI:
- The 🐧 button appears in the sidebar (or as a floating button if no sidebar nav found)
- Clicking it opens the panel
- Status shows "Desktop running" with a live VNC viewport
- Clicking "Stop Desktop" shuts down the container cleanly

## Related

- **Companion repo** (Docker + sidecar):
  [ChonSong/hermes-desktop](https://github.com/ChonSong/hermes-desktop)
- **Agent Zero** (inspiration):
  [agent0ai/agent-zero](https://github.com/agent0ai/agent-zero)
- **Desktop Companion** (sidecar extension pattern):
  [hermes-webui-extensions/desktop-companion](https://github.com/hermes-webui/hermes-webui-extensions/tree/main/extensions/desktop-companion)
