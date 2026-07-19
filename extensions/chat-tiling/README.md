# Chat Tiling

Multi-session tiling layouts for Hermes WebUI — split your chat panel into a
grid of independent sessions. Each tile holds its own session context (messages, model,
streaming state); only the focused tile uses the shared composer and live model
context. Great for comparing agent outputs, monitoring multiple sessions side-by-side,
or keeping a reference conversation visible while you work elsewhere.

## What It Does

- **Layouts** — 2-column (horizontal split), 4-corner (2×2 grid), 6-tile (3×2 grid)
- **Independent tiles** — each tile is a full session: model chip, messages, streaming state
- **Maximize** — expand one tile to fill the entire grid; restore with one click
- **Focus switching** — click any tile to make it the active composer/model context
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

## Settings

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `default_layout` | enum | `"4"` | Default layout when tiling activates |
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

## Architecture

```text
┌─────────────────────────────────────────────┐
│  Toolbar (2 | 4 | 6 | ✕) in .app-titlebar   │
├─────────────────────────────────────────────┤
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │  Tile 1  │  │  Tile 2  │  │  Tile 3  │  │
│  │ header   │  │ header   │  │ header   │  │
│  │ messages │  │ messages │  │ messages │  │
│  │ (indep.) │  │ (indep.) │  │ (indep.) │  │
│  └──────────┘  └──────────┘  └──────────┘  │
│  ┌──────────┐  ┌──────────┐                │
│  │  Tile 4  │  │  Tile 5  │  ← 3×2 grid   │
│  └──────────┘  └──────────┘                │
└─────────────────────────────────────────────┘
```

Each tile holds `{ id, sid, session, messages, busy, activeStreamId, maximized, cv, mv }`.
Switching focus snapshots the outgoing tile's state and restores the incoming tile's
composer value + model selection.
