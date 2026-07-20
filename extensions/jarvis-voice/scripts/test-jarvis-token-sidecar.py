#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import os
import pathlib
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

ROOT = pathlib.Path(__file__).resolve().parents[1]
SIDE = ROOT / "scripts" / "jarvis-token-sidecar.py"
JS = ROOT / "assets" / "jarvis-voice.js"

os.environ.pop("GEMINI_API_KEY", None)
os.environ.pop("GOOGLE_API_KEY", None)

spec = importlib.util.spec_from_file_location("jarvis_token_sidecar", SIDE)
assert spec and spec.loader
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

assert not mod._origin_allowed("http://127.0.0.1:8080")
assert not mod._origin_allowed("http://localhost:3000")
assert not mod._origin_allowed("https://evil.example")
assert not mod._origin_allowed(None)

mod.ALLOWED_ORIGINS.add("http://127.0.0.1:8080")
mod.ALLOWED_ORIGINS.add("https://webui.example")
assert mod._origin_allowed("http://127.0.0.1:8080")
assert mod._origin_allowed("https://webui.example")
assert not mod._origin_allowed("https://webui.example.evil")

server = ThreadingHTTPServer(("127.0.0.1", 0), mod.Handler)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
base = f"http://127.0.0.1:{server.server_port}"
try:
    assert urllib.request.urlopen(base + "/health", timeout=2).status == 200

    def post(origin: str | None = None) -> int:
        req = urllib.request.Request(base + "/api/token", method="POST")
        if origin:
            req.add_header("Origin", origin)
        try:
            return urllib.request.urlopen(req, timeout=2).status
        except urllib.error.HTTPError as exc:
            return exc.code

    assert post() == 403
    assert post("https://evil.example") == 403
    assert post("http://127.0.0.1:8080") == 500  # allowed origin, no test key

    class FakeToken:
        name = "ephemeral-test-token"

    class FakeAuthTokens:
        def create(self, config: dict):
            assert config["uses"] == 1
            assert "expire_time" in config
            assert "new_session_expire_time" in config
            assert config["http_options"]["api_version"] == "v1alpha"
            return FakeToken()

    class FakeClient:
        auth_tokens = FakeAuthTokens()

    setattr(mod, "_client", lambda: FakeClient())
    req = urllib.request.Request(base + "/api/token", method="POST")
    req.add_header("Origin", "http://127.0.0.1:8080")
    with urllib.request.urlopen(req, timeout=2) as res:
        body = res.read().decode("utf-8")
        assert res.status == 200
        assert "ephemeral-test-token" in body
finally:
    server.shutdown()
    server.server_close()

js = JS.read_text()
sidecar = SIDE.read_text()
assert "String(msg.value || '')" in js
assert "pendingFiles" in js
assert "/api/session?session_id=${encodeURIComponent(sid)}&messages=1&resolve_model=0&msg_limit=500" in js
assert "hermesBusy(window.S.session, window.S)" in js
assert "pendingUserMessage" in js and "hasPendingUserMessage" in js
assert "state.hermesToolRunning" in js
assert "Gemini setup timed out" in js
assert "api.get(key)" in js
assert "state.captureNode.connect(state.silentNode)" in js
assert "micStartPromise" in js
assert "micEpoch" in js
assert "state.captureCtx.resume" in js
assert "sendGemini({ toolResponse: { functionResponses: responses } }, ws)" in js
assert "if (state.ws !== ws) return" in js
assert "disconnectEpoch" in js
assert "Jarvis connection cancelled" in js
assert "count > beforeCount + 1" in js
assert "this.offset-=c.length" in js
assert "audioStreamEnd" in js
assert "catch (err)" in js and "stopMic();" in js
assert "return origin.rstrip(\"/\") in ALLOWED_ORIGINS" in sidecar
assert 'Access-Control-Allow-Origin", "*"' not in sidecar
assert "_reject_origin(self)" in sidecar

print("ok jarvis voice checks")
