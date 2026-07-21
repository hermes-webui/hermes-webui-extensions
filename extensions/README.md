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
- `custom-branding`: white-label the app with your own logo + favicon (titlebar
  mark, empty-state hero logo, and browser-tab icon; downscaled + stored locally).
- `theme-creator`: build your own theme with a live color editor; custom themes
  register into the native Appearance picker (needs core theme-registration).
- `session-export-pdf`: export the current conversation to PDF (print) or copy
  it as Markdown, via a titlebar button.
- `mcp-tool-shortcuts`: pin MCP tools and draft a ready-to-send request into
  the composer (never auto-executes); lives in Settings → MCP Tools.
- `e-ink-skin`: maximum-contrast near-monochrome light skin for e-ink displays;
  registers into the native Appearance picker via the theme-registration API.
- `skin-pack`: popular editor-inspired color themes (Dracula, Gruvbox, One Dark,
  Tokyo Night, Rosé Pine, Solarized Dark) that register into the native
  Appearance picker via the theme-registration API.
- `mobile-haptics`: short device vibration when an assistant turn finishes
  (Android / Android-PWA; no-ops on desktop and iOS).
- `external-app-tab`: pin a compatible self-hosted web app (Grafana, a
  dashboard, or another framable tool) as a tab inside the WebUI via an iframe
  (needs the core `HERMES_WEBUI_CSP_FRAME_EXTRA` knob for external origins).
- `profile-avatars`: per-profile avatar images across profile chips, transcript
  assistant badges, and the session list; server-stored via a loopback sidecar
  so they sync across devices with zero localStorage.
- `sysinfo`: Insights add-ons under System health — an on-demand/scheduled
  internet speed test and a full Docker card (live container stats, compose
  grouping, start/stop/restart, one-click image updates) via a loopback sidecar.
