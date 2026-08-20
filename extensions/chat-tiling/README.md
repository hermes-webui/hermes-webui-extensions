# Chat Tiling

Multi-session tiling layouts for Hermes WebUI — split your chat panel into a
grid of session snapshots. Each tile holds a session context (messages, model,
streaming state); only the focused tile uses the shared composer and live model
context. Great for comparing agent outputs side-by-side, keeping a reference
conversation visible while you work elsewhere, or monitoring multiple sessions
as static snapshots.

## What It Does

- **Layouts** — 2-column (horizontal split), 4-corner (2×2 grid), 6-tile (3×2 grid)
- **Session snapshots** — each tile renders a session's messages via `window.renderTranscript()`
- **Focus switching** — click any tile to make it the active composer/model context; the outgoing tile's state is saved, the incoming tile's session is restored to the shared context
- **Maximize** — expand one tile to fill the entire grid; restore with one click
- **Session restore** — click any sidebar session to load it into the next empty tile (when auto-tile is enabled)
- **Graceful close** — cancels in-flight streaming before removing the tile

## Keyboard Shortcuts

| Shortcut | Layout |
|----------|--------|
| `Ctrl+Alt+1` | 1 tile (full width) |
| `Ctrl+Alt+2` | 2 columns |
| `Ctrl+Alt+4` | 4 corners (2×2) |
| `Ctrl+Alt+6` | 6 tiles (3×2) |

Press the same chord while the grid is active to dismiss it.

## How It Works

```
Sidebar click → registerHermesSessionOpenHandler (preload phase: snapshot outgoing tile)
                                        (loaded phase: fill tile with session data)
  → tiling extension fills next empty tile
  → tile gets its own session context (sid/messages/model)
  → only the focused tile drives the shared composer

Toolbar button → showGrid(cols, rows)
  → snapshot current session
  → create N tile elements in #ext-tile-grid
  → renderTranscript() renders messages in each tile
```

The extension uses two stable WebUI public APIs:

- `window.registerHermesSessionOpenHandler(fn)` — fires on session open; routes
  clicks to empty tiles when the grid is active.
- `window.renderTranscript(container, messages, opts)` — renders a message array
  into any container using the sanitized markdown pipeline.

## Architecture

The extension has **one shared `S`**, **one composer**, and **one live model/run
context**. Only the focused tile can safely own it. Non-focused tiles are
rendered snapshots — they display messages but do not drive the live context.
This is today's Core contract; true concurrent multi-session streaming requires
a future Core capability.

```text
┌─────────────────────────────────────────────┐
│  Toolbar (2 | 4 | 6 | ✕) in .app-titlebar   │
├─────────────────────────────────────────────┤
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │  Tile 1  │  │  Tile 2  │  │  Tile 3  │  │
│  │ header   │  │ header   │  │ header   │  │
│  │ messages │  │ messages │  │ messages │  │
│  │(snapshot)│  │(snapshot)│  │(snapshot)│  │
│  └──────────┘  └──────────┘  └──────────┘  │
│  ┌──────────┐  ┌──────────┐                │
│  │  Tile 4  │  │  Tile 5  │  ← 3×2 grid   │
│  └──────────┘  └──────────┘                │
└─────────────────────────────────────────────┘
```

Each tile holds `{ id, sid, session, messages, busy, activeStreamId, maximized, cv, mv }`.
Switching focus snapshots the outgoing tile's state and restores the incoming tile's
composer value + model selection.

## Settings

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `auto_tile` | boolean | `true` | Auto-fill tiles on sidebar session click |
| `show_sidebar_badges` | boolean | `true` | Show active-tile-count badges in sidebar |

## Install For Local Testing

```bash
cd /path/to/hermes-webui
HERMES_WEBUI_EXTENSION_DIR=/path/to/hermes-webui-dev/extensions/chat-tiling \
HERMES_WEBUI_EXTENSION_MANIFEST=manifest.json \
./start.sh
```

Or register in your dev state dir's `extension-install-manifest.json` and restart.

## Requirements

Hermes WebUI **≥ 2026.07.18** (the release that shipped
`registerHermesSessionOpenHandler` and `renderTranscript` as public APIs).
The extension loads and safely no-ops on older versions (feature-detected).

## Capabilities

- `manifest-bundle`
