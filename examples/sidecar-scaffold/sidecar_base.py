"""Canonical loopback-sidecar scaffold for Hermes WebUI extensions.

    SIDECAR_BASE_VERSION = 1

DO NOT EDIT per-extension. This file is vendored byte-identical into every
sidecar extension and verified by CI (`scripts/sync-sidecar-base.mjs --check`).
Per-extension values (id, port, handler module) come from `sidecar.json` at
runtime — never edit a constant in here. If you need behavior this file does not
provide, propose a change to the canonical copy, bump SIDECAR_BASE_VERSION, and
re-sync every extension; do not fork it.

Why the scaffold owns the dispatch loop
----------------------------------------
The loopback port is reachable by any local process, and the WebUI proxy strips
every inbound credential before forwarding, so a sidecar cannot tell a proxied
request from a direct one. WebUI (token-v1) mints a per-extension secret and
injects it as ``X-Hermes-Sidecar-Token`` on every proxied request. This scaffold
validates that token **deny-by-default at the single dispatch chokepoint** — auth
is inherited, not invoked per route, so a forgotten guard cannot open a route.
Only ``GET/HEAD /health`` is served without a token (the WebUI diagnostics probe
hits it cross-origin).

What it protects (be honest): callers that cannot read the user's state dir
(other-UID users, host containers, sandboxed network-only processes). It does NOT
defend against arbitrary same-UID code — that can read the token file directly.

Envelope (matches the WebUI proxy — do not fight it)
----------------------------------------------------
Requests/responses are fully buffered by the proxy: response body <= 512 KiB,
request body <= the proxy cap, ~10 s upstream timeout, NO streaming/SSE. For work
longer than a few seconds use the start-job + poll pattern (see
docs/SIDECAR_CONTRACT.md), not a long-held request.

Handler contract
----------------
Register handlers against method + path (path params with ``{name}``)::

    app = Sidecar()                       # reads sidecar.json next to this file

    @app.route("GET", "/api/items")
    def list_items(req):
        return app.json({"items": [...]})          # -> (200, headers, bytes)

    @app.route("GET", "/api/items/{item_id}")
    def get_item(req):
        return app.json({"id": req.params["item_id"]})

    @app.route("POST", "/api/upload")
    def upload(req):
        data = req.body                             # raw bytes (multipart etc.)
        return (200, {"Content-Type": "image/png"}, blob)   # binary ok

    # background threads are fine — the scaffold owns the dispatch loop, not the
    # process. Start threads, then serve.
    app.serve()

A handler returns either ``app.json(obj)`` / ``app.gzip_json(obj)`` or a raw
``(status:int, headers:dict, body:bytes)`` tuple.
"""
from __future__ import annotations

import gzip
import hmac
import json
import os
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Callable, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, urlsplit

SIDECAR_BASE_VERSION = 1

_TOKEN_HEADER = "X-Hermes-Sidecar-Token"
_HEALTH_PATHS = {"/health"}
# Request-body ceiling the scaffold enforces itself (the proxy also caps; this is
# defense-in-depth so a direct caller can't OOM the sidecar).
_MAX_REQUEST_BYTES = 20 * 1024 * 1024
_LOOPBACK_HOST = "127.0.0.1"


class Request:
    __slots__ = ("method", "path", "query", "params", "headers", "body")

    def __init__(self, method, path, query, params, headers, body):
        self.method = method
        self.path = path
        self.query: Dict[str, List[str]] = query
        self.params: Dict[str, str] = params
        self.headers = headers
        self.body: bytes = body

    def query_one(self, name: str, default: Optional[str] = None) -> Optional[str]:
        vals = self.query.get(name)
        return vals[0] if vals else default


def _compile(path: str) -> Tuple[re.Pattern, List[str]]:
    """Turn '/api/items/{id}' into a regex + the param names."""
    names: List[str] = []
    out = ["^"]
    for seg in path.split("/"):
        if not seg:
            continue
        out.append("/")
        m = re.fullmatch(r"\{([a-zA-Z_][a-zA-Z0-9_]*)\}", seg)
        if m:
            names.append(m.group(1))
            out.append(r"([^/]+)")
        else:
            out.append(re.escape(seg))
    out.append("/?$")
    return re.compile("".join(out)), names


def _resolve_token_path(ext_id: str) -> Optional[Path]:
    """Resolve the token file the SAME way core does (§9.2). Explicit override
    first, then the WebUI state dir, then HERMES_HOME/webui, then the platform
    default — so a relocated state dir does not silently break auth."""
    override = os.getenv("HERMES_EXT_SIDECAR_TOKEN_FILE")
    if override:
        return Path(override).expanduser()
    state_dir = os.getenv("HERMES_WEBUI_STATE_DIR")
    if state_dir:
        return Path(state_dir).expanduser() / "sidecar-auth" / f"{ext_id}.token"
    home = os.getenv("HERMES_HOME")
    if home:
        return Path(home).expanduser() / "webui" / "sidecar-auth" / f"{ext_id}.token"
    # Platform default mirrors core api/paths.py.
    if sys.platform == "win32":
        base = os.getenv("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(base) / "hermes" / "webui" / "sidecar-auth" / f"{ext_id}.token"
    return Path.home() / ".hermes" / "webui" / "sidecar-auth" / f"{ext_id}.token"


class Sidecar:
    def __init__(self, config_path: Optional[str] = None):
        cfg = self._load_config(config_path)
        self.ext_id: str = cfg["id"]
        self.port: int = int(cfg["port"])
        self.proxy_auth: str = cfg.get("proxy_auth", "token-v1")
        self._token_path = _resolve_token_path(self.ext_id)
        self._routes: List[Tuple[str, re.Pattern, List[str], Callable]] = []

    @staticmethod
    def _load_config(config_path: Optional[str]) -> Dict:
        p = Path(config_path) if config_path else Path(__file__).with_name("sidecar.json")
        cfg = json.loads(p.read_text(encoding="utf-8"))
        if not isinstance(cfg, dict) or "id" not in cfg or "port" not in cfg:
            raise ValueError("sidecar.json must define at least {id, port}")
        return cfg

    # -- registration -------------------------------------------------------
    def route(self, method: str, path: str):
        pattern, names = _compile(path)
        def deco(fn: Callable) -> Callable:
            self._routes.append((method.upper(), pattern, names, fn))
            return fn
        return deco

    # -- response helpers ---------------------------------------------------
    @staticmethod
    def json(obj, status: int = 200) -> Tuple[int, Dict[str, str], bytes]:
        body = json.dumps(obj).encode("utf-8")
        return status, {"Content-Type": "application/json"}, body

    @staticmethod
    def gzip_json(obj, status: int = 200) -> Tuple[int, Dict[str, str], bytes]:
        body = gzip.compress(json.dumps(obj).encode("utf-8"))
        return status, {"Content-Type": "application/json", "Content-Encoding": "gzip"}, body

    # -- auth ---------------------------------------------------------------
    def _current_token(self) -> Optional[str]:
        if self._token_path is None:
            return None
        try:
            tok = self._token_path.read_text(encoding="utf-8").strip()
        except (OSError, UnicodeDecodeError):
            return None
        return tok or None

    def _authorized(self, headers) -> bool:
        if self.proxy_auth != "token-v1":
            return True  # legacy sidecar (declared unauthenticated in its manifest)
        expected = self._current_token()  # re-read per request: live rotation
        if not expected:
            return False  # fail closed when no token on disk
        presented = headers.get(_TOKEN_HEADER, "")
        return bool(presented) and hmac.compare_digest(presented, expected)

    # -- serving ------------------------------------------------------------
    def _dispatch(self, method: str, raw_path: str, headers, read_body: Callable) -> Tuple[int, Dict[str, str], bytes]:
        parsed = urlsplit(raw_path)
        path = parsed.path
        # Health is the ONLY tokenless route (WebUI probes it cross-origin).
        if path in _HEALTH_PATHS and method in ("GET", "HEAD"):
            return self.json({"ok": True, "sidecar_base_version": SIDECAR_BASE_VERSION})
        # Deny-by-default: every non-health route requires the injected token.
        if not self._authorized(headers):
            return self.json(
                {
                    "error": "sidecar proxy token missing or mismatched",
                    "hint": "requests must arrive through the authenticated WebUI "
                            "sidecar proxy; is WebUI running and do core + sidecar "
                            "agree on the state dir?",
                    "sidecar_base_version": SIDECAR_BASE_VERSION,
                },
                status=401 if self._current_token() else 503,
            )
        query = parse_qs(parsed.query)
        for r_method, pattern, names, fn in self._routes:
            if r_method != method:
                continue
            m = pattern.match(path)
            if not m:
                continue
            params = dict(zip(names, m.groups()))
            body = read_body()
            req = Request(method, path, query, params, headers, body)
            result = fn(req)
            return self._normalize(result)
        return self.json({"error": "not found"}, status=404)

    @staticmethod
    def _normalize(result) -> Tuple[int, Dict[str, str], bytes]:
        if isinstance(result, tuple) and len(result) == 3:
            status, headers, body = result
            if isinstance(body, str):
                body = body.encode("utf-8")
            return int(status), dict(headers or {}), body or b""
        raise TypeError("handler must return app.json(...)/app.gzip_json(...) or (status, headers, bytes)")

    def serve(self) -> None:
        app = self

        class Handler(BaseHTTPRequestHandler):
            def _run(self, method: str):
                def read_body() -> bytes:
                    try:
                        n = int(self.headers.get("Content-Length", 0))
                    except (TypeError, ValueError):
                        n = 0
                    if n < 0 or n > _MAX_REQUEST_BYTES:
                        return b""
                    return self.rfile.read(n) if n else b""
                try:
                    status, headers, body = app._dispatch(method, self.path, self.headers, read_body)
                except Exception:  # never leak a traceback to the caller
                    status, headers, body = app.json({"error": "internal error"}, status=500)
                self.send_response(status)
                sent_ct = False
                for k, v in (headers or {}).items():
                    if k.lower() == "content-type":
                        sent_ct = True
                    # never echo the token back, even if a handler set it
                    if k.lower().startswith("x-hermes-"):
                        continue
                    self.send_header(k, v)
                if not sent_ct:
                    self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                if method != "HEAD":
                    self.wfile.write(body)

            def do_GET(self):
                self._run("GET")

            def do_HEAD(self):
                self._run("HEAD")

            def do_POST(self):
                self._run("POST")

            def do_PUT(self):
                self._run("PUT")

            def do_PATCH(self):
                self._run("PATCH")

            def do_DELETE(self):
                self._run("DELETE")

            def log_message(self, format, *args):
                pass  # no request logging (would risk logging headers/token)

        ThreadingHTTPServer((_LOOPBACK_HOST, self.port), Handler).serve_forever()
