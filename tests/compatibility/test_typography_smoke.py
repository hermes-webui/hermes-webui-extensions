import unittest

from browser_smoke import EXPECTED_CORE_BASELINE_REQUESTS
from typography_smoke import CONFIGURE_SELECTOR, FONT_CANDIDATES, _filtered_unexpected_http


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


class TypographyConfigureSurfaceTests(unittest.TestCase):
    def test_configure_selector_targets_installed_typography_only(self) -> None:
        self.assertEqual(
            CONFIGURE_SELECTOR,
            '#extensionsInstalled [data-extension-configure-id="typography"]',
        )

    def test_macos_fallback_candidates_are_distinct_paths(self) -> None:
        self.assertIn("/System/Library/Fonts/SFNS.ttf", FONT_CANDIDATES)
        self.assertIn("/System/Library/Fonts/SFNSMono.ttf", FONT_CANDIDATES)


if __name__ == "__main__":
    unittest.main()
