# RSS Feeds

RSS Feeds is a Hermes WebUI extension that adds a full RSS/Atom reader to the
WebUI: a two-pane overlay with categorized subscriptions in the sidebar and
entries on the right — plus keyword filtering, full-text search, cross-device
read tracking, and optional AI summaries.

## What It Does

- **Subscriptions** — add/remove feeds, grouped into categories with per-feed
  favicons; enable/disable feeds individually.
- **Reading** — paginated entry cards with age stamps; entries you've clicked
  are marked read (server-side, so read state follows you across devices).
- **Auto-refresh** — background fetch on a configurable interval with a live
  countdown in the sidebar; failures surface in a persistent panel, not a toast.
- **Keyword filter** — keep only entries whose title/summary match your saved
  keywords (case-insensitive, word-boundary matching); toggle on/off anytime.
- **Search** — free-text search across every feed's title + summary.
- **AI summaries (optional)** — summarize an article, a feed, a category, or
  everything. Free/local backends only: local Ollama, OpenRouter `:free`
  models, or Gemini free tier — configurable in the settings popup, with a
  live status line showing exactly which backend/model will run and a
  one-click connectivity test.

## Current Shape

```text
Hermes WebUI page
  -> assets/feeds-inject.js   builds the overlay + titlebar launcher
  -> assets/feeds.js          all reader logic (fetch via the sidecar proxy)
  -> assets/feeds.css         self-contained styles (host CSS vars only)
WebUI sidecar proxy (after consent)
  -> /api/extensions/rss-feeds/sidecar/api/feeds/*
  -> loopback sidecar on 127.0.0.1:17797 (sidecar/sidecar.py)
     -> SQLite at $HERMES_FEEDS_STATE_DIR/feeds.db
```

## Network destinations (why `network_external: true`)

The **browser** only ever talks to the WebUI's same-origin sidecar proxy — it
makes no direct external requests. All outbound network access happens in the
**sidecar** (127.0.0.1), and it is fully enumerated here:

| Destination | When | Data sent |
|---|---|---|
| **Feed hosts you subscribe to** | on refresh / add-feed | GET of the exact feed URL you subscribed — including any query string that URL already contains (the sidecar adds none of its own, and sends no cookies/identifiers) |
| **Article URLs from those feeds** | only when you Summarize an article | plain GET of the article URL to extract its text |
| **`icons.duckduckgo.com`, then `www.google.com/s2/favicons`** | first time a feed's favicon is needed | the feed's domain, to fetch a 16px site icon (cached on disk after) |
| **`openrouter.ai`** | only when a Summarize action routes to OpenRouter | article text + `OPENROUTER_API_KEY` (Authorization header) |
| **`generativelanguage.googleapis.com`** | only when a Summarize action routes to Gemini | article text + `GEMINI_API_KEY` / `GOOGLE_API_KEY` (`x-goog-api-key` header) |

Every sidecar fetch is SSRF-guarded: it resolves the hostname, rejects any
non-global IP (loopback, private, link-local, CGNAT/metadata ranges), and pins
the connection to the validated IP (re-validating on each redirect hop). The two
credentialed LLM calls disable redirects entirely so a key can never be replayed
to a redirected host. Responses are size- and time-capped. There is no telemetry,
no analytics, and no background beacon of any kind.

Separately, the per-article **Share** buttons build links to social hosts
(Twitter/X, Facebook, Telegram, WhatsApp) and open them in a new browser tab.
That is user-initiated navigation — the extension itself sends nothing to those
hosts.

## Filesystem access

The sidecar reads/writes only:

- **`$HERMES_FEEDS_STATE_DIR/feeds.db`** (default `~/.hermes/webui/feeds.db`) —
  its SQLite store (feeds, entries, summaries, settings) and the on-disk favicon
  cache alongside it.
- **`sidecar/feeds_seed.txt`** (bundled) — read-only starter subscription list.

Summarize credentials (`OPENROUTER_API_KEY` / `GEMINI_API_KEY` / `GOOGLE_API_KEY`)
are read **only from the sidecar's own process environment** — the sidecar does not
read `~/.hermes/.env` or any other credential file.

## Capabilities

- `manifest-bundle`
- `loopback-sidecar`

## Supported WebUI version / API surface

Requires a WebUI build containing the `token-v1` sidecar-proxy authentication
boundary (core [#6331](https://github.com/nesquena/hermes-webui/pull/6331), first
in `exp-v0.52.129`) — not any `≥ 0.16` release. Until #6331 reaches the stable
channel, run an `exp-v0.52.129`+ build. Required surface:

- manifest-bundled asset injection (`manifest.json` scripts/stylesheets)
- `token-v1` sidecar proxy at `/api/extensions/<id>/sidecar/*` (core injects
  `X-Hermes-Sidecar-Token`; approve the sidecar in **Settings → Extensions**)
- a titlebar/host element to append the launcher button to (falls back to
  `document.body`)

All UI is extension-owned DOM (a body-level overlay); no core views are
modified beyond adding the launcher button.

## Sidecar (token-v1 scaffold)

Built on the canonical Hermes sidecar scaffold. `sidecar/sidecar.py` and
`sidecar/sidecar_base.py` are vendored **byte-identical** from
`examples/sidecar-scaffold/` (CI: `scripts/sync-sidecar-base.mjs --check`); this
extension's own code is `sidecar/routes_impl.py` (a thin adapter over the reader
logic) + `sidecar/feeds.py` (feed fetch/parse/summaries — RSS/Atom parsed with
stdlib `xml.etree`, no third-party deps, so it runs cleanly under `python3 -S`)
+ `sidecar/shim.py` (state dir + JSON helper). `sidecar/sidecar.json` declares
`{id, port, proxy_auth}`. Runs on `127.0.0.1:17797`; `GET /health` is the only
tokenless route.

**Proxy auth — `token-v1`.** The loopback port is reachable by any local process
and the WebUI proxy strips inbound credentials, so the sidecar can't tell a
proxied request from a direct one. Core mints a per-extension secret and injects
`X-Hermes-Sidecar-Token`; the scaffold validates it **deny-by-default** at one
dispatch chokepoint (every route but `/health`). Missing token file → `503`,
wrong token → `401`. **Honest scope:** this protects against callers that can't
read the user's state dir (other-UID users, host containers, sandboxed
processes) — the same level as WebUI's own auth. It does **not** defend against
arbitrary same-UID code, which can read the token file directly. Auth is
fail-closed while WebUI auth is off — enable it in **Settings → Password**, then
approve the sidecar in **Settings → Extensions**.

| Setting | Source | Default |
|---|---|---|
| Port | `sidecar/sidecar.json` | `17797` |
| State dir (feeds.db + token) | `HERMES_WEBUI_STATE_DIR` | `~/.hermes/webui` |

Install the systemd user unit — it runs `/usr/bin/python3 -S -u sidecar.py` with
no token in the unit (core provisions it in the state dir). No pip dependencies:
the sidecar is stdlib-only.

```bash
cp sidecar/rss-feeds-sidecar.service ~/.config/systemd/user/
systemctl --user enable --now rss-feeds-sidecar
```

A starter subscription list ships in `sidecar/feeds_seed.txt`.

**Health:** `GET http://127.0.0.1:17797/health` returns
`{"ok": true, "sidecar_base_version": N}`. The WebUI diagnostics card probes this
cross-origin (credentials omitted); the token-bearing proxy path serves real
traffic.

**Docker limitation:** a bridge-networked WebUI container cannot reach a host-run
sidecar's `127.0.0.1:17797` (loopback is namespace-local). Sidecars work only
where core and the sidecar share a network namespace and the state dir.

## Install, disable, uninstall

- **Install**: copy the extension into the WebUI's gallery extension dir
  (`$HERMES_WEBUI_STATE_DIR/extensions/`, default `~/.hermes/webui/extensions/`),
  enable it in **Settings → Extensions**, start the sidecar, reload.
- **Disable**: toggle off in **Settings → Extensions** — the launcher and
  overlay stop being injected on the next render. No restart required.
- **Uninstall**: remove it in **Settings → Extensions** (or delete the
  directory). Feed data remains in `feeds.db` under the state dir; delete that
  file to remove all subscriptions/entries/summaries. The browser keys under the
  `mc.feeds.*` prefix (read state, view preference, page sizes) can be cleared
  from DevTools.

## Manual verification

1. Click the Feeds titlebar button → the two-pane overlay opens; add a feed by
   URL → entries appear after refresh.
2. Settings gear → change entries-per-page / visible feeds → Save → the list
   re-renders accordingly.
3. Set an auto-refresh interval → the sidebar countdown ticks and a refresh
   fires exactly when it reaches zero.
4. Summarize an article (with a summary backend configured) → a job spinner
   appears and the digest lands under 🧠 Summaries; the settings status line
   shows which backend/model ran.
5. Disable the extension in Settings → Extensions → reload: no launcher, no
   overlay, no sidecar traffic.

## Future CI checks

- `node --check assets/feeds.js assets/feeds-inject.js`
- JSON validity of `extension.json` / `manifest.json`
- `python3 -m py_compile sidecar/*.py`
- Sidecar contract test: `GET /health` returns `{"ok": true}`;
  `POST /api/feeds` + `GET /api/feeds/entries` round-trip on a temp state dir.

## AI summary backends (optional)

The defaults target free tiers, but this is **not enforced** — a paid or
billing-enabled key still works. In particular a `GEMINI_API_KEY` inherits
whatever tier its Google Cloud project is on, so a project with billing enabled
**can incur charges**. Use a free-tier key if you want a hard no-cost guarantee.
Configure in the feeds **Settings** popup:

- **Local (ollama)** — an Ollama instance on `localhost:<port>` (default
  `11434`). The model dropdown lists whatever is installed on that Ollama. If
  your model runs on another host, set up your own port-forward to that local
  port — the extension does not open any tunnel itself.
- **OpenRouter** — needs `OPENROUTER_API_KEY` in the sidecar's **process
  environment** (e.g. via the unit's `EnvironmentFile=`); the sidecar never reads
  it from a file itself. Defaults to a `:free` model.
- **Gemini** — needs `GEMINI_API_KEY` / `GOOGLE_API_KEY` in the process
  environment likewise. Defaults to the free tier (but see the billing note above).
- **Auto** — local → OpenRouter → Gemini fallback chain.

## Storage

- Server: SQLite `feeds.db` in the state dir (feeds, entries, summaries,
  settings) plus the on-disk favicon cache.
- Browser (`localStorage`):
  - `mc.feeds.read` — read-state cache (which entries you've opened).
  - `mc.feeds.read.visibility` — show/hide-read view preference.
  - `mc.feeds.pageSize`, `mc.feeds.pageSize.clicked`,
    `mc.feeds.pageSize.summaries` — entries-per-page for each view.

## Install For Local Testing

```bash
# from a hermes-webui checkout with the gallery extension dir enabled
cp -r rss-feeds "$HERMES_WEBUI_STATE_DIR/extensions/"   # default: ~/.hermes/webui/extensions/
# register/enable it in Settings → Extensions, start the sidecar, reload
```
