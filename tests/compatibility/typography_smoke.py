#!/usr/bin/env python3
"""Real-browser lifecycle smoke for the Typography extension."""

from __future__ import annotations

import argparse
import base64
import os
import shutil
import sys
import tempfile
import traceback
from pathlib import Path
from typing import Any

try:
    from browser_smoke import (
        CompatibilityFailure,
        EXPECTED_CORE_BASELINE_REQUESTS,
        SetupFailure,
        _assert_browser_health,
        _install_network_guards,
        _record_screenshot,
        _start_server,
        _terminate,
        _write_json,
    )
except ModuleNotFoundError:  # pragma: no cover - supports module execution.
    from tests.compatibility.browser_smoke import (
        CompatibilityFailure,
        EXPECTED_CORE_BASELINE_REQUESTS,
        SetupFailure,
        _assert_browser_health,
        _install_network_guards,
        _record_screenshot,
        _start_server,
        _terminate,
        _write_json,
    )


REPO_ROOT = Path(__file__).resolve().parents[2]
DESKTOP_VIEWPORT = {"width": 1440, "height": 1000}
MOBILE_VIEWPORT = {"width": 390, "height": 844}
EXTENSION_RESOURCES = (
    "/extensions/typography/assets/typography.js",
    "/extensions/typography/assets/typography.css",
)
GOOGLE_CSS_PREFIX = "https://fonts.googleapis.com/css2"
FONT_CANDIDATES = (
    "/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation2/LiberationSerif-Regular.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf",
)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--core-dir",
        default=os.environ.get("HERMES_CORE_DIR", ""),
        help="independent Hermes WebUI Core checkout (or HERMES_CORE_DIR)",
    )
    parser.add_argument(
        "--extension-root",
        default=os.environ.get("HERMES_EXTENSION_ROOT", str(REPO_ROOT / "extensions")),
        help="extension source root (default: this checkout's extensions/)",
    )
    parser.add_argument(
        "--evidence-dir",
        default=os.environ.get(
            "COMPATIBILITY_EVIDENCE_DIR",
            str(REPO_ROOT / ".compatibility-evidence"),
        ),
        help="directory for screenshots and results JSON",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("HERMES_COMPATIBILITY_PORT", "0") or "0"),
        help="optional fixed non-production port; 0 chooses a free ephemeral port",
    )
    return parser.parse_args()


def _find_fonts() -> tuple[Path, Path]:
    found = [Path(candidate) for candidate in FONT_CANDIDATES if Path(candidate).is_file()]
    if not found:
        raise SetupFailure(f"no installed Liberation/DejaVu font found in {FONT_CANDIDATES!r}")
    first = found[0]
    second = next((candidate for candidate in found[1:] if candidate.stat().st_size != first.stat().st_size), None)
    if second is None:
        raise SetupFailure("two installed Liberation/DejaVu fonts with distinct sizes are required")
    return first, second


def _new_page(browser: Any, viewport: dict[str, int], init_script: str | None = None) -> tuple[Any, Any, list[dict[str, str]], list[str], dict[str, list[dict[str, Any]]]]:
    context = browser.new_context(
        viewport=viewport,
        is_mobile=viewport == MOBILE_VIEWPORT,
        service_workers="block",
    )
    if init_script:
        context.add_init_script(init_script)
    network_events = _install_network_guards(context)
    page = context.new_page()
    console_errors: list[dict[str, str]] = []
    page_errors: list[str] = []

    def on_console(message: Any) -> None:
        if message.type != "error":
            return
        location = getattr(message, "location", {}) or {}
        location_url = location.get("url", "") if isinstance(location, dict) else getattr(location, "url", "")
        console_errors.append({"text": str(message.text), "url": str(location_url)})

    page.on("console", on_console)
    page.on("pageerror", lambda error: page_errors.append(str(error)))
    return context, page, console_errors, page_errors, network_events


def _is_google_css_event(event: dict[str, Any]) -> bool:
    return str(event.get("url", "")).startswith(GOOGLE_CSS_PREFIX)


def _is_expected_core_reload(event: dict[str, Any]) -> bool:
    expected = EXPECTED_CORE_BASELINE_REQUESTS.get(str(event.get("url", "")))
    return bool(
        expected
        and event.get("method") == "GET"
        and event.get("resource_type") == expected[0]
        and event.get("occurrence") == expected[1] + 1
    )


def _filtered_unexpected_http(events: list[dict[str, Any]], allow_core_reload: bool) -> list[dict[str, Any]]:
    filtered = []
    allowed_reload_urls = set()
    for event in events:
        if _is_google_css_event(event):
            continue
        url = str(event.get("url", ""))
        if allow_core_reload and url not in allowed_reload_urls and _is_expected_core_reload(event):
            allowed_reload_urls.add(url)
            continue
        filtered.append(event)
    return filtered


def _assert_typography_health(
    *,
    case_name: str,
    console_errors: list[dict[str, str]],
    page_errors: list[str],
    network_events: dict[str, list[dict[str, Any]]],
    allow_core_reload: bool = False,
) -> None:
    # Google CSS is deliberately blocked and expected; every other off-origin
    # request remains a failure through the shared deny-by-default guard.
    filtered_console = [
        entry for entry in console_errors
        if not str(entry.get("url", "")).startswith(GOOGLE_CSS_PREFIX)
    ]
    filtered_network = {key: list(value) for key, value in network_events.items()}
    filtered_network["unexpected_http"] = _filtered_unexpected_http(
        filtered_network.get("unexpected_http", []),
        allow_core_reload,
    )
    _assert_browser_health(
        case_name=case_name,
        console_errors=filtered_console,
        page_errors=page_errors,
        extension_fragments=EXTENSION_RESOURCES,
        network_events=filtered_network,
    )


def _network_summary(events: dict[str, list[dict[str, Any]]]) -> dict[str, int]:
    return {
        "blocked_http": len(events.get("blocked_http", [])),
        "unexpected_http": len(events.get("unexpected_http", [])),
        "blocked_websockets": len(events.get("blocked_websockets", [])),
        "google_css_requests": sum(
            1 for event in events.get("blocked_http", []) if _is_google_css_event(event)
        ),
    }


def _boot_page(page: Any, base_url: str) -> None:
    page.goto(f"{base_url}/", wait_until="domcontentloaded", timeout=30_000)
    try:
        page.wait_for_load_state("networkidle", timeout=8_000)
    except Exception:
        pass
    page.wait_for_function(
        "resources => resources.every(resource => performance.getEntriesByType('resource').some(entry => entry.name.includes(resource)))",
        arg=list(EXTENSION_RESOURCES),
        timeout=15_000,
    )
    page.locator("#hwx-type-rail-button").wait_for(state="attached", timeout=15_000)


def _open_panel(page: Any) -> None:
    page.locator("#hwx-type-rail-button").click()
    page.locator("#hwx-type-panel").wait_for(state="visible", timeout=5_000)


def _wait_for_status(page: Any, expected: str, *, contains: bool = False) -> None:
    expression = (
        "expected => { const node = document.querySelector('#hwx-type-local-status'); "
        "return node && (expected ? "
        "(node.textContent || '').includes(expected) : !(node.textContent || '').trim()); }"
        if contains
        else "expected => { const node = document.querySelector('#hwx-type-local-status'); return node && (node.textContent || '') === expected; }"
    )
    page.wait_for_function(expression, arg=expected, timeout=10_000)


def _db_summary(page: Any) -> dict[str, Any]:
    return page.evaluate(
        """
        () => new Promise((resolve, reject) => {
          const request = indexedDB.open('hermes-ext-typography-fonts', 1);
          request.onerror = () => reject(request.error || new Error('database summary open failed'));
          request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains('hermes-ext-typography-font-records')) {
              request.result.createObjectStore('hermes-ext-typography-font-records', {keyPath: 'id'});
            }
          };
          request.onsuccess = () => {
            const database = request.result;
            const transaction = database.transaction('hermes-ext-typography-font-records', 'readonly');
            const cursorRequest = transaction.objectStore('hermes-ext-typography-font-records').openCursor();
            let count = 0;
            let totalBytes = 0;
            let updatedAt = [];
            cursorRequest.onerror = () => reject(cursorRequest.error || new Error('database summary cursor failed'));
            cursorRequest.onsuccess = () => {
              const cursor = cursorRequest.result;
              if (!cursor) return;
              const value = cursor.value || {};
              count += 1;
              totalBytes += value.bytes && Number.isFinite(value.bytes.byteLength) ? value.bytes.byteLength : 0;
              updatedAt.push(Number.isFinite(value.updatedAt) ? value.updatedAt : 0);
              cursor.continue();
            };
            transaction.oncomplete = () => {
              database.close();
              resolve({count, totalBytes, updatedAt});
            };
            transaction.onerror = () => reject(transaction.error || new Error('database summary transaction failed'));
          };
        })
        """
    )


def _local_face_count(page: Any) -> int:
    return int(
        page.evaluate(
            """
            () => Array.from(document.fonts || []).filter(face =>
              String(face.family || '').includes('HermesTypographyLocal_')).length
            """
        )
    )


def _local_option_values(page: Any) -> list[str]:
    return list(
        page.evaluate(
            """
            () => Array.from(document.querySelectorAll('#hwx-type-interface optgroup option'))
              .map(option => option.value)
            """
        )
    )


def _selection(page: Any) -> dict[str, str]:
    return dict(page.evaluate("() => window.HermesTypographyExtension.getSelection()"))


def _local_snapshot(page: Any) -> dict[str, Any]:
    return {
        "database": _db_summary(page),
        "face_count": _local_face_count(page),
        "selection": _selection(page),
    }


def _assert_same_local_snapshot(before: dict[str, Any], after: dict[str, Any], label: str) -> None:
    if before["database"] != after["database"]:
        raise CompatibilityFailure(f"{label}: IndexedDB changed unexpectedly")
    if before["face_count"] != after["face_count"]:
        raise CompatibilityFailure(f"{label}: registered FontFace state changed unexpectedly")
    if before["selection"] != after["selection"]:
        raise CompatibilityFailure(f"{label}: selection changed unexpectedly")


def _replace(page: Any, font_path: Path) -> None:
    with page.expect_file_chooser() as chooser_info:
        page.get_by_role("button", name="Replace").click()
    chooser_info.value.set_files(str(font_path))


def _main_flow(base_url: str, evidence_dir: Path, browser: Any, first_font: Path, second_font: Path) -> dict[str, Any]:
    context, page, console_errors, page_errors, network_events = _new_page(browser, DESKTOP_VIEWPORT)
    screenshot = evidence_dir / "typography-desktop.png"
    try:
        _boot_page(page, base_url)
        default_tokens = page.evaluate(
            """() => ['--font-ui', '--font-conversation', '--font-mono'].map(name =>
              document.documentElement.style.getPropertyValue(name).trim())"""
        )
        if default_tokens != ["", "", ""]:
            raise CompatibilityFailure(f"default root tokens were not removed: {default_tokens!r}")
        if page.locator("#hwx-type-google-fonts").count() != 0:
            raise CompatibilityFailure("default choices created a Google stylesheet")
        if _network_summary(network_events).get("google_css_requests", 0):
            raise CompatibilityFailure("default choices requested Google CSS")

        page.evaluate(
            """
            () => {
              window.__typographyListenerStats = {add: 0, remove: 0};
              const add = document.addEventListener;
              const remove = document.removeEventListener;
              document.addEventListener = function(type, listener, options) {
                if (type === 'keydown') window.__typographyListenerStats.add += 1;
                return add.call(this, type, listener, options);
              };
              document.removeEventListener = function(type, listener, options) {
                if (type === 'keydown') window.__typographyListenerStats.remove += 1;
                return remove.call(this, type, listener, options);
              };
            }
            """
        )
        rail = page.locator("#hwx-type-rail-button")
        rail.click()
        page.locator("#hwx-type-panel").wait_for(state="visible")
        page.evaluate("() => window.HermesTypographyExtension.open(document.getElementById('hwx-type-rail-button'))")
        if page.locator("#hwx-type-panel").count() != 1:
            raise CompatibilityFailure("repeated panel open created a duplicate panel")
        page.get_by_role("button", name="Close typography").click()
        page.locator("#hwx-type-panel").wait_for(state="detached")
        rail.click()
        page.locator("#hwx-type-panel").wait_for(state="visible")
        listener_stats = page.evaluate("() => window.__typographyListenerStats")
        if listener_stats != {"add": 2, "remove": 1}:
            raise CompatibilityFailure(f"panel listener lifecycle duplicated: {listener_stats!r}")

        page.select_option("#hwx-type-interface", "courier-prime")
        page.select_option("#hwx-type-conversation", "bitter")
        page.select_option("#hwx-type-code", "space-mono")
        link = page.locator("#hwx-type-google-fonts")
        link.wait_for(state="attached")
        href = link.get_attribute("href") or ""
        if page.locator("#hwx-type-google-fonts").count() != 1 or any(
            family not in href for family in ("Courier+Prime", "Bitter", "Space+Mono")
        ):
            raise CompatibilityFailure(f"hosted font stylesheet was not deduplicated: {href!r}")
        page.wait_for_timeout(250)
        if _network_summary(network_events)["google_css_requests"] < 1:
            raise CompatibilityFailure("hosted font stylesheet was not intercepted as an off-origin request")
        tokens = page.evaluate(
            """() => ['--font-ui', '--font-conversation', '--font-mono'].map(name =>
              document.documentElement.style.getPropertyValue(name))"""
        )
        if not all(expected in actual for expected, actual in zip(("Courier Prime", "Bitter", "Space Mono"), tokens)):
            raise CompatibilityFailure(f"role root tokens were not applied: {tokens!r}")
        page.select_option("#hwx-type-preset", "webui-default")
        page.locator("#hwx-type-google-fonts").wait_for(state="detached")
        default_tokens = page.evaluate(
            """() => ['--font-ui', '--font-conversation', '--font-mono'].map(name =>
              document.documentElement.style.getPropertyValue(name).trim())"""
        )
        if default_tokens != ["", "", ""]:
            raise CompatibilityFailure(f"returning to defaults kept root tokens: {default_tokens!r}")

        page.locator("#hwx-type-import:not([disabled])").wait_for(state="visible", timeout=10_000)
        page.locator("#hwx-type-local-file").set_input_files(str(first_font))
        page.wait_for_function(
            "() => document.querySelectorAll('#hwx-type-local-list .hwx-type-local-item').length === 1",
            timeout=15_000,
        )
        _wait_for_status(page, "")
        local_value = _local_option_values(page)[0]
        for role in ("interface", "conversation", "code"):
            if page.locator(f"#hwx-type-{role} optgroup option").count() != 1:
                raise CompatibilityFailure(f"imported font missing from {role} selector")
        page.select_option("#hwx-type-interface", local_value)
        if _selection(page)["interface"] != local_value:
            raise CompatibilityFailure("local selection was not applied")
        persisted = _db_summary(page)
        if persisted["count"] != 1 or persisted["totalBytes"] != first_font.stat().st_size:
            raise CompatibilityFailure(f"imported font was not persisted: {persisted!r}")
        if _local_face_count(page) != 1:
            raise CompatibilityFailure("imported FontFace was not registered")
        _record_screenshot(page, screenshot)

        page.reload(wait_until="domcontentloaded", timeout=30_000)
        page.locator("#hwx-type-rail-button").wait_for(state="visible", timeout=15_000)
        _open_panel(page)
        page.locator("#hwx-type-import:not([disabled])").wait_for(state="visible", timeout=10_000)
        if local_value not in _local_option_values(page) or _selection(page)["interface"] != local_value:
            raise CompatibilityFailure("reload did not restore the IndexedDB font and selection")
        if _local_face_count(page) != 1:
            raise CompatibilityFailure("reload did not activate the persisted FontFace")

        page.evaluate(
            """
            () => {
              const prototype = Object.getPrototypeOf(document.fonts);
              window.__typographyFontDeleteCalls = 0;
              window.__typographyOriginalFontDelete = prototype.delete;
              prototype.delete = function(face) {
                window.__typographyFontDeleteCalls += 1;
                return window.__typographyOriginalFontDelete.call(this, face);
              };
            }
            """
        )
        delete_calls_before_replace = page.evaluate("() => window.__typographyFontDeleteCalls")
        _replace(page, second_font)
        _wait_for_status(page, "Font replaced.", contains=True)
        replaced = _db_summary(page)
        if replaced["count"] != 1 or replaced["totalBytes"] != second_font.stat().st_size:
            raise CompatibilityFailure(f"replacement was not persisted: {replaced!r}")
        if _selection(page)["interface"] != local_value or _local_face_count(page) != 1:
            raise CompatibilityFailure("replacement changed the active selection or face count")
        if page.evaluate("() => window.__typographyFontDeleteCalls") <= delete_calls_before_replace:
            raise CompatibilityFailure("replacement did not clean up the previous FontFace")

        before_unavailable = _local_snapshot(page)
        page.evaluate("() => { window.__typographySavedConfirm = window.confirm; window.confirm = undefined; }")
        page.get_by_role("button", name="Delete").click()
        _wait_for_status(page, "Deleting is unavailable in this browser.")
        _assert_same_local_snapshot(before_unavailable, _local_snapshot(page), "missing confirmation")
        page.evaluate(
            """() => {
              document.querySelector('#hwx-type-local-status').textContent = 'Awaiting throwing confirmation.';
              window.confirm = () => { throw new Error('blocked'); };
            }"""
        )
        page.get_by_role("button", name="Delete").click()
        _wait_for_status(page, "Deleting is unavailable in this browser.")
        _assert_same_local_snapshot(before_unavailable, _local_snapshot(page), "throwing confirmation")
        page.evaluate("() => { window.confirm = () => false; }")
        page.get_by_role("button", name="Delete").click()
        page.wait_for_timeout(100)
        _assert_same_local_snapshot(before_unavailable, _local_snapshot(page), "cancelled deletion")
        page.evaluate("() => { window.confirm = window.__typographySavedConfirm; }")
        page.once("dialog", lambda dialog: dialog.accept())
        page.get_by_role("button", name="Delete").click()
        page.wait_for_function(
            "() => document.querySelectorAll('#hwx-type-local-list .hwx-type-local-item').length === 0",
            timeout=10_000,
        )
        if _db_summary(page)["count"] != 0 or _local_face_count(page) != 0:
            raise CompatibilityFailure("confirmed deletion did not remove storage and FontFace")
        if _selection(page)["interface"] != "default":
            raise CompatibilityFailure("confirmed deletion did not clear the local selection")
        _assert_typography_health(
            case_name="typography-main",
            console_errors=console_errors,
            page_errors=page_errors,
            network_events=network_events,
            allow_core_reload=True,
        )
        return {
            "status": "passed",
            "checks": [
                "defaults/root-tokens",
                "hosted-stylesheet/network-block",
                "import/persistence/reload",
                "replacement/fontface-cleanup",
                "delete-unavailable/cancel/confirm",
                "panel-deduplication/listeners",
            ],
            "screenshot": screenshot.name,
        }
    except Exception:
        _record_screenshot(page, screenshot)
        raise
    finally:
        context.close()


def _mobile_flow(base_url: str, evidence_dir: Path, browser: Any) -> dict[str, Any]:
    context, page, console_errors, page_errors, network_events = _new_page(browser, MOBILE_VIEWPORT)
    screenshot = evidence_dir / "typography-mobile.png"
    try:
        _boot_page(page, base_url)
        page.evaluate("() => window.HermesTypographyExtension.open(document.getElementById('hwx-type-rail-button'))")
        page.locator("#hwx-type-panel").wait_for(state="visible", timeout=5_000)
        _record_screenshot(page, screenshot)
        _assert_typography_health(
            case_name="typography-mobile",
            console_errors=console_errors,
            page_errors=page_errors,
            network_events=network_events,
        )
        return {"status": "passed", "screenshot": screenshot.name}
    except Exception:
        _record_screenshot(page, screenshot)
        raise
    finally:
        context.close()


def _open_failure_flow(base_url: str, browser: Any) -> dict[str, Any]:
    context, page, console_errors, page_errors, network_events = _new_page(
        browser,
        DESKTOP_VIEWPORT,
        """
        (() => {
          const originalOpen = window.indexedDB.open.bind(window.indexedDB);
          window.indexedDB.open = function() {
            throw new Error('Injected IndexedDB open failure.');
          };
          window.__typographyOriginalOpen = originalOpen;
        })();
        """,
    )
    try:
        _boot_page(page, base_url)
        _open_panel(page)
        _wait_for_status(page, "could not open IndexedDB", contains=True)
        if not page.locator("#hwx-type-import").is_disabled():
            raise CompatibilityFailure("IndexedDB open failure left import enabled")
        if page.locator("#hwx-type-local-list .hwx-type-local-item").count() != 0:
            raise CompatibilityFailure("IndexedDB open failure exposed stored records")
        _assert_typography_health(
            case_name="typography-open-failure",
            console_errors=console_errors,
            page_errors=page_errors,
            network_events=network_events,
        )
        return {"status": "passed", "checks": ["graceful-indexeddb-open-failure"]}
    finally:
        context.close()


def _write_failure_flow(base_url: str, browser: Any, first_font: Path, second_font: Path) -> dict[str, Any]:
    context, page, console_errors, page_errors, network_events = _new_page(browser, DESKTOP_VIEWPORT)
    try:
        _boot_page(page, base_url)
        _open_panel(page)
        page.locator("#hwx-type-import:not([disabled])").wait_for(state="visible", timeout=10_000)
        page.locator("#hwx-type-local-file").set_input_files(str(first_font))
        page.wait_for_function(
            "() => document.querySelectorAll('#hwx-type-local-list .hwx-type-local-item').length === 1",
            timeout=15_000,
        )
        page.evaluate(
            """
            () => {
              const prototype = Object.getPrototypeOf(document.fonts);
              window.__typographyFontDeleteCalls = 0;
              window.__typographyOriginalFontDelete = prototype.delete;
              prototype.delete = function(face) {
                window.__typographyFontDeleteCalls += 1;
                return window.__typographyOriginalFontDelete.call(this, face);
              };
              window.__typographyOriginalPut = IDBObjectStore.prototype.put;
              IDBObjectStore.prototype.put = function() {
                throw new Error('Injected IndexedDB write failure.');
              };
            }
            """
        )
        _replace(page, second_font)
        _wait_for_status(page, "Injected IndexedDB write failure.", contains=True)
        failed = _db_summary(page)
        if failed["count"] != 1 or failed["totalBytes"] != first_font.stat().st_size:
            raise CompatibilityFailure(f"failed replacement changed the prior record: {failed!r}")
        if _local_face_count(page) != 1:
            raise CompatibilityFailure("failed replacement did not preserve the prior FontFace")
        if page.evaluate("() => window.__typographyFontDeleteCalls") < 1:
            raise CompatibilityFailure("failed replacement did not clean up its new FontFace")

        page.evaluate("() => { IDBObjectStore.prototype.put = window.__typographyOriginalPut; }")
        page.reload(wait_until="domcontentloaded", timeout=30_000)
        page.locator("#hwx-type-rail-button").wait_for(state="visible", timeout=15_000)
        _open_panel(page)
        page.locator("#hwx-type-import:not([disabled])").wait_for(state="visible", timeout=10_000)
        page.evaluate(
            """
            () => {
              window.__typographyOriginalPut = IDBObjectStore.prototype.put;
              IDBObjectStore.prototype.put = function() {
                throw new Error('Injected IndexedDB import write failure.');
              };
            }
            """
        )
        # The existing record is replaced only after a successful put; this
        # import failure is checked on a fresh ID so it cannot alter the record.
        page.locator("#hwx-type-local-file").set_input_files(str(second_font))
        _wait_for_status(page, "Injected IndexedDB import write failure.", contains=True)
        if _db_summary(page)["count"] != 1 or _local_face_count(page) != 1:
            raise CompatibilityFailure("failed import did not leave existing storage and face intact")
        page.evaluate("() => { IDBObjectStore.prototype.put = window.__typographyOriginalPut; }")
        _assert_typography_health(
            case_name="typography-write-failure",
            console_errors=console_errors,
            page_errors=page_errors,
            network_events=network_events,
            allow_core_reload=True,
        )
        return {
            "status": "passed",
            "checks": ["failed-replacement-preservation", "failed-import-preservation"],
        }
    finally:
        context.close()


def _seed_overflow_database(page: Any, font_path: Path) -> None:
    valid_bytes = base64.b64encode(font_path.read_bytes()).decode("ascii")
    invalid_bytes = base64.b64encode(bytes((1, 2, 3, 4))).decode("ascii")
    page.evaluate(
        """
        ({records}) => new Promise((resolve, reject) => {
          const request = indexedDB.open('hermes-ext-typography-fonts', 1);
          request.onerror = () => reject(request.error || new Error('seed database open failed'));
          request.onupgradeneeded = () => {
            request.result.createObjectStore('hermes-ext-typography-font-records', {keyPath: 'id'});
          };
          request.onsuccess = () => {
            const database = request.result;
            const transaction = database.transaction('hermes-ext-typography-font-records', 'readwrite');
            const store = transaction.objectStore('hermes-ext-typography-font-records');
            for (const record of records) {
              const binary = Uint8Array.from(atob(record.bytesBase64), character => character.charCodeAt(0)).buffer;
              store.put({
                id: record.id,
                name: record.name,
                format: 'ttf',
                bytes: binary,
                createdAt: 1,
                updatedAt: 1,
              });
            }
            transaction.oncomplete = () => { database.close(); resolve(); };
            transaction.onerror = () => reject(transaction.error || new Error('seed database transaction failed'));
          };
        })
        """,
        {"records": [
            {"id": "font-01", "name": "Retained font", "bytesBase64": valid_bytes},
            *[
                {"id": f"font-{index:02d}", "name": f"Unavailable {index}", "bytesBase64": invalid_bytes}
                for index in range(2, 10)
            ],
        ]},
    )


def _overflow_flow(base_url: str, browser: Any, evidence_dir: Path, first_font: Path) -> dict[str, Any]:
    context, page, console_errors, page_errors, network_events = _new_page(browser, DESKTOP_VIEWPORT)
    screenshot = evidence_dir / "typography-overflow.png"
    try:
        page.goto(f"{base_url}/health", wait_until="domcontentloaded", timeout=15_000)
        _seed_overflow_database(page, first_font)
        _boot_page(page, base_url)
        _open_panel(page)
        _wait_for_status(page, "Extra stored fonts were not loaded", contains=True)
        status = page.locator("#hwx-type-local-status").text_content() or ""
        if "browser site-data controls" not in status or "New imports and replacements" not in status:
            raise CompatibilityFailure(f"overflow status was not actionable: {status!r}")
        if not page.locator("#hwx-type-import").is_disabled():
            raise CompatibilityFailure("overflow database left import enabled")
        if page.locator("#hwx-type-local-list .hwx-type-local-item").count() != 8:
            raise CompatibilityFailure("overflow startup retained an unbounded or incomplete record list")
        if len(_local_option_values(page)) != 1 or _local_face_count(page) != 1:
            raise CompatibilityFailure("the retained in-cap font was not usable after overflow startup")
        stored = _db_summary(page)
        if stored["count"] != 9:
            raise CompatibilityFailure("overflow startup deleted or hid database records")
        _record_screenshot(page, screenshot)
        _assert_typography_health(
            case_name="typography-overflow",
            console_errors=console_errors,
            page_errors=page_errors,
            network_events=network_events,
        )
        return {"status": "passed", "checks": ["bounded-overflow-startup"], "screenshot": screenshot.name}
    except Exception:
        _record_screenshot(page, screenshot)
        raise
    finally:
        context.close()


def main() -> int:
    args = _parse_args()
    evidence_dir = Path(args.evidence_dir).expanduser().resolve()
    evidence_dir.mkdir(parents=True, exist_ok=True)
    results: dict[str, Any] = {"status": "running", "cases": {}}
    results_path = evidence_dir / "typography-results.json"
    proc = None
    log_file = None
    try:
        core_dir = Path(args.core_dir).expanduser().resolve()
        extension_root = Path(args.extension_root).expanduser().resolve()
        if not core_dir.is_dir():
            raise SetupFailure("HERMES_CORE_DIR/--core-dir must point to an independent Hermes WebUI checkout")
        source_dir = extension_root / "typography"
        if not source_dir.is_dir():
            raise SetupFailure(f"Typography extension directory not found: {source_dir}")
        first_font, second_font = _find_fonts()

        try:
            from playwright.sync_api import sync_playwright
        except ImportError as exc:
            raise SetupFailure("Playwright is required; install tests/compatibility/requirements.txt") from exc

        with tempfile.TemporaryDirectory(prefix="hermes-typography-compat-") as temp:
            temp_root = Path(temp)
            bundle_root = temp_root / "typography-bundle"
            shutil.copytree(source_dir, bundle_root / "typography")
            state_root = temp_root / "state"
            proc, log_file, base_url, port = _start_server(
                core_dir=core_dir,
                extension_root=bundle_root,
                manifest_relative="typography/manifest.json",
                state_root=state_root,
                log_path=temp_root / "typography-server.log",
                requested_port=args.port,
            )
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(
                    headless=True,
                    args=["--no-sandbox", "--disable-dev-shm-usage"],
                )
                try:
                    main_result = _main_flow(base_url, evidence_dir, browser, first_font, second_font)
                    results["cases"]["main"] = {**main_result, "port": port}
                    results["cases"]["mobile"] = _mobile_flow(base_url, evidence_dir, browser)
                    results["cases"]["open-failure"] = _open_failure_flow(base_url, browser)
                    results["cases"]["write-failure"] = _write_failure_flow(base_url, browser, first_font, second_font)
                    results["cases"]["overflow"] = _overflow_flow(base_url, browser, evidence_dir, first_font)
                finally:
                    browser.close()
        results["status"] = "passed"
        _write_json(results_path, results)
        print("TYPOGRAPHY COMPATIBILITY PASSED")
        print(f"evidence={evidence_dir}")
        return 0
    except SetupFailure as exc:
        results["status"] = "setup_failure"
        results["error"] = str(exc)
        _write_json(results_path, results)
        print(f"SETUP FAILURE: {exc}", file=sys.stderr)
        print(f"evidence={evidence_dir}", file=sys.stderr)
        return 2
    except CompatibilityFailure as exc:
        results["status"] = "failed"
        results["error"] = str(exc)
        results["traceback"] = traceback.format_exc()
        _write_json(results_path, results)
        print(f"TYPOGRAPHY COMPATIBILITY FAILED: {exc}", file=sys.stderr)
        print(f"evidence={evidence_dir}", file=sys.stderr)
        return 1
    except Exception as exc:
        results["status"] = "harness_error"
        results["error"] = f"{type(exc).__name__}: {exc}"
        results["traceback"] = traceback.format_exc()
        _write_json(results_path, results)
        print(f"HARNESS ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
        print(f"evidence={evidence_dir}", file=sys.stderr)
        return 2
    finally:
        _terminate(proc, log_file)


if __name__ == "__main__":
    sys.exit(main())
