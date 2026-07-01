# Vision & Roadmap — Hermes WebUI Extensions

This repository is the **curated extension library** for Hermes WebUI. This
document describes where it's going so contributors can build toward a shared
target. It's a living plan, not a frozen spec — expect it to evolve as the
foundation lands in stages.

## The thesis

Hermes WebUI core stays **lean and carefully curated** — deliberately *not*
kitchen-sink. Just because something *can* be built into the core for everyone
doesn't mean it *should* be. Everything genuinely useful that doesn't belong in
the curated core gets a first-class home as an **extension**.

The goal: a large library of **vetted** extensions, and an in-WebUI
**Settings → Extensions** experience where you browse a gallery and install what
you want in one click. The core stays clean for everyone; a rich ecosystem grows
around it. Out-of-scope-for-core ideas get *redirected here* instead of rejected.

## Two repos, clean split

- **`nesquena/hermes-webui` (core)** — the extension *infrastructure*: the loader,
  manifest contract, same-origin asset injection, sandboxed static serving, the
  Settings → Extensions UI, status/diagnostics, and the authoritative loading
  contract in [`docs/EXTENSIONS.md`](https://github.com/nesquena/hermes-webui/blob/master/docs/EXTENSIONS.md).
- **`hermes-webui/hermes-webui-extensions` (this repo)** — the *entries*: curated
  extension submissions, library conventions, examples, trust docs, the registry,
  and compatibility/CI.

Contract and runtime live in core; entries and conventions live here.

## Trust model (non-negotiable)

Extensions are **trusted local code**, not passive themes. Extension JavaScript
runs in the **WebUI origin** and can interact with the **authenticated session**,
so every entry is reviewed like application code. Entries must disclose the APIs
and DOM surfaces they touch, any local sidecar process, any network/filesystem/
native-host/OS access, and how to install/disable/remove them.

Because the library is **curated**, *being merged is the vetting*. The one-click
install trusts the registry precisely because every entry in it passed review.

## Capability ladder

Extensions grow in capability in stages. Each rung is independently shippable.

1. **Asset bundling** ✅ *done* — a manifest bundles an extension's scripts/styles
   so multi-extension installs don't require hand-maintained env-var lists.
   Same-origin only (`/extensions/` or `/static/`).
2. **Settings UI** ✅ *shipped* — a Settings → Extensions surface: listing,
   enable/disable, and one-click install/uninstall from the gallery (with sha256
   verification against the registry), plus a diagnostics tab.
3. **Sidecar metadata + direct loopback** *foundation merged (descriptive metadata); direct loopback shipped* — an extension can
   *declare* a local helper process (`sidecar: { type, origin, health_path }`) so
   WebUI can show the dependency and, later, report coarse health. **Today**, an
   extension's JS can talk to a trusted loopback sidecar **directly** — the core
   CSP `connect-src` already allows `http://127.0.0.1:*` / `localhost` / `ws://`
   loopback — so direct browser → sidecar is the *current* sidecar-class pattern.
4. **Backend routes / same-origin proxy** *planned / future* — a **future, opt-in,
   per-extension same-origin proxy** (`/extensions/<id>/sidecar/*` → the declared
   loopback origin). This is *not* required for sidecar extensions to work today
   (see #3 — direct loopback already works); it's future core work for cases the
   direct path can't cover (e.g. the sidecar's own CORS, hiding the port, uniform
   same-origin auth). Repo entries should **not** depend on it yet. In-process
   server route handlers are a later, separately-gated step beyond that.

## The registry & install experience (target)

- Each extension carries its own metadata file; **a GitHub Action regenerates a
  full `registry.json` index on every merge to `main`**. The registry only ever
  contains merged (vetted) entries.
- **Settings → Extensions** in WebUI reads the registry: browse the curated
  extensions, open an entry, read about it (description, screenshots, trust
  disclosures), and hit **Install**.
- Install shows a confirmation dialog, installs the extension in place, and
  **restarts WebUI if the extension requires it** (entries declare whether a
  restart is needed). The same surface lists installed extensions and lets you
  **disable or uninstall** them.
- Later: gallery polish, auto-install of trusted extensions.

## Compatibility & testing

Before real entries accumulate, the library gets a compatibility/test layer:
- entries declare the **extension API surface / capabilities** they require
  (capability names, preferred over exact version pins), so the core can roll
  forward and maintainers can tell what breaks;
- **CI validates each entry's manifest/metadata** on every PR (schema validation
  first), and the registry generator re-validates on merge.

## How you can help

- **UI-tweak-class extensions** — sidebar items, composer affordances, panels,
  diagnostics, themes-with-logic. (Several are already in flight.)
- **Richer / sidecar-class extensions** — anything pairing WebUI assets with a
  trusted local helper process (the Desktop Companion pet assistant is the first
  candidate driving the sidecar + proxy work).
- **Foundation** — the registry generator, the manifest/metadata schema, CI
  validation, and the Settings → Extensions UI.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) and
[`docs/extension-entry.md`](docs/extension-entry.md) for how to structure an
entry today. Tracking issues break the roadmap above into concrete pieces.

> Status: foundation phase. Conventions here are a basis for review, not a locked
> marketplace contract yet.
