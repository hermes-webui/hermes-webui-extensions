# Command Code Usage

**Command Code Usage** is a trusted local Hermes WebUI extension that adds a chip
to the composer footer (right after the model chip) opening a panel with the
**Command Code account usage**: the account's own live five-hour and weekly
spend windows (used / cap + percent + reset times), the plan and its renewal
date, the monthly credit balance, and the current billing period's request/cost
totals — straight from Command Code's alpha billing endpoints. Once data arrives
the chip itself shows the two window percentages as `CmdCode: x%·y%`.

## What It Does

- Adds a **CommandCode** chip to the composer footer, right after
  the model chip (`.composer-model-wrap`), looking like the other `.composer-left`
  pills: a real `<button>` (focusable, `aria-haspopup="dialog"`, live
  `aria-expanded`) with button chrome stripped — no border, no tint, no tooltip.
  Hovering it opens the panel after a short delay
  (moving away before the delay elapses cancels the open); clicking it toggles the
  panel, so keyboard and touch users get the same panel. The panel stays **pinned**
  (it does not close when the cursor leaves) and is
  dismissed with `Escape`, clicking the chip again, or a click outside.
- The panel grows **to the right of the chip**, shows a small **callout tail**
  pointing down at the chip, and animates in (fade + 5 px nudge, `.14s` ease) —
  the same visual language as the context-window tooltip.
- As soon as usage is fetched the chip label becomes the two window percentages,
  e.g. `CmdCode: 5%·2%` (5-hour · weekly). Without data (sidecar down, no key) it
  stays `CommandCode`.
- Shows one bar per window (5-hour / weekly) with the percent, the amount used
  (`$0.69 of $14.00 used`) and a live "resets in …" countdown derived from the
  endpoint's `resetAt`; an exceeded window turns its bar and amount red.
- Shows the account meta rows: **Plan** (+ status and renewal), **Monthly
  credits** remaining, purchased/free credits when non-zero, and **This period**
  (requests + cost).
- Configurable in **Settings → Extensions → Command Code Usage**: auto-refresh
  on/off and the refresh interval.

## Data source

`GET https://api.commandcode.ai/alpha/billing/credits` returns the window limits
(five-hour / weekly: `used`, `cap`, `resetAt`) and the credit balances
(monthly / purchased / free); `/billing/subscriptions` adds the plan id, status
and current period end, and `/usage/summary` the period's request/cost totals.
These are Command Code's own alpha accounting endpoints — the same numbers their
CLI and quota tooling read — so they are authoritative for the account. This
extension shows them verbatim; the only computed value is the window **percent**,
which is the direct ratio of the returned `used`/`cap` and is always displayed
next to both numbers. No account identity is fetched: the sidecar never calls
`/alpha/whoami`, so no email, name or token enters the payload.

These endpoints are an **undocumented alpha surface** and may change without
notice; the panel surfaces 401/403/404/redirect/size failures as explicit
messages instead of guessing.

## Current Shape

```text
Hermes WebUI page
  -> manifest-bundled extension assets (/extensions/commandcode-usage/assets/*)
  -> composer chip (right after the model chip) -> panel
  -> same-origin sidecar proxy: /api/extensions/commandcode-usage/sidecar/api/usage
  -> sidecar (127.0.0.1:17800, token-v1)
       -> GET api.commandcode.ai/alpha/billing/credits        (windows + balances)
       -> GET api.commandcode.ai/alpha/billing/subscriptions  (plan + renewal)
       -> GET api.commandcode.ai/alpha/usage/summary          (period totals)
       -> ~/.hermes/.env                                      (key, when not in the environment)
```

The browser never sees the API key; it lives in the sidecar process only.

## Capabilities

- `manifest-bundle`
- `loopback-sidecar`

## Install

1. **Install the extension.** From the gallery (Settings → Extensions) or by
   copying this directory to `~/.hermes/webui/extensions/commandcode-usage/`.
2. **Start the sidecar.**

   ```bash
   cp ~/.hermes/webui/extensions/commandcode-usage/sidecar/commandcode-usage-sidecar.service \
      ~/.config/systemd/user/
   systemctl --user enable --now commandcode-usage-sidecar
   curl -s http://127.0.0.1:17800/health
   ```

   Any other way of running `sidecar/sidecar.py` works too, as long as
   `HERMES_WEBUI_STATE_DIR` points at the WebUI state dir so the sidecar finds the
   proxy token.
3. **Approve the sidecar proxy** in **Settings → Extensions → Diagnostics → the
   "Loopback sidecar" card → "Approve proxy consent"** for Command Code Usage.
   This is what lets the browser reach the sidecar through the WebUI instead of
   guessing a loopback port.
4. **Enable WebUI authentication** (Settings → Password) if it is off. The
   `token-v1` proxy is deliberately fail-closed without it, because an
   unauthenticated WebUI would otherwise act as a token-bearing forwarding oracle
   for any local process.
5. **Have a key.** `COMMANDCODE_API_KEY` in the sidecar's environment or in
   `~/.hermes/.env`.

## Disable And Uninstall

- Disable the extension: Settings → Extensions → toggle it off (or set
  `"enabled": false` in the manifest), then reload the WebUI.
- Stop the sidecar: `systemctl --user disable --now commandcode-usage-sidecar`.
- Uninstall: remove `~/.hermes/webui/extensions/commandcode-usage/`. Nothing is
  persisted outside it except the settings the browser stores for the extension id
  and the proxy token WebUI mints in `~/.hermes/webui/sidecar-auth/`.

## Trust And Permissions

This is trusted local code running with WebUI session authority.

Browser assets (`assets/commandcode-usage.js` / `.css`):

- create extension-owned DOM — one chip inserted into core's `.composer-left`
  and a `position: fixed` panel on `<body>` — declared honestly as
  `permissions.dom.mutates_core_views: true`;
- call exactly two same-origin endpoints: `GET /api/extensions/status` (to explain
  a missing sidecar/proxy consent) and
  `GET /api/extensions/commandcode-usage/sidecar/api/usage`;
- contact **no** external origin — there is no third-party URL in the assets;
- read/write a small set of preferences through the sanctioned
  `HermesExtensionSettings` accessors, with a namespaced `localStorage` fallback
  (`hermes-ext-commandcode-usage`) for older core;
- never touch cookies, the clipboard, or the filesystem.

Sidecar (`sidecar/`, testable in isolation):

- reads the Command Code API key from its own environment or `~/.hermes/.env`;
- makes three outbound `GET`s to Command Code's alpha billing endpoints with that
  key, refusing any redirect (so the key cannot follow a redirect to an unknown
  host) and capping each response body;
- writes no application or state data (Python may create bounded bytecode caches
  inside the sidecar's own directory);
- never returns the key, and does not log requests (the scaffold suppresses
  request logging so an `Authorization` header cannot land in a log).

**Scope, stated honestly.** The `token-v1` token converts "any local process that
can reach the loopback port" into "processes that can read the user's WebUI state
dir". It does **not** defend against arbitrary same-UID code, which can read the
token file or read your `.env` directly. Nothing here changes that.

## Sidecar

- Origin `http://127.0.0.1:17800`, health path `/health`, `proxy_auth: token-v1`.
- Vendored runtime at `sidecar/`; `sidecar_base.py` and `sidecar.py` are
  byte-identical to the canonical scaffold and must stay that way.
- One route: `GET /api/usage` (`?refresh=1` bypasses the 60 s usage cache). Each
  outbound request sets a 6 s socket timeout and caps each response body at
  64 KiB, so a healthy endpoint stays comfortably inside the proxy's ~10 s
  buffered upstream timeout and 512 KiB cap and there is no job/poll dance.
  Redirects are refused outright.
- `routes_impl.py` holds routes only; all logic is in `commandcode_usage.py`.
- Failure codes stay explicit (`invalid_key`, `blocked`, `not_found`,
  `redirected`, `bad_payload`, `unreachable`, `http_<code>`), so the panel can
  say what actually happened instead of blaming the key.

## Known Limitations

- **Loopback only.** Sidecars cannot work against a bridge-networked WebUI
  container: `127.0.0.1` is namespace-local, so core and sidecar must share a
  network namespace and the state dir.
- The endpoints are Command Code's **alpha** API; a schema change breaks the
  panel until this extension is updated.
- The chip mounts right after `.composer-model-wrap` inside `.composer-left` (beside
  `#providerQuotaChip`); a core rename of those would require an update — standard
  for a DOM-injection extension.

## Compatibility

- manifest-bundled extension assets served same-origin under `/extensions/`
- loopback sidecar with `proxy_auth: token-v1` and the consent-gated proxy at
  `/api/extensions/<id>/sidecar/…`
- `extension-settings`: `HermesExtensionSettings.settingsForExtension(id)` with
  `settings_schema` + `permissions.storage.owned: true`
- DOM integration point: `.composer-footer` → `.composer-model-wrap` (the chip is
  inserted right after it, inside `.composer-left`, beside `#providerQuotaChip`),
  and the panel grows to the right of the chip with a callout tail pointing at it.
  Styling mirrors the core composer chips (`.composer-*-chip`) and the
  context-window tooltip (`.ctx-tooltip`): `--surface` + `--border2` +
  `0 -4px 24px` shadow, `::after` tail and an opacity/translate entry animation.
  The chip uses core tokens (`--warning`, `--error`, `--accent-text`) for color.
- The chip hides on phones (`@media max-width: 640px`), and steps aside in core's
  two composer-collapse stages (`.composer-footer.cf-icons` /
  `.composer-footer.cf-burger`) so it never pushes core into hiding its own
  model/workspace labels earlier than it otherwise would.
- WebUI API surface: `GET /api/extensions/status`

## Verification

```bash
node scripts/validate-extensions.mjs
node scripts/scan-extension-safety.mjs
node scripts/sync-sidecar-base.mjs --check
node scripts/check-sidecar-usage.mjs
node --check extensions/commandcode-usage/assets/commandcode-usage.js
python3 scripts/test-commandcode-redirect.py
node scripts/test-commandcode-hover-click.mjs
python3 -m json.tool extensions/commandcode-usage/extension.json
python3 -m json.tool extensions/commandcode-usage/manifest.json
```

Sidecar route behaviour, with the service running:

```bash
# tokenless probe: the scaffold denies by default
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:17800/api/usage      # 503 (no token file / no header)
curl -s http://127.0.0.1:17800/health                                          # {"ok":true,...} — the only tokenless route
```

Manual verification:

- hovering the composer's **CommandCode** chip opens the panel to its right (with
  a callout tail and a fade-in); the chip label shows `CmdCode: x%·y%` matching
  `GET api.commandcode.ai/alpha/billing/credits` for your key; the panel stays
  pinned until `Escape`, clicking the chip again, or a click outside
- the window amounts, percents and "resets in …" countdowns agree with the raw
  endpoint; the monthly credits / plan / period rows match
  `/billing/subscriptions` and `/usage/summary`
- with the sidecar stopped, the panel explains that the sidecar is not answering
  instead of showing empty bars
- with proxy consent revoked, the panel points at Settings → Extensions →
  Diagnostics
- the chip is keyboard-reachable (Tab) with a visible focus ring; Enter/Space
  opens the panel and `aria-expanded` flips to `true`, closing flips it back
- `Escape`, clicking the chip again, and a click outside all dismiss the panel
