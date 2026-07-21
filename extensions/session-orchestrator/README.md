# Session Orchestrator

Voice-commanded multi-session orchestration for Hermes WebUI — create, switch,
prompt, and monitor concurrent agent sessions hands-free via speech commands or
text shortcuts.

## What It Does

- **Voice commands** — say "new session dev", "switch session dev", "start
  prompt", "stop prompt", "read session dev", "maximise session" via the
  existing voice mode microphone.
- **Session alias registry** — assign friendly names to sessions (`dev`,
  `staging`, `research`) instead of tracking hex IDs.
- **Asynchronous completion notifications** — when a background session finishes
  processing, hear "Response ready in session dev" via TTS, plus an optional
  browser notification + chime.
- **Input buffer** — "start prompt" opens a recording buffer; subsequent speech
  accumulates until "stop prompt" flushes it to the agent. Or auto-flush on
  silence.
- **Tile integration** — works with the [chat-tiling](../chat-tiling/) extension:
  aliases show as color-coded badges on sidebar sessions, and `maximise session`
  expands the tile.

## How It Works

```text
Voice input (mic) → SpeechRecognition → Command Parser
  ├─ Matches command → execCommand → create/switch/read/maximize
  └─ No match + buffer open → append to input buffer
  └─ No match + buffer closed → normal send via existing _voiceModeSend

Session completion → SessionChannel SSE → _handleBgTaskCompleteEvent
  → chime + browser notification + TTS: "Response ready in session [alias]"
```

The orchestrator **wraps** existing voice mode (`_voiceModeSend` hijack) and
**intercepts** the existing background-task-complete handler — no new backend
routes needed.

## Voice Commands

| Say | Action |
|-----|--------|
| "new session dev" | Creates a new WebUI session, registers alias "dev" |
| "switch session dev" | Loads the "dev" session |
| "start prompt" | Opens the input buffer for the active session |
| "stop prompt" | Closes the buffer and sends to the agent |
| "read session dev" | Speaks the latest response from "dev" via TTS |
| "maximise session" | Expands the active tile to full grid |
| "close session dev" | Closes the tile and removes the alias |
| "list sessions" | Lists all tracked aliases |
| "help" | Speaks available commands |

## Keyboard Shortcut

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+O` | Toggle orchestrator on/off |
| `Escape` (while recording) | Cancel input buffer |

## Text Commands

When orchestrator is active, type any command into the composer and send it
normally — the command parser intercepts at `_voiceModeSend`. Commands work in
both voice and text.

## Settings

- **Play chime on session completion** — plays via existing `playAttentionSound()`.
- **Speak completion alerts via TTS** — speaks "Response ready in session [alias]".
- **Silence threshold** — milliseconds of silence before auto-flushing the input buffer.

## Capabilities

- `manifest-bundle`

## Install For Local Testing

```bash
cd /path/to/hermes-webui
HERMES_WEBUI_EXTENSION_DIR=/path/to/hermes-webui-extensions/extensions/session-orchestrator \
HERMES_WEBUI_EXTENSION_MANIFEST=manifest.json \
./start.sh
```

Or register in your dev state dir's `extension-install-manifest.json` and restart
the WebUI service.

## Controls

| API | Description |
|-----|-------------|
| `window.Orchestrator.enabled()` | Boolean — is orchestrator active? |
| `window.Orchestrator.aliases()` | Copy of the alias → session map |
| `window.Orchestrator.activeAlias()` | Currently-focused alias name |
| `window.Orchestrator.bufferOpen()` | Boolean — is buffer recording? |
| `window.Orchestrator.toggle()` | Toggle orchestrator on/off |
| `window.Orchestrator.execCommand({action, args})` | Execute a parsed command |
| `window.Orchestrator.parseCommand(text)` | Parse text into a command object |
| `window.Orchestrator.registerAlias(name, sessionData)` | Manually register an alias |
| `window.Orchestrator.unregisterAlias(name)` | Remove an alias |

## Disable And Uninstall

Disable via Settings → Extensions → Session Orchestrator toggle. Or remove the
`extensions/session-orchestrator/` directory and restart.

Aliases persist in `localStorage` under the `hwx-orch-state` key. Clear it if
you want a clean slate.

## Trust And Permissions

This is trusted local code. Current disclosed behavior:

- reads/writes `localStorage` under key `hwx-orch-state` (alias registry)
- intercepts `window._voiceModeSend` to parse commands from speech (restored on
  disable)
- intercepts `window._handleBgTaskCompleteEvent` for completion notifications
  (restored on disable)
- calls `window.newSession()`, `window.loadSession()`, `window.send()`,
  `window.api()` — existing WebUI globals
- sets a 500ms `setInterval` watching `S.busy` transitions as completion
  fallback
- uses `window.speechSynthesis.speak()` for command feedback
- does NOT access external networks, filesystem, native hosts, or sidecar
  processes

## Compatibility

- Requires a browser with `SpeechRecognition` + `speechSynthesis` (Chrome/Edge/
  Brave). Falls back to text-only mode on Firefox/Safari without STT.
- Tested against hermes-webui v0.51.845+
- Optional integration with [chat-tiling](../chat-tiling/) extension (badges on
  sidebar rows, tile maximize)

## Known Limitations

- **Phase 1 only** — orchestrator manages aliases and voice commands but does
  not provision containerized desktop environments (that's Phase 2, tracked in
  the [hermes-desktop](../hermes-desktop/) extension as a per-session container
  pattern).
- **Single active buffer** — only one session can have its input buffer open
  at a time.
- **Alias collision** — if you say "new session dev" twice, the second
  overwrites the first silently (deliberate: voice-first shouldn't require
  confirmation dialogs).
- Depends on `window._voiceModeSend` being the current send function. If voice
  mode is not active, commands entered as text in the composer still work
  through the same interception point.

## Verification

```bash
node scripts/validate-extensions.mjs
node scripts/scan-extension-safety.mjs
node --check extensions/session-orchestrator/assets/orchestrator.js
python3 -m json.tool extensions/session-orchestrator/extension.json
python3 -m json.tool extensions/session-orchestrator/manifest.json
```

Manual verification:

1. Enable voice mode (Settings → Preferences → Hands-free voice mode button)
2. Say "new session dev" → hear "Session dev initialized."
3. Say "list sessions" → hear "Tracked sessions: dev"
4. Say "start prompt" → hear "Recording." Buffer indicator appears.
5. Speak a prompt → silence → auto-sends to "dev" session
6. Switch to a different tab — when response completes, hear notification
7. Say "read session dev" → hear the latest assistant response
8. Toggle orchestrator with `Ctrl+Shift+O` → hear disabled confirmation
