"""Self-contained shim for the Feeds sidecar — replaces the 3 webui imports
(api.config.STATE_DIR, api.helpers.j, api.auth.*) so feeds.py runs standalone,
with NO dependency on the hermes-webui repo (survives upstream updates)."""
import gzip
import json
import os
from pathlib import Path

# Feeds DB lives alongside the WebUI state so existing feeds/data carry over.
STATE_DIR = Path(
    os.environ.get("HERMES_FEEDS_STATE_DIR")
    or os.environ.get("HERMES_WEBUI_STATE_DIR")
    or (Path.home() / ".hermes" / "webui")
)


def _accepts_gzip(handler) -> bool:
    try:
        return "gzip" in (handler.headers.get("Accept-Encoding", "") or "")
    except Exception:
        return False


def j(handler, payload, status: int = 200, extra_headers: dict = None, *, pretty: bool = True) -> None:
    """Minimal JSON responder (subset of api.helpers.j). The WebUI proxy adds the
    outer security headers; the sidecar only needs a correct JSON body."""
    body = json.dumps(payload, indent=2 if pretty else None).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    if _accepts_gzip(handler) and len(body) > 1024:
        body = gzip.compress(body, compresslevel=4)
        handler.send_header("Content-Encoding", "gzip")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", "no-store")
    if extra_headers:
        for k, v in extra_headers.items():
            handler.send_header(k, v)
    handler.end_headers()
    try:
        handler.wfile.write(body)
    except (BrokenPipeError, ConnectionResetError):
        pass


# Auth is enforced by the WebUI *before* it proxies to this loopback sidecar
# (authenticated session + explicit per-extension sidecar-proxy consent). So the
# sidecar itself is unauthenticated-but-unreachable-except-via-that-proxy: report
# auth disabled so feeds.py's _require_auth() passes.
def is_auth_enabled() -> bool:
    return False


def parse_cookie(handler):
    return None


def verify_session(cookie_value) -> bool:
    return False
