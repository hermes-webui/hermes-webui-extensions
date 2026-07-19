"""Agent avatar storage — per-profile image BLOBs in webui state.

Storage: SQLite at STATE_DIR/avatars.db. One row per Hermes profile, replacing
on re-upload. Image bytes live in the BLOB column directly — small (≤1MB
per avatar) and atomic with the rest of the webui state.

Accepted formats: PNG, JPEG, WebP (magic-byte sniff, not just Content-Type).
Recommended dimensions: 256×256 to 512×512. No server-side resize (Pillow
is not a webui dep); the client should resize before upload if needed.

Routes wired from api/routes.py:
  GET    /api/avatars/{profile}   — image bytes with ETag + Cache-Control
  POST   /api/avatars/{profile}   — multipart upload, field name: "avatar"
  DELETE /api/avatars/{profile}   — remove row
"""
from __future__ import annotations

import hashlib
import sqlite3
import time
from typing import Optional

from shim import STATE_DIR
from shim import j
from shim import parse_multipart


_AVATARS_DB = STATE_DIR / "avatars.db"
_ALLOWED_MIMES = {"image/png", "image/jpeg", "image/webp"}
_MAX_BYTES = 1 * 1024 * 1024


def _ensure_db() -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(_AVATARS_DB)
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS avatars (
                profile    TEXT PRIMARY KEY,
                mime       TEXT NOT NULL,
                bytes      BLOB NOT NULL,
                etag       TEXT NOT NULL,
                updated_at REAL NOT NULL
            )
            """
        )
        conn.commit()
    finally:
        conn.close()


def _open() -> sqlite3.Connection:
    _ensure_db()
    return sqlite3.connect(_AVATARS_DB)


def get_avatar_meta(profile: str) -> Optional[dict]:
    """Return {mime, etag, updated_at} or None if no avatar for profile."""
    if not profile:
        return None
    try:
        conn = _open()
    except Exception:
        return None
    try:
        row = conn.execute(
            "SELECT mime, etag, updated_at FROM avatars WHERE profile = ?",
            (profile,),
        ).fetchone()
        if not row:
            return None
        return {"mime": row[0], "etag": row[1], "updated_at": row[2]}
    finally:
        conn.close()


def avatar_url_for(profile: str) -> Optional[str]:
    """URL with cache-busting v= param so switching/uploading invalidates client cache."""
    meta = get_avatar_meta(profile)
    if not meta:
        return None
    return f"/api/avatars/{profile}?v={int(meta['updated_at'])}"


def list_avatars() -> dict:
    """Map {profile: {url, updated_at}} for every profile that HAS an avatar.
    The extension frontend uses this instead of /api/profiles.avatar_url (which
    vanilla upstream does not provide) to know which profiles have an image."""
    try:
        conn = _open()
    except Exception:
        return {}
    try:
        rows = conn.execute("SELECT profile, updated_at FROM avatars").fetchall()
    finally:
        conn.close()
    return {
        r[0]: {"url": f"/api/avatars/{r[0]}?v={int(r[1])}", "updated_at": r[1]}
        for r in rows
    }


def rename_avatar(old_profile: str, new_profile: str) -> bool:
    """Move an avatar row from old_profile to new_profile (profile rename).

    No-op if old has no avatar. If new already has a row it is replaced. Returns
    True if a row was moved.
    """
    if not old_profile or not new_profile or old_profile == new_profile:
        return False
    try:
        conn = _open()
    except Exception:
        return False
    try:
        cur = conn.execute("SELECT 1 FROM avatars WHERE profile = ?", (old_profile,))
        if not cur.fetchone():
            return False
        conn.execute("DELETE FROM avatars WHERE profile = ?", (new_profile,))
        conn.execute("UPDATE avatars SET profile = ? WHERE profile = ?", (new_profile, old_profile))
        conn.commit()
        return True
    finally:
        conn.close()


def _require_auth(handler) -> bool:
    from shim import is_auth_enabled, parse_cookie, verify_session
    if not is_auth_enabled():
        return True
    cv = parse_cookie(handler)
    return bool(cv and verify_session(cv))


def _err(handler, status: int, msg: str) -> bool:
    j(handler, {"error": msg}, status=status)
    return True


def _detect_mime(blob: bytes) -> str:
    if len(blob) >= 8 and blob[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if len(blob) >= 3 and blob[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if len(blob) >= 12 and blob[:4] == b"RIFF" and blob[8:12] == b"WEBP":
        return "image/webp"
    return "application/octet-stream"


def _valid_profile(name: str) -> bool:
    if not name or len(name) > 128:
        return False
    return all(c.isalnum() or c in "-_." for c in name)


def handle_get_avatar(handler, profile: str) -> bool:
    if not _valid_profile(profile):
        return _err(handler, 400, "invalid profile name")
    try:
        conn = _open()
    except Exception as exc:
        return _err(handler, 500, f"avatars store unavailable: {exc}")
    try:
        row = conn.execute(
            "SELECT mime, bytes, etag FROM avatars WHERE profile = ?",
            (profile,),
        ).fetchone()
    finally:
        conn.close()
    if not row:
        return _err(handler, 404, "no avatar")
    mime, blob, etag = row[0], row[1], row[2]
    inm = handler.headers.get("If-None-Match", "")
    if inm and inm == etag:
        handler.send_response(304)
        handler.send_header("ETag", etag)
        handler.end_headers()
        return True
    handler.send_response(200)
    handler.send_header("Content-Type", mime)
    handler.send_header("Content-Length", str(len(blob)))
    handler.send_header("ETag", etag)
    handler.send_header("Cache-Control", "private, max-age=31536000, immutable")
    handler.send_header("X-Content-Type-Options", "nosniff")
    handler.end_headers()
    try:
        handler.wfile.write(blob)
    except (BrokenPipeError, ConnectionResetError):
        pass
    return True


def handle_post_avatar(handler, profile: str) -> bool:
    if not _require_auth(handler):
        return _err(handler, 401, "Authentication required")
    if not _valid_profile(profile):
        return _err(handler, 400, "invalid profile name")
    ct = handler.headers.get("Content-Type", "")
    if "multipart/form-data" not in ct:
        return _err(handler, 400, "expected multipart/form-data with file field 'avatar'")
    try:
        cl = int(handler.headers.get("Content-Length", "0") or "0")
    except ValueError:
        return _err(handler, 400, "invalid Content-Length")
    if cl <= 0:
        return _err(handler, 400, "empty body")
    if cl > _MAX_BYTES + 4096:
        return _err(handler, 413, f"avatar too large (max {_MAX_BYTES // 1024} KiB)")
    try:
        _fields, files = parse_multipart(handler.rfile, ct, cl)
    except Exception as exc:
        return _err(handler, 400, f"multipart parse failed: {exc}")
    if "avatar" not in files:
        return _err(handler, 400, "missing 'avatar' file field")
    _filename, blob = files["avatar"]
    if len(blob) > _MAX_BYTES:
        return _err(handler, 413, f"avatar too large (max {_MAX_BYTES // 1024} KiB)")
    if not blob:
        return _err(handler, 400, "empty avatar payload")
    mime = _detect_mime(blob)
    if mime not in _ALLOWED_MIMES:
        return _err(
            handler,
            415,
            "unsupported image type — allowed: PNG, JPEG, WebP (detected by magic bytes)",
        )
    etag = '"' + hashlib.sha256(blob).hexdigest()[:32] + '"'
    now = time.time()
    try:
        conn = _open()
    except Exception as exc:
        return _err(handler, 500, f"avatars store unavailable: {exc}")
    try:
        conn.execute(
            "INSERT OR REPLACE INTO avatars (profile, mime, bytes, etag, updated_at) VALUES (?, ?, ?, ?, ?)",
            (profile, mime, blob, etag, now),
        )
        conn.commit()
    finally:
        conn.close()
    j(
        handler,
        {
            "profile": profile,
            "mime": mime,
            "size": len(blob),
            "updated_at": now,
            "url": avatar_url_for(profile),
        },
        status=200,
    )
    return True


def handle_delete_avatar(handler, profile: str) -> bool:
    if not _require_auth(handler):
        return _err(handler, 401, "Authentication required")
    if not _valid_profile(profile):
        return _err(handler, 400, "invalid profile name")
    try:
        conn = _open()
    except Exception as exc:
        return _err(handler, 500, f"avatars store unavailable: {exc}")
    try:
        cur = conn.execute("DELETE FROM avatars WHERE profile = ?", (profile,))
        conn.commit()
        deleted = bool(cur.rowcount)
    finally:
        conn.close()
    j(handler, {"profile": profile, "deleted": deleted}, status=200)
    return True
