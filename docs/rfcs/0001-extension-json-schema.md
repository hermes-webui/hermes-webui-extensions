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

  // --- install behavior ---
  "restart_required": false,            // does installing/enabling require a WebUI restart?

  // --- gallery + trust ---
  "screenshots": ["screenshots/pet.png"],
  // Honest disclosure; drives review + the gallery's "this extension can…" note.
  // Finer-grained than a coarse 4-bool set BECAUSE extension JS runs in the WebUI
  // origin and can call authenticated WebUI APIs — that authority must be surfaced
  // explicitly, not hidden inside a generic "network" bool. (per @santastabber)
  "permissions": {
    "webui_authenticated_api": true,   // calls authenticated same-origin WebUI APIs (the in-origin authority)
    "webui_dom": ["composer", "sidebar"],  // which UI surfaces it reads/mutates (coarse named surfaces)
    "network_external": false,         // any non-same-origin / non-loopback fetch
    "loopback_sidecar": true,          // talks to a declared localhost sidecar
    "filesystem": false,               // reads/writes local files (via a sidecar/native host)
    "native_host": true,               // starts or drives a native/desktop process
    "storage": ["localStorage"]        // browser storage it uses
  },

  // --- compatibility ---
  "min_webui_version": "0.51.0"         // optional; prefer `capabilities` over hard version pins where possible
}
```

### Fields the **Action adds** to the published registry entry (authors don't write these)

```jsonc
{
  "download": "https://<pages-host>/artifacts/desktop-companion-0.1.0.zip",
  "sha256": "…",                        // integrity hash; install verifies bytes == reviewed entry
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

## Open questions (please weigh in)

1. **One file or two?** Author-writes-`extension.json` + Action-derives-`manifest.json`
   (recommended), or authors hand-write both? Trade-off: single source of truth +
   minimal loader contract vs. fewer moving parts / no generation step.
2. **`capabilities` vocabulary + ownership.** Confirmed core-owned; what's the
   initial shipped set? Proposed today: `manifest-bundle`, `loopback-sidecar`.
   Future: `sidecar-proxy` (gated on core), later in-process routes.
3. **`permissions` granularity.** The block above is a first cut at finer buckets
   (surfacing in-origin authed-API access explicitly). Right set / right names?
4. **Versioning / updates.** How does the gallery offer "update available" — compare
   `version`, or the `sha256`? Where do older versions go?
5. **Screenshots** — committed in-repo (simple, bloats the repo over time) or
   referenced/hosted (lighter repo, another fetch + integrity question)?

## Not in scope for this RFC

The core-side loader changes, the proxy security model (#5), and the install
mechanics (#4/#9) — this RFC is only the **entry metadata shape**. Those are
tracked separately.
