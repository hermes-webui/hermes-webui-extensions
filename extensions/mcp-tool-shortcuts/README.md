# MCP Tool Shortcuts

MCP Tool Shortcuts is a trusted local Hermes WebUI extension that lets you **pin
frequently-used MCP tools** and get a one-click strip that **drafts a
ready-to-send natural-language tool request into the composer**. It **never
auto-executes** a tool — it only inserts a prompt you review and send.

## What It Does

- In **Settings → MCP Tools**, each tool row gets a **pin star**.
- Pinned tools appear as **clickable chips** in a "★ Pinned tools" strip at the
  top of the MCP Tools section.
- Clicking a chip drafts `Use the <name> tool (on the <server> server) to: `
  into the composer, focuses it, and switches to chat so you can finish the
  request and send it.
- Pins persist in `localStorage` and are **filtered against the live tool list**
  (from the authenticated `/api/mcp/tools`), so stale or cross-profile pins
  simply don't render.

## Safety (important)

- It **never calls `/api/mcp/call`** and never executes a tool. It only **drafts
  a prompt** into the composer for you to review and send — the same
  draft-not-execute model as the source PR.
- All tool names / servers are HTML-escaped wherever rendered.
- Pins are filtered against the live, profile-scoped tool inventory, so a pin
  from another profile or a removed tool never produces a chip.

## Credit

Design reference: closed core PR
[#3222](https://github.com/nesquena/hermes-webui/pull/3222) (@AJV20) — the
draft-not-execute model, `esc()`-everything, stale-pin filtering, and the
`server::name` shortcut key. This is the extension form of that idea (routed to
extensions to keep the core MCP panel lean).

## Current Shape

```text
Hermes WebUI page
  -> manifest-bundled extension assets
  -> /extensions/assets/mcp-tool-shortcuts.js + .css
  -> GET /api/mcp/tools (live, authed) for the tool inventory
  -> Settings -> MCP Tools: pin stars on rows + a "Pinned tools" chip strip
  -> click a chip -> draft a prompt into #msg (composer) -> switch to chat
  -> localStorage: hermes-ext-mcp-pinned-tools (["server::name", ...])
```

This extension is `static-ui` / manifest-bundle only. It does not add backend
routes, start a sidecar, access external networks, read/write files, or use
native host APIs. It reads the existing authenticated `/api/mcp/tools` endpoint.

## Capabilities

- `manifest-bundle`

## Install For Local Testing

```bash
cd /path/to/hermes-webui
HERMES_WEBUI_EXTENSION_DIR=/path/to/hermes-webui-extensions/extensions/mcp-tool-shortcuts HERMES_WEBUI_EXTENSION_MANIFEST=manifest.json ./start.sh
```

Open **Settings → MCP Tools**, pin a tool with its star, then click its chip in
the "Pinned tools" strip — a drafted request appears in the composer.

## Controls

Also on `window.HermesMcpShortcutsExtension`:

- `.pins()` — current pinned keys (`server::name`)
- `.refresh()` — re-fetch the live tool list and re-render

## Disable And Uninstall

Restart Hermes WebUI without `HERMES_WEBUI_EXTENSION_DIR` /
`HERMES_WEBUI_EXTENSION_MANIFEST`, or remove the
`extensions/mcp-tool-shortcuts/` directory. Pins live under
`hermes-ext-mcp-pinned-tools`.

## Trust And Permissions

This is trusted local code. Current disclosed behavior:

- creates extension-owned DOM (pin stars on tool rows + a pinned-tools chip
  strip in the MCP Tools settings section)
- reads the existing authenticated `GET /api/mcp/tools` (declared
  `webui_api.read: ["mcp/tools"]`) for the live tool inventory
- inserts a drafted natural-language prompt into the composer (`#msg`) and uses
  `switchPanel('chat')` to show it (`webui_navigation: true`)
- reads/writes `localStorage` under the single key
  `hermes-ext-mcp-pinned-tools`
- **does NOT call `/api/mcp/call` or execute any tool**, does NOT access cookies,
  contact external networks, use the filesystem, or use native hosts

## Compatibility

- manifest-bundled extension assets + same-origin serving under `/extensions/`
- the authenticated `/api/mcp/tools` endpoint
- the MCP Tools settings DOM (`#mcpToolList`, `.mcp-tool-row`,
  `.mcp-tool-name`, `.mcp-tool-server`) and the composer (`#msg`) — the
  integration contract; a core rename would need an update

## Verification

```bash
node scripts/validate-extensions.mjs
node scripts/scan-extension-safety.mjs
node scripts/generate-registry.mjs --out dist/registry.json
node --check extensions/mcp-tool-shortcuts/assets/mcp-tool-shortcuts.js
python3 -m json.tool extensions/mcp-tool-shortcuts/extension.json
python3 -m json.tool extensions/mcp-tool-shortcuts/manifest.json
```

Manual verification:

- open Settings → MCP Tools; each tool row shows a pin star
- pinning a tool adds a chip to the "Pinned tools" strip; unpinning removes it
- clicking a chip drafts a request into the composer and switches to chat, and
  does NOT execute anything
- pins persist across a reload and a removed/cross-profile tool produces no chip
- the strip + stars re-apply after the tool list re-renders (search/pagination)

## Known Limitations

- Pinning happens in Settings → MCP Tools (where the tool list lives); the chips
  also render there. (A future version could surface the chips near the composer
  too.)
- Drafts a generic "use this tool to: …" prompt — it does not pre-fill tool
  arguments (deliberate: no execution, no schema-form).
- Relies on the MCP Tools DOM + `/api/mcp/tools`; a core rename would need an
  update.
