"""Route implementations for the rss-feeds sidecar (token-v1 scaffold).

``feeds.py`` holds all the reader logic — feed fetch with SSRF/redirect
hardening, parsing, read tracking, and AI summaries — and does its own internal
path routing in ``handle_get / handle_post / handle_patch / handle_delete``,
writing responses through ``shim.j(handler, ...)`` (and a couple of raw
``handler.send_*`` calls for the favicon). Rather than rewrite that ~1900-line
module (and risk its hardening), this file adapts it: ``_Capture`` mimics the
small handler surface those functions touch, so each scaffold route runs the
matching ``feeds.py`` handler and returns exactly what it wrote.

Auth is enforced deny-by-default by the scaffold (``sidecar_base.py``); every
route here is reachable only with a valid ``X-Hermes-Sidecar-Token``, and
``/health`` (scaffold-owned) is the sole tokenless route. The old SSE
``/api/feeds/refresh/stream`` route is intentionally dropped: the WebUI proxy
buffers responses (no streaming), and the frontend already uses the plain
``POST /api/feeds/refresh``.
"""
from __future__ import annotations

import json
from urllib.parse import SplitResult, urlencode

import feeds


class _Capture:
    """Mimics the subset of BaseHTTPRequestHandler that feeds.py + shim.j use,
    capturing the response instead of writing it to a socket."""

    def __init__(self, headers):
        self.headers = headers          # feeds/shim read .get("Accept-Encoding"), etc.
        self.wfile = self               # feeds/shim call handler.wfile.write(...)
        self._status = 200
        self._hdrs = {}
        self._chunks = []
        self.responded = False          # set once a handler writes a response

    # response builders
    def send_response(self, code, *_a):
        self._status = int(code)
        self.responded = True

    def send_header(self, key, value):
        self._hdrs[str(key)] = str(value)

    def end_headers(self):
        pass

    def write(self, chunk):             # wfile.write
        if chunk:
            self._chunks.append(chunk if isinstance(chunk, (bytes, bytearray)) else str(chunk).encode("utf-8"))

    def flush(self):
        pass

    def result(self):
        body = b"".join(bytes(c) for c in self._chunks)
        # The scaffold recomputes Content-Length; drop ours so it isn't sent twice.
        hdrs = {k: v for k, v in self._hdrs.items() if k.lower() != "content-length"}
        return self._status, hdrs, body


def _parsed(req):
    """Rebuild a urlsplit-style object (path + raw query string) for feeds.py,
    which does its own parse_qs on ``parsed.query``."""
    qs = urlencode(req.query, doseq=True) if req.query else ""
    return SplitResult(scheme="", netloc="", path=req.path, query=qs, fragment="")


def _json_body(req):
    try:
        return json.loads(req.body or b"{}")
    except Exception:
        return {}


def _dispatch(app, fn, req, *args):
    # feeds.py handlers write via j()/raw send_* and then `return j(...)` (which is
    # None) — so the return value is NOT a reliable "handled" signal. Detect whether
    # a response was actually written instead; an unmatched route writes nothing.
    cap = _Capture(req.headers)
    try:
        fn(cap, *args)
    except Exception as exc:  # never leak a traceback
        return app.json({"error": f"sidecar error: {exc}"}, status=500)
    if not cap.responded:
        return app.json({"error": "not found"}, status=404)
    return cap.result()


def register(app) -> None:
    # -- GET (feeds.handle_get routes internally by path) --
    @app.route("GET", "/api/feeds")
    def g_root(req):
        return _dispatch(app, feeds.handle_get, req, _parsed(req))

    @app.route("GET", "/api/feeds/favicon")
    def g_favicon(req):
        return _dispatch(app, feeds.handle_get, req, _parsed(req))

    @app.route("GET", "/api/feeds/settings")
    def g_settings(req):
        return _dispatch(app, feeds.handle_get, req, _parsed(req))

    @app.route("GET", "/api/feeds/summary-status")
    def g_sumstatus(req):
        return _dispatch(app, feeds.handle_get, req, _parsed(req))

    @app.route("GET", "/api/feeds/refresh-status")
    def g_refreshstatus(req):
        return _dispatch(app, feeds.handle_get, req, _parsed(req))

    @app.route("GET", "/api/feeds/summary-test-status")
    def g_sumteststatus(req):
        return _dispatch(app, feeds.handle_get, req, _parsed(req))

    @app.route("GET", "/api/feeds/add-status")
    def g_addstatus(req):
        return _dispatch(app, feeds.handle_get, req, _parsed(req))

    @app.route("GET", "/api/feeds/entries")
    def g_entries(req):
        return _dispatch(app, feeds.handle_get, req, _parsed(req))

    @app.route("GET", "/api/feeds/summaries")
    def g_summaries(req):
        return _dispatch(app, feeds.handle_get, req, _parsed(req))

    # -- POST --
    @app.route("POST", "/api/feeds")
    def p_root(req):
        return _dispatch(app, feeds.handle_post, req, _parsed(req), _json_body(req))

    @app.route("POST", "/api/feeds/refresh")
    def p_refresh(req):
        return _dispatch(app, feeds.handle_post, req, _parsed(req), _json_body(req))

    @app.route("POST", "/api/feeds/read")
    def p_read(req):
        return _dispatch(app, feeds.handle_post, req, _parsed(req), _json_body(req))

    @app.route("POST", "/api/feeds/summary-test")
    def p_sumtest(req):
        return _dispatch(app, feeds.handle_post, req, _parsed(req), _json_body(req))

    @app.route("POST", "/api/feeds/summarize")
    def p_summarize(req):
        return _dispatch(app, feeds.handle_post, req, _parsed(req), _json_body(req))

    @app.route("POST", "/api/feeds/settings")
    def p_settings(req):
        return _dispatch(app, feeds.handle_post, req, _parsed(req), _json_body(req))

    # -- PATCH (feed edit; feeds.handle_patch extracts the id from the path) --
    @app.route("PATCH", "/api/feeds/{fid}")
    def pa_feed(req):
        return _dispatch(app, feeds.handle_patch, req, _parsed(req), _json_body(req))

    # -- DELETE (summaries first — more specific — then a feed by id) --
    @app.route("DELETE", "/api/feeds/summaries/{sid}")
    def d_summary(req):
        return _dispatch(app, feeds.handle_delete, req, _parsed(req))

    @app.route("DELETE", "/api/feeds/{fid}")
    def d_feed(req):
        return _dispatch(app, feeds.handle_delete, req, _parsed(req))
