# Paperclip Session Hider

Paperclip Session Hider keeps Hermes WebUI's conversation sidebar focused by
hiding Paperclip/Hermes **tool-origin** rows such as repeated generic
`Tool Session` entries.

It is intentionally narrow:

- it does **not** delete, archive, rename, or modify sessions;
- it only hides rows in the current browser DOM;
- sessions remain available through WebUI search/API/storage and reappear when
  the extension is disabled;
- by default it hides only generic `Tool Session` rows, so named tool-origin
  sessions such as approval or merge-gate sessions remain visible.

## Why not a built-in WebUI setting?

Hermes WebUI currently has native settings for broader source classes:

- **Settings → Preferences → Show non-WebUI sessions** (`show_cli_sessions`) hides
  or shows external/agent sessions as a coarse group.
- Recent WebUI builds also include **Show Claude Code sessions**
  (`show_claude_code_sessions`) for the Claude Code source.
- Webhook and cron sources have their own toggles where supported.

There is no native Paperclip/tool-origin equivalent such as `show_tool_sessions`
or a per-source Paperclip sidebar filter. This extension fills that gap without a
core WebUI patch.

## Settings

Open **Settings → Extensions → Paperclip Session Hider**.

- **Hide Paperclip tool sessions** — master enable/disable toggle.
- **Rows to hide**:
  - **Generic Tool Session rows only** (default): hides rows whose source metadata
    is `tool`/`paperclip` and whose title is `Tool Session` or `Tool`.
  - **All tool-origin rows**: hides every row with `tool`/`paperclip` source
    metadata, including named approval sessions.

The default mode is conservative so important named approval sessions are not
hidden by accident.

## Install

Install it from the Hermes WebUI extension gallery/registry when available. For a
manual trusted-local install, copy this directory into the configured WebUI
extension directory and enable its manifest bundle.

```text
extensions/paperclip-session-hider/
  README.md
  extension.json
  manifest.json
  assets/
```

Refresh the WebUI tab after installation if your WebUI build does not hot-reload
extension manifests.

## Disable or uninstall

- Disable it from **Settings → Extensions** to show all rows again.
- Or uninstall/remove the extension directory from the configured extension
  directory.

No session data cleanup is required because the extension does not write to
session storage or backend APIs. Browser-local settings may remain under the
extension-owned settings namespace.

## Trust model and permissions

This is a trusted local static UI extension. It:

- reads `/api/sessions` from the same WebUI origin to map rendered sidebar row IDs
  to session source metadata;
- uses a scoped `MutationObserver` on `#sessionList` so rows stay hidden after
  sidebar refreshes, polling updates, search changes, and virtualization rerenders;
- adds/removes extension-owned CSS classes on `.session-item[data-sid]` and
  `.session-child-session[data-sid]` rows;
- uses WebUI's sanctioned `HermesExtensionSettings` API for browser-local
  settings, with a legacy localStorage fallback for older builds.

It does not use external network access, a sidecar, native host, filesystem
access, cookies, or WebUI write APIs.

## Compatibility and limitations

Tested against Hermes WebUI builds that expose:

- manifest-bundle extension loading;
- `/api/sessions` with `session_source` / `raw_source` / `source_tag` /
  `source_label` metadata;
- sidebar rows with `.session-item[data-sid]` (and child rows with
  `.session-child-session[data-sid]`);
- `HermesExtensionSettings` for native extension settings.

If metadata is temporarily unavailable, the extension falls back only when a DOM
row has a generated timestamp-style session id and is titled exactly `Tool Session`
/ `Tool`. Once `/api/sessions` is available, explicit non-tool metadata wins and
prevents hiding ordinary WebUI/cron/messaging sessions even if they happen to have
the same title.

While WebUI batch-select mode is active, the extension unhides rows temporarily so
bulk selection actions are not applied to an invisible subset.

## Verification

```bash
node --check extensions/paperclip-session-hider/assets/paperclip-session-hider.js
node scripts/test-paperclip-session-hider.mjs
node scripts/validate-extensions.mjs
node scripts/scan-extension-safety.mjs
```
