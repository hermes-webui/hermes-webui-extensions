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
    }


class CapabilityResultContractTests(unittest.TestCase):
    def test_complete_lifecycle_result_is_accepted(self) -> None:
        capability_smoke._validate_probe_result(_valid_result())

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
