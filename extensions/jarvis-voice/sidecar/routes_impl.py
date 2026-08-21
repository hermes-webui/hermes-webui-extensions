"""Jarvis Voice's authenticated Gemini ephemeral-token route."""
from __future__ import annotations

import datetime as dt
import json
import os
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

# v1beta is load-bearing: Google documents the ephemeral-token flow as working
# only with v1beta, and the client WebSocket must match the minting version.
_TOKEN_URL = "https://generativelanguage.googleapis.com/v1beta/auth_tokens"

# Core's sidecar proxy allows roughly 10 s end to end (docs/SIDECAR_CONTRACT.md).
# Spend well under half of it upstream so a slow provider surfaces as our own 502
# with margin left for sidecar + proxy handling, instead of tripping the proxy's
# own deadline and becoming an opaque failure.
_UPSTREAM_TIMEOUT_SECONDS = 4

# A successful auth_tokens reply is a few hundred bytes. Anything larger is not a
# token, so cap the read instead of handing an unbounded provider body to the
# JSON parser.
_MAX_RESPONSE_BYTES = 64 * 1024


class _NoRedirects(HTTPRedirectHandler):
    """Refuse every 3xx.

    urllib would otherwise replay this POST at the redirect target with the user's
    ``x-goog-api-key`` still attached, handing the Gemini credential to whatever
    host the Location header names. This endpoint has no legitimate redirect, so
    returning ``None`` stops the chain before a second request is made and lets
    the 3xx surface as an error.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


# The empty ProxyHandler pins this to a direct connection as well: an ambient
# https_proxy in the user's environment must not see the API key either.
_OPENER = build_opener(ProxyHandler({}), _NoRedirects())


def _read_key_file() -> tuple[str | None, str | None]:
    """Read the Gemini key from the sidecar-owned key file.

    A key imported into the systemd user manager is inherited by every user
    service; a mode-0600 file under the sidecar's own user is scoped to
    whoever can already read that user's files. A present-but-loose file is a
    hard error rather than a fallback to the environment — silently working
    around a misconfigured key file would defeat the scoping.
    Returns (key, error); both None means "no file, try the environment".
    """
    path = os.path.join(os.path.expanduser("~"), ".config", "jarvis-voice", "api_key")
    try:
        mode = os.stat(path).st_mode
    except OSError:
        return None, None
    if mode & 0o077:
        return None, "Gemini key file must not be group/world accessible (chmod 600 ~/.config/jarvis-voice/api_key)"
    try:
        with open(path, encoding="utf-8") as fh:
            key = fh.read().strip()
    except OSError:
        return None, "Gemini key file is unreadable"
    if not key:
        return None, "Gemini key file is empty"
    return key, None


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
        with _OPENER.open(request, timeout=_UPSTREAM_TIMEOUT_SECONDS) as response:
            # One byte past the cap, so an oversized body is detectable rather
            # than silently truncated into a confusing parse error.
            raw = response.read(_MAX_RESPONSE_BYTES + 1)
    except (HTTPError, URLError, TimeoutError, OSError):
        return None, "Gemini token service is unavailable"
    if len(raw) > _MAX_RESPONSE_BYTES:
        return None, "Gemini token service returned an oversized response"
    try:
        result = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None, "Gemini token service returned an invalid response"
    token = result.get("name") if isinstance(result, dict) else None
    if not isinstance(token, str) or not token:
        return None, "Gemini token service returned an invalid response"
    return {"token": token, "expires_at": _timestamp(now + dt.timedelta(minutes=30))}, None


def register(app) -> None:
    @app.route("POST", "/api/token")
    def create_token(req):
        file_key, file_error = _read_key_file()
        if file_error:
            return app.json({"error": file_error}, status=503)
        api_key = file_key or os.getenv("GEMINI_API_KEY")
        if not api_key:
            return app.json({"error": "Gemini API key is not configured"}, status=503)
        payload, error = _mint_token(api_key)
        if error:
            return app.json({"error": error}, status=502)
        return app.json(payload)
