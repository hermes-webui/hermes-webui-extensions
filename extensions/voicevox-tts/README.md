# VOICEVOX TTS

VOICEVOX TTS is a trusted local Hermes WebUI extension that adds **VOICEVOX** — a
free, locally-hosted Japanese text-to-speech engine — as a selectable TTS engine.
Once selected in **Settings → TTS Engine**, both the per-message **Listen** button
and hands-free **voice mode** synthesize speech through your local VOICEVOX
server.

## What It Does

- Registers a **VOICEVOX (local)** engine via the core TTS-engine registration
  capability (`window.registerHermesTtsEngine`), so it appears in the built-in
  Settings → TTS Engine dropdown alongside Browser / Edge / ElevenLabs.
- Synthesizes via the standard VOICEVOX two-step flow (`/audio_query` →
  `/synthesis`) and hands the WAV audio back to core, which plays it through the
  same `<audio>` lifecycle as the built-in Edge engine (including stop / re-listen
  in voice mode).
- The speaker id is configurable via `localStorage`
  (`hermes-ext-voicevox-speaker`, default 1); the user's saved rate nudges
  VOICEVOX's `speedScale`.
- **Configurable server URL** — override the VOICEVOX address via a **VOICEVOX
  Server URL** field injected into Settings → TTS Engine (shown only when VOICEVOX
  is the selected engine); stored in `localStorage` (`hermes-ext-voicevox-base`,
  default `http://127.0.0.1:50021`). Absolute URLs and same-origin relative paths
  (for a reverse proxy) are accepted.
- **Voice list** — when VOICEVOX is selected, the Voice dropdown is populated from
  the server's `GET /speakers` (speaker + style names), cached ~30s; changing the
  server URL refreshes it (debounced).

> Server-URL field, voice-list population, and the configurable base URL were
> contributed by **@luperrypf** (extensions PR #30), folded into this PR with
> thanks.

## Dependency

Requires the core **TTS-engine registration capability**
(`window.registerHermesTtsEngine`). On an older WebUI without it, the extension
**no-ops gracefully** (logs a warning; nothing breaks).

You also need a running **VOICEVOX** server (default `http://127.0.0.1:50021`).
VOICEVOX is a separate, free local application — see the VOICEVOX project. If the
server isn't running, synthesis fails gracefully (core shows a toast on the Listen
button / re-listens in voice mode).

## Current Shape

```text
Hermes WebUI page
  -> manifest-bundled extension assets
  -> /extensions/assets/voicevox-tts.js
  -> window.registerHermesTtsEngine({ id:'voicevox', synthesize })
  -> Settings -> TTS Engine -> "VOICEVOX (local)"
  -> synthesize(): POST 127.0.0.1:50021/audio_query -> POST /synthesis -> WAV
  -> localStorage: hermes-ext-voicevox-speaker (speaker id)
```

This extension is `static-ui` / manifest-bundle only. It does not add backend
routes, start a sidecar itself, use native host APIs, or make any **external**
network calls — it talks **only** to the loopback VOICEVOX server.

## Capabilities

- `manifest-bundle`

## Install For Local Testing

```bash
# start VOICEVOX (the local app) so 127.0.0.1:50021 is reachable, then:
cd /path/to/hermes-webui
HERMES_WEBUI_EXTENSION_DIR=/path/to/hermes-webui-extensions/extensions/voicevox-tts HERMES_WEBUI_EXTENSION_MANIFEST=manifest.json ./start.sh
```

Open Settings → TTS Engine, choose **VOICEVOX (local)**, then click **Listen** on
an assistant message (or use voice mode).

## Controls

Also on `window.HermesVoicevoxExtension`:

- `.getSpeaker()` / `.setSpeaker(n)` — VOICEVOX speaker id
- `.base` — the VOICEVOX server base URL (loopback)

## Disable And Uninstall

Switch the TTS Engine back to Browser/Edge/ElevenLabs, then restart Hermes WebUI
without `HERMES_WEBUI_EXTENSION_DIR` / `HERMES_WEBUI_EXTENSION_MANIFEST`, or remove
the `extensions/voicevox-tts/` directory.

## Trust And Permissions

This is trusted local code. Current disclosed behavior:

- calls `window.registerHermesTtsEngine(...)` once to add the VOICEVOX engine
- on synthesis, makes **loopback-only** requests (`/audio_query`, `/synthesis`,
  `/speakers`) with `credentials:'omit'` — no external network. The server address
  defaults to `http://127.0.0.1:50021` and is user-overridable, but the override is
  **strictly validated**: only an http(s) **loopback** host (`localhost`,
  `127.0.0.0/8`, `::1`) or a safe **root-relative same-origin proxy path** is
  accepted; any external/protocol-relative URL is rejected and falls back to the
  loopback default (`network_external: false`; `loopback_sidecar: true`)
- reads/writes `localStorage` under `hermes-ext-voicevox-speaker` (its own speaker
  id) and `hermes-ext-voicevox-base` (the server-URL override), and **reads** the
  shared core key `hermes-tts-voice` (the Settings voice selection)
- injects **one Settings field** ("VOICEVOX Server URL") next to the core TTS voice
  selector, and populates the core voice dropdown from `/speakers` — a scoped DOM
  mutation of the Settings panel only
- does NOT call WebUI HTTP APIs, access cookies (requests are `credentials:'omit'`),
  use the filesystem, or use native hosts

The loopback-validation policy preserves the no-SSRF design of the source PR even
with the configurable URL.

## Compatibility

- manifest-bundled extension assets + same-origin serving under `/extensions/`
- the core TTS-engine registration capability (`window.registerHermesTtsEngine`)
- a running VOICEVOX server at `127.0.0.1:50021` (loopback is already permitted by
  the default CSP `connect-src`)

## Verification

```bash
node scripts/validate-extensions.mjs
node scripts/scan-extension-safety.mjs
node scripts/generate-registry.mjs --out dist/registry.json
node --check extensions/voicevox-tts/assets/voicevox-tts.js
python3 -m json.tool extensions/voicevox-tts/extension.json
python3 -m json.tool extensions/voicevox-tts/manifest.json
```

Manual verification (with a running VOICEVOX server + the core capability):

- Settings → TTS Engine lists **VOICEVOX (local)**
- selecting it and clicking Listen on a message plays VOICEVOX audio
- voice mode reads replies through VOICEVOX
- with the server stopped, synthesis fails gracefully (toast / re-listen), no
  uncaught errors

## Known Limitations

- Requires the core TTS-engine registration capability and a running VOICEVOX
  server; no-ops / fails gracefully without either.
- VOICEVOX is Japanese-focused; quality on other languages varies.
- Single speaker id at a time (configurable via `HermesVoicevoxExtension.setSpeaker`).
