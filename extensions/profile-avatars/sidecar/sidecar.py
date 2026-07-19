#!/usr/bin/env python3
"""Profile Avatars sidecar — runs api/avatars.py's handlers as a standalone
loopback service. The WebUI proxies /api/extensions/profile-avatars/sidecar/<path>
here (after user consent). Serves per-profile avatar image BLOBs + upload/delete,
plus a /api/avatars list endpoint the extension uses in place of vanilla's
missing /api/profiles.avatar_url. Listens on 127.0.0.1:$HERMES_AVATARS_SIDECAR_PORT
(default 17798)."""
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, unquote

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import avatars  # noqa: E402  (repointed imports resolve via shim.py in this dir)

PORT = int(os.environ.get("HERMES_AVATARS_SIDECAR_PORT", "17798"))
_PREFIX = "/api/avatars"


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _health(self) -> bool:
        if self.path.rstrip("/") == "/health":
            body = b'{"ok": true}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return True
        return False

    def _profile(self, path: str) -> str:
        # /api/avatars/<profile>  → <profile>  (query already stripped by caller)
        return unquote(path[len(_PREFIX) + 1:]) if len(path) > len(_PREFIX) + 1 else ""

    def _dispatch(self, method: str):
        if self._health():
            return
        path = urlsplit(self.path).path
        try:
            # List endpoint (which profiles have avatars) — the extension's
            # replacement for vanilla's missing /api/profiles.avatar_url.
            if method == "GET" and path.rstrip("/") == _PREFIX:
                return avatars.j(self, {"avatars": avatars.list_avatars()})
            if not path.startswith(_PREFIX + "/"):
                return self._404()
            profile = self._profile(path)
            if method == "GET":
                avatars.handle_get_avatar(self, profile)
            elif method == "POST":
                avatars.handle_post_avatar(self, profile)
            elif method == "DELETE":
                avatars.handle_delete_avatar(self, profile)
            else:
                self._404()
        except BrokenPipeError:
            pass
        except Exception as exc:  # never 500-crash a connection silently
            self._err(500, f"sidecar error: {exc}")

    def _404(self):
        self._err(404, "not found")

    def _err(self, code, msg):
        import json
        body = json.dumps({"error": msg}).encode()
        try:
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception:
            pass

    def do_GET(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def do_DELETE(self):
        self._dispatch("DELETE")

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    avatars._ensure_db()
    print(f"[profile-avatars-sidecar] listening on 127.0.0.1:{PORT}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
