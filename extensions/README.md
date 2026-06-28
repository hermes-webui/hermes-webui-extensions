# Extensions

Extension entries live in this directory.

Use one directory per extension:

```text
extensions/<extension-id>/
  README.md
  extension.json
  manifest.json
  assets/
```

Do not add shared runtime code here unless multiple accepted extensions already
need it and maintainers agree on the shared contract.

## Entries

- `desktop-companion`: trusted local Desktop Companion entry and first
  sidecar-class extension candidate.
- `mobile-conversations`: phone-only floating Conversations button and
  long-press shortcuts for the existing Hermes WebUI mobile drawer.
- `voicevox-tts`: use a local VOICEVOX server as a TTS engine (registers into
  Settings → TTS Engine via the core TTS-engine registration hook).
