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
- **Focus switching** — click any *bound* tile to make it the active composer/model context; the outgoing tile's state is saved, the incoming tile's session is loaded via `window.loadSession()`
- **Maximize** — expand one tile to fill the entire grid; restore with one click
- **Session restore** — click any sidebar session to load it into the next free tile (when auto-tile is enabled); with auto-tile off the focused tile follows Core instead of reserving a slot
- **Graceful close** — cancels in-flight streaming before removing the tile

## How It Works

```
Sidebar click → registerHermesSessionOpenHandler (preload phase: reserve a slot)
                                        (loaded phase: bind the tile + focus it)
  → tiling extension fills a tile
  → tile gets its own session context (sid/messages/model)
  → only the focused tile drives the shared composer
  → if no slot can be bound, the extension vetoes the navigation
    (returns {cancel:true}) rather than letting the tile and Core disagree

Toolbar button → showGrid(cols, rows)
  → create #ext-tile-grid as an absolute overlay inside .messages-shell
  → build N tile elements (normal stretching CSS grid items)
  → focus first tile (transparent, shows live #msgInner beneath)
  → non-focused tiles render renderTranscript snapshots (opaque overlay)
```

The extension uses three stable WebUI public APIs:

- `window.registerHermesSessionOpenHandler(fn)` — fires on session open; routes
  clicks to tiles when the grid is active. Returning `{cancel:true}` from the
  preload phase vetoes the navigation.
- `window.renderTranscript(container, messages, opts)` — renders a message array
  into any container using the sanitized markdown pipeline.
- `window.loadSession(sid)` — swaps Core's live session state when focusing a tile.

## Architecture

The extension uses a **single-live-session** model: Core owns one `S` object,
one composer, and one live model/run context. Only the focused tile can safely
own it. Non-focused tiles are rendered snapshots — they display messages but
do not drive the live context.

Key invariants:
- **#messages stays visible** — Core owns scroll, pagination, virtualization
- **#msgInner stays in #messages** — never detached, never moved
- **Grid is an overlay** — absolute inside `.messages-shell`, the
  non-scrolling wrapper, so it does not scroll away with the transcript
- **Tiles are real grid items** — they stretch into their cell; nothing is
  `position:absolute`, so tiles cannot stack at a shared origin
- **Focused tile = transparent window** — shows live #msgInner beneath
- **Non-focused tiles = opaque snapshots** — cover #msgInner beneath
- **Unbound tiles are not focusable** — a tile with no session can never take
  the composer, so input cannot be sent to a different conversation
- **Tiles and Core never disagree** — a navigation with no bindable slot is
  vetoed, and when auto-tiling is off the focused tile follows Core
- **focusTile() calls loadSession(tile.sid)** — actually swaps Core's session state
- **switchLayout() rearranges grid only** — doesn't touch #msgInner
- **hideGrid() removes overlay** — focused tile's session stays as the live session
- **All mutations are serialized** — focus/close/layout/hide run as single
  transactions on one queue, so two mutators can never interleave

```text
┌─────────────────────────────────────────────┐
│  Toolbar (2 | 4 | 6 | ✕) in .app-titlebar   │
├─────────────────────────────────────────────┤
│  .messages-shell (non-scrolling anchor)     │
│  ├── #messages (Core owns scroll)           │
│  │     #msgInner (live session content)     │
│  └── #ext-tile-grid (absolute, inset:0)     │
│      ┌──────────┐  ┌──────────┐             │
│      │  Tile 1  │  │  Tile 2  │             │
│      │(focused) │  │(snapshot)│             │
│      │transparent│  │  opaque  │             │
│      └──────────┘  └──────────┘             │
└─────────────────────────────────────────────┘
```

Each tile holds `{ id, sid, session, messages, busy, activeStreamId, maximized, cv, mv }`.
Switching focus calls `loadSession()` to swap Core's session, then restores the
incoming tile's composer value + model selection.

## Settings

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `auto_tile` | boolean | `true` | Auto-fill tiles on sidebar session click. When off, no slot is reserved and the focused tile follows Core instead |
| `show_sidebar_badges` | boolean | `true` | Show active-tile-count badges in sidebar |
| `preload_timeout_ms` | number | `5000` | How long a reserved tile slot is held before it is released. A reservation is never stolen before this deadline; only after it expires can another session reuse the slot |

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