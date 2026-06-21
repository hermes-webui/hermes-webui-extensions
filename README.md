# Hermes WebUI Extensions

This repository is the community extension library for Hermes WebUI.

The goal is to give trusted local extensions a shared place to document,
package, review, and iterate without turning every optional workflow into
Hermes WebUI core code.

## Status

This repository is intentionally early. The WebUI extension APIs and backend
support are still evolving, so the conventions here should be treated as a
foundation for review rather than a locked marketplace contract.

For the current WebUI-side loading contract, see `docs/EXTENSIONS.md` in the
main Hermes WebUI repository.

## What Belongs Here

- Optional local workflows that should not be core WebUI features.
- UI panels, tools, diagnostics, or workspace helpers that run as trusted
  same-origin extension assets.
- Local sidecar integrations, such as native desktop helpers, when their trust
  model and installation steps are explicit.
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
    manifest.json
    assets/
    screenshots/
docs/
  extension-entry.md
examples/
  manifest-bundle/
```

Each extension should stay self-contained under `extensions/<extension-id>/`.
Shared docs and examples live under `docs/` and `examples/`.

## First Phase Scope

This first phase defines repository shape and contribution expectations only.
It does not add an extension registry UI, install flow, backend proxy, or any
Desktop Companion assets.

