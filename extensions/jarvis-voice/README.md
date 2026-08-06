# Jarvis Voice

Jarvis Voice is a trusted local Hermes WebUI extension that adds a small voice
button powered by **Gemini Live**. Gemini handles realtime speech and calls one
browser tool, `run_hermes`, whenever a request needs action. Hermes remains the
authority for tools, credentials, approvals, and dangerous writes.

## What Google Receives

While Jarvis is connected, the following leaves your machine for Google's Gemini
Live service:

- **Your microphone audio**, streamed continuously as 16 kHz PCM for as long as
  **Talk** is active — not only when you are addressing Jarvis.
- **Speech-to-text transcripts** of both sides of the conversation (Jarvis
  enables input and output transcription).
- **The task text** Gemini composes for `run_hermes`, which is derived from what
  you said.
- **Hermes's final reply text** for each `run_hermes` call, truncated to 8,000
  characters, returned to Gemini so it can speak the answer.

Gemini gets no direct access to Hermes tools, files, or credentials; `run_hermes`
is the only boundary crossing. But the content above does reach a third party, so
do not use Jarvis in a session whose transcript must stay local. Click **Stop** or
**Disconnect** to end the audio stream.

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

Install the extension. Put the Gemini key in the sidecar's own key file — do
**not** import it into the systemd user manager, where every subsequently
started user service would inherit it:

```bash
install -d -m 700 ~/.config/jarvis-voice
(umask 077; printf '%s\n' 'your_key_here' > ~/.config/jarvis-voice/api_key)
```

The sidecar reads `~/.config/jarvis-voice/api_key` and refuses to start a
token request if the file is group- or world-accessible; keep it mode `0600`.
(For manual, non-systemd runs, `GEMINI_API_KEY` in the launching shell still
works as a fallback when no key file exists.)

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

If your WebUI uses a non-default profile or state directory, the sidecar must
look for the core-provisioned proxy token in the same place — and it must
also start from where the extension actually lives, because the shipped
unit's `WorkingDirectory=` points at the default
`~/.hermes/webui/extensions/jarvis-voice/sidecar` and Python fails before the
sidecar starts if that path does not exist. Add a local drop-in
(`systemctl --user edit jarvis-voice-sidecar`) overriding both:

```ini
[Service]
Environment=HERMES_WEBUI_STATE_DIR=/path/to/that/state/dir
WorkingDirectory=/path/to/that/state/dir/extensions/jarvis-voice/sidecar
```

If you have additionally relocated extensions with
`HERMES_WEBUI_EXTENSION_DIR`, point `WorkingDirectory=` at
`jarvis-voice/sidecar` under that directory instead. Then
`systemctl --user daemon-reload && systemctl --user restart
jarvis-voice-sidecar`. A drop-in on your machine does not modify the shipped
unit file.

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
- `.stopPlayback()` — silences the rest of the current spoken turn
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
- Sessions do not survive Gemini's connection lifetime. The Live API closes
  each WebSocket after roughly ten minutes (it announces this with a `goAway`
  message), and Jarvis configures no session resumption — when the provider
  closes the connection, the session ends and you must click **Connect**
  again. Conversation context does not carry over.
