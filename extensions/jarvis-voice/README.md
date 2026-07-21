# Jarvis Voice

Jarvis Voice is a trusted local Hermes WebUI extension that adds a small voice
button powered by **Gemini Live**. Gemini handles realtime speech and calls one
browser tool, `run_hermes`, whenever a request needs action. Hermes remains the
authority for tools, credentials, approvals, and dangerous writes.

## What It Does

- Adds a floating **J** button.
- Streams microphone PCM to Gemini Live and plays Gemini's native audio.
- Exposes exactly one Gemini tool: `run_hermes(task)`.
- Sends action tasks through the existing Hermes composer/send flow.
- Refuses to replace a draft or pending attachment and correlates the final reply
  to the originating session.

## Setup

Jarvis requires a WebUI build containing core sidecar token-v1 support (#6331).
WebUI authentication must be enabled under **Settings → Password**. Then approve
Jarvis Voice under **Settings → Extensions** so the core can provision the
per-extension proxy token.

Install the extension. Export the key in your shell, then keep it out of the
unit by placing it in the user manager environment with mode `0600`:

```bash
export GEMINI_API_KEY=your_key_here
install -d -m 700 ~/.config/environment.d
(umask 077; printf 'GEMINI_API_KEY=%s\n' "$GEMINI_API_KEY" > ~/.config/environment.d/jarvis-voice.conf)
systemctl --user import-environment GEMINI_API_KEY
```

Then install and start the sidecar service:

```bash
mkdir -p ~/.config/systemd/user
cp extensions/jarvis-voice/sidecar/jarvis-voice-sidecar.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now jarvis-voice-sidecar
```

The service runs only the reviewed standard-library sidecar:

```text
/usr/bin/python3 -S -u sidecar.py
```

Allow Gemini Live WebSocket connections in WebUI CSP before starting WebUI:

```bash
export HERMES_WEBUI_CSP_CONNECT_EXTRA="wss://generativelanguage.googleapis.com"
```

## Request Flow

```text
Hermes WebUI page
  -> POST /api/extensions/jarvis-voice/sidecar/api/token
  -> authenticated WebUI proxy injects X-Hermes-Sidecar-Token
  -> 127.0.0.1:18787/api/token
  -> Gemini ephemeral token API
  -> Gemini Live WebSocket
  -> Gemini tool call: run_hermes({ task })
  -> current WebUI composer + send()
  -> Hermes Agent tools/actions
  -> final reply returned to Gemini
```

The browser never calls the loopback sidecar directly. `/health` is liveness-only;
every other route requires the core-injected proxy token. This protects callers
that cannot read the user's WebUI state directory, not arbitrary same-UID code.
Sidecars are unsupported when WebUI runs in a bridge-networked Docker container
separate from the host sidecar because their loopback namespaces differ.

## Controls

Also on `window.HermesJarvisVoice`:

- `.connect()`
- `.disconnect()`
- `.startMic()` / `.stopMic()`
- `.runHermes(task)`

## Disable And Uninstall

Disable or uninstall Jarvis Voice in **Settings → Extensions**, then stop and
disable `jarvis-voice-sidecar` to remove Gemini access.

## Compatibility

Requires manifest-bundled assets, native extension settings, browser
`AudioContext`/`AudioWorklet`/`getUserMedia`/`WebSocket`, the existing Hermes
`S`, `send`, `#msg`, and optional `autoResize` surfaces, and a WebUI build with
sidecar token-v1 support.

## Verification

```bash
node scripts/sync-sidecar-base.mjs --check
node scripts/check-sidecar-usage.mjs
node scripts/test-sidecar-contract.mjs
python3 scripts/test-sidecar-scaffold.py
node scripts/validate-extensions.mjs
node scripts/scan-extension-safety.mjs
node scripts/test-jarvis-voice.mjs
python3 extensions/jarvis-voice/sidecar/test_routes.py
node --check extensions/jarvis-voice/assets/jarvis-voice.js
```

## Known Limitations

- No wake word. Click **Talk**.
- No screen/video input.
- Gemini receives no direct Hermes tool access. `run_hermes` is the boundary.
- Tool timeout defaults to 180 seconds.
