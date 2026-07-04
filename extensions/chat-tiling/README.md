# Chat Tiling

Chat Tiling is a client-side Hermes WebUI extension that lets you view several
conversations at once in a resizable tile grid, instead of one session at a time.

## What It Does

- Adds tiling layouts to the chat area: **2-column** split, **4 corners** (2×2
  grid), and **6 tiles** (3×2 grid). Switch layouts from the toolbar buttons in
  the app title bar, or with **Ctrl/⌘ + Alt + 1 / 2 / 4 / 6**.
- Click a session in the sidebar to open it in the focused tile.
- Each tile shows that conversation's transcript (rendered with the same
  formatting as the main chat — bold, code, code blocks, links). The **focused**
  tile is wired to the shared composer, model picker, and live stream, so you send
  and watch in whichever tile you've clicked into; click another tile to switch
  focus. A small dot in a tile header marks a conversation that's actively running.
- Maximize / restore an individual tile.
- Remembers your last-used layout locally and can restore it (or your configured
  default) on load.

## Install

Copy the `chat-tiling` folder into your Hermes WebUI extensions directory
(`HERMES_WEBUI_EXTENSION_DIR`), then enable it from Settings → Extensions. It is
entirely client-side — no core changes, no server component, no network access.

## Settings

- **Default layout** — which grid the auto-tile-on-load restore opens when there's
  no saved last-used layout (2-column / 4 corners / 6 tiles).
- **Enter tiling automatically on load** — when on, the grid opens on page load
  (your last-used layout, or the default above); when off, the app loads untiled
  and you enter tiling from the toolbar.
- **Show tile count badges in sidebar** — show a small badge on a sidebar session
  row indicating how many tiles currently hold that conversation.

## Credits

Originally authored by [@ChonSong](https://github.com/ChonSong) and contributed
to Hermes WebUI as PR nesquena/hermes-webui#5312. Migrated here to the extensions
repository because it is a self-contained client-side extension (the right home
for it) rather than a core change.
