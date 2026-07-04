# Chat Tiling

Chat Tiling is a client-side Hermes WebUI extension that lets you work with
multiple conversations at once in a resizable tile grid, instead of one session
at a time.

## What It Does

- Adds tiling layouts to the chat area: **2-column** split, **4 corners** (2×2
  grid), and **6 tiles** (3×2 grid).
- Click a session in the sidebar to open it in the focused tile.
- Each tile has its own independent composer, model selection, message list, and
  live streaming — so you can run and watch several conversations side by side.
- Maximize / restore an individual tile.
- Remembers your preferred default layout (configurable in the extension's
  settings).

## Install

Copy the `chat-tiling` folder into your Hermes WebUI extensions directory
(`HERMES_WEBUI_EXTENSION_DIR`), then enable it from Settings → Extensions. It is
entirely client-side — no core changes, no server component, no network access.

## Settings

- **Default layout** — which grid to open with (2-column / 4 corners / 6 tiles).
- **Auto-tile** — whether to enter a tiled layout automatically.

## Credits

Originally authored by [@ChonSong](https://github.com/ChonSong) and contributed
to Hermes WebUI as PR nesquena/hermes-webui#5312. Migrated here to the extensions
repository because it is a self-contained client-side extension (the right home
for it) rather than a core change.
