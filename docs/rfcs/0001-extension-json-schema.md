# RFC 0001 — Extension entry metadata (`extension.json`)

**Status:** Draft / for discussion
**Audience:** extension library maintainers + contributors

This is an **RFC, not a locked contract.** It proposes a concrete shape for
per-extension metadata so we have something specific to react to. Please leave
comments on the PR — field names, what's required vs. optional, and the open
questions at the end are all up for debate before anything is implemented.

## Why

Two roadmap pieces need a metadata file per extension:

- the **registry generator** (#3) — discovers entries, validates them, and emits a
  public `registry.json` (deployed to GitHub Pages) that the in-WebUI gallery reads;
- the **install flow** (#4) + **delivery** (#9) — needs name/description/screenshots
  to show, a download + integrity hash to install, and a `restart_required` signal;
- **CI validation** (#6) + **safety gates** (#8) — validate entries against a schema
  on every PR.

A single declared file is the natural source of truth for all of these.

## Proposed: author writes `extension.json`, the Action derives the loader manifest

Recommendation (open to debate — see Open Questions): each
`extensions/<id>/extension.json` is the **one file an author maintains**. The
registry GitHub Action **derives** the minimal runtime `manifest.json` the core
loader (`api/extensions.py`) consumes, from the `assets` block below. Rationale:
single source of truth for authors; the loader contract stays minimal and
auditable (and core-owned). The alternative — two hand-written files — is also on
the table.

## Proposed schema

```jsonc
{
  // --- identity ---
  "id": "desktop-companion",            // required; lowercase, hyphens, unique in the repo; should match the directory name
  "name": "Desktop Companion",          // required; human-facing title
  "description": "A digital pet assistant that lives alongside your chats.",  // required; one-paragraph gallery blurb
  "version": "0.1.0",                   // required; semver
  "author": "franksong2702",            // required; GitHub handle or name
  "homepage": "https://github.com/franksong2702/hermes-webui-desktop-companion",  // optional

  // --- what the loader injects (same-origin only; bare paths resolve under /extensions/) ---
  "assets": {
    "scripts": ["assets/companion-adapter.js"],
    "stylesheets": ["assets/companion-adapter.css"]
  },

  // --- what core surface this entry needs (capability names, not version pins) ---
  // capabilities are CORE-OWNED: the canonical list lives in the core repo, since
  // it defines the actual surface. Only list a capability core has SHIPPED.
  // `manifest-bundle` and `loopback-sidecar` (direct browser→loopback, shipped today)
  // are valid now; do NOT list `sidecar-proxy` until core ships the same-origin proxy.
  "capabilities": ["manifest-bundle", "loopback-sidecar"],

  // --- optional local helper process. The `sidecar` block is descriptive metadata. ---
  // Today an extension reaches this directly (browser → loopback, allowed by the
  // core CSP connect-src). A same-origin proxy to it is FUTURE work (capability
  // `sidecar-proxy`), not assumable by entries yet.
  "sidecar": {
    "type": "loopback",
    "origin": "http://127.0.0.1:17787",
    "health_path": "/health"
  },

  // --- install / lifecycle behavior ---
  // Different states restart independently (per @franksong2702 / Desktop Companion):
  // installing WebUI assets, starting a loopback sidecar, and launching a native
  // host are separate. Distinguish what actually needs to restart; leave
  // native-host autostart preference owned by the EXTENSION, not WebUI core.
  "lifecycle": {
    "webui_restart_required": false,   // do the injected WebUI assets need a WebUI restart to take effect?
    "sidecar_start_required": true,    // install/enable needs a loopback sidecar to be started
    "native_host_start_required": true,// a native/desktop host process must launch
    "native_host_autostart": "extension_owned"  // WebUI core does NOT own this; the extension decides
  },

  // --- gallery + trust ---
  "screenshots": ["screenshots/pet.png"],   // in-repo for the first pass (per maintainers)
  // Honest disclosure; drives review + the gallery's "this extension can…" note.
  // Finer-grained than a coarse bool set BECAUSE extension JS runs in the WebUI
  // origin and can call authenticated WebUI APIs — that authority must be surfaced
  // explicitly. Vocabulary distinguishes purpose, not just on/off (per @santastabber
  // + @franksong2702, grounded in Desktop Companion's real surface).
  "permissions": {
    // WebUI API access BY PURPOSE — read (session/status) vs write (chat/action)
    "webui_api": { "read": ["sessions", "status"], "write": [] },
    // navigation helpers it uses (e.g. window.loadSession), distinct from API writes
    "webui_navigation": true,
    // extension-OWNED DOM vs mutation/replacement of CORE views
    "dom": { "owned": true, "mutates_core_views": false },
    // extension-owned storage keys vs touching EXISTING WebUI keys
    "storage": { "owned": ["companion-prefs"], "shared_webui_keys": ["hermes-webui-session"] },
    "loopback_sidecar": true,          // talks to a declared localhost sidecar
    "native_host": true,               // native host / windowing (transparent windows, menus, drag, restart)
    // filesystem: distinguish ARBITRARY local file access from serving BUNDLED assets
    "filesystem": { "arbitrary": false, "serves_bundled_assets": true },
    "network_external": false          // any non-same-origin / non-loopback fetch
  },

  // --- compatibility (capability-first; version only as a fallback hint) ---
  "min_webui_version": "0.51.0"         // optional fallback; prefer `capabilities` over hard version pins
}
```

### Fields the **Action adds** to the published registry entry (authors don't write these)

```jsonc
{
  "download": "https://<pages-host>/artifacts/desktop-companion-0.1.0.zip",
  "sha256": "…",                        // integrity hash; install verifies bytes == reviewed entry
  "artifact_size": 123456,
  "published_at": "2026-…",
  "entry_path": "extensions/desktop-companion/"
}
```

## Manifest derivation must preserve core hardening (per @santastabber)

When the Action derives the runtime `manifest.json` from `assets`, the output
**must satisfy every rule the core loader already enforces** — same-origin asset
paths only (`/extensions/` or `/static/`), no traversal/encoded dot-segments, the
URL-count and manifest-size caps, bare paths resolving under `/extensions/`. The
derivation never relaxes those; if an entry's `assets` can't produce a
core-valid manifest, the entry fails validation. The generated manifest is held
to the *same* bar as a hand-written one.

## Install metadata / lifecycle the schema must support (per @santastabber)

The install flow (#4/#9) needs more than a download URL. Track in the entry +
delivery design:

- **artifact integrity** — `sha256` verified before extract (Action-added field).
- **zip-slip-safe extraction** — paths confined to the extension dir; reject
  `..`/absolute members (the loader's `_is_safe_relative_path` shape).
- **installed file tracking** — record the file set an install placed, so…
- **rollback + clean uninstall** — install is reversible; uninstall removes
  exactly what was placed and nothing else.

## Validation (what CI / safety gates check — #6, #8)

- required fields present; `id` is lowercase-hyphen, unique, matches the directory
- `assets` paths are same-origin / repo-local (no external URLs, no traversal) AND
  the *derived* manifest passes the core loader's hardening rules
- declared `capabilities` are in the **core-owned** capability list and SHIPPED
  (e.g. reject `sidecar-proxy` until core ships it)
- `permissions` block present and honest — cross-checked against a static scan of
  the assets (e.g. `network_external:false` + an external `fetch` → flagged;
  `webui_authenticated_api:false` + calls to authed endpoints → flagged)
- no secrets / binaries committed; manifest within size bounds

## Resolved (maintainer consensus)

- **One file (not two).** Both maintainers favor: authors maintain `extension.json`,
  CI derives the runtime loader manifest. Frank's rationale from real Desktop
  Companion code: the author-facing metadata (identity, assets, sidecar,
  permissions, compatibility, source repo, screenshots, install/lifecycle notes)
  is much richer than the loader manifest, and hand-writing both would drift.
- **Capabilities are core-owned; declare only shipped ones.** Desktop Companion
  declares `manifest-bundle` + `loopback-sidecar` today, NOT `sidecar-proxy`.
- **Screenshots in-repo for the first pass.** Revisit if repo size becomes an issue.
- **Updates:** user-facing comparison by `version`; integrity by `sha256`.
- **Compatibility capability-first**, `min_webui_version` as a fallback hint only.

## Open questions (please weigh in)

1. **`permissions` vocabulary — final shape.** The block above now distinguishes
   purpose (API read vs write, owned-DOM vs core-view mutation, owned-storage vs
   shared WebUI keys, native-host/windowing, bundled-assets vs arbitrary FS),
   grounded in Desktop Companion's real surface. Is this the right set + names, or
   still too fine / too coarse in places?
2. **`lifecycle` shape.** Splitting `webui_restart_required` /
   `sidecar_start_required` / `native_host_start_required` and leaving
   `native_host_autostart` extension-owned — does that match how the install flow
   (#4) should reason about "what needs to (re)start"?
3. **Versioning details.** `version` drives "update available" in the gallery, but
   where do older artifact versions live, and does the gallery pin/verify the
   `sha256` of the specific version it offers?

## Not in scope for this RFC

The core-side loader changes, the proxy security model (#5), and the install
mechanics (#4/#9) — this RFC is only the **entry metadata shape**. Those are
tracked separately.
