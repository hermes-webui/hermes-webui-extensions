# Typography

Typography lets users choose curated fonts, role-based presets, and browser-local
font files for the Hermes WebUI interface, conversations, and code. It adds a
**Typography** button to the WebUI rail.

## Install for local testing

From a Hermes WebUI checkout, point the manifest-bundle loader at this entry:

```bash
cd /path/to/hermes-webui
HERMES_WEBUI_EXTENSION_DIR=/path/to/hermes-webui-extensions/extensions/typography \
HERMES_WEBUI_EXTENSION_MANIFEST=manifest.json ./start.sh
```

Click **Typography** in the rail to open the panel.

## Behavior

- The compact Preset selector applies and persists one complete triple in this
  order: **WebUI Default** (`default`, `same-ui`, `default`); **Nous**
  (`courier-prime`, `same-ui`, `courier-prime`); **Modern** (`geist`,
  `same-ui`, `geist-mono`); **Accessible** (`atkinson-hyperlegible-next`,
  `same-ui`, `atkinson-hyperlegible-mono`); **Comfortable Reading**
  (`lexend-deca`, `literata`, `source-code-pro`); **Noto** (`noto-sans`,
  `noto-serif`, `noto-sans-mono`); **IBM Plex** (`ibm-plex-sans`,
  `ibm-plex-serif`, `ibm-plex-mono`); **Developer** (`inter`, `same-ui`,
  `jetbrains-mono`); **Dense** (`public-sans`, `same-ui`, `inconsolata`);
  **Warm** (`nunito-sans`, `lora`, `fira-code`); and **Cyberdeck** (`oxanium`,
  `geist`, `space-mono`).
  Manual changes show **Custom**;
  matching a triple identifies its preset again.
- Interface, Conversations, and Code selectors use role-specific curated
  catalogs and previews. Conversations includes additional reading serifs such
  as Bitter that are not offered for Interface or Code.
  Interface and Conversations previews include `Ag Il1 O0 0123456789`;
  Conversations also exercises semantic *italic* and **bold** text. The code
  diagnostic preview includes `Il1 O0 {} [] != => ,.;:`.
- **Google-hosted choices** load selected families from Google and expose the
  browser IP to Google. Interface and Conversations families request upright
  weights plus true italic 400/700 faces; Code-only families request upright
  weights. Shared families are requested once with the union. **WebUI default
  choices** use core-provided system font stacks; this extension makes no
  external font request for them. **Local fonts** are read from this browser
  and are never sent to a server.
- Clicking **Import font** opens the native file picker; selecting a file
  validates and imports it immediately. Cancel does nothing, and selecting the
  same file again is supported.

## Browser-local fonts

The panel accepts `.woff2`, `.woff`, `.ttf`, and `.otf` files up to 10 MiB each.
It rejects empty files, mismatched MIME types when a MIME type is present, and
files whose signatures are not `wOF2`, `wOFF`, OpenType `OTTO`, or TrueType
`0x00010000` (`true` is also accepted for `.ttf`). TrueType-outline `.otf`
files may use `0x00010000`. `FontFace.load()` succeeds before a record is
persisted.

Font bytes use native IndexedDB only:

- database: `hermes-ext-typography-fonts`
- object store: `hermes-ext-typography-font-records`
- records contain only an opaque ID, display name, format, bytes, and created /
  updated timestamps; browser source paths are not stored

Stored faces are activated on startup with `document.fonts.add`. Active local
fonts appear in a **Local fonts** group in all three role selectors under stable
values such as `local:<opaque-id>`. Invalid or unavailable selections fall back
to their role defaults without deleting stored records. Each imported font can
be previewed, renamed, replaced, or deleted. Rename trims names to 80
characters and rejects an empty result. Replace validates and loads first, so a
failure leaves the previous record and active face intact. Delete removes the
IndexedDB record and registered face, and returns only roles that directly
select that font to their defaults.

Import management is disabled with an explanatory status if IndexedDB,
`FontFace`, or `document.fonts` support is unavailable; curated fonts and
presets remain usable. Import only font files you are licensed to use. This
extension does not upload, sync, share, convert, subset, or server-store local
font data.

## Trust, permissions, and storage

This is trusted static manifest-bundle code with no dependencies, backend,
sidecar, remote script, filesystem access, cookies, native host, or server file
upload. It may load the Google stylesheet for selected curated families; this is
declared as `network_external: true`. Local font bytes never enter the Google
request, extension settings, or localStorage.

The extension uses WebUI's stable root font tokens:

- `--font-ui`
- `--font-conversation`
- `--font-mono`

It sets or removes only those three inline properties on
`document.documentElement.style`. WebUI defaults remove the inline property so
core owns the fallback. **Same as interface** follows the current interface
stack, including a local font when selected.

Generic selection values are stored through
`window.HermesExtensionSettings.storageForExtension('typography')` when
available, with the legacy `hermes-ext-typography-selection` localStorage key as
the older-core fallback. The library metadata declares only that scalar
selection key as user-visible owned storage; the runtime manifest grants Core's
owned storage namespace for this accessor. Font bytes are never scalar settings
values. There is intentionally no `settings_schema`.

The immutable public debug surface is `window.HermesTypographyExtension` with
the version, curated catalog, preset metadata, selection accessors, and pure
validation helpers. It contains no local font names, paths, bytes, or private
records.

## Disable and uninstall

Disable Typography by restarting Hermes WebUI without the extension directory or
manifest environment variables. Uninstall it by removing the local
`extensions/typography/` entry (or removing it from the installed extension
set). Browser site-data controls remove the selection and the
`hermes-ext-typography-fonts` IndexedDB database; uninstalling the bundle alone
does not need to contact a server.

## Compatibility and verification

Compatibility requires a manifest bundle and the core font tokens listed above.
The three-font Core contract was introduced by `nesquena/hermes-webui#5918`; older
Core builds do not support all roles.
The extension-owned storage API is used when available, with a namespaced
localStorage fallback for older builds. A core without the font tokens still
loads the extension, but selected fonts cannot affect core views. A browser
without local-font APIs still supports curated choices and presets.

## Known limitations

Native select option rendering varies by browser. Local-font management depends
on IndexedDB and the browser Font Loading API. Each imported local font file is
registered as one family/face, so missing weights and italics may be synthesized.
Blocking Google requests leaves a selected curated family on its declared system
fallback stack.

Manual checks:

1. Click the Typography rail button and confirm it opens the panel and the
   first selector receives focus.
2. Choose every preset, then change one role and confirm **Custom** appears;
   restore a triple and confirm its preset is identified again.
3. Change each role and confirm its preview and root token update. Confirm the
   `Ag Il1 O0 0123456789` diagnostics, semantic italic/bold Conversations
   sample, code diagnostic preview, and **Same as interface** behavior. When
   hosted families are selected, inspect the single extension stylesheet link
   to confirm role-appropriate Google CSS2 weights and deduplication.
4. Click **Import font**, select one valid file, cancel once, select the same
   file again, then try one invalid or oversized file. Confirm the local font
   appears in all three Local fonts groups, survives reload, and does not create
   a network request.
5. Test Preview, Rename, Replace failure/success, Delete, Escape,
   backdrop click, Close, mobile layout, and focus return to the opener.

Automated checks:

```bash
node --check extensions/typography/assets/typography.js
node -e "JSON.parse(require('fs').readFileSync('extensions/typography/extension.json')); JSON.parse(require('fs').readFileSync('extensions/typography/manifest.json'))"
node scripts/test-typography-rail-entry.mjs
node scripts/test-typography.mjs
node scripts/validate-extensions.mjs
node scripts/scan-extension-safety.mjs
git diff --check
```
