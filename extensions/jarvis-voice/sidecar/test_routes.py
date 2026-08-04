#!/usr/bin/env python3
from __future__ import annotations

import email.message
import io
import json
import os
import tempfile
from types import SimpleNamespace
from urllib.request import HTTPSHandler, ProxyHandler, build_opener

import routes_impl


class App:
    def __init__(self):
        self.routes = []

    def route(self, method, path):
        def decorate(fn):
            self.routes.append((method, path, fn))
            return fn
        return decorate

    @staticmethod
    def json(payload, status=200):
        return status, {}, json.dumps(payload).encode()


class StubResponse(io.BytesIO):
    """Minimal stand-in for an http.client response, good enough for urllib's real
    handler chain (error processor + redirect handler) to run against."""

    def __init__(self, code, headers=None, body=b""):
        super().__init__(body)
        self.code = code
        self.status = code
        self.msg = "stub"
        self.reason = "stub"
        self.url = routes_impl._TOKEN_URL
        self._headers = email.message.Message()
        for key, value in (headers or {}).items():
            self._headers[key] = value

    def info(self):
        return self._headers

    def geturl(self):
        return self.url


attempts = []


def install(responder):
    """Swap only the module opener's transport, keeping urllib's real redirect and
    error handling in the chain — the point is to exercise the no-redirect policy,
    not to stub it out."""
    del attempts[:]

    class StubHTTPSHandler(HTTPSHandler):
        def https_open(self, req):
            attempts.append({
                "url": req.full_url,
                "headers": dict(req.header_items()),
                "body": json.loads(req.data),
                "timeout": req.timeout,
            })
            return responder(req)

    routes_impl._OPENER = build_opener(
        ProxyHandler({}), routes_impl._NoRedirects(), StubHTTPSHandler()
    )


# Isolate the key-file location: the route resolves it under $HOME at call
# time, and these tests must not see (or touch) the developer's real key.
os.environ["HOME"] = tempfile.mkdtemp()

app = App()
routes_impl.register(app)
assert [(method, path) for method, path, _ in app.routes] == [("POST", "/api/token")]
handler = app.routes[0][2]
os.environ["GEMINI_API_KEY"] = "test-key"

# -- happy path ------------------------------------------------------------
install(lambda req: StubResponse(200, body=json.dumps({"name": "auth_tokens/test"}).encode()))
status, _, body = handler(SimpleNamespace())
assert status == 200
result = json.loads(body)
assert result["token"] == "auth_tokens/test"
assert result["expires_at"].endswith("Z")
assert len(attempts) == 1
assert attempts[0]["url"] == "https://generativelanguage.googleapis.com/v1alpha/auth_tokens"
assert attempts[0]["headers"]["X-goog-api-key"] == "test-key"
assert attempts[0]["body"]["uses"] == 1
# Materially shorter than core's ~10 s sidecar-proxy budget so a slow provider
# surfaces as our own 502, with margin left for sidecar + proxy handling.
assert attempts[0]["timeout"] <= 5, attempts[0]["timeout"]

# -- a redirect must never replay the API key at another host --------------
for code in (301, 302, 303, 307, 308):
    install(lambda req, code=code: StubResponse(
        code, headers={"Location": "https://attacker.example/steal"}
    ))
    status, _, body = handler(SimpleNamespace())
    assert status == 502, (code, status)
    assert len(attempts) == 1, f"{code} produced {len(attempts)} requests; the key was replayed"
    assert "attacker.example" not in json.dumps(attempts), code

# -- an oversized provider body is rejected before parsing -----------------
install(lambda req: StubResponse(200, body=b'{"name":"' + b"a" * (64 * 1024 + 64) + b'"}'))
status, _, body = handler(SimpleNamespace())
assert status == 502
assert "oversized" in json.loads(body)["error"]


# -- provider timeout surfaces as unavailable, not a traceback -------------
def _timeout(req):
    raise TimeoutError("provider slow")


install(_timeout)
status, _, body = handler(SimpleNamespace())
assert status == 502
assert "unavailable" in json.loads(body)["error"]

# -- non-JSON provider body ------------------------------------------------
install(lambda req: StubResponse(200, body=b"<html>nope</html>"))
status, _, body = handler(SimpleNamespace())
assert status == 502
assert "invalid" in json.loads(body)["error"]

# -- missing credential ----------------------------------------------------
os.environ.pop("GEMINI_API_KEY")
os.environ.pop("GOOGLE_API_KEY", None)
status, _, _ = handler(SimpleNamespace())
assert status == 503

# -- the key file is the scoped configuration path -------------------------
# Importing the key into the systemd user manager hands it to every user
# service; a mode-0600 file owned by the sidecar's user does not. The file is
# preferred over the environment, and a file with loose permissions is refused
# outright — silently falling back around a misconfigured file would defeat the
# point of scoping it.
key_dir = os.path.join(os.environ["HOME"], ".config", "jarvis-voice")
os.makedirs(key_dir)
key_path = os.path.join(key_dir, "api_key")
with open(key_path, "w", encoding="utf-8") as fh:
    fh.write("file-key\n")
os.chmod(key_path, 0o600)
install(lambda req: StubResponse(200, body=json.dumps({"name": "auth_tokens/file"}).encode()))
status, _, body = handler(SimpleNamespace())
assert status == 200, (status, body)
assert attempts[0]["headers"]["X-goog-api-key"] == "file-key"

# A group/world-readable key file is refused, even with an env var available.
os.chmod(key_path, 0o644)
os.environ["GEMINI_API_KEY"] = "env-key"
status, _, body = handler(SimpleNamespace())
assert status == 503, (status, body)
assert "600" in json.loads(body)["error"]

# Restored permissions work again; the file wins over the environment.
os.chmod(key_path, 0o600)
install(lambda req: StubResponse(200, body=json.dumps({"name": "auth_tokens/file2"}).encode()))
status, _, _ = handler(SimpleNamespace())
assert status == 200
assert attempts[0]["headers"]["X-goog-api-key"] == "file-key"

# No file: the environment fallback still serves manual (non-systemd) runs.
os.remove(key_path)
install(lambda req: StubResponse(200, body=json.dumps({"name": "auth_tokens/env"}).encode()))
status, _, _ = handler(SimpleNamespace())
assert status == 200
assert attempts[0]["headers"]["X-goog-api-key"] == "env-key"
os.environ.pop("GEMINI_API_KEY")

print("ok jarvis sidecar routes")
