# Contributing

Thanks for helping build the Hermes WebUI extension ecosystem.

The extension system is still taking shape, so keep PRs small and explicit.
If an extension needs new WebUI APIs, start by describing the requirement
before adding a large implementation.

## Contribution Rules

- Keep each extension self-contained under `extensions/<extension-id>/`.
- Include a `README.md` with install, disable, uninstall, and trust notes.
- Include a `manifest.json` that uses same-origin asset paths.
- Do not commit secrets, tokens, credentials, cookies, private endpoints, or
  machine-specific state.
- Do not load remote third-party scripts at runtime.
- Disclose any network, filesystem, native host, sidecar, or OS integration.
- Bind sidecar services to localhost by default and document any ports used.
- Document the WebUI version or extension API surface the entry was tested
  against.
- Prefer docs and examples when the WebUI extension contract is still changing.

## Pull Request Checklist

Before opening a PR, confirm:

- [ ] The change belongs in the extension library, not Hermes WebUI core.
- [ ] The extension or example is isolated under one directory.
- [ ] The README explains the user workflow and trust model.
- [ ] The manifest uses local extension assets.
- [ ] Install, disable, and uninstall behavior is documented.
- [ ] Any sidecar or native integration is documented clearly.
- [ ] Compatibility and verification notes are included.
- [ ] No secrets, generated local state, or unreviewed binaries are included.

## Review Expectations

Maintainers may ask for an extension to start as documentation or an example
until the WebUI-side API is ready. This is expected while the foundation work
lands in stages.
