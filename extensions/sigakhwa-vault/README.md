# Sigakhwa Result Vault

Keep the useful parts of assistant replies — a table, a diagram, a section or the whole answer — as cards you
can reopen later, without them ever being silently changed.

## What it does

- **Save a card.** Hover an assistant reply and press the star icon. A dialog lists the parts it found
  (whole answer, each markdown table, each Mermaid diagram, each `##` section); pick one, adjust the title,
  save.
- **Reopen.** The *보관함* button opens the vault (bottom sheet on phones). Cards show title, type and save
  time; opening one renders the saved snapshot (tables and markdown with a minimal escaping renderer,
  Mermaid with WebUI's own Mermaid; sources containing `<img>` or `<image>` use escaped code instead).
- **Snapshots are immutable.** A card stores the content as it was at save time plus a SHA-256 of the full
  source message. *원문 변경 확인* (check source) re-reads the source and reports *동일* (same) or *변경됨*
  (changed); the card itself is never overwritten. *새 저장본 만들기* saves the current content as a new
  card.
- **Back to the source.** *원문으로 이동* opens the conversation and scrolls to the message. If the source
  changed or cannot be verified, it warns first and only moves after *그래도 이동*.
- Rename, delete, and JSON export/import.

## Storage and sync

Cards use the same store as *Sigakhwa Bookmarks & TOC* (namespace `sigakhwa-vault`):

- Browser only by default (`localStorage` key `hermes-viz-store:sigakhwa-vault`), shown as *이 기기에만 저장됨*.
- When Sigakhwa Bookmarks is installed with its sidecar running and proxy consent granted, cards are stored
  on the WebUI host through that sidecar and shared between devices. This extension has no sidecar of its own.

Cards larger than 256 KiB of ASCII-escaped JSON are refused with a clear message. The shared store enforces a total limit of 1,000 cards / 2 MiB; quota errors have a separate notice.

## Install

- **Gallery:** Settings → Extensions → Gallery → *Sigakhwa Result Vault* → Install, then reload.
- **Manual:** copy this folder to `STATE_DIR/extensions/sigakhwa-vault/` and add it to the install record, or
  serve it with `HERMES_WEBUI_EXTENSION_DIR` + a manifest.

## Disable / uninstall

Toggle off or Uninstall in Settings → Extensions → Installed. The star button disappears at once; the panel
goes on the next reload. Saved cards stay in `localStorage` (and in the sidecar's
`sigakhwa-vault.json` if sync was on) until you delete them; export them first if you want to keep them.

## WebUI surfaces used

- `hermesExt.register()` with one message action (icon `star`, assistant replies only); core allows **two**
  message actions per page.
- `GET /api/session?...&msg_limit=all` to read the raw markdown of the reply being saved and to verify the
  source later. At invoke time it captures the complete message content and role from Core state (including the loaded-message offset). Before saving, it compares the normalized full content and role with the server message; if the capture is unavailable or differs, saving is refused.
- `HermesVizNav` (bundled) to open the source conversation; WebUI's global `mermaid` to render saved diagrams.

## Trust and permissions

Trusted same-origin code with your WebUI session. Reads the transcript of the reply you save. Writes only its
own store namespace. No external network. Saved content is rendered only through an escaping renderer (no raw
HTML from replies is ever inserted). Every listed, opened or imported card is schema-checked. Invalid cards appear as corrupted, cannot be opened, and can be deleted; invalid import entries are skipped.

## Known limitations

- Only backtick code fences and `##` sections are recognised as parts.
- Saved Mermaid cards are rendered by the Mermaid version WebUI ships.
- Message indexes are not durable across edit/regenerate/truncate; the role and text checks prevent saving
  the wrong message, and the source check flags a moved or changed source.

## Compatibility and verification

Targets Hermes WebUI `7a74ae1b` (October 2026). Core PR nesquena/hermes-webui#8159 is merged and included in `exp-v0.52.460` on the experimental channel. Registered CI tests exercise the shipped extractor, escaping renderer, card validation, full-message identity, FAB positioning and Mermaid image fallback with local stubs/jsdom. These tests do not establish real-browser or cross-device integration.
