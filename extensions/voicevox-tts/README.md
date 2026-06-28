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
- on synthesis, makes **loopback-only** requests to `http://127.0.0.1:50021`
  (`/audio_query`, `/synthesis`) — no external network
  (`network_external: false`; `loopback_sidecar: true`)
- reads/writes `localStorage` under the single key
  `hermes-ext-voicevox-speaker`
- creates **no DOM**
- does NOT call WebUI HTTP APIs, access cookies, use the filesystem, or use native
  hosts

The loopback-only address (hardcoded `127.0.0.1`) mirrors the no-SSRF design of
the source PR.

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
