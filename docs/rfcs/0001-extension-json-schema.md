# RFC 0001 — Extension entry metadata (`extension.json`)

**Status:** Implemented; updated to match the shipped registry contract
**Audience:** extension library maintainers + contributors

This RFC records the design discussion that produced the current extension
metadata contract. The implementation now validates both author-maintained files:
the library-facing `extension.json` and core's minimal runtime `manifest.json`.

## Why

Two roadmap pieces need a metadata file per extension:

- the **registry generator** (#3) — discovers entries, validates them, and emits a
  public `registry.json` (deployed to GitHub Pages) that the in-WebUI gallery reads;
- the **install flow** (#4) + **delivery** (#9) — needs name/description/screenshots
  to show, a download + integrity hash to install, and a `restart_required` signal;
- **CI validation** (#6) + **safety gates** (#8) — validate entries against a schema
  on every PR.

The richer library declaration and the minimal runtime declaration split those
responsibilities; CI is the source of truth for whether they agree.

## Implemented: author maintains both declarations and CI checks agreement

Each extension maintains `extension.json` for registry, permissions, lifecycle,
and compatibility metadata, plus the minimal `manifest.json` consumed by core's
loader (`api/extensions.py`). CI requires IDs, asset lists, and sidecar wire fields
to agree exactly. The registry generator packages the reviewed manifest; it does
not synthesize or replace it.

## Implemented `extension.json` schema

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
  // `manifest-bundle` and `loopback-sidecar` are valid core capabilities.
  // The sidecar auth/proxy posture is declared by `sidecar.proxy_auth`; there is
  // no separate `sidecar-proxy` capability.
  "capabilities": ["manifest-bundle", "loopback-sidecar"],

  // --- optional local helper process. The `sidecar` block is descriptive metadata. ---
  // token-v1 runtimes are reached through core's consent-gated same-origin proxy.
  // An external runtime may stay explicitly legacy while its browser adapter
  // still uses direct loopback access, as Desktop Companion currently does.
  "sidecar": {
    "type": "loopback",
    "origin": "http://127.0.0.1:17787",
    "health_path": "/health",
    "proxy_auth": "legacy",
    "runtime": {
      "kind": "external",
      "repository": "https://github.com/franksong2702/hermes-webui-desktop-companion"
    }
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

## Manifest consistency preserves core hardening (per @santastabber)

The checked-in runtime `manifest.json` must satisfy every rule the core loader
already enforces: same-origin asset paths only (`/extensions/` or `/static/`), no
traversal or encoded dot-segments, URL-count and manifest-size caps, and bare
paths resolving under `/extensions/`. CI also compares it with `extension.json`;
drift in assets or sidecar wire fields fails validation before packaging.

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
- `assets` paths are same-origin / repo-local (no external URLs, no traversal),
  the checked-in manifest passes core loader hardening, and both declarations agree
- declared `capabilities` are in the **core-owned** capability list and SHIPPED
  (`proxy_auth` is sidecar metadata, not a separate capability)
- loopback sidecars explicitly declare proxy auth plus vendored/external runtime
  ownership; vendored runtimes carry the canonical token-v1 scaffold while
  external runtimes name their source repository
- `permissions` block present and honest — cross-checked against a static scan of
  the assets (e.g. `network_external:false` + an external `fetch` → flagged;
  `webui_authenticated_api:false` + calls to authed endpoints → flagged)
- high-risk entry scan blocks obvious secrets, symlinks or unsafe paths, dangerous
  JavaScript execution patterns, undeclared external network literals, and
  undeclared localStorage writes
- generated registry artifacts must carry matching `download`, artifact-level
  `sha256`, and `artifact_size` fields, and the generated zip must be readable as
  an extension artifact
- no secrets / binaries committed; manifest within size bounds

## Resolved (maintainer consensus)

- **Two reviewed files with exact drift checks.** Authors maintain rich
  `extension.json` metadata and core's minimal runtime `manifest.json`. CI compares
  their identity, assets, and sidecar wire fields, while the registry packages the
  checked-in manifest unchanged.
- **Capabilities are core-owned; declare only shipped ones.** Desktop Companion
  declares `manifest-bundle` + `loopback-sidecar`; proxy auth lives in its
  `sidecar` block rather than a separate capability.
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
