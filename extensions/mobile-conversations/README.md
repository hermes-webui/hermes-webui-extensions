# Mobile Conversations Button

Mobile Conversations Button is a trusted local Hermes WebUI extension that adds
a phone-only floating **Conversations** button near the chat composer. It opens
the existing mobile conversations drawer and provides a long-press shortcuts
menu for common conversation navigation actions.

## What It Does

- Adds a phone-width-only floating Conversations button inside the chat messages
  shell.
- Short tap opens or closes the existing mobile conversations/sidebar drawer.
- Long press opens a menu with shortcuts for:
  - New conversation
  - Open sidebar
  - Go to top
  - Go to last message
- Hides the floating button while the mobile drawer is already open.
- Leaves desktop-width layouts unchanged.

## Current Shape

```text
Hermes WebUI page
  -> manifest-bundled extension assets
  -> /extensions/assets/mobile-conversations.js
  -> /extensions/assets/mobile-conversations.css
  -> existing WebUI mobile sidebar, session, and scroll UI hooks
```

This extension is `static-ui` / manifest-bundle only. It does not add backend
routes, start a sidecar, access external networks, read or write local files, or
use native host APIs.

## Capabilities

This entry declares only capabilities currently available to extension entries:

- `manifest-bundle`

It does not require `loopback-sidecar` or future sidecar proxy support.

## Install For Local Testing

Start Hermes WebUI with this extension directory:

```bash
cd /path/to/hermes-webui
HERMES_WEBUI_EXTENSION_DIR=/path/to/hermes-webui-extensions/extensions/mobile-conversations HERMES_WEBUI_EXTENSION_MANIFEST=manifest.json ./start.sh
```

The runtime `manifest.json` injects:

```json
{
  "extensions": [
    {
      "id": "mobile-conversations",
      "name": "Mobile Conversations Button",
      "description": "Phone-only floating Conversations button and shortcut menu for Hermes WebUI.",
      "scripts": ["assets/mobile-conversations.js"],
      "stylesheets": ["assets/mobile-conversations.css"]
    }
  ]
}
```

## Disable And Uninstall

To disable the WebUI extension, restart Hermes WebUI without:

```text
HERMES_WEBUI_EXTENSION_DIR
HERMES_WEBUI_EXTENSION_MANIFEST
HERMES_WEBUI_EXTENSION_STYLESHEET_URLS
HERMES_WEBUI_EXTENSION_SCRIPT_URLS
```

To uninstall it from a manual local setup, remove the
`extensions/mobile-conversations/` directory from the local extensions checkout
or remove the entry from the aggregate manifest that points at it.

## Trust And Permissions

This is trusted local code. The injected JavaScript runs in the Hermes WebUI
browser origin and can use the logged-in browser session.

Current disclosed behavior:

- creates extension-owned DOM for the floating button and long-press menu
- inserts the floating button into the existing `.messages-shell`
- reads existing mobile layout state through WebUI DOM/classes
- calls existing WebUI browser functions when available, including
  `switchPanel`, `closeMobileSidebar`, `newSession`, `renderSessionList`,
  `jumpToSessionStart`, and `scrollToBottom`
- toggles existing mobile sidebar classes as a fallback when the public browser
  helper is unavailable
- uses pointer, context-menu, keyboard, resize, scroll, and mutation-observer
  handlers for mobile interaction and accessibility behavior
- does not call WebUI HTTP APIs
- does not use localStorage or sessionStorage
- does not access cookies
- does not contact loopback or external network services
- does not use arbitrary filesystem or native host APIs

## Compatibility

Required WebUI surface:

- manifest-bundled extension assets
- same-origin extension asset serving under `/extensions/`
- mobile WebUI layout with `.messages-shell`, `.sidebar`, and `#panelChat`
- existing browser hooks for mobile drawer/session/scroll behavior where
  available; the extension has DOM fallbacks for older builds

The source local extension was tested against Hermes WebUI versions at or after
`0.51.545`. The compatibility requirement is better described as the manifest
bundle plus the mobile sidebar/browser-hook surfaces listed above.

## Verification

From this repository:

```bash
node scripts/validate-extensions.mjs
node scripts/scan-extension-safety.mjs
node scripts/generate-registry.mjs --out dist/registry.json
node --check extensions/mobile-conversations/assets/mobile-conversations.js
python3 -m json.tool extensions/mobile-conversations/extension.json
python3 -m json.tool extensions/mobile-conversations/manifest.json
```

Manual mobile verification should confirm:

- at phone width, the floating Conversations button appears near the lower-right
  chat controls
- tapping the button opens the existing mobile conversations drawer
- the button is hidden while the drawer is open
- long press opens the shortcuts menu
- the synthetic click after a long press does not also toggle the drawer
- the next normal tap still works
- Escape closes the shortcuts menu and returns focus to the button
- desktop-width layouts do not show the button

## Known Limitations

- No one-click install path is available yet.
- The extension relies on current WebUI DOM and browser helper names until a
  formal mobile sidebar extension API exists.
- The extension is intentionally mobile-only and does not add a desktop control.
