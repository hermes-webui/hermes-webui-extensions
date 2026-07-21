# Fun Audio Chat Connector

Full-duplex speech-to-speech (S2S) voice chatting extension for Hermes WebUI. Connects to a local [Fun-Audio-Chat](https://github.com/alibaba-damo-academy/FunAudioChat) server via WebSocket.

## How it works

1. **Floating mic button** appears in the bottom-right corner of Hermes WebUI
2. Click the mic to open the voice panel — shows connection status, VU meter, and controls
3. Enter FAC server host/port in Settings (default: `127.0.0.1:11236`)
4. Click **Talk** to start speaking — mic audio is captured as Opus in WebM and streamed to FAC
5. FAC processes the speech and streams back audio responses, which play in real-time
6. Click **Stop** to end your turn

## Protocol

Binary WebSocket protocol to `ws://{host}:{port}/chat`:

| Byte 0 (type) | Payload | Description |
|---|---|---|
| `0x00` | JSON handshake | `{"cmd":"hello","version":1}` |
| `0x01` | Opus audio (WebM) | Mic capture chunks |
| `0x02` | JSON text | Transcription results |
| `0x03` | JSON control | start/end_turn/stop |

## Files

| File | Purpose |
|---|---|
| `extension.json` | Full extension descriptor with permissions |
| `manifest.json` | Gallery bundle manifest |
| `assets/connector.js` | Injected JS — creates floating mic button + overlay |
| `assets/connector.css` | Styling for the panel |
| `assets/icon.svg` | Mic icon (Feather mic style) |

## Permissions

- `dom.owned: true` — owns its overlay DOM subtree
- `storage.owned` — persists host/port/mode settings
- `network_external: false` — connects only to a **loopback** FAC server. The host
  field is validated in-code (`localhost` / `127.0.0.0/8` / `::1` only); a non-loopback
  host is rejected and reset to `127.0.0.1`, so mic audio can never reach an external
  WebSocket. The FAC server is a separate local app you run yourself (see Usage) —
  this extension only talks to it over a direct browser→loopback WebSocket, with no
  bundled sidecar and no backend/proxy route.
- `microphone: true` — requires mic access (browser prompt)

## Usage

1. Start your FAC server: `python3 fun_audio_chat/server.py` (or similar)
2. Enable the extension in Hermes WebUI Settings → Extensions
3. Click the mic icon in the bottom-right corner
4. Adjust host/port in Settings if needed
5. Click **Talk** and speak
