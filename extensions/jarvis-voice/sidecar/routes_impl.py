"""Jarvis Voice's authenticated Gemini ephemeral-token route."""
from __future__ import annotations

import datetime as dt
import json
import os
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

_TOKEN_URL = "https://generativelanguage.googleapis.com/v1alpha/auth_tokens"


def _timestamp(value: dt.datetime) -> str:
    return value.isoformat().replace("+00:00", "Z")


def _mint_token(api_key: str) -> tuple[dict | None, str | None]:
    now = dt.datetime.now(dt.timezone.utc)
    payload = json.dumps(
        {
            "uses": 1,
            "expireTime": _timestamp(now + dt.timedelta(minutes=30)),
            "newSessionExpireTime": _timestamp(now + dt.timedelta(minutes=1)),
        }
    ).encode("utf-8")
    request = Request(
        _TOKEN_URL,
        data=payload,
        headers={"Content-Type": "application/json", "x-goog-api-key": api_key},
        method="POST",
    )
    try:
        with urlopen(request, timeout=8) as response:
            result = json.load(response)
    except (HTTPError, URLError, TimeoutError, ValueError):
        return None, "Gemini token service is unavailable"
    token = result.get("name") if isinstance(result, dict) else None
    if not isinstance(token, str) or not token:
        return None, "Gemini token service returned an invalid response"
    return {"token": token, "expires_at": _timestamp(now + dt.timedelta(minutes=30))}, None


def register(app) -> None:
    @app.route("POST", "/api/token")
    def create_token(req):
        api_key = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
        if not api_key:
            return app.json({"error": "Gemini API key is not configured"}, status=503)
        payload, error = _mint_token(api_key)
        if error:
            return app.json({"error": error}, status=502)
        return app.json(payload)
