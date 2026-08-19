#!/usr/bin/env python3
"""Certify the pinned Core E0, B1, and scoped Configure contracts."""

from __future__ import annotations

import argparse
import os
import shutil
import sys
import tempfile
import traceback
from pathlib import Path
from typing import Any

import browser_smoke


REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURE_ROOT = Path(__file__).resolve().parent / "fixtures" / "e0-b1-capability-probe"
PROBE_SCRIPT_FRAGMENT = "/extensions/capability-probe/assets/capability-probe.js"
SESSION_ID = "capability-session"
STREAM_ID = "capability-stream"
EXPECTED_CONFIGURE_FAILURE = "capability-probe intentional Configure failure"
EXPECTED_CONFIGURE_DIAGNOSTIC = (
    "[Hermes extensions] capability-probe Configure handler failed: "
    f"Error: {EXPECTED_CONFIGURE_FAILURE}"
)
EXPECTED_CONFIGURE_UI_FAILURE = "Extension configuration failed."

SetupFailure = browser_smoke.SetupFailure
CompatibilityFailure = browser_smoke.CompatibilityFailure


def _is_expected_configure_diagnostic(entry: object) -> bool:
    if not isinstance(entry, dict):
        return False
    text = entry.get("text")
    if not isinstance(text, str):
        return False
    first_line = text.splitlines()[0] if text else ""
    return first_line == EXPECTED_CONFIGURE_DIAGNOSTIC


def _unexpected_page_errors(page_errors: list[str]) -> list[str]:
    return [
        text
        for text in page_errors
        if not browser_smoke._is_benign_core_page_error(text)
    ]


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--core-dir",
        default=os.environ.get("HERMES_CORE_DIR", ""),
        help="path to the independently checked-out Hermes WebUI Core",
    )
    parser.add_argument(
        "--evidence-dir",
        default=os.environ.get(
            "COMPATIBILITY_EVIDENCE_DIR",
            str(REPO_ROOT / ".compatibility-evidence"),
        ),
        help="directory for logs, screenshots, and results JSON",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("HERMES_CAPABILITY_PORT", "0") or "0"),
        help="optional fixed non-production port; 0 chooses a free ephemeral port",
    )
    return parser.parse_args()


def _validate_probe_result(result: dict[str, Any]) -> None:
    registration = result.get("registration")
    expected_registration = {
        "id": "capability-probe",
        "handle_fields": ["events", "id", "settings", "storage"],
        "handle_frozen": True,
        "events_frozen": True,
        "same_handle": True,
        "unknown_is_null": True,
        "unknown_storage_unchanged": True,
    }
    if registration != expected_registration:
        raise CompatibilityFailure(
            f"E0 registration contract mismatch: {registration!r}"
        )

    events = result.get("events")
    if not isinstance(events, list) or len(events) != 2:
        raise CompatibilityFailure(
            f"B1 lifecycle must emit exactly start + complete once: {events!r}"
        )
    start, complete = events
    if not isinstance(start, dict) or not isinstance(complete, dict):
        raise CompatibilityFailure(
            f"B1 lifecycle events must be objects: {events!r}"
        )
    expected_identity = {
        "session_id": SESSION_ID,
        "stream_id": STREAM_ID,
    }
    if (
        start.get("type") != "turn:start"
        or {key: start.get(key) for key in expected_identity} != expected_identity
        or start.get("active_stream_id") != STREAM_ID
        or start.get("busy") is not True
        or start.get("last_content") != "question"
    ):
        raise CompatibilityFailure(f"B1 start event mismatch: {start!r}")
    if (
        complete.get("type") != "turn:complete"
        or {key: complete.get(key) for key in expected_identity} != expected_identity
        or complete.get("status") != "completed"
        or complete.get("active_stream_id") is not None
        or complete.get("busy") is not False
        or complete.get("last_content") != "settled-done"
    ):
        raise CompatibilityFailure(
            f"B1 terminal callback did not observe settled idle state: {complete!r}"
        )
    if result.get("duplicate_terminal_accepted") is not False:
        raise CompatibilityFailure(
            "B1 accepted a duplicate terminal event for the same session/stream"
        )

    configure = result.get("configure")
    if not isinstance(configure, dict):
        raise CompatibilityFailure(
            f"Configure compatibility result is missing or malformed: {configure!r}"
        )
    expected_registration = {
        "api_function": True,
        "registered": True,
        "duplicate_rejected": True,
        "unregister_idempotent": True,
    }
    if configure.get("registration") != expected_registration:
        raise CompatibilityFailure(
            f"Configure registration contract mismatch: {configure.get('registration')!r}"
        )
    expected_scalars = {
        "installed_buttons": 1,
        "diagnostics_buttons": 0,
        "pending_before_handler": True,
        "second_click_suppressed": True,
        "reusable_after_settlement": True,
    }
    for key, expected in expected_scalars.items():
        if configure.get(key) != expected:
            raise CompatibilityFailure(
                f"Configure {key} mismatch: {configure.get(key)!r}"
            )
    focus_restores = configure.get("focus_restores")
    if focus_restores != {"success": 1, "failure": 1}:
        raise CompatibilityFailure(
            f"Configure settlement focus restoration mismatch: {focus_restores!r}"
        )
    failure = configure.get("failure")
    expected_failure = {
        "diagnostic": EXPECTED_CONFIGURE_DIAGNOSTIC,
        "generic_ui_message": EXPECTED_CONFIGURE_UI_FAILURE,
        "page_errors": [],
        "settings_usable": True,
    }
    if failure != expected_failure:
        raise CompatibilityFailure(
            f"Configure failure isolation mismatch: {failure!r}"
        )


def _run_configure_ui(
    page: Any,
    page_errors: list[str],
) -> dict[str, Any]:
    """Exercise the shipped Configure hook through Settings → Extensions."""

    try:
        from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
    except ImportError as exc:
        raise SetupFailure(
            "Playwright is required; install tests/compatibility/requirements.txt"
        ) from exc

    button_selector = (
        '#extensionsInstalled [data-extension-configure-id="capability-probe"]'
    )
    ui_stage = "settings-click"
    try:
        # Navigate through the actual Settings controls so the assertions cover
        # the mounted user surface, not only the private renderer helpers.
        page.locator('button[data-panel="settings"]').first.click()
        ui_stage = "settings-panel"
        page.locator("#panelSettings").wait_for(
            state="visible", timeout=browser_smoke.ENTRY_TIMEOUT_MS
        )
        ui_stage = "extensions-section-click"
        page.locator(
            '#settingsMenu button[data-settings-section="extensions"]'
        ).click()
        ui_stage = "extensions-pane"
        page.locator("#settingsPaneExtensions").wait_for(
            state="visible", timeout=browser_smoke.ENTRY_TIMEOUT_MS
        )
        ui_stage = "installed-tab"
        page.locator('button[data-extensions-tab="installed"]').click()
        ui_stage = "installed-list"
        page.locator("#extensionsInstalled .extension-installed-list").wait_for(
            state="visible", timeout=browser_smoke.ENTRY_TIMEOUT_MS
        )
        ui_stage = "configure-button"
        page.locator(button_selector).wait_for(
            state="visible", timeout=browser_smoke.ENTRY_TIMEOUT_MS
        )
    except PlaywrightTimeoutError as exc:
        raise CompatibilityFailure(
            "Configure Settings UI did not render the effective-enabled fixture "
            f"(stage={ui_stage})"
        ) from exc

    installed_buttons = page.locator(button_selector).count()

    page.locator('button[data-extensions-tab="diagnostics"]').click()
    try:
        page.locator("#extensionsDiagnostics .extension-installed-list").wait_for(
            state="visible", timeout=browser_smoke.ENTRY_TIMEOUT_MS
        )
    except PlaywrightTimeoutError as exc:
        raise CompatibilityFailure(
            "Configure Diagnostics surface did not render"
        ) from exc
    diagnostics_buttons = page.locator(
        '#extensionsDiagnostics [data-extension-configure-id="capability-probe"]'
    ).count()

    page.locator('button[data-extensions-tab="installed"]').click()
    page.locator(button_selector).wait_for(
        state="visible", timeout=browser_smoke.ENTRY_TIMEOUT_MS
    )

    page.locator(button_selector).evaluate(
        """button => {
          button.__configureFocusRestoreCount = 0;
          const nativeFocus = button.focus.bind(button);
          button.focus = (...args) => {
            button.__configureFocusRestoreCount += 1;
            return nativeFocus(...args);
          };
        }"""
    )
    button = page.locator(button_selector)
    button.click()
    try:
        page.wait_for_function(
            """() => {
              const probe = window.HermesCapabilityBaselineProbe;
              const state = window.HermesExtensionSettings
                ._configureStateForExtension('capability-probe');
              const button = document.querySelector(%r);
              return probe.configure.invocations === 1
                && probe.configure.pending_before_handler === true
                && state.pending === true
                && button && button.disabled === true;
            }""" % button_selector,
            timeout=browser_smoke.ENTRY_TIMEOUT_MS,
        )
    except PlaywrightTimeoutError as exc:
        raise CompatibilityFailure(
            "Configure did not enter pending before invoking the handler"
        ) from exc

    pending_before_handler = page.evaluate(
        "() => window.HermesCapabilityBaselineProbe.configure.pending_before_handler"
    )
    invocations_before_suppressed_click = page.evaluate(
        "() => window.HermesCapabilityBaselineProbe.configure.invocations"
    )
    page.evaluate(
        """selector => {
          const button = document.querySelector(selector);
          if (button) button.click();
        }""",
        button_selector,
    )
    page.wait_for_timeout(50)
    invocations_after_suppressed_click = page.evaluate(
        "() => window.HermesCapabilityBaselineProbe.configure.invocations"
    )
    second_click_suppressed = (
        invocations_after_suppressed_click == invocations_before_suppressed_click
    )

    if not page.evaluate("() => window.HermesCapabilityBaselineProbe.resolveConfigure()"):
        raise CompatibilityFailure("Configure success handler could not be settled")
    try:
        page.wait_for_function(
            """() => {
              const state = window.HermesExtensionSettings
                ._configureStateForExtension('capability-probe');
              const button = document.querySelector(%r);
              return state.pending === false && button && button.disabled === false;
            }""" % button_selector,
            timeout=browser_smoke.ENTRY_TIMEOUT_MS,
        )
    except PlaywrightTimeoutError as exc:
        raise CompatibilityFailure(
            "Configure settlement did not restore a reusable button"
        ) from exc
    success_focus_count = page.locator(button_selector).evaluate(
        "button => button.__configureFocusRestoreCount"
    )

    button.click()
    try:
        page.wait_for_function(
            "() => window.HermesCapabilityBaselineProbe.configure.invocations === 2",
            timeout=browser_smoke.ENTRY_TIMEOUT_MS,
        )
        page.wait_for_function(
            """() => document.querySelector('#toast')?.dataset.toastMessage
              === %r""" % EXPECTED_CONFIGURE_UI_FAILURE,
            timeout=browser_smoke.ENTRY_TIMEOUT_MS,
        )
        page.wait_for_function(
            """() => {
              const state = window.HermesExtensionSettings
                ._configureStateForExtension('capability-probe');
              const button = document.querySelector(%r);
              return state.pending === false && button && button.disabled === false;
            }""" % button_selector,
            timeout=browser_smoke.ENTRY_TIMEOUT_MS,
        )
    except PlaywrightTimeoutError as exc:
        raise CompatibilityFailure(
            "Configure failure did not settle with the expected generic UI error"
        ) from exc
    failure_focus_count = page.locator(button_selector).evaluate(
        "button => button.__configureFocusRestoreCount"
    )
    generic_ui_message = page.locator("#toast").get_attribute("data-toast-message")
    reusable_after_settlement = page.locator(button_selector).is_enabled()
    settings_usable = (
        page.locator("#settingsPaneExtensions").is_visible()
        and page.locator(button_selector).count() == 1
    )

    return {
        "installed_buttons": installed_buttons,
        "diagnostics_buttons": diagnostics_buttons,
        "pending_before_handler": pending_before_handler,
        "second_click_suppressed": second_click_suppressed,
        "focus_restores": {
            "success": success_focus_count,
            "failure": failure_focus_count - success_focus_count,
        },
        "reusable_after_settlement": reusable_after_settlement,
        "failure": {
            "diagnostic": None,
            "generic_ui_message": generic_ui_message,
            "page_errors": _unexpected_page_errors(page_errors),
            "settings_usable": settings_usable,
        },
    }


def _run_probe(base_url: str, evidence_dir: Path) -> dict[str, Any]:
    try:
        from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
        from playwright.sync_api import sync_playwright
    except ImportError as exc:
        raise SetupFailure(
            "Playwright is required; install tests/compatibility/requirements.txt"
        ) from exc

    responses: list[dict[str, Any]] = []
    request_failures: list[str] = []
    console_errors: list[dict[str, str]] = []
    page_errors: list[str] = []
    screenshot_path = evidence_dir / "e0-b1-capability.png"

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-dev-shm-usage"],
        )
        context = browser.new_context(service_workers="block")
        network_events = browser_smoke._install_network_guards(context)
        page = context.new_page()

        def on_response(response: Any) -> None:
            if PROBE_SCRIPT_FRAGMENT in response.url:
                responses.append({"url": response.url, "status": response.status})

        def on_request_failed(request: Any) -> None:
            if PROBE_SCRIPT_FRAGMENT in request.url:
                request_failures.append(f"{request.url}: {request.failure}")

        def on_console(message: Any) -> None:
            if message.type != "error":
                return
            location = getattr(message, "location", {}) or {}
            location_url = (
                location.get("url", "")
                if isinstance(location, dict)
                else getattr(location, "url", "")
            )
            console_errors.append({"text": str(message.text), "url": str(location_url)})

        page.on("response", on_response)
        page.on("requestfailed", on_request_failed)
        page.on("console", on_console)
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        try:
            page.goto(f"{base_url}/", wait_until="domcontentloaded", timeout=30_000)
            try:
                page.wait_for_load_state("networkidle", timeout=8_000)
            except PlaywrightTimeoutError:
                pass
            try:
                page.wait_for_function(
                    "() => window.HermesCapabilityBaselineProbe?.ready === true",
                    timeout=browser_smoke.ENTRY_TIMEOUT_MS,
                )
                page.locator(".messages-shell").wait_for(
                    state="visible", timeout=browser_smoke.ENTRY_TIMEOUT_MS
                )
            except PlaywrightTimeoutError as exc:
                raise CompatibilityFailure(
                    "E0/B1 capability probe or Core host did not become ready"
                ) from exc
            if request_failures or not responses or any(item["status"] >= 400 for item in responses):
                raise CompatibilityFailure(
                    f"capability probe resource failed: {request_failures or responses!r}"
                )
            browser_smoke._assert_browser_health(
                case_name="e0-b1-capability",
                console_errors=console_errors,
                page_errors=page_errors,
                extension_fragments=(PROBE_SCRIPT_FRAGMENT,),
                network_events=network_events,
            )
            boot_result = page.evaluate(
                "() => ({error: window.HermesCapabilityBaselineProbe.error || null})"
            )
            if boot_result.get("error"):
                raise CompatibilityFailure(
                    f"E0 registration unavailable: {boot_result['error']}"
                )
            result = page.evaluate(
                "() => window.HermesCapabilityBaselineProbe.runCompleteLifecycle()"
            )
            configure_result = _run_configure_ui(page, page_errors)
            result["configure"] = configure_result
            expected_diagnostics = [
                entry
                for entry in console_errors
                if _is_expected_configure_diagnostic(entry)
            ]
            if len(expected_diagnostics) != 1:
                raise CompatibilityFailure(
                    "Configure failure did not emit exactly the expected Core diagnostic: "
                    f"{expected_diagnostics!r}"
                )
            configure_result["failure"]["diagnostic"] = str(
                expected_diagnostics[0]["text"]
            ).splitlines()[0]
            browser_smoke._record_screenshot(page, screenshot_path)
            configure_result["registration"] = page.evaluate(
                "() => window.HermesCapabilityBaselineProbe.finishConfigureRegistration()"
            )
            unexpected_console_errors = [
                entry
                for entry in console_errors
                if not _is_expected_configure_diagnostic(entry)
            ]
            _validate_probe_result(result)
            page.wait_for_timeout(250)
            browser_smoke._assert_browser_health(
                case_name="e0-b1-capability",
                console_errors=unexpected_console_errors,
                page_errors=page_errors,
                extension_fragments=(PROBE_SCRIPT_FRAGMENT,),
                network_events=network_events,
            )
            return {
                "status": "passed",
                "probe": result,
                "resource_urls": [item["url"] for item in responses],
                "screenshot": str(screenshot_path),
                "blocked_http": list(network_events["blocked_http"]),
                "blocked_websockets": list(network_events["blocked_websockets"]),
            }
        finally:
            browser_smoke._write_json(
                evidence_dir / "e0-b1-capability-network.json", network_events
            )
            context.close()
            browser.close()


def main() -> int:
    args = _parse_args()
    evidence_dir = Path(args.evidence_dir).expanduser().resolve()
    evidence_dir.mkdir(parents=True, exist_ok=True)
    result_path = evidence_dir / "e0-b1-capability-results.json"
    result: dict[str, Any] = {
        "core_contract": "E0+B1+Configure",
        "fixture_extension": "capability-probe",
    }
    proc = None
    log_file = None
    try:
        core_dir = Path(args.core_dir).expanduser().resolve()
        if not core_dir.is_dir():
            raise SetupFailure(
                "HERMES_CORE_DIR/--core-dir must point to an independent Hermes WebUI checkout"
            )
        if not (FIXTURE_ROOT / "manifest.json").is_file():
            raise SetupFailure(f"capability fixture is unavailable: {FIXTURE_ROOT}")

        with tempfile.TemporaryDirectory(prefix="hermes-e0-b1-compat-") as temp:
            temp_root = Path(temp)
            extension_root = temp_root / "extensions"
            fixture_target = extension_root / "capability-probe"
            extension_root.mkdir()
            shutil.copytree(FIXTURE_ROOT, fixture_target)
            try:
                proc, log_file, base_url, port = browser_smoke._start_server(
                    core_dir=core_dir,
                    extension_root=extension_root,
                    manifest_relative="capability-probe/manifest.json",
                    state_root=temp_root / "state",
                    log_path=evidence_dir / "e0-b1-capability-server.log",
                    requested_port=args.port,
                )
                result.update(_run_probe(base_url, evidence_dir))
                result["port"] = port
            finally:
                browser_smoke._terminate(proc, log_file)
                proc = None
                log_file = None
        browser_smoke._write_json(result_path, result)
        print("E0/B1/CONFIGURE CAPABILITY COMPATIBILITY PASSED")
        print(
            "registration=passed lifecycle=start+complete-once settled-idle=passed "
            "configure=registered-ui-pending-focus-failure-isolated"
        )
        print(f"evidence={evidence_dir}")
        return 0
    except SetupFailure as exc:
        result["status"] = "setup_failure"
        result["error"] = str(exc)
        browser_smoke._write_json(result_path, result)
        print(f"SETUP FAILURE: {exc}", file=sys.stderr)
        print(f"evidence={evidence_dir}", file=sys.stderr)
        return 2
    except CompatibilityFailure as exc:
        result["status"] = "failed"
        result["error"] = str(exc)
        browser_smoke._write_json(result_path, result)
        print(f"E0/B1 CAPABILITY COMPATIBILITY FAILED: {exc}", file=sys.stderr)
        print(f"evidence={evidence_dir}", file=sys.stderr)
        return 1
    except Exception as exc:
        result["status"] = "harness_error"
        result["error"] = f"{type(exc).__name__}: {exc}"
        result["traceback"] = traceback.format_exc()
        browser_smoke._write_json(result_path, result)
        print(f"HARNESS ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
        print(f"evidence={evidence_dir}", file=sys.stderr)
        return 2
    finally:
        browser_smoke._terminate(proc, log_file)


if __name__ == "__main__":
    sys.exit(main())
