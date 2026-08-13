#!/usr/bin/env python3
"""Certify the pinned Core E0 identity and B1 turn-lifecycle contracts."""

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

SetupFailure = browser_smoke.SetupFailure
CompatibilityFailure = browser_smoke.CompatibilityFailure


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
            _validate_probe_result(result)
            page.wait_for_timeout(250)
            browser_smoke._record_screenshot(page, screenshot_path)
            browser_smoke._assert_browser_health(
                case_name="e0-b1-capability",
                console_errors=console_errors,
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
        "core_contract": "E0+B1",
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
        print("E0/B1 CAPABILITY COMPATIBILITY PASSED")
        print("registration=passed lifecycle=start+complete-once settled-idle=passed")
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
