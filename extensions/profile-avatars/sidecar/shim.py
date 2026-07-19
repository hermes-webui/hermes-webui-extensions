"""Self-contained shim for the Avatars sidecar — replaces the 4 webui imports
(api.config.STATE_DIR, api.helpers.j, api.upload.parse_multipart, api.auth.*) so
avatars.py runs standalone with NO dependency on the hermes-webui repo (survives
upstream updates)."""
import email.parser as _ep
import gzip
import json
import os
import re as _re
from pathlib import Path

# Avatars DB lives alongside the WebUI state so existing avatars carry over.
STATE_DIR = Path(
    os.environ.get("HERMES_AVATARS_STATE_DIR")
    or os.environ.get("HERMES_WEBUI_STATE_DIR")
    or (Path.home() / ".hermes" / "webui")
)

_MAX_UPLOAD_BYTES = 20 * 1024 * 1024


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


def _read_chunked_body(rfile, max_bytes):
    """Read an HTTP/1.1 chunked request body (proxy may strip Content-Length)."""
    chunks, total = [], 0
    while True:
        size_line = rfile.readline()
        if not size_line:
            break
        size_line = size_line.split(b";", 1)[0].strip()
        try:
            size = int(size_line, 16)
        except ValueError:
            break
        if size == 0:
            rfile.readline()
            break
        total += size
        if total > max_bytes:
            raise ValueError(f"Upload too large (max {max_bytes} bytes)")
        chunks.append(rfile.read(size))
        rfile.readline()
    return b"".join(chunks)


def parse_multipart(rfile, content_type, content_length, transfer_encoding="") -> tuple:
    """Pure multipart/form-data parser (copied from api.upload.parse_multipart,
    minus the session/workspace machinery avatars never uses)."""
    m = _re.search(r"boundary=([^;\s]+)", content_type)
    if not m:
        raise ValueError("No boundary in Content-Type")
    boundary = m.group(1).strip('"').encode()
    try:
        length = int(content_length)
    except (TypeError, ValueError):
        raise ValueError("Invalid Content-Length") from None
    if length < 0:
        raise ValueError("Invalid Content-Length (negative)")
    if length > _MAX_UPLOAD_BYTES:
        raise ValueError(f"Upload too large (max {_MAX_UPLOAD_BYTES} bytes)")
    if length == 0 and "chunked" in (transfer_encoding or "").lower():
        raw = _read_chunked_body(rfile, _MAX_UPLOAD_BYTES)
    else:
        raw = rfile.read(length)
    fields, files = {}, {}
    delimiter = b"--" + boundary
    for part in raw.split(delimiter)[1:]:
        stripped = part.lstrip(b"\r\n")
        if stripped.startswith(b"--"):
            break
        sep = b"\r\n\r\n" if b"\r\n\r\n" in part else b"\n\n"
        if sep not in part:
            continue
        header_raw, body = part.split(sep, 1)
        if body.endswith(b"\r\n"):
            body = body[:-2]
        elif body.endswith(b"\n"):
            body = body[:-1]
        header_text = header_raw.lstrip(b"\r\n").decode("utf-8", errors="replace")
        msg = _ep.HeaderParser().parsestr(header_text)
        disp = msg.get("Content-Disposition", "")
        name_m = _re.search(r'name="([^"]*)"', disp)
        file_m = _re.search(r'filename="([^"]*)"', disp)
        if not name_m:
            continue
        name = name_m.group(1)
        if file_m:
            files[name] = (file_m.group(1), body)
        else:
            fields[name] = body.decode("utf-8", errors="replace")
    return fields, files


# Auth is enforced by the WebUI *before* it proxies to this loopback sidecar
# (authenticated session + explicit per-extension sidecar-proxy consent).
def is_auth_enabled() -> bool:
    return False


def parse_cookie(handler):
    return None


def verify_session(cookie_value) -> bool:
    return False
