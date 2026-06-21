# Extension Entry Contract

This document defines the repository-side shape for extension entries in this
library. It complements the WebUI-side loading contract documented in the main
Hermes WebUI repository.

## Required Files

Each extension entry should include:

```text
extensions/<extension-id>/
  README.md
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

## Compatibility Notes

Because the WebUI extension API is still evolving, extension READMEs should
name the WebUI version, PR, or API surface they were tested against whenever
possible.

Compatibility notes should prefer capability names over exact versions when
possible. For example, say an extension needs manifest bundles and sidecar
metadata rather than only naming the first release where those features worked.
