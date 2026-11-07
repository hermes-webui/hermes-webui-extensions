# Custom Branding

Configure one public **instance name and image** for every device, or keep
personal logos in one browser. Core owns server persistence, initial metadata,
favicons, Apple icons, notifications and the PWA manifest; this extension owns
the editor and titlebar/empty-state logos. It never renames the assistant or
profiles, or rewrites conversation titles.

## Install and compatibility

Version 0.2.0 requires manifest bundles. Shared mode additionally requires
**Shared installation identity API v1**, detected with `GET api/instance-branding`
and `api_version: 1`. Earlier releases including `exp-v0.52.653` do not provide
that API. Do not infer compatibility from that version number.

The integration reference is core commit
`036339c5f7085254f783c17fbf1bbfcbd9540da6`, including the `instance_name`
prerequisite from [#8307](https://github.com/nesquena/hermes-webui/pull/8307).
This is an integration branch, not a claim of upstream release availability.
Core's `docs/instance-branding.md` defines the server contract.

Install the reviewed zip using the gallery when published, or extract its
`custom-branding` directory and configure a manual installation:

```sh
HERMES_WEBUI_EXTENSION_DIR=/path/to/custom-branding \
HERMES_WEBUI_EXTENSION_MANIFEST=manifest.json ./start.sh
```

The actual runtime `manifest.json` entry must retain numeric
`"instance_branding_api": 1`. It is a provider handshake, not a catalog
capability or new permission. The package generator preserves that file.
Core activates shared identity only with a compatible enabled provider.

Shared management requires **enabled WebUI authentication and an unrestricted
owner session**. Profile-bound sessions and auth-disabled installations cannot
write, even on localhost. There is no new administrator role. The editor
honors `can_manage`, `can_upload`, and `provider_available`.

Image import requires core's optional image dependency; follow its installation
instructions in the environment that runs WebUI. The extension never installs
dependencies. Without the normalizer, names and existing images still work;
new image upload is disabled.

## Configure

Open **Settings → Extensions → Installed → Custom Branding → Configure**, or
click the titlebar/empty-state logo. Close or Escape settles the Configure hook.

1. Enter the instance name. Choose whether branding owns that name, then save.
   An adopted name is hidden on disable and cleared on reset; an independent
   native name survives those operations.
2. Select one **static square PNG, 512–2048 px, up to 2 MiB**. Confirm that the
   image becomes public. Core validates and normalizes it into all required
   sizes. Upload alone does not enable sharing.
3. Enable sharing. Every new access receives the server identity. Successful
   writes consume the canonical response and reload the page; returning tabs
   use core's visibility/pageshow revision check without polling.

Each write uses native CSRF and the preceding response's exact ETag/If-Match.
A conflict refreshes the displayed state and asks you to review and save again;
it never silently retries. API errors are displayed and preserve server state.
The v1 shell supplies an app-root `document.baseURI`, including session routes
and stripped proxy prefixes; API and image URLs resolve against that base.

## Personal images and fallback

On older core, personal mode remains available. Expand **Personal images** to
upload/remove a logo (256px) or favicon (64px); PNG/JPEG/WebP are rasterized in
the browser and stored under the original keys:

- `hermes-ext-custom-branding-logo`
- `hermes-ext-custom-branding-favicon`

Shared identity takes priority while active, including when the API probe
fails but the initial HTML already declares sharing active. Local favicon and
Apple swaps are suppressed; local images are retained without automatic upload
or migration. When sharing is inactive, personal images resume. Remove both
personal images as well if you want entirely native Hermes visuals.

The legacy `window.HermesCustomBrandingExtension` methods remain available:
`getLogo`, `getFavicon`, `setLogo`, `setFavicon`, `clearLogo`, `clearFavicon`,
`refresh`; `open()` opens the editor. These methods edit only personal storage.

## Migration, disable, reset and uninstall

Back up existing sources and state before a real migration. First rehearse in
a separate checkout with isolated `HERMES_HOME` and `HERMES_WEBUI_STATE_DIR`.
Import the original square 512px PNG through Configure; do not copy patched
HTML/manifests into a newer checkout or import the 64px personal favicon.
Set/adopt the intended name, enable, then verify from a clean browser.
Native `bot_name`, profile names, and technical PWA identity are independent.

**Disable sharing** retains server name/image configuration. **Reset** removes
image references and clears only the branding-owned name. Neither clears
personal browser storage. Disabling/uninstalling the extension, downgrading to
0.1.0, or losing provider compatibility makes the server projection inactive
on the next request; retained configuration can return with a compatible
provider. Reload existing tabs. For a manual install, restart without the two
extension environment variables to uninstall. Gallery installs use the normal
Disable/Uninstall controls. State stays outside the checkout in WebUI settings
and `STATE_DIR/branding`, so code upgrades do not remove it.

PWA `id`, `scope`, `start_url`, and manifest URL remain owned by core. Shared
images use `purpose: any`; no maskable guarantee is made. New installations
consume the current manifest and Apple metadata. Updating an already-installed
launcher icon/name depends on browser/OS policy and may require reinstallation.
Changing web content does not prove launcher refresh. Offline shells can retain
older metadata. Personal mode does not update an installed PWA manifest.

## Trust and permissions

Trusted same-origin code; no sidecar, native host, arbitrary filesystem access,
or external network. Reads `api/instance-branding`; writes that endpoint and
`api/instance-branding/image` with the authenticated WebUI session. Explicit
shared uploads send pixels to the server; normalized names and derivatives
are intentionally public, while the master/settings remain private to core.

The extension mutates titlebar/empty-state DOM and (only in personal mode)
favicon links. It owns its picker, images, and the two localStorage keys above.
It reads core's public identity projection and CSRF configuration, without
reading cookies or persisting credentials. Permission declarations disclose
these APIs, storage and DOM surfaces. Local input accepts only raster images;
shared input's authoritative validation is performed by core.

## Credit

Preserves the client-side rebuild of the original branding proposal by
**[@gavinssr](https://github.com/gavinssr)** in closed core PR
[#3307](https://github.com/nesquena/hermes-webui/pull/3307), incorporated through
extension PR [#41](https://github.com/hermes-webui/hermes-webui-extensions/pull/41).
Core PR [#2208](https://github.com/nesquena/hermes-webui/pull/2208) is an earlier
branding antecedent. Shared persistence builds on that work without copying
its historical upload implementation.

## Verification

```sh
node --check extensions/custom-branding/assets/custom-branding.js
node scripts/test-custom-branding.mjs
node scripts/run-behavior-tests.mjs --check
node scripts/run-behavior-tests.mjs
node scripts/validate-extensions.mjs
node scripts/scan-extension-safety.mjs
node scripts/generate-registry.mjs --out dist/registry.json
```

A browser smoke uses the actual generated zip against a selected API-v1 core
with disposable state and native test authentication. Core's real installer verifies, extracts and tracks the generated zip; only its HTTPS
transport is replaced with local artifact bytes (no gallery download claim). Test-only requirements:
Playwright, Pillow and core runtime dependencies; install Chromium and Firefox.
Run with a compatible test environment (the older hash-locked compatibility
requirements pin typing-extensions below current core dependency requirements;
keep those environments separate or resolve that test-only dependency explicitly).

```sh
python tests/compatibility/custom_branding_smoke.py \
  --core-dir /path/to/core \
  --artifact dist/artifacts/custom-branding-0.2.0.zip \
  --evidence-dir /path/to/disposable-evidence
```

The smoke checks runtime handshake, native Configure, upload/name/enable,
separate Chromium/Firefox storage, metadata/manifest/DOM, personal priority,
desktop/narrow captures, provider disable/reactivation, missing-v1 downgrade
fallback, disable and reset. This is desktop headless engine
coverage and narrow viewport emulation; **not Android/iOS or installed-PWA
launcher validation**. Real proxy/OIDC integration and physical launcher
refresh remain deployment checks. DOM class renames need compatibility review.
