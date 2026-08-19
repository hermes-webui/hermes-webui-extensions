# Browser compatibility smoke

The compatibility-certification job runs a real Hermes WebUI Core checkout and
headless Chromium. It combines an allow-listed merged extension reference, a
test-only E0/B1/Configure capability probe, and Typography's dedicated browser scenarios;
it is not a claim that every changed extension has browser coverage.

## Current contract

The allowlist currently contains the merged `mobile-conversations` extension.
The smoke starts Core's `server.py` with an isolated `HERMES_HOME`,
`HERMES_WEBUI_STATE_DIR`, workspace, and agent stub, then uses a free
non-production localhost port. The subprocess environment is built from an
empty mapping: only `PATH`, `LANG`/`LC_*`, the explicitly declared
`HERMES_WEBUI_*`/Core startup settings, isolated `HOME`/`XDG_*` paths under the
case state directory, `NO_PROXY` for loopback, and `PYTHONNOUSERSITE=1` are
present. It does not inherit
`PYTHONPATH`, `PYTHONHOME`, provider or gateway settings, proxy variables, or
unspecified `HERMES_*` values. The smoke never sends a chat or requires a
provider/model.

The browser context blocks service workers. Before navigation, the harness
allows HTTP(S) only to `localhost`, `127.0.0.1`, and `[::1]`; all other HTTP(S)
requests are aborted and recorded. Each fixed CDN URL from the pinned Core
index can spend the known-baseline allowance only for its exact URL, `GET`
method, expected Playwright resource type, and bounded occurrence count. A
duplicate request, another method, another resource type, or another URL is
recorded as unexpected. Console errors are associated with
`message.location.url`; a URL-less or non-exact CDN error is therefore not
baseline noise. Any unexpected off-origin HTTP(S) attempt, or any non-loopback
WebSocket, fails the compatibility case. For WebSockets the Playwright 1.62
route callback records the URL and returns without `connect_to_server()` or
synchronous `close()`: Playwright mocks the page-side socket without dialing
the external server and without blocking Chromium. This is a no-egress smoke,
not an assertion that the CDN is reachable.

At a 390x844 mobile viewport, the positive case requires all of the following:

- the extension's JavaScript and stylesheet are requested successfully;
- Core's extension host (`.messages-shell`, named by the reference README) is
  visible before entry assertions begin;
- the extension-owned `#mobileConversationsBtn` is visible;
- its extension-owned `data-hwx-mobile-conversations="1"` marker is present;
- its extension-owned `aria-label="Open conversations"` is present;
- the extension-owned runtime marker reports version `0.1.1`;
- the extension-owned ARIA shortcut menu has the four documented actions.

The negative fixture injects a JavaScript resource and stylesheet but has no
entry. The same entry assertion must time out; the smoke records that expected
failure as a pass. This prevents a CI green from meaning only that an asset URL
returned HTTP 200. The fixture lives under
`tests/compatibility/fixtures/mobile-conversations-resource-only/` and is not a
shipped extension. The separate test-only `off-origin-egress.js` fixture
attempts a non-baseline fetch and verifies that the browser guard records it and
fails the compatibility assertion; it is also not a shipped extension.

Assertions use the extension's own id/data/ARIA surfaces. The Core host
selector is only a readiness precondition, not the extension pass/fail oracle;
Core remains the real host that serves the app shell and injected assets.

### E0/B1/Configure capability certification

The separate test-only `capability-probe` fixture certifies the public Core
foundation that merged extensions can build on. It runs in the same isolated,
no-provider real Core browser environment and proves that:

- a boot-trusted manifest ID receives the frozen E0 handle with the documented
  `id`, `settings`, `storage`, and `events` fields;
- an unknown ID fails closed without creating browser-storage state;
- Core's real `attachLiveStream` → SSE `done` path emits one `turn:start` and
  one `turn:complete` with the original session/stream identity;
- the terminal callback observes the active stream cleared, the pane idle, and
  the settled assistant transcript; and
- a duplicate terminal dispatch for that session/stream is rejected.
- a boot-trusted fixture with no `settings_schema` and no
  `permissions.storage.owned` receives `ext.settings.registerConfigure` as a
  function; one handler registers, a duplicate fails closed, and its
  unregister function is idempotent;
- the effective-enabled fixture renders exactly one **Configure** button under
  Settings → Extensions → Installed and none under Diagnostics;
- Configure enters pending before the handler runs, suppresses a second click,
  settles back to a reusable button, and restores focus exactly once to the
  opener; and
- an intentional handler failure emits the exact Core diagnostic
  `[Hermes extensions] capability-probe Configure handler failed: Error:
  capability-probe intentional Configure failure`, shows Core's generic
  `Extension configuration failed.` UI, leaves Settings usable, and produces
  no unhandled page error.

The fixture replaces `EventSource` only for the controlled lifecycle invocation;
Core still owns the live-stream handler, state transition, event normalization,
and duplicate suppression being exercised. Configure uses the real Settings UI;
the fixture only controls its deterministic first (thenable) and second
(intentional failure) handler outcomes. It does not contact a provider or claim
durable/global event delivery.

## Local run

Install the hash-locked Core/browser-smoke dependencies in an isolated
environment, then install Chromium:

```bash
python3.12 -m pip install --require-hashes -r tests/compatibility/requirements.txt
python3.12 -m playwright install --with-deps chromium
```

Run with an explicit independent Core checkout:

```bash
export HERMES_CORE_DIR=/path/to/hermes-webui
export COMPATIBILITY_EVIDENCE_DIR="$PWD/compatibility-evidence"
python3.12 tests/compatibility/browser_smoke.py
python3.12 tests/compatibility/capability_smoke.py
python3.12 tests/compatibility/typography_smoke.py
```

Each command exits `0` only when its positive and negative contracts pass. A
compatibility assertion exits `1` with status `failed`. Missing setup (for
example, a Core checkout or Playwright browser that is unavailable) and
unexpected harness/driver exceptions exit `2`; the latter is recorded as
status `harness_error` with a traceback rather than being reported as an
extension regression. Evidence includes JSON results, server logs,
network-block records, and screenshots when the browser reaches the relevant
page.

## CI boundary

The `browser-compatibility` job checks out `nesquena/hermes-webui` independently
at the pinned, maintainer-verified Core SHA in
`.github/workflows/extensions.yml` (`b1c2bea92ee8369797d051a0e0789968bd351343`,
release `exp-v0.52.241`),
installs the complete hash-locked Core/browser-smoke and Playwright dependency
surface from `tests/compatibility/requirements.txt` with
`pip --require-hashes`, and
uploads `compatibility-evidence/**` with `if: always()`. The new job's
checkout, setup-python, and upload-artifact actions are pinned to full commit
SHAs (with the corresponding `v5` tag noted beside each pin). It runs on pull
requests whenever extension code, the smoke, fixture, docs, or workflow
changes. The existing registry/safety job remains a separate gate.

To update the pin, first rerun this smoke against the candidate Core checkout,
review the logs/screenshots/results, then change the SHA and repeat the CI
verification. Do not replace the pin with a moving branch reference.

Adding another merged reference requires an explicit `ReferenceSpec` allowlist
item, an extension-owned id/ARIA observable, and a positive plus resource-only
negative scenario. Until then, the merged-entry reference covers only
`mobile-conversations`; the E0/B1 and Typography tracks have their own explicit
contracts and none of these tracks certifies every merged or changed extension.

The Playwright requirement is kept in `tests/compatibility/requirements.txt`
because a real browser is necessary to execute injected JavaScript. Removing
the browser job and that file is the rollback path; the existing static/schema
checks remain unchanged.
