# Session Export to PDF

Session Export to PDF is a trusted local Hermes WebUI extension that lets you
export the current conversation to a clean **PDF** (via the browser's print
dialog, with a print-styled layout) or **copy it as Markdown**. It adds an export
button to the app titlebar.

## What It Does

- Adds an export button to the app titlebar (next to Reload); it shows only when
  a conversation is open.
- Clicking it opens a small menu:
  - **Export to PDF** — clones the rendered transcript into a print-styled,
    off-screen container and calls `window.print()` with a scoped `@media print`
    stylesheet, so the printed/saved PDF is just the conversation (titled, with
    roles, code blocks, links preserved) rather than a raw `Ctrl+P` of the whole
    app chrome. Use your browser's "Save as PDF" destination.
  - **Copy as Markdown** — copies the conversation as `# title` + `## You` /
    `## Assistant` sections to the clipboard.
- No backend, **no bundled PDF library**, no network. Everything is done in the
  browser from the already-rendered transcript.

## Credit

Design reference: closed core PR
[#3425](https://github.com/nesquena/hermes-webui/pull/3425) (@vanshaj-pahwa),
which added a print-markup/formatting export to core. This is the extension form
of that idea (routed to extensions to keep core lean).

## Current Shape

```text
Hermes WebUI page
  -> manifest-bundled extension assets
  -> /extensions/assets/session-export-pdf.js + .css
  -> titlebar button -> menu -> clone #messages rows into #hwxPrintRoot
     + @media print { show only #hwxPrintRoot } -> window.print()
  -> (or) copy transcript as Markdown to the clipboard
```

This extension is `static-ui` / manifest-bundle only. It does not add backend
routes, start a sidecar, access external networks, read/write files, or use
native host APIs.

## Capabilities

- `manifest-bundle`

## Install For Local Testing

```bash
cd /path/to/hermes-webui
HERMES_WEBUI_EXTENSION_DIR=/path/to/hermes-webui-extensions/extensions/session-export-pdf HERMES_WEBUI_EXTENSION_MANIFEST=manifest.json ./start.sh
```

Open a conversation, click the export button in the titlebar, and choose Export
to PDF (then pick "Save as PDF" in the print dialog) or Copy as Markdown.

## Controls

Also on `window.HermesSessionExportExtension`:

- `.exportPdf()` — open the print dialog for the current conversation
- `.exportMarkdown()` — copy the conversation as Markdown
- `.refresh()` — re-evaluate button visibility

## Disable And Uninstall

Restart Hermes WebUI without `HERMES_WEBUI_EXTENSION_DIR` /
`HERMES_WEBUI_EXTENSION_MANIFEST`, or remove the `extensions/session-export-pdf/`
directory. The extension stores nothing.

## Trust And Permissions

This is trusted local code. Current disclosed behavior:

- creates extension-owned DOM (a titlebar button, a small menu, and a temporary
  off-screen print container that is removed after printing)
- reads the rendered transcript from `#messages` (`.msg-body` of each real
  message row; hidden anchor/worklog segments are skipped)
- calls `window.print()` (`uses_print`) and writes to the clipboard
  (`uses_clipboard`) for the Markdown copy
- does NOT call WebUI HTTP APIs, read/write localStorage, access cookies, contact
  any network, or use the filesystem / native hosts
- the print body reuses the already-sanitized rendered HTML from core's renderer
  (it is cloned, not re-parsed from raw input)

## Compatibility

- manifest-bundled extension assets + same-origin serving under `/extensions/`
- the app titlebar (`.app-titlebar`, `#btnReload`) to host the button
- the transcript DOM (`#messages`, `[data-msg-idx]`, `.msg-body`) — the
  integration contract; a core rename would need an update

## Verification

```bash
node scripts/validate-extensions.mjs
node scripts/scan-extension-safety.mjs
node scripts/generate-registry.mjs --out dist/registry.json
node --check extensions/session-export-pdf/assets/session-export-pdf.js
python3 -m json.tool extensions/session-export-pdf/extension.json
python3 -m json.tool extensions/session-export-pdf/manifest.json
```

Manual verification:

- with a conversation open, the titlebar export button appears; with no
  conversation it is hidden
- Export to PDF opens the print dialog showing only the titled transcript (not
  the app chrome), with roles, code blocks, and links preserved
- Copy as Markdown puts the conversation on the clipboard
- the off-screen print container is removed after printing (no leftover DOM)

## Known Limitations

- PDF generation uses the browser print dialog (choose "Save as PDF") — there is
  no silent server-side PDF render (deliberate: no bundled library, no backend).
- Exports the currently-open conversation (not a bulk/all-sessions export).
- Reads the rendered transcript, so only what's rendered in the DOM is exported;
  very long virtualized transcripts export what is present in `#messages`.
