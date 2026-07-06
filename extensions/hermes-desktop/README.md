# Hermes Desktop v0.2.0 — Computer Use Integration

A full Linux desktop inside Hermes WebUI with **Computer Use** target selection.
Choose which display the agent drives — the **host Xvfb framebuffer** or a
**containerized XFCE desktop** — and watch it happen live via noVNC.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                        Browser (Hermes WebUI)                     │
│  ┌─────────────────────┐  ┌──────────────────────────────────┐   │
│  │      Chat Panel     │  │     Desktop Panel (Extension)     │   │
│  │                     │  │  ┌────────────────────────────┐   │   │
│  │  User <-> Agent     │  │  │  noVNC iframe              │   │   │
│  │                     │  │  │  (live desktop viewport)   │   │   │
│  │                     │  │  ├────────────────────────────┤   │   │
│  │                     │  │  │  Mini Transcript            │   │   │
│  │                     │  │  │  (renderTranscript hook)    │   │   │
│  │                     │  │  ├────────────────────────────┤   │   │
│  │                     │  │  │  Settings → Target Selector │   │   │
│  │                     │  │  │  ● Host (Xvfb :0)          │   │   │
│  │                     │  │  │  ○ Container (Xfce :1)     │   │   │
│  └─────────────────────┘  │  └────────────────────────────┘   │   │
│                           └──────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
         │                          │
         │Terminal / computer_use    │ HTTP iframe
         ▼                          ▼
┌──────────────────────────────────────────────────────────────────┐
│                        Host Machine                               │
│                                                                   │
│  ┌──────────────────────┐  ┌────────────────────────────────┐    │
│  │  cua-driver (Host)   │  │  Sidecar (Python) :17887        │    │
│  │  DISPLAY=:0          │  │  ┌──────────────────────────┐  │    │
│  │  Xvfb                │  │  │  /health                  │  │    │
│  │  640×480             │  │  │  /container/start         │  │    │
│  │  x11vnc :5901 → noVNC│  │  │  /container/stop         │  │    │
│  │  :6081                │  │  │  /cua/status             │  │    │
│  └──────────────────────┘  │  │  /cua/target              │  │    │
│                            │  └──────────────────────────┘  │    │
│  ┌──────────────────────┐  └────────────────────────────────┘    │
│  │  Docker Container    │                                         │
│  │  (hermes-desktop)    │                                         │
│  │  Xfce4 on DISPLAY=:1 │                                         │
│  │  TigerVNC :5900 →    │                                         │
│  │  noVNC :6901          │                                         │
│  │  Chromium, Blender,  │                                         │
│  │  LibreOffice, xdotool│                                         │
│  └──────────────────────┘                                         │
│                                                                   │
│  ┌──────────────────────┐                                         │
│  │  cua-driver (Cont.)  │                                         │
│  │  (inside container)  │                                         │
│  │  DISPLAY=:1          │                                         │
│  └──────────────────────┘                                         │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
```

### How the agent interacts

1. **You chat** in the main WebUI panel
2. **Agent uses `computer_use` tool** — dispatches to the selected target's
   cua-driver instance (host `:0` or container `:1`)
3. **Desktop updates appear live** in the noVNC iframe in the extension panel
4. **Agent transcript** renders alongside the desktop via `renderTranscript`
   hook (requires PR #5508 in WebUI core)
5. **You watch and steer** — the panel shows exactly what the agent sees

### Two targets

| Target | DISPLAY | Desktop | VNC | Use Case |
|--------|---------|---------|-----|----------|
| **Host (Xvfb :0)** | `:0` | Headless framebuffer | x11vnc → noVNC :6081 | Lightweight, no container overhead, fast screenshots |
| **Container (Xfce :1)** | `:1` | Full XFCE4 | TigerVNC → noVNC :6901 | Real desktop apps (browser, office, 3D), RustDesk client |

---

## Installation

### 1. Install the Extension

In Hermes WebUI, open **Settings → Extensions → Gallery** and install
**Hermes Desktop**.

For local development:

```bash
cd hermes-webui-extensions
HERMES_WEBUI_EXTENSION_DIR=extensions/hermes-desktop \
HERMES_WEBUI_EXTENSION_MANIFEST=manifest.json \
./start.sh
```

### 2. Clone the Companion Repo

```bash
git clone https://github.com/ChonSong/hermes-desktop
cd hermes-desktop
```

### 3. Build the Docker Container

```bash
docker compose -f docker/docker-compose.yml build
```

First build pulls `ubuntu:24.04`, installs XFCE4, TigerVNC, noVNC, and
desktop tools. Expect 1-2 minutes (~2.5 GB image).

### 4. Start the Sidecar

```bash
python3 sidecar/sidecar.py
```

The sidecar binds to `127.0.0.1:17887` and provides the management API
used by the extension.

### 5. Install cua-driver (for Computer Use)

```bash
hermes computer-use install
```

This installs the `cua-driver` binary and enables the `computer_use` tool
for the Hermes agent.

For **container target** support, also install inside the container:

```bash
docker exec hermes-desktop hermes computer-use install
```

### 6. Open the Desktop

Click the **🐧** button in the WebUI sidebar. The panel shows:
- Container status (start/stop)
- Target selector (Host vs Container)
- Live noVNC viewport of the active target
- Agent transcript (when open)
- Computer Use status per target

---

## Usage Flow

### Selecting a target

Open the panel → click **⚙** → choose **Host (Xvfb :0)** or **Container (Xfce :1)**.
The choice persists in localStorage.

When you switch targets:
- The noVNC iframe reloads to point at the new target's VNC port
- The agent's subsequent `computer_use` calls route to the corresponding
  cua-driver instance
- The status badge updates to show the active target

### Agent-driven desktop workflow

1. Open the desktop panel and ensure the target is running
2. Tell the agent: *"Open Chromium in the desktop and navigate to example.com"*
3. The agent calls `computer_use` to click the app menu, type the URL, etc.
4. Watch the desktop update live in the panel
5. The mini transcript shows the agent's reasoning in parallel

### Manual control via terminal

```bash
# Launch an app in the container
docker exec hermes-desktop xfce4-terminal &

# Type text
docker exec hermes-desktop xdotool type "Hello from Hermes"

# Click at coordinates
docker exec hermes-desktop xdotool mousemove 400 300 click 1

# Take a screenshot
docker exec hermes-desktop import -window root /tmp/screenshot.png

# Copy screenshot for vision analysis
docker cp hermes-desktop:/tmp/screenshot.png /tmp/screenshot.png
```

---

## Configuration Reference

### Extension Settings

| Setting | Key (localStorage) | Values | Default | Description |
|---------|-------------------|--------|---------|-------------|
| Target | `hermes-desktop:target` | `"host"` / `"container"` | `"container"` | Which display the agent drives |
| Transcript | `hermes-desktop:transcript` | `true` / `false` | `false` | Show agent transcript in panel |

### Sidecar API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Sidecar + container status |
| `/container/start` | POST | Start the desktop container |
| `/container/stop` | POST | Stop the desktop container |
| `/container/status` | GET | Container state detail |
| `/cua/status` | GET | cua-driver health for each target (`{"host": "...", "container": "..."}`) |
| `/cua/target` | GET | Current active target |
| `/cua/target` | POST | Set active target (body: `{"target": "host"}`) |

### WebUI Core APIs (PR #5508)

| API | Purpose |
|-----|---------|
| `window.registerHermesSessionOpenHandler(fn)` | Hook into session navigation (used for transcript refresh) |
| `window.renderTranscript(container, messages, opts)` | Render chat messages into any DOM container |

---

## Remote Access

The VNC iframe connects to `localhost` ports, which works when the browser
runs on the same machine as Hermes. For remote access:

| Method | How |
|--------|-----|
| **Cloudflare Tunnel** | Tunnel ports 6081 (host) and 6901 (container) alongside WebUI |
| **SSH forward** | `ssh -L 6081:localhost:6081 -L 6901:localhost:6901 your-host` |
| **RustDesk** | Connect to the host desktop directly (bypasses WebUI) |
| **Future** | `sidecar-proxy` capability routes VNC through the WebUI domain |

---

## Trust Model and Permissions

Hermes Desktop is **trusted local code**. Summary:

- Creates an **owned DOM panel** — does NOT mutate core WebUI views
- Opens an **iframe to `http://127.0.0.1:6080`** or `:6901` (VNC viewport)
- Fetches sidecar health/status via **`http://127.0.0.1:17887`**
- Does NOT read authenticated WebUI APIs
- Does NOT write to WebUI session/approval/clarify endpoints
- Stores extension-owned preferences in **localStorage** under `hermes-desktop:` prefix
- Does NOT access external networks
- Does NOT write to arbitrary filesystem paths

**The sidecar** manages Docker lifecycle and exposes cua-driver status.

**The `computer_use` tool** runs via `hermes computer-use install` — it drives
the desktop via accessibility (AT-SPI on Linux), not pixel scraping. See the
[computer-use skill](https://github.com/nousresearch/hermes-agent) for details.

---

## Dependencies

| Component | Required | Version |
|-----------|----------|---------|
| Docker | Yes | 24+ |
| Python | Yes | 3.10+ |
| cua-driver | For agent-driven control | Latest (`hermes computer-use install`) |
| x11vnc | For host target visualization | Any |
| noVNC | For host target (optional on container) | Included in container |
| Hermes WebUI | Yes | v0.10+ with manifest-bundle support |

---

## Known Limitations

- **Host target requires x11vnc + noVNC** — the extension expects noVNC on
  port 6081 for the host framebuffer. Set up manually:
  ```bash
  x11vnc -display :0 -forever -nopw -shared -rfbport 5901 &
  /usr/share/novnc/utils/novnc_proxy --vnc localhost:5901 --listen 6081 &
  ```
- **cua-driver in container** — installing cua-driver inside the Docker
  container requires the container to have `hermes` CLI available or the
  binary installed manually.
- **No clipboard sync** — bidirectional clipboard between browser and
  desktop is not implemented.
- **Audio not bridged** — PulseAudio bridge can be added as a follow-up.
- **Multi-session not supported** — one container, one desktop.

---

## Disable and Uninstall

**Disable** (keep installed, stop injecting):
1. Add `"hermes-desktop"` to `disabled_extensions` in `extension-overrides.json`
2. Restart WebUI

**Stop the desktop container:**
```bash
docker compose -f hermes-desktop/docker/docker-compose.yml down
```

**Uninstall:**
1. Stop the container as above
2. Remove the extension from `extension-install-manifest.json`
3. `rm -rf ~/.hermes/webui/extensions/hermes-desktop/`
4. `docker rmi hermes-desktop`
5. Restart WebUI

---

## Related

- **Companion repo** (Docker + sidecar): [ChonSong/hermes-desktop](https://github.com/ChonSong/hermes-desktop)
- **Computer Use skill**: [computer-use](https://github.com/nousresearch/hermes-agent/skills/computer-use)
- **WebUI core hooks** (PR #5508): `registerHermesSessionOpenHandler` + `renderTranscript`
- **Desktop Companion** (original sidecar pattern): `hermes-webui-extensions/desktop-companion`
- **Agent Zero** (inspiration): [agent0ai/agent-zero](https://github.com/agent0ai/agent-zero)

---

## Changelog

### v0.2.0 (2026-07-06)
- **Target selector**: Choose Host (Xvfb :0) or Container (Xfce :1)
- **Computer Use integration**: cua-driver status indicators per target
- **Mini transcript**: Agent messages rendered via `renderTranscript` hook
- **Settings panel**: Persistent configuration via local storage
- **Sidecar API**: `/cua/status` and `/cua/target` endpoints
- **Documentation**: Architecture diagram, usage flow, configuration reference

### v0.1.0 (2026-07-01)
- Initial release: containerized XFCE desktop with noVNC panel
