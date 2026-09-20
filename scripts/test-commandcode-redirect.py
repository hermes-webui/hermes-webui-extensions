#!/usr/bin/env python3
"""Regression tests for the commandcode-usage sidecar's credential safety.

The sidecar calls Command Code's alpha billing endpoints with an
``Authorization: Bearer <key>`` header. urllib follows redirects while
PRESERVING that header, so a redirect would hand the API key to an unknown
host. These tests assert that the sidecar refuses any redirect (the redirect
target is never contacted and never sees the key) and that an oversized
upstream body is rejected, keeping the payload inside core's sidecar-proxy cap.
"""
from __future__ import annotations

import http.server
import importlib.util
import json
import sys
import threading
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SIDECAR_DIR = REPO_ROOT / "extensions" / "commandcode-usage" / "sidecar"
_SOURCE = SIDECAR_DIR / "commandcode_usage.py"
_SPEC = importlib.util.spec_from_file_location("commandcode_usage_collector", _SOURCE)
if _SPEC is None or _SPEC.loader is None:
    raise RuntimeError(f"cannot load {_SOURCE}")
ccu = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = ccu
_SPEC.loader.exec_module(ccu)


class _TargetHandler(http.server.BaseHTTPRequestHandler):
    """The redirect destination — must never receive a request."""
    hits = 0

    def do_GET(self):  # noqa: N802
        type(self).hits += 1
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"credits":{}}')

    def log_message(self, *args):  # silence
        pass


class _OriginHandler(http.server.BaseHTTPRequestHandler):
    target = ("127.0.0.1", 0)
    mode = "redirect"       # redirect | payload | oversize
    payloads: dict = {}     # path -> response body (payload mode)

    def do_GET(self):  # noqa: N802
        if self.mode == "redirect":
            host, port = self.target
            self.send_response(302)
            self.send_header("Location", f"http://{host}:{port}/landed")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        if self.mode == "oversize":
            self.wfile.write(b"a" * (ccu._MAX_UPSTREAM_BYTES + 1))  # > 64 KiB
            return
        self.wfile.write(self.payloads.get(self.path, b"{}"))

    def log_message(self, *args):  # silence
        pass


class CommandCodeFetchSafetyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.servers: list[http.server.HTTPServer] = []
        _OriginHandler.mode = "redirect"
        _OriginHandler.payloads = {}

    def tearDown(self) -> None:
        for srv in self.servers:
            srv.shutdown()
            srv.server_close()

    def _serve(self, handler_cls) -> tuple[http.server.HTTPServer, tuple]:
        srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler_cls)
        thread = threading.Thread(target=srv.serve_forever, daemon=True)
        thread.start()
        self.servers.append(srv)
        return srv, srv.server_address

    def _point_all_endpoints(self, addr) -> tuple:
        """Redirect every collector URL at the local origin, returning the old ones."""
        old = (ccu.CREDITS_URL, ccu.SUBSCRIPTIONS_URL, ccu.SUMMARY_URL)
        base = f"http://{addr[0]}:{addr[1]}"
        ccu.CREDITS_URL = base + "/credits"
        ccu.SUBSCRIPTIONS_URL = base + "/subs"
        ccu.SUMMARY_URL = base + "/summary"
        return old

    @staticmethod
    def _restore(old: tuple) -> None:
        ccu.CREDITS_URL, ccu.SUBSCRIPTIONS_URL, ccu.SUMMARY_URL = old

    def test_redirect_refused_key_never_leaks(self) -> None:
        target, target_addr = self._serve(_TargetHandler)
        origin, origin_addr = self._serve(_OriginHandler)
        _OriginHandler.target = target_addr

        old = self._point_all_endpoints(origin_addr)
        try:
            result = ccu.account_usage("SUPER_SECRET_KEY_12345", force=True)
        finally:
            self._restore(old)

        self.assertEqual(result.get("error"), "redirected")
        self.assertFalse(result.get("available", True))
        # The redirect destination must never be contacted — so it can never
        # observe the Authorization header.
        self.assertEqual(_TargetHandler.hits, 0)
        _TargetHandler.hits = 0

    def test_oversized_body_rejected(self) -> None:
        origin, origin_addr = self._serve(_OriginHandler)
        _OriginHandler.mode = "oversize"

        old = self._point_all_endpoints(origin_addr)
        try:
            result = ccu.account_usage("KEY", force=True)
        finally:
            self._restore(old)

        self.assertEqual(result.get("error"), "bad_payload")
        self.assertFalse(result.get("available", True))

    def test_normal_payload_parsed(self) -> None:
        origin, origin_addr = self._serve(_OriginHandler)
        _OriginHandler.mode = "payload"
        _OriginHandler.payloads = {
            "/credits": json.dumps({
                "credits": {
                    "belowThreshold": False,
                    "creditThreshold": 0,
                    "monthlyCredits": 69.31,
                    "purchasedCredits": 0,
                    "freeCredits": 0,
                },
                "windowLimits": {
                    "limited": True,
                    "exceeded": None,
                    "fiveHour": {"used": 0.7, "cap": 14, "exceeded": False, "resetAt": 1789944078499},
                    "weekly": {"used": 0.7, "cap": 35, "exceeded": False, "resetAt": 1790530878499},
                },
            }).encode(),
            "/subs": json.dumps({
                "success": True,
                "data": {
                    "planId": "individual-goat",
                    "status": "active",
                    "cancelAtPeriodEnd": False,
                    "currentPeriodEnd": "2026-10-20T17:38:23.000Z",
                },
            }).encode(),
            "/summary": json.dumps({
                "totalCount": 212,
                "totalCost": 0.619,
                "successRate": 100,
                "periodBasis": "billing-period",
            }).encode(),
        }

        old = self._point_all_endpoints(origin_addr)
        try:
            result = ccu.account_usage("KEY", force=True)
        finally:
            self._restore(old)

        self.assertTrue(result.get("available"))
        self.assertIsNone(result.get("error"))
        self.assertEqual(result["windows"]["five_hour"]["percent"], 5.0)  # 0.7 / 14
        self.assertEqual(result["windows"]["weekly"]["cap"], 35.0)
        self.assertTrue(result["windows"]["five_hour"]["resets_at"].endswith("Z"))
        self.assertEqual(result["plan"]["label"], "GOAT")
        self.assertEqual(result["plan"]["renews_at"], "2026-10-20T17:38:23.000Z")
        self.assertEqual(result["period"]["requests"], 212)
        self.assertAlmostEqual(result["period"]["cost"], 0.619)
        self.assertEqual(result["credits"]["monthly_remaining"], 69.31)


if __name__ == "__main__":
    unittest.main(verbosity=2)
