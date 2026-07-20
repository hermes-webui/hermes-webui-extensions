# Jarvis Voice

Jarvis Voice is a trusted local Hermes WebUI extension that adds a small voice
button powered by **Gemini Live**. Gemini handles realtime speech and calls one
browser tool, `run_hermes`, whenever the request needs real action. `run_hermes`
sends the task through the current Hermes WebUI session, waits for the final
assistant reply, and returns that result to Gemini to speak back.

## What It Does

- Adds a floating **J** button.
- Connects directly from the browser to Gemini Live over WebSocket using an
  ephemeral token minted by a local loopback sidecar.
- Streams microphone PCM audio to Gemini Live.
- Plays Gemini's native audio response.
- Exposes exactly one Gemini tool: `run_hermes(task)`.
- Uses the existing Hermes composer/send flow for actions, so Hermes keeps its
  configured tools, credentials, approvals, and safety behavior.

## Setup

Install the WebUI extension from the gallery or load it locally. Then start the
local token sidecar:

```bash
cd extensions/jarvis-voice
python3 -m venv .venv
. .venv/bin/activate
pip install google-genai
GEMINI_API_KEY=your_key_here JARVIS_ALLOWED_ORIGINS=http://127.0.0.1:8080 python scripts/jarvis-token-sidecar.py
```

`JARVIS_ALLOWED_ORIGINS` is a comma-separated allowlist for the exact WebUI origin. Set it explicitly, including scheme and port, for both loopback and exposed WebUI origins.

Allow Gemini Live WebSocket connections in WebUI CSP before starting WebUI:

```bash
export HERMES_WEBUI_CSP_CONNECT_EXTRA="wss://generativelanguage.googleapis.com"
```

Loopback token calls use `http://127.0.0.1:18787`, which WebUI already allows in
`connect-src`.

## Current Shape

```text
Hermes WebUI page
  -> /extensions/jarvis-voice/assets/jarvis-voice.js + .css
  -> POST http://127.0.0.1:18787/api/token
  -> wss://generativelanguage.googleapis.com/...BidiGenerateContentConstrained
  -> Gemini tool call: run_hermes({ task })
  -> current WebUI composer + send()
  -> Hermes Agent tools/actions
  -> final reply returned to Gemini
```

## Controls

Also on `window.HermesJarvisVoice`:

- `.connect()`
- `.disconnect()`
- `.startMic()` / `.stopMic()`
- `.runHermes(task)`

## Disable And Uninstall

Disable or uninstall the extension in **Settings → Extensions**, or restart
WebUI without its manual extension manifest. Stop the token sidecar process to
remove Gemini access.

## Trust And Permissions

This is trusted local code. Current disclosed behavior:

- creates extension-owned DOM: floating button, small panel, status/log rows
- asks for microphone permission and streams audio to Gemini Live
- connects to the external Gemini Live WebSocket
- calls a loopback token sidecar at `http://127.0.0.1:18787`
- writes no secrets and never sees the Gemini API key; the sidecar holds it
- uses native browser audio playback for Gemini PCM output
- invokes the existing Hermes WebUI composer and `send()` function when Gemini
  calls `run_hermes`
- refuses to replace an unsent composer draft or pending attachments
- polls the originating `/api/session` by id, so switching conversations does
  not feed unrelated replies back to Gemini
- does not expose Gmail, Calendar, filesystem, or other credentials directly to
  Gemini; those stay inside Hermes Agent tools
- does not call `/api/mcp/call` directly and does not bypass WebUI approvals

If Hermes is already running a task, `run_hermes` refuses to queue or steer
silently and tells Gemini to ask the user what to do.

## Compatibility

Requires:

- manifest-bundled extension assets + same-origin serving under `/extensions/`
- native Settings → Extensions `settings_schema`
- browser `AudioContext`, `AudioWorklet`, `getUserMedia`, and `WebSocket`
- WebUI globals used by existing extensions: `S`, `send`, the `#msg` composer,
  and optional `autoResize`
- `HERMES_WEBUI_CSP_CONNECT_EXTRA` permitting Gemini Live's `wss://` origin
- a local token sidecar with `POST /api/token` and `GET /health`

## Verification

```bash
node scripts/validate-extensions.mjs
node scripts/scan-extension-safety.mjs
node scripts/generate-registry.mjs --out dist/registry.json
node scripts/test-jarvis-voice.mjs
python3 extensions/jarvis-voice/scripts/test-jarvis-token-sidecar.py
node --check extensions/jarvis-voice/assets/jarvis-voice.js
python3 -m py_compile extensions/jarvis-voice/scripts/jarvis-token-sidecar.py
python3 -m json.tool extensions/jarvis-voice/extension.json
python3 -m json.tool extensions/jarvis-voice/manifest.json
```

Manual verification with a real Gemini key:

- start sidecar with `GEMINI_API_KEY`
- start WebUI with CSP connect extra
- open Jarvis panel, click **Talk**, grant microphone access
- say a casual prompt and hear Gemini answer
- say an action prompt like "ask Hermes to check my calendar tomorrow"
- confirm Hermes receives the task in the current session and Jarvis speaks back
  the final Hermes reply

## Known Limitations

- No wake word. Click **Talk**.
- No screen/video input.
- No direct Gemini access to individual Hermes tools; one `run_hermes` bridge is
  the safety boundary.
- Tool timeout defaults to 180 seconds.
