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

