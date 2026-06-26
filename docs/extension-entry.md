# Extension Entry Contract

This document defines the repository-side shape for extension entries in this
library. It complements the WebUI-side loading contract documented in the main
Hermes WebUI repository.

## Required Files

Each extension entry should include:

```text
extensions/<extension-id>/
  README.md
  extension.json
  manifest.json
  assets/
```

Optional files:

```text
extensions/<extension-id>/
  screenshots/
  docs/
  scripts/
```

## Manifest Shape

`extension.json` is the author-facing metadata source for registry, gallery,
trust, capability, and lifecycle information. `manifest.json` is the current
runtime loader manifest consumed by Hermes WebUI.

The current WebUI loader reads a manifest bundle with an `extensions` array.
Extension entries should keep paths local to the extension directory.

```json
{
  "extensions": [
    {
      "id": "example-extension",
      "scripts": ["assets/example-extension.js"],
      "stylesheets": ["assets/example-extension.css"]
    }
  ]
}
```

Use stable, lowercase extension IDs. Prefer letters, numbers, and hyphens.

## Sidecar Metadata

Extensions that depend on a local helper process should declare it in manifest
metadata once the WebUI-side contract supports that field. This lets WebUI show
users that an extension has a local dependency and eventually report coarse
health state without hardcoding extension-specific behavior.

Example shape:

```json
{
  "extensions": [
    {
      "id": "desktop-companion",
      "name": "Desktop Companion",
      "scripts": ["assets/companion-adapter.js"],
      "stylesheets": ["assets/companion-adapter.css"],
      "sidecar": {
        "type": "loopback",
        "origin": "http://127.0.0.1:17787",
        "health_path": "/health"
      }
    }
  ]
}
```

The `sidecar` object should stay descriptive unless the main WebUI repo defines
stronger behavior. Declaring a sidecar should not imply install, auto-start,
proxy, or public network access semantics.

Suggested fields:

- `type`: use `loopback` for a local HTTP service bound to localhost
- `origin`: the localhost origin the extension expects
- `health_path`: a read-only path WebUI can use for coarse health checks

## README Shape

Each extension README should cover:

- what the extension does
- who it is for
- installation steps
- disable and uninstall steps
- WebUI APIs or DOM surfaces used
- trust model and permissions
- sidecar or native host behavior, if any
- known limitations
- compatibility and verification notes

## Sidecar And Native Host Notes

Some extensions may need a local process outside the browser, such as a desktop
helper, native window, model bridge, or OS integration. Those entries should
document:

- how the sidecar starts and stops
- default host and port
- whether it exposes any network listener
- whether it reads or writes local files
- whether it can run without modifying Hermes WebUI core
- what breaks if the WebUI extension API changes

Sidecars should bind to localhost by default and avoid public network exposure.

## Post-Install Guidance

Extensions that need a local app, sidecar, or native host should include
`post_install` so gallery UIs can tell users what to do after clicking Install.
This is user-facing guidance; lifecycle remains the machine-readable source for
what must start.

Example:

```json
{
  "post_install": {
    "summary": "Install enables the WebUI bridge. In the Desktop Companion repo, run npm run start:pet to launch the desktop pet.",
    "docs_url": "https://github.com/franksong2702/hermes-webui-desktop-companion#after-gallery-install",
    "requires_local_app": true,
    "local_app_label": "Desktop Companion app"
  }
}
```

Suggested fields:

- `summary`: one short sentence shown after install
- `docs_url`: an http(s) link with setup/start instructions
- `requires_local_app`: `true` when the extension needs a local app or native
  host for its visible behavior
- `local_app_label`: the reader-facing name of that local app or host

## Compatibility Notes

Because the WebUI extension API is still evolving, extension READMEs should
name the WebUI version, PR, or API surface they were tested against whenever
possible.

Compatibility notes should prefer capability names over exact versions when
possible. For example, say an extension needs manifest bundles and sidecar
metadata rather than only naming the first release where those features worked.

## Validation And Registry

Run the repo-wide validator before opening or updating an extension PR:

```bash
node scripts/validate-extensions.mjs
node scripts/scan-extension-safety.mjs
```

The validator scans every `extensions/*/extension.json`, checks required files,
safe local asset paths, runtime `manifest.json` consistency, shipped capability
names, lifecycle and permission shape, and selected permissions-vs-code drift
such as WebUI API read/write disclosures.

The safety scan layers on high-risk checks for entry files before they can land:
obvious secrets, symlinks or unsafe paths, blocked JavaScript execution patterns,
undeclared external network literals, localStorage writes without owned-key
declarations, and generated artifact hash/size consistency.

Generate the registry locally with:

```bash
node scripts/generate-registry.mjs --out dist/registry.json
```

The generated registry is the gallery/install index consumed by future WebUI
extension UI work. The first version includes the reviewed entry metadata plus
Action-added fields such as `entry_path`, `runtime_manifest_path`,
`published_at`, `file_count`, and per-file `file_sha256` values.

The generator also writes deterministic per-extension zip artifacts under
`dist/artifacts/` and adds install-delivery fields to each registry entry:

- `download`: the GitHub Pages URL for the reviewed extension zip
- `sha256`: the artifact-level SHA-256 hash the install client must verify
- `artifact_size`: the artifact byte size

Zip members are rooted under the extension id, for example
`desktop-companion/extension.json`, so the core install client can extract into
the extension root with a zip-slip-safe path check. The core WebUI install
client still owns fetch, hash verification, extraction, installed-file tracking,
rollback, and uninstall.
