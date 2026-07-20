# Hermes WebUI Extensions

[![CI](https://github.com/hermes-webui/hermes-webui-extensions/actions/workflows/extensions.yml/badge.svg)](https://github.com/hermes-webui/hermes-webui-extensions/actions/workflows/extensions.yml)
[![Pages](https://img.shields.io/github/deployments/hermes-webui/hermes-webui-extensions/github-pages?label=pages)](https://hermes-webui.github.io/hermes-webui-extensions/)

This repository is the community extension library for Hermes WebUI.

The goal is to give trusted local extensions a shared place to document,
package, review, and iterate without turning every optional workflow into
Hermes WebUI core code.

## Status

This repository is young but the core loop is live: the registry, CI safety
gates, and the one-click install/uninstall UI in WebUI (Settings → Extensions)
have all shipped. The WebUI extension APIs are still growing, so the conventions
here are a maintained foundation rather than a locked marketplace contract.

For the current WebUI-side loading contract, see
[`docs/EXTENSIONS.md`](https://github.com/nesquena/hermes-webui/blob/main/docs/EXTENSIONS.md)
in the main Hermes WebUI repository. For authoring an entry in this repo, see
[`docs/extension-entry.md`](docs/extension-entry.md).

## What Belongs Here

- Optional local workflows that should not be core WebUI features.
- UI panels, tools, diagnostics, or workspace helpers that run as trusted
  same-origin extension assets.
- Local sidecar integrations, such as native desktop helpers, when their trust
  model and installation steps are explicit.
- Native-host resource bundles that belong to a sidecar extension, as long as
  the entry makes clear that those assets are for the native host and are not
  WebUI core UI.
- Examples that help extension authors follow the current WebUI contract.

## What Does Not Belong Here

- Core bug fixes or required WebUI behavior.
- Remote third-party script loaders.
- Secrets, tokens, credentials, or machine-specific configuration.
- Unreviewed binaries or installers.
- Extensions that require broad WebUI core changes before they can run.

## Trust Model

Hermes WebUI extensions are trusted local code. Extension JavaScript runs in
the WebUI origin and can interact with the authenticated WebUI session. That
means extensions should be reviewed like application code, not like passive
themes.

Extension PRs should disclose:

- what APIs or DOM surfaces they use
- whether they start or talk to a local sidecar process
- whether they access the network, filesystem, native host, or OS APIs
- how a user can install, disable, and remove the extension

## Repository Layout

```text
extensions/
  <extension-id>/
    README.md
    extension.json
    manifest.json
    assets/
    screenshots/
docs/
  extension-entry.md
examples/
  manifest-bundle/
  loopback-sidecar/
```

Each extension should stay self-contained under `extensions/<extension-id>/`.
Shared docs and examples live under `docs/` and `examples/`.

## Compatibility And Testing

Extensions should declare the WebUI extension API surface they expect, not just
the WebUI version they were first tested with. This gives maintainers a way to
check existing extensions when the main Hermes WebUI repo rolls forward.

Extension entries should document:

- supported Hermes WebUI version or release range
- required extension API surface, such as manifest bundles or sidecar metadata
- sidecar health expectations, if a local helper process is used
- install, disable, and uninstall behavior
- manual verification steps
- any future CI check that should protect the extension

This repository validates existing extension entries as the main WebUI extension
contract evolves.

Run the current repo-wide checks locally with:

```bash
node scripts/validate-extensions.mjs
node scripts/test-extension-validator.mjs
node scripts/test-sidecar-contract.mjs
python3 scripts/test-sidecar-scaffold.py
node scripts/scan-extension-safety.mjs
node scripts/sync-sidecar-base.mjs --check
node scripts/check-sidecar-usage.mjs
node scripts/validate-desktop-companion.mjs
node scripts/generate-registry.mjs --out dist/registry.json
```

Pull requests run the same validation, contract, and safety checks in CI. Pushes to `main`
generate the registry and per-extension zip artifacts for GitHub Pages. The
registry entry includes a `download` URL and artifact-level `sha256` for each
extension so the WebUI install client fetches and verifies reviewed bytes before
extracting them. The core-side install client — safe extraction, sha256
verification, and uninstall — has shipped in the main Hermes WebUI repo
(Settings → Extensions).

## Current Entries

The live entry list is maintained in
[`extensions/README.md`](extensions/README.md), and the published, installable set
is the generated registry
([`registry.json`](https://hermes-webui.github.io/hermes-webui-extensions/registry.json)).
See those rather than a hardcoded list here, which drifts on every merge.

The one-click **install flow and registry UI shipped in core** (Settings →
Extensions: browse the registry, review permissions, install/uninstall with
sha256 verification). Merged entries here are validated + safety-scanned in CI,
published to the registry, and become one-click-installable from inside WebUI.
The consent-gated per-extension loopback proxy is shipped. `token-v1` runtimes use
that same-origin path and validate core's per-install token; explicitly legacy
external adapters may still use direct loopback under the core CSP allowance.
Every sidecar entry must document its install and lifecycle requirements.
