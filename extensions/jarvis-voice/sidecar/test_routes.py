#!/usr/bin/env python3
from __future__ import annotations

import json
import os
from types import SimpleNamespace

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


class Response:
    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def read(self):
        return json.dumps(self.payload).encode()


seen = {}
def fake_urlopen(request, timeout):
    seen["url"] = request.full_url
    seen["headers"] = dict(request.header_items())
    seen["body"] = json.loads(request.data)
    seen["timeout"] = timeout
    return Response({"name": "auth_tokens/test"})


app = App()
routes_impl.register(app)
assert [(method, path) for method, path, _ in app.routes] == [("POST", "/api/token")]
handler = app.routes[0][2]
routes_impl.urlopen = fake_urlopen
os.environ["GEMINI_API_KEY"] = "test-key"
status, _, body = handler(SimpleNamespace())
assert status == 200
result = json.loads(body)
assert result["token"] == "auth_tokens/test"
assert result["expires_at"].endswith("Z")
assert seen["url"] == "https://generativelanguage.googleapis.com/v1alpha/auth_tokens"
assert seen["headers"]["X-goog-api-key"] == "test-key"
assert seen["body"]["uses"] == 1
assert seen["timeout"] == 8
os.environ.pop("GEMINI_API_KEY")
os.environ.pop("GOOGLE_API_KEY", None)
status, _, _ = handler(SimpleNamespace())
assert status == 503
print("ok jarvis sidecar routes")
