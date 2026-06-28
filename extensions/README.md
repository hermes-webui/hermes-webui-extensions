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
- `mobile-conversations`: phone-only floating Conversations button, same-location
  drawer close X, and long-press shortcuts for the existing Hermes WebUI mobile drawer.
- `message-pins`: pin individual messages in a conversation, with a header
  popover, click-to-jump, and client-side per-session persistence.
- `model-favorites`: star your most-used models; favorites are promoted to a
  ★ Favorites group at the top of the composer model picker.
- `custom-avatar`: give the assistant a custom avatar image in the chat
  transcript (downscaled + stored locally; assistant-only).
- `theme-creator`: build your own theme with a live color editor; custom themes
  register into the native Appearance picker (needs core theme-registration).
- `session-export-pdf`: export the current conversation to PDF (print) or copy
  it as Markdown, via a titlebar button.
