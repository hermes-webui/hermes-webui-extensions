# Message Pins

Message Pins is a trusted local Hermes WebUI extension that lets you pin
individual messages in a conversation. It adds a pin button to each message, a
header popover that lists your pinned messages with click-to-jump, and a small
badge showing the pin count. Pins are saved locally in your browser, per
session.

## What It Does

- Adds a pin button to each message (in the hover action bar, with a floating
  fallback for messages that have no action bar).
- Pinning a message records it; pinning is capped at 3 messages per conversation
  with a polite over-cap notice (unpin one to pin another).
- Adds a pin button near the top-right of the chat area with a count badge.
  Clicking it opens a popover listing the pinned messages.
- Clicking a pinned message in the popover scrolls to it and briefly highlights
  it. If that message has been virtualized out of the loaded transcript window,
  the extension tells you to scroll up to load it first rather than silently
  doing nothing.
- Each popover entry has an unpin control.
- Pins are stored per `session_id`, so each conversation keeps its own set, and
  switching conversations swaps the displayed pins.

## Current Shape

```text
Hermes WebUI page
  -> manifest-bundled extension assets
  -> /extensions/assets/message-pins.js
  -> /extensions/assets/message-pins.css
  -> existing WebUI message rows ([data-msg-idx]) + .messages-shell
  -> localStorage (key: hermes-ext-message-pins)
```

This extension is `static-ui` / manifest-bundle only. It does not add backend
routes, start a sidecar, access external networks, read or write files, or use
native host APIs. Persistence is client-side `localStorage`, so pins are
per-browser and not synced across devices.

## Capabilities

This entry declares only capabilities currently available to extension entries:

- `manifest-bundle`

It does not require `loopback-sidecar` or the sidecar proxy.

## Install For Local Testing

Start Hermes WebUI with this extension directory:

```bash
cd /path/to/hermes-webui
HERMES_WEBUI_EXTENSION_DIR=/path/to/hermes-webui-extensions/extensions/message-pins HERMES_WEBUI_EXTENSION_MANIFEST=manifest.json ./start.sh
```

The runtime `manifest.json` injects:

```json
{
  "extensions": [
    {
      "id": "message-pins",
      "name": "Message Pins",
      "description": "Pin individual messages in a conversation, with a header popover and click-to-jump.",
      "scripts": ["assets/message-pins.js"],
      "stylesheets": ["assets/message-pins.css"]
    }
  ]
}
```

This entry can be browsed and installed from Settings -> Extensions.

## Disable And Uninstall

To disable the WebUI extension, restart Hermes WebUI without:

```text
HERMES_WEBUI_EXTENSION_DIR
HERMES_WEBUI_EXTENSION_MANIFEST
HERMES_WEBUI_EXTENSION_STYLESHEET_URLS
HERMES_WEBUI_EXTENSION_SCRIPT_URLS
```

To uninstall it from a manual local setup, remove the
`extensions/message-pins/` directory from the local extensions checkout or
remove the entry from the aggregate manifest that points at it.

Your saved pins live under the `hermes-ext-message-pins` key in your browser's
localStorage. Clearing that key (or your site data) removes all saved pins.

## Trust And Permissions

This is trusted local code. The injected JavaScript runs in the Hermes WebUI
browser origin and can use the logged-in browser session.

Current disclosed behavior:

- creates extension-owned DOM for the pin buttons, header button, popover, and a
  small toast
- inserts the pin button into each message's existing `.msg-actions` bar, with a
  floating fallback appended to the message row when no action bar exists
- inserts the header button into the existing `.messages-shell`
- reads message rows via the existing `data-msg-idx`, `data-raw-text`, and
  `data-session-id` attributes already present on the page
- reads the active session id from a rendered message's `data-session-id` (or
  from the `/session/<id>` URL as a fallback)
- uses a `MutationObserver` on the messages container to re-apply pin
  decorations after the transcript re-renders
- reads and writes `localStorage` under the single key `hermes-ext-message-pins`
- does not call WebUI HTTP APIs
- does not access cookies
- does not contact loopback or external network services
- does not use arbitrary filesystem or native host APIs

All message text rendered into the popover and previews is inserted via
`textContent` (or escaped), so message content cannot inject markup.

## Compatibility

Required WebUI surface:

- manifest-bundled extension assets
- same-origin extension asset serving under `/extensions/`
- message rows carrying `data-msg-idx` (and, where available, `data-raw-text`
  and `data-session-id`), inside `#messages` / `.messages-shell`

This entry targets Hermes WebUI builds that render message rows with
`data-msg-idx` and the `.msg-actions` hover bar. The compatibility requirement is
better described as the manifest bundle plus the message-row DOM surface above.

## Verification

From this repository:

```bash
node scripts/validate-extensions.mjs
node scripts/scan-extension-safety.mjs
node scripts/generate-registry.mjs --out dist/registry.json
node --check extensions/message-pins/assets/message-pins.js
python3 -m json.tool extensions/message-pins/extension.json
python3 -m json.tool extensions/message-pins/manifest.json
```

Manual verification should confirm:

- hovering a message shows a pin button; clicking it pins the message and the
  header badge count increases
- the header pin button opens a popover listing the pinned messages
- clicking a pinned entry scrolls to and highlights that message
- the unpin control in the popover removes a pin
- pinning a 4th message shows the over-cap notice instead of pinning
- reloading the page keeps the pins for that conversation
- switching to another conversation shows that conversation's own pins
- a pin whose message is scrolled out of the virtualized window shows the
  "scroll up to load it" notice instead of doing nothing

## Known Limitations

- Pins are stored per browser via `localStorage`; they are not synced across
  devices or browsers (a deliberate consequence of being a client-side-only
  extension with no backend).
- The extension relies on the current message-row DOM (`data-msg-idx`,
  `.msg-actions`) until a formal message-decoration extension API exists.
- Jump-to-pin requires the target message to be within the loaded transcript
  window; very old messages in a long conversation may need to be scrolled into
  range first.

## Credit

The pin UX in this extension — a per-message pin button, a header popover with a
count badge, click-to-jump, and a 3-pin cap — follows the design from closed
core PR [#2534](https://github.com/nesquena/hermes-webui/pull/2534) by
**@Michaelyklam** (originally requested in issue #2508). That PR implemented
pinning with a new core API and server-side persistence; it was a good idea that
did not fit core's scope, so it was reimagined here as an opt-in extension that
persists pins client-side and needs no core changes. Thanks to @Michaelyklam for
the original concept and design.
