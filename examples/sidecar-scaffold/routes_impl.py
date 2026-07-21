"""Example route implementations for the sidecar scaffold.

This is the ONLY file an extension author writes. It shows every capability the
three real PR-#64 sidecars need: JSON, path params, query strings, a binary
response with a custom content-type, a gzip-JSON response, and a background
thread. Auth is handled entirely by the scaffold — nothing here touches the
token; a handler simply cannot be reached without a valid one (except /health,
which the scaffold owns).
"""
from __future__ import annotations

import threading
import time

# Trivial in-memory state a background daemon updates, to show threads are fine.
_STATE = {"ticks": 0}

# A 1x1 transparent PNG, to demonstrate a binary response with custom headers.
_PNG_1x1 = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06"
    b"\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05"
    b"\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82"
)


def register(app) -> None:
    @app.route("GET", "/api/status")
    def status(req):
        # query string reachable via req.query / req.query_one
        verbose = req.query_one("verbose") == "1"
        payload = {"ticks": _STATE["ticks"]}
        if verbose:
            payload["note"] = "verbose"
        return app.json(payload)

    @app.route("GET", "/api/items/{item_id}")
    def get_item(req):
        # path parameter
        return app.json({"id": req.params["item_id"]})

    @app.route("GET", "/api/report")
    def report(req):
        # gzip-JSON convenience (feeds + sysinfo hand-roll this today)
        return app.gzip_json({"rows": list(range(100))})

    @app.route("GET", "/api/pixel.png")
    def pixel(req):
        # binary response with a custom content-type + hardening header
        return (200, {"Content-Type": "image/png", "X-Content-Type-Options": "nosniff"}, _PNG_1x1)

    @app.route("POST", "/api/echo")
    def echo(req):
        # raw request body (multipart / arbitrary bytes) available as req.body
        return app.json({"received_bytes": len(req.body)})


def start_background(app) -> None:
    def _tick():
        while True:
            _STATE["ticks"] += 1
            time.sleep(5)
    threading.Thread(target=_tick, daemon=True).start()
