# XTTS v2 (local studio voice)

Adds a **text-to-speech engine** to Hermes WebUI that synthesizes speech through
a local [XTTS v2](https://github.com/coqui-ai/TTS) HTTP daemon. Instead of a
browser/system voice, replies are spoken in the daemon's studio voice, with no
cloud TTS provider involved.

It uses the core TTS-engine extension seam
(`window.registerHermesTtsEngine`, documented in the main WebUI repo under
*Extensions → Registering a custom TTS engine*), so it needs **no changes to
WebUI core**: the engine appears in **Settings → TTS Engine** alongside
Browser / Edge / ElevenLabs / OpenAI and drives both the per-message **Listen**
button and **voice mode**.

The extension is the client half. The server half is a small daemon you run
yourself — a reference implementation that speaks this exact contract lives at
**[gaidar0yegor/xtts-tts-daemon](https://github.com/gaidar0yegor/xtts-tts-daemon)**
(install, start and smoke-check commands below).

## What It Does

- Registers an engine `xtts` that POSTs the reply text to a local XTTS v2 daemon
  on loopback and returns the WAV the daemon produces.
- Sends one request per reply; the daemon owns long-text splitting, WAV
  concatenation, and speaker handling.
- Picks the language from the `language` setting, or from script when it is
  `auto` (Cyrillic → `ru`, otherwise `en`).
- Degrades safely: a non-WAV body, an HTTP error, a redirect, an unreachable
  daemon or a stalled request becomes a rejected promise with a readable
  message (core toasts on Listen / retries in voice mode) instead of playing
  silence or hanging voice mode.

## Who It Is For

Self-hosted Hermes WebUI users who already run — or are willing to run — a local
XTTS v2 speech daemon and want the WebUI to sound like their own agent: no
cloud provider, no API key, nothing leaving the machine.

## Requirements

| Requirement | Notes |
|---|---|
| Hermes WebUI with `window.registerHermesTtsEngine` | Current core. Older core: the script warns and no-ops. |
| A loopback XTTS v2 daemon implementing the contract below | Reference daemon: [gaidar0yegor/xtts-tts-daemon](https://github.com/gaidar0yegor/xtts-tts-daemon) |
| CORS on that daemon | Mandatory — see [CORS](#cors-is-required). |
| Loopback allowed in the CSP `connect-src` | Default WebUI behavior (`127.0.0.1`, `localhost`). |

## Setup

### 1. Run the daemon

The reference daemon is stdlib HTTP around Coqui's XTTS v2. XTTS needs Python
3.9–3.11 and ~1.8 GB of model weights on first run:

```bash
git clone https://github.com/gaidar0yegor/xtts-tts-daemon
cd xtts-tts-daemon
python3.11 -m venv .venv
.venv/bin/pip install --upgrade pip
.venv/bin/pip install coqui-tts
.venv/bin/python xtts_daemon.py --port 8120 --speaker "Viktor Menelaos"
```

Smoke-check it before touching the WebUI — the first 12 bytes must be
`RIFF....WAVE`:

```bash
curl -s http://127.0.0.1:8120/health
curl -s -X POST http://127.0.0.1:8120/ \
  -H 'Content-Type: application/json' \
  -d '{"text":"Hello from XTTS","language":"en","speaker":"Viktor Menelaos"}' \
  | head -c 12; echo
```

To check the WebUI wiring without downloading a model (no GPU, no weights), run
the same daemon with `--mock`: it answers the identical contract with a short
tone.

The daemon repo also ships a `systemd --user` unit if you want it up at login.

### 2. Install the extension and pick the engine

1. Install/enable **XTTS v2 (local studio voice)** in Settings → Extensions.
2. Open **Settings → TTS Engine** and select **XTTS v2 (local studio voice)**.
3. Press **Listen** on a message, or use voice mode.

Default settings:

| Setting | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Engine availability in the TTS picker. |
| `daemon_url` | `http://127.0.0.1:8120/` | Loopback daemon endpoint. |
| `speaker` | `Viktor Menelaos` | One of the model's built-in speakers. |
| `language` | `auto` | `auto` = Cyrillic → `ru`, else `en`; or any of the 17 XTTS v2 codes. |

Change them in **Settings → Extensions → XTTS v2 (local studio voice)**.
`daemon_url` is validated as a loopback HTTP(S) origin and refused otherwise, so
the setting can never redirect audio synthesis off the box. IPv6 `[::1]` is not
accepted: WebUI's CSP allows `127.0.0.1` and `localhost` but not `[::1]`, so
such a URL would pass a naive check and then fail in the browser. A `daemon_url`
whose origin equals the WebUI's own origin is rejected as well — that request
would carry the WebUI session cookie and CSRF header into core's API — and the
engine sends `credentials: 'omit'` regardless.

### 3. Daemon contract

The extension sends exactly this and expects audio back:

```http
POST / HTTP/1.1
Content-Type: application/json

{"text": "reply text", "language": "en", "speaker": "Viktor Menelaos"}
```

```http
200 OK
Content-Type: audio/wav
<RIFF/WAVE, 24 kHz, 16-bit mono>
```

Any HTTP status outside 2xx, a body that is not RIFF/WAVE, or a redirect is
rejected. `GET /health` and `OPTIONS /` are optional for the engine but expected
of a usable daemon (the reference one implements both).

### CORS is required

The WebUI page and the daemon are different origins (different ports), so the
browser preflights the POST. A daemon that does not answer the preflight gets
blocked by the browser, and the extension then reports
`XTTS daemon unreachable at <url> — is the daemon running, and does it allow CORS from this page?`
(the raw browser error is only visible in the console).

The daemon must answer `OPTIONS /` with:

```http
Access-Control-Allow-Origin: <the WebUI origin, or *>
Access-Control-Allow-Methods: POST, OPTIONS
Access-Control-Allow-Headers: Content-Type
```

and repeat `Access-Control-Allow-Origin` on the `POST` response. The reference
daemon does both (echoing the caller's `Origin` and sending `Vary: Origin`).

## Where The Daemon Must Run

The synthesis request is issued **by the browser**, so `127.0.0.1` means *the
device you are browsing from* — not the machine running WebUI.

- Browser and daemon on the same machine (normal desktop/laptop use): fine.
- WebUI in a browser on another device (phone, tablet, second computer): the
  request goes to *that device's* loopback and fails. See Known Limitations.

## Permissions And Trust Model

This extension runs as trusted local code in the WebUI origin, with the logged-in
session's authority. It declares:

- `network_external: false` — the only network call is to a **loopback** daemon
  (`http://127.0.0.1:*` / `http://localhost:*` are already in WebUI's enforced
  CSP `connect-src`). No external origin is ever contacted.
- `loopback_sidecar: true` — the extension talks to a local helper the user runs
  (rendered by core as “Can contact a declared local loopback helper”). It does
  **not** use the WebUI sidecar proxy: the browser reaches loopback directly.
- `dom.owned: false` — it creates no DOM and does not touch core views.
- `storage.owned: true` — its `settings_schema` fields render as native settings.
- `filesystem.serves_bundled_assets: true`, no native host, no WebUI API calls.
- `lifecycle.sidecar_start_required: true` — the user has to start the daemon.

The loopback port is the trust boundary: anything that can reach it can
synthesize. Bind the daemon to `127.0.0.1` and never expose it on a public
interface.

## Disable And Uninstall

- **Disable:** Settings → Extensions → toggle *XTTS v2* off, or pick another
  TTS Engine in Settings → TTS Engine.
- **Uninstall:** remove the extension from Settings → Extensions. No files,
  routes, or sidecars are left behind. The daemon is independent of the
  extension and keeps running.

## Known Limitations

- **Not reachable from other devices.** As above, the fetch originates in the
  browser: a phone or another computer cannot reach a daemon running on the
  WebUI host through `daemon_url`. The supported route for that is core's
  sidecar proxy (`docs/SIDECAR_CONTRACT.md` in the main WebUI repo), which
  reaches loopback on the WebUI host instead — a larger change that this
  extension does not ship.
- Requires a separately installed and started XTTS v2 daemon; the extension does
  not install or manage it (`lifecycle.sidecar_start_required: true`).
- One request per reply, no streaming: the whole reply is synthesized before
  playback starts.
- Requests have a 120 s deadline (covering both the fetch and the body read). A
  long reply on a CPU-only daemon can exceed it; the reference daemon's
  sentence splitting and the `--device cuda` flag are the levers.
- Speed and pitch settings do not apply (XTTS has none in this contract).
- Language: the 17 XTTS v2 languages; anything else needs a different model.
  Mixed-language replies are synthesized in one language.
- XTTS v2 model weights are released under the Coqui Public Model License
  (non-commercial), which applies to the daemon and the voices it produces, not
  to this client-side extension.
- CI verifies the HTTP contract (the reference daemon's `--mock` mode) and the
  engine's behavior; it does not download or run the XTTS model.

## Compatibility

Needs the core `window.registerHermesTtsEngine` seam (present in current Hermes
WebUI) and loopback allowed in the CSP `connect-src` (the default). On an older
core without the seam, the script logs a warning and does nothing; WebUI keeps
its built-in engines.

## Verification

Repo gates:

```bash
node scripts/validate-extensions.mjs        # entry shape, permissions-vs-code drift
node scripts/scan-extension-safety.mjs      # secrets, blocked JS patterns, network literals
node scripts/test-xtts-tts.mjs              # 13 behavior cases for this engine
```

`scripts/test-xtts-tts.mjs` drives the real engine source in a vm context
against a loopback stand-in daemon and asserts: the registered engine id, the
exact JSON body, `credentials: 'omit'`, `redirect: 'error'`, a deadline signal on
every request, the language setting and Cyrillic detection, rejection of
non-WAV/HTTP-error/redirect bodies, rejection of a `daemon_url` on the WebUI
origin (including the fallback), loopback-only `daemon_url` validation with no
`[::1]`, empty-text and disabled-engine guards, and the 120 s timeout path.
Against the pre-review head (`21d0b97`) the same suite passes 6 of 13; with the
fixes above it passes 13 of 13.

Manual:

1. Start the daemon (`--mock` is enough to prove wiring).
2. Install the extension, select the engine in Settings → TTS Engine.
3. Press **Listen**. The synthesized body is a `RIFF/WAVE` buffer and plays
   without a browser voice.
4. Stop the daemon and press **Listen** again: you get the CORS/unreachable
   message, not a hang.

## Current Shape

```text
WebUI Settings → TTS Engine: "xtts"
  → core _hermesTtsSynth('xtts', text)
  → this extension synthesize(text)
  → fetch POST http://127.0.0.1:8120/  { text, language, speaker }
      credentials: 'omit', redirect: 'error', 120 s AbortController
  → WAV (24 kHz mono) or a rejected promise with a readable reason
  → core <audio> playback (Listen button + voice mode)
```
