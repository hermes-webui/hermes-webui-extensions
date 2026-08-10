import unittest

from browser_smoke import EXPECTED_CORE_BASELINE_REQUESTS
from typography_smoke import _filtered_unexpected_http


class TypographyNetworkFilterTests(unittest.TestCase):
    def test_only_one_exact_core_reload_is_filtered_per_url(self) -> None:
        url, (resource_type, max_occurrences) = next(iter(EXPECTED_CORE_BASELINE_REQUESTS.items()))
        reload_event = {
            "url": url,
            "method": "GET",
            "resource_type": resource_type,
            "occurrence": max_occurrences + 1,
        }
        wrong_method = {**reload_event, "method": "POST"}

        self.assertEqual(
            _filtered_unexpected_http([reload_event, reload_event, wrong_method], True),
            [reload_event, wrong_method],
        )
        self.assertEqual(_filtered_unexpected_http([reload_event], False), [reload_event])


if __name__ == "__main__":
    unittest.main()