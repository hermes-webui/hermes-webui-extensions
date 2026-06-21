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
  "capabilities": ["manifest-bundle", "sidecar"],   // e.g. manifest-bundle | sidecar | proxy

  // --- optional local helper process (descriptive until the core sidecar/proxy contract ships) ---
  "sidecar": {
    "type": "loopback",
    "origin": "http://127.0.0.1:17787",
    "health_path": "/health"
  },

  // --- install behavior ---
  "restart_required": false,            // does installing/enabling require a WebUI restart?

  // --- gallery + trust ---
  "screenshots": ["screenshots/pet.png"],
  "permissions": {                      // honest disclosure; drives review + the gallery's "this extension can…" note
    "network": false,
    "filesystem": false,
    "native_host": true,               // true here because of the sidecar
    "sidecar": true
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

## Validation (what CI / safety gates check — #6, #8)

- required fields present; `id` is lowercase-hyphen, unique, matches the directory
- `assets` paths are same-origin / repo-local (no external URLs, no traversal)
- declared `capabilities` exist in the current core extension contract
- `permissions` block present and honest (cross-checked against a static scan of
  the assets — e.g. an extension declaring `network: false` but containing `fetch`
  to an external origin is flagged)
- no secrets / binaries committed; manifest within size bounds

## Open questions (please weigh in)

1. **One file or two?** Author-writes-`extension.json` + Action-derives-`manifest.json`
   (recommended), or authors hand-write both? Trade-off: single source of truth +
   minimal loader contract vs. fewer moving parts / no generation step.
2. **`capabilities` vocabulary.** What's the initial set of capability names, and
   who owns the canonical list (core repo, since it defines the surface)?
3. **`permissions` granularity.** Is the coarse `{network, filesystem, native_host,
   sidecar}` shape enough for the gallery's trust display, or do we want finer
   buckets?
4. **Versioning / updates.** How does the gallery offer "update available" — compare
   `version`, or the `sha256`? Where do older versions go?
5. **Screenshots** — committed in-repo (simple, bloats the repo over time) or
   referenced/hosted (lighter repo, another fetch + integrity question)?

## Not in scope for this RFC

The core-side loader changes, the proxy security model (#5), and the install
mechanics (#4/#9) — this RFC is only the **entry metadata shape**. Those are
tracked separately.
