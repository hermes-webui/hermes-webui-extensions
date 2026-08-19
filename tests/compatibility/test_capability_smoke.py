"""Regression tests for the E0/B1 compatibility result contract."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parent))
import capability_smoke  # noqa: E402


def _valid_result() -> dict:
    return {
        "registration": {
            "id": "capability-probe",
            "handle_fields": ["events", "id", "settings", "storage"],
            "handle_frozen": True,
            "events_frozen": True,
            "same_handle": True,
            "unknown_is_null": True,
            "unknown_storage_unchanged": True,
        },
        "events": [
            {
                "type": "turn:start",
                "session_id": "capability-session",
                "stream_id": "capability-stream",
                "active_stream_id": "capability-stream",
                "busy": True,
                "last_content": "question",
            },
            {
                "type": "turn:complete",
                "session_id": "capability-session",
                "stream_id": "capability-stream",
                "status": "completed",
                "active_stream_id": None,
                "busy": False,
                "last_content": "settled-done",
            },
        ],
        "duplicate_terminal_accepted": False,
        "configure": {
            "registration": {
                "api_function": True,
                "registered": True,
                "duplicate_rejected": True,
                "unregister_idempotent": True,
            },
            "installed_buttons": 1,
            "diagnostics_buttons": 0,
            "pending_before_handler": True,
            "second_click_suppressed": True,
            "focus_restores": {"success": 1, "failure": 1},
            "reusable_after_settlement": True,
            "failure": {
                "diagnostic": capability_smoke.EXPECTED_CONFIGURE_DIAGNOSTIC,
                "generic_ui_message": capability_smoke.EXPECTED_CONFIGURE_UI_FAILURE,
                "page_errors": [],
                "settings_usable": True,
            },
        },
    }


class CapabilityResultContractTests(unittest.TestCase):
    def test_expected_configure_diagnostic_accepts_playwright_stack_suffix(self) -> None:
        entry = {
            "text": (
                capability_smoke.EXPECTED_CONFIGURE_DIAGNOSTIC
                + "\n    at <anonymous>:1:80"
            )
        }
        self.assertTrue(capability_smoke._is_expected_configure_diagnostic(entry))

    def test_near_match_configure_diagnostic_is_not_expected(self) -> None:
        entries = [
            {
                "text": capability_smoke.EXPECTED_CONFIGURE_DIAGNOSTIC.replace(
                    "capability-probe", "other-extension", 1
                )
            },
            {
                "text": capability_smoke.EXPECTED_CONFIGURE_DIAGNOSTIC.replace(
                    "intentional Configure failure", "different failure", 1
                )
            },
            {
                "text": capability_smoke.EXPECTED_CONFIGURE_DIAGNOSTIC
                + " extra text on the first line"
            },
        ]
        for entry in entries:
            self.assertFalse(capability_smoke._is_expected_configure_diagnostic(entry))

    def test_known_sandbox_page_error_is_filtered(self) -> None:
        benign = (
            "Failed to read the 'serviceWorker' property from 'Navigator': "
            "Service worker is disabled because the context is sandboxed "
            "and lacks the 'allow-same-origin' flag."
        )
        self.assertEqual(capability_smoke._unexpected_page_errors([benign]), [])

    def test_configure_page_error_is_not_filtered(self) -> None:
        unexpected = "capability-probe Configure page error"
        self.assertEqual(
            capability_smoke._unexpected_page_errors([unexpected]), [unexpected]
        )

    def test_complete_lifecycle_result_is_accepted(self) -> None:
        capability_smoke._validate_probe_result(_valid_result())

    def test_configure_result_is_required(self) -> None:
        result = _valid_result()
        result.pop("configure")
        with self.assertRaises(capability_smoke.CompatibilityFailure):
            capability_smoke._validate_probe_result(result)

    def test_malformed_configure_result_is_rejected(self) -> None:
        result = _valid_result()
        result["configure"]["failure"]["generic_ui_message"] = "handler boom"
        with self.assertRaises(capability_smoke.CompatibilityFailure):
            capability_smoke._validate_probe_result(result)

    def test_duplicate_terminal_event_is_rejected(self) -> None:
        result = _valid_result()
        result["events"].append(dict(result["events"][-1]))
        with self.assertRaises(capability_smoke.CompatibilityFailure):
            capability_smoke._validate_probe_result(result)

    def test_malformed_event_is_a_compatibility_failure(self) -> None:
        result = _valid_result()
        result["events"][0] = None
        with self.assertRaises(capability_smoke.CompatibilityFailure):
            capability_smoke._validate_probe_result(result)

    def test_unknown_registration_must_fail_closed_without_storage_side_effects(self) -> None:
        result = _valid_result()
        result["registration"]["unknown_is_null"] = False
        result["registration"]["unknown_storage_unchanged"] = False
        with self.assertRaises(capability_smoke.CompatibilityFailure):
            capability_smoke._validate_probe_result(result)

    def test_terminal_callback_must_observe_idle_settled_state(self) -> None:
        result = _valid_result()
        result["events"][-1]["active_stream_id"] = "capability-stream"
        result["events"][-1]["busy"] = True
        with self.assertRaises(capability_smoke.CompatibilityFailure):
            capability_smoke._validate_probe_result(result)


if __name__ == "__main__":
    unittest.main()
