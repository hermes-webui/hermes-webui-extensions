"""Route implementations for the hermes-graph sidecar (token-v1 scaffold).

Read-only graph API. Every route runs behind the scaffold's deny-by-default token guard
(``sidecar_base.py``); ``/health`` (scaffold-owned) is the only tokenless route.
The heavy work lives in ``graph_index.py`` / ``graph_service.py`` and runs in a background
thread started by ``start_background`` — a request never waits for an index build
(the WebUI proxy buffers, caps the response at 512 KiB and times out at ~10 s).
"""
from __future__ import annotations

import os

import graph_service

SERVICE = graph_service.GraphService()


def _int(value, default, lo, hi):
    try:
        return max(lo, min(hi, int(value)))
    except (TypeError, ValueError):
        return default


def start_background(app) -> None:
    try:
        os.nice(10)   # indexing must never compete with the agent / WebUI for CPU
    except OSError:
        pass
    SERVICE.start()


def register(app) -> None:
    @app.route("GET", "/graph")
    def graph_get(req):
        roots = req.query_one("roots", "ws")
        max_nodes = _int(req.query_one("max_nodes"), 4000, 50, 20000)
        while True:  # shrink until the compressed body fits the proxy's 512 KiB cap
            payload = SERVICE.graph(roots=roots, max_nodes=max_nodes)
            if payload.get("state") != "ready":
                return app.json(payload, status=202)
            body = SERVICE.encode(payload)
            if len(body) <= graph_service.RESPONSE_BUDGET or max_nodes <= 50:
                return 200, {"Content-Type": "application/json", "Content-Encoding": "gzip"}, body
            max_nodes = int(max_nodes * 0.75)

    @app.route("GET", "/graph/ego")
    def ego_get(req):
        payload = SERVICE.ego(req.query_one("id", ""), hops=_int(req.query_one("hops"), 2, 1, 3))
        return app.gzip_json(payload)

    @app.route("GET", "/status")
    def status_get(req):
        return app.json(SERVICE.status())

    @app.route("POST", "/reindex")
    def reindex_post(req):
        SERVICE.start()
        return app.json({"state": "started"}, status=202)
