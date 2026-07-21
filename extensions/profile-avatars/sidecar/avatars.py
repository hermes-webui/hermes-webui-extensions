"""Agent avatar storage — per-profile image BLOBs in the WebUI state dir.

Pure storage + validation logic for the profile-avatars sidecar. The HTTP layer
(``routes_impl.py``) calls these functions; auth is handled deny-by-default by the
canonical scaffold (``sidecar_base.py``), so nothing here touches tokens, cookies,
or a raw HTTP handler.

Storage: SQLite at ``STATE_DIR/avatars.db``, one row per Hermes profile (replaced
on re-upload). Accepted formats: PNG, JPEG, WebP (magic-byte sniff, not just
Content-Type). ≤512 KiB per avatar — matches the core sidecar-proxy response cap,
so a larger image would store fine but 502 on read; reject it at upload instead.
"""
from __future__ import annotations

import email.parser as _ep
import email.policy as _policy
import hashlib
import os
import re as _re
import sqlite3
import time
from pathlib import Path
from typing import Optional

# Avatars DB lives in the WebUI state dir (same place core provisions the sidecar
# token) so the existing avatars.db carries over. HERMES_AVATARS_STATE_DIR is kept
# as a back-compat fallback for pre-token-v1 installs.
STATE_DIR = Path(
    os.environ.get("HERMES_WEBUI_STATE_DIR")
    or os.environ.get("HERMES_AVATARS_STATE_DIR")
    or (Path.home() / ".hermes" / "webui")
)

_AVATARS_DB = STATE_DIR / "avatars.db"
ALLOWED_MIMES = {"image/png", "image/jpeg", "image/webp"}
# 512 KiB matches the core sidecar-proxy's hard response cap.
MAX_BYTES = 512 * 1024


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


# -- validation ------------------------------------------------------------

def valid_profile(name: str) -> bool:
    if not name or len(name) > 128:
        return False
    return all(c.isalnum() or c in "-_." for c in name)


def detect_mime(blob: bytes) -> str:
    if len(blob) >= 8 and blob[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if len(blob) >= 3 and blob[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if len(blob) >= 12 and blob[:4] == b"RIFF" and blob[8:12] == b"WEBP":
        return "image/webp"
    return "application/octet-stream"


# -- reads -----------------------------------------------------------------

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
    """URL with cache-busting v= param so switching/uploading invalidates cache."""
    meta = get_avatar_meta(profile)
    if not meta:
        return None
    return f"/api/avatars/{profile}?v={_cache_buster(meta['updated_at'], meta.get('etag'))}"


def list_avatars() -> dict:
    """Map {profile: {url, updated_at}} for every profile that HAS an avatar.
    The extension frontend uses this instead of /api/profiles.avatar_url (which
    vanilla upstream does not provide) to know which profiles have an image."""
    try:
        conn = _open()
    except Exception:
        return {}
    try:
        rows = conn.execute("SELECT profile, updated_at, etag FROM avatars").fetchall()
    finally:
        conn.close()
    return {
        r[0]: {"url": f"/api/avatars/{r[0]}?v={_cache_buster(r[1], r[2])}", "updated_at": r[1]}
        for r in rows
    }


def _cache_buster(updated_at, etag) -> str:
    """Collision-free cache-busting token for an avatar URL.

    ``updated_at`` alone (an int-truncated epoch second) collides when two
    distinct uploads land in the same wall-clock second, pinning the browser to
    the first blob until reload. Folding in the content ETag makes the token
    change whenever the bytes change, even within a second.
    """
    base = int(updated_at) if updated_at is not None else 0
    tag = (etag or "").strip('"')
    if not tag:
        return str(base)
    return f"{base}-{tag[:12]}"


def get_avatar_row(profile: str):
    """Return (mime, blob, etag) for profile, or None. Caller validates the name."""
    try:
        conn = _open()
    except Exception:
        return None
    try:
        row = conn.execute(
            "SELECT mime, bytes, etag FROM avatars WHERE profile = ?",
            (profile,),
        ).fetchone()
    finally:
        conn.close()
    if not row:
        return None
    return row[0], row[1], row[2]


# -- writes ----------------------------------------------------------------

def store_avatar(profile: str, mime: str, blob: bytes) -> dict:
    """Insert/replace the avatar row and return the response metadata dict."""
    etag = '"' + hashlib.sha256(blob).hexdigest()[:32] + '"'
    now = time.time()
    conn = _open()
    try:
        conn.execute(
            "INSERT OR REPLACE INTO avatars (profile, mime, bytes, etag, updated_at) VALUES (?, ?, ?, ?, ?)",
            (profile, mime, blob, etag, now),
        )
        conn.commit()
    finally:
        conn.close()
    return {
        "profile": profile,
        "mime": mime,
        "size": len(blob),
        "updated_at": now,
        "url": avatar_url_for(profile),
    }


def delete_avatar(profile: str) -> bool:
    conn = _open()
    try:
        cur = conn.execute("DELETE FROM avatars WHERE profile = ?", (profile,))
        conn.commit()
        return bool(cur.rowcount)
    finally:
        conn.close()


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


# -- multipart -------------------------------------------------------------

def parse_multipart(body: bytes, content_type: str) -> tuple:
    """Parse multipart/form-data from an already-read body (the scaffold reads the
    full request body for us, so there is no stream/chunked handling to do here).
    Returns (fields, files) where files[name] = (filename, raw_bytes)."""
    if "\r" in content_type or "\n" in content_type:
        raise ValueError("Invalid Content-Type")
    m = _re.search(r"boundary=([^;\s]+)", content_type)
    if not m or not m.group(1).strip('"'):
        raise ValueError("No boundary in Content-Type")

    try:
        envelope = (
            b"Content-Type: "
            + content_type.encode("ascii")
            + b"\r\nMIME-Version: 1.0\r\n\r\n"
            + body
        )
    except UnicodeEncodeError as exc:
        raise ValueError("Invalid Content-Type") from exc

    message = _ep.BytesParser(policy=_policy.default).parsebytes(envelope)
    if not message.is_multipart():
        raise ValueError("Malformed multipart body")

    fields, files = {}, {}
    for part in message.iter_parts():
        if part.is_multipart() or part.get_content_disposition() != "form-data":
            continue
        name = part.get_param("name", header="content-disposition")
        if not name:
            continue
        if name in fields or name in files:
            raise ValueError(f"Duplicate multipart field: {name}")
        decoded = part.get_payload(decode=True)
        payload = decoded if isinstance(decoded, bytes) else b""
        filename = part.get_filename()
        if filename is not None:
            files[name] = (filename, payload)
        else:
            charset = part.get_content_charset() or "utf-8"
            fields[name] = payload.decode(charset, errors="replace")
    return fields, files
