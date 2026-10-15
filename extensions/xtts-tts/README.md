# XTTS v2 (local studio voice)

Adds a **text-to-speech engine** to Hermes WebUI that synthesizes speech through
a local [XTTS v2](https://github.com/coqui-ai/TTS) HTTP daemon. Instead of a
browser/system voice, replies are spoken in the daemon's studio voice — the same
voice a self-hosted Hermes Agent uses for its own spoken replies.

It uses the core TTS-engine extension seam
(`window.registerHermesTtsEngine`, documented in the main WebUI repo under
*Extensions → Registering a custom TTS engine*), so it needs **no changes to
WebUI core**: the engine simply appears in **Settings → TTS Engine** alongside
Browser / Edge / ElevenLabs / OpenAI and drives both the per-message **Listen**
button and **voice mode**.

## What It Does

- Registers an engine `xtts` that POSTs the reply text to a local XTTS v2 daemon
  on loopback and returns the WAV the daemon produces.
- Lets the daemon own **language** (Cyrillic → `ru`, otherwise `en`) and
  **speaker**; the long-text split and WAV concatenation happen inside the
  daemon, so the whole reply text is sent in one request.
- Degrades safely: a non-WAV or error body is turned into a rejected promise
  (core then toasts on the Listen button / re-listens in voice mode) instead of
  playing silence.

## Who It Is For

Self-hosted Hermes WebUI users who already run a local XTTS v2 speech daemon and
want the WebUI to sound like their agent, in their own voice — without a cloud
TTS provider and without touching the WebUI source tree.

## Engine contract

Core provides `window.registerHermesTtsEngine({ id, label, synthesize })`:

- `id` — `xtts` ([a-z0-9_-], must not shadow a built-in engine).
- `label` — `XTTS v2 (local studio voice)` (rendered via `textContent`).
- `synthesize(text, opts)` — returns a `Promise<ArrayBuffer>` of WAV audio.
  The saved `{ voice, rate, pitch }` in `opts` are ignored: XTTS owns the speaker
  and prosody.

Core owns selection, the dropdown option, and playback (including stop/rearm in
voice mode). This extension only produces audio bytes.

## Setup

You need a running XTTS v2 daemon that accepts
`POST / {"text", "language", "speaker"}` and answers with a WAV body (24 kHz mono).
A minimal stdlib daemon that loads `tts_models/multilingual/multi-dataset/xtts_v2`,
splits long text by sentence, and concatenates the chunks into one WAV is enough.

Default expectations:

| Setting      | Default                    |
|--------------|----------------------------|
| `daemon_url` | `http://127.0.0.1:3032/`   |
| `speaker`    | `Viktor Menelaos`          |

Change them in **Settings → Extensions → XTTS v2 (local studio voice)**.
`daemon_url` is validated against loopback (`127.0.0.1`, `localhost`, `::1`) and
refused otherwise, so the setting can never redirect audio synthesis off the box.

Then:

1. Start your XTTS v2 daemon.
2. **Settings → TTS Engine → XTTS v2 (local studio voice)**.
3. Press **Listen** on a message, or use voice mode.

## Permissions And Trust Model

This extension runs as trusted local code in the WebUI origin, with the logged-in
session's authority. It declares:

- `network_external: false` — the only network call is to a **loopback** daemon
  (`http://127.0.0.1:*` / `http://localhost:*` are already in WebUI's enforced
  CSP `connect-src`). No external origin is ever contacted.
- `dom.owned: false` — it creates no DOM and does not touch core views.
- `storage.owned: true` — its `settings_schema` fields render as native settings.
- `loopback_sidecar: false` — it uses the browser's direct loopback path, not the
  WebUI sidecar proxy. The daemon binds to localhost; anyone who can reach the
  loopback port can also synthesize. Do not expose the daemon on a public
  interface.

## Disable And Uninstall

- **Disable:** Settings → Extensions → toggle *XTTS v2* off, or pick another
  TTS Engine in Settings → TTS Engine.
- **Uninstall:** remove the extension from Settings → Extensions. No files,
  routes, or sidecars are left behind. Your XTTS daemon is independent of the
  extension and keeps running.

## Known Limitations

- Requires a separately installed and running XTTS v2 daemon; the extension does
  not start or manage it (`lifecycle.sidecar_start_required: false`).
- Speed and pitch settings do not apply (the daemon does not expose them).
- Language is chosen by script (`ru`/`en`); other languages depend on the
  daemon's own language handling.

## Compatibility

Needs the core `window.registerHermesTtsEngine` seam (present in current Hermes
WebUI) and loopback allowed in the CSP `connect-src` (the default). On an older
core without the seam, the script logs a warning and does nothing; WebUI keeps
its built-in engines.

## Verification

- `node scripts/validate-extensions.mjs` — entry shape, manifest consistency,
  permissions-vs-code drift, local asset paths.
- `node scripts/scan-extension-safety.mjs` — secrets, blocked JS patterns,
  loopback-only network literals.
- Manual: with the extension installed and a daemon on `127.0.0.1:3032`, select
  the engine and press **Listen**. The synthesized body is a `RIFF/WAVE` buffer
  and plays without a browser voice.

## Current Shape

```text
WebUI Settings → TTS Engine: "xtts"
  → core _hermesTtsSynth('xtts', text)
  → this extension synthesize(text)
  → fetch POST http://127.0.0.1:3032/  { text, language, speaker }
  → WAV (24 kHz mono)
  → core <audio> playback (Listen button + voice mode)
```
