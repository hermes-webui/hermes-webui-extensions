#!/usr/bin/env python3
"""Tiny loopback token sidecar for Jarvis Voice.

Set GEMINI_API_KEY, then run this file. It exposes:
  GET  /health
  POST /api/token
"""

from __future__ import annotations

import datetime as dt
import importlib
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = "127.0.0.1"
PORT = int(os.environ.get("JARVIS_TOKEN_PORT", "18787"))
API_KEY = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
ALLOWED_ORIGINS = {
    item.strip().rstrip("/")
    for item in os.environ.get("JARVIS_ALLOWED_ORIGINS", "").split(",")
    if item.strip()
}
ALLOW_NO_ORIGIN = os.environ.get("JARVIS_ALLOW_NO_ORIGIN") == "1"


def _client():
    if not API_KEY:
        return None
    genai = importlib.import_module("google.genai")
    return genai.Client(api_key=API_KEY, http_options={"api_version": "v1alpha"})


def _origin_allowed(origin: str | None) -> bool:
    if not origin:
        return ALLOW_NO_ORIGIN
    return origin.rstrip("/") in ALLOWED_ORIGINS


def _origin(handler: BaseHTTPRequestHandler) -> str | None:
    origin = handler.headers.get("Origin")
    return origin.rstrip("/") if origin and _origin_allowed(origin) else None


def _json(handler: BaseHTTPRequestHandler, status: int, payload: dict) -> None:
    body = json.dumps(payload, indent=2).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(body)))
    origin = _origin(handler)
    if origin:
        handler.send_header("Access-Control-Allow-Origin", origin)
        handler.send_header("Vary", "Origin")
    handler.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
    handler.send_header("Access-Control-Allow-Headers", "Content-Type")
    handler.end_headers()
    handler.wfile.write(body)


def _reject_origin(handler: BaseHTTPRequestHandler) -> bool:
    origin = handler.headers.get("Origin")
    if _origin_allowed(origin):
        return False
    _json(handler, 403, {"error": "origin not allowed", "origin": origin})
    return True


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args) -> None:
        print("[jarvis-token] " + format % args)

    def do_OPTIONS(self) -> None:  # noqa: N802 - stdlib hook
        if _reject_origin(self):
            return
        _json(self, 204, {})

    def do_GET(self) -> None:  # noqa: N802 - stdlib hook
        if self.path == "/health":
            _json(self, 200, {"ok": True, "service": "jarvis-token-sidecar", "has_key": bool(API_KEY)})
            return
        _json(self, 404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802 - stdlib hook
        if self.path != "/api/token":
            _json(self, 404, {"error": "not found"})
            return
        if _reject_origin(self):
            return
        try:
            client = _client()
        except Exception as exc:
            _json(self, 500, {"error": str(exc)})
            return
        if client is None:
            _json(self, 500, {"error": "GEMINI_API_KEY or GOOGLE_API_KEY is required"})
            return
        now = dt.datetime.now(dt.timezone.utc)
        expire = now + dt.timedelta(minutes=30)
        try:
            token = client.auth_tokens.create(
                config={
                    "uses": 1,
                    "expire_time": expire.isoformat(),
                    "new_session_expire_time": (now + dt.timedelta(minutes=1)).isoformat(),
                    "http_options": {"api_version": "v1alpha"},
                }
            )
        except Exception as exc:  # keep the browser error actionable
            _json(self, 500, {"error": str(exc)})
            return
        _json(self, 200, {"token": token.name, "expires_at": expire.isoformat()})


def main() -> None:
    if not API_KEY:
        print("warning: GEMINI_API_KEY/GOOGLE_API_KEY is not set; /api/token will fail")
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Jarvis token sidecar listening on http://{HOST}:{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
