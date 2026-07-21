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
import zlib
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
MAX_AVATARS = 128
MAX_DIMENSION = 4096
MAX_PIXELS = 16 * 1024 * 1024
_PROFILE_RE = _re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")


class InvalidImageError(ValueError):
    """The upload is not a structurally valid, reasonably sized raster image."""


class AvatarLimitError(ValueError):
    """The bounded avatar store has no room for another profile row."""


def _harden_db_files() -> None:
    """Keep the avatar database and transient SQLite files owner-only."""
    for path in STATE_DIR.glob(f"{_AVATARS_DB.name}*"):
        try:
            if path.is_file() and not path.is_symlink():
                path.chmod(0o600)
        except OSError:
            # A journal can disappear between glob/stat; SQLite remains the
            # authority for whether the operation itself succeeded.
            pass


def _ensure_db() -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    if _AVATARS_DB.is_symlink():
        raise RuntimeError("avatars database must not be a symlink")
    conn = sqlite3.connect(_AVATARS_DB)
    try:
        _AVATARS_DB.chmod(0o600)
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
        _harden_db_files()


def _open() -> sqlite3.Connection:
    _ensure_db()
    return sqlite3.connect(_AVATARS_DB)


# -- validation ------------------------------------------------------------

def valid_profile(name: str) -> bool:
    return bool(isinstance(name, str) and _PROFILE_RE.fullmatch(name))


def detect_mime(blob: bytes) -> str:
    if len(blob) >= 8 and blob[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if len(blob) >= 3 and blob[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if len(blob) >= 12 and blob[:4] == b"RIFF" and blob[8:12] == b"WEBP":
        return "image/webp"
    return "application/octet-stream"


def _checked_dimensions(width: int, height: int) -> tuple[int, int]:
    if width <= 0 or height <= 0:
        raise InvalidImageError("image dimensions must be positive")
    if width > MAX_DIMENSION or height > MAX_DIMENSION or width * height > MAX_PIXELS:
        raise InvalidImageError(
            f"image dimensions exceed {MAX_DIMENSION}px / {MAX_PIXELS} pixels"
        )
    return width, height


def _png_dimensions(blob: bytes) -> tuple[int, int]:
    if len(blob) < 45 or blob[:8] != b"\x89PNG\r\n\x1a\n":
        raise InvalidImageError("malformed PNG")
    pos = 8
    width = height = None
    saw_idat = False
    saw_iend = False
    while pos + 12 <= len(blob):
        length = int.from_bytes(blob[pos:pos + 4], "big")
        kind = blob[pos + 4:pos + 8]
        end = pos + 12 + length
        if end > len(blob):
            raise InvalidImageError("truncated PNG chunk")
        data_end = pos + 8 + length
        expected_crc = int.from_bytes(blob[data_end:data_end + 4], "big")
        actual_crc = zlib.crc32(blob[pos + 4:data_end]) & 0xFFFFFFFF
        if expected_crc != actual_crc:
            raise InvalidImageError("PNG chunk checksum mismatch")
        if pos == 8:
            if kind != b"IHDR" or length != 13:
                raise InvalidImageError("PNG must start with IHDR")
            width = int.from_bytes(blob[pos + 8:pos + 12], "big")
            height = int.from_bytes(blob[pos + 12:pos + 16], "big")
        if kind == b"IDAT":
            saw_idat = True
        if kind == b"IEND":
            if length != 0:
                raise InvalidImageError("invalid PNG IEND")
            saw_iend = True
            break
        pos = end
    if width is None or height is None or not saw_idat or not saw_iend:
        raise InvalidImageError("incomplete PNG")
    return _checked_dimensions(width, height)


_JPEG_SOF = {
    0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7,
    0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF,
}


def _jpeg_dimensions(blob: bytes) -> tuple[int, int]:
    if len(blob) < 12 or not blob.startswith(b"\xff\xd8") or not blob.endswith(b"\xff\xd9"):
        raise InvalidImageError("malformed JPEG")
    pos = 2
    dimensions = None
    saw_scan = False
    while pos < len(blob) - 2:
        if blob[pos] != 0xFF:
            raise InvalidImageError("invalid JPEG marker")
        while pos < len(blob) and blob[pos] == 0xFF:
            pos += 1
        if pos >= len(blob):
            break
        marker = blob[pos]
        pos += 1
        if marker in (0xD8, 0xD9) or 0xD0 <= marker <= 0xD7:
            continue
        if pos + 2 > len(blob):
            raise InvalidImageError("truncated JPEG segment")
        seg_len = int.from_bytes(blob[pos:pos + 2], "big")
        if seg_len < 2 or pos + seg_len > len(blob):
            raise InvalidImageError("invalid JPEG segment length")
        if marker == 0xDA:
            if dimensions is None or pos + seg_len >= len(blob) - 2:
                raise InvalidImageError("invalid JPEG scan")
            saw_scan = True
            break
        if marker in _JPEG_SOF:
            if seg_len < 7:
                raise InvalidImageError("invalid JPEG frame header")
            height = int.from_bytes(blob[pos + 3:pos + 5], "big")
            width = int.from_bytes(blob[pos + 5:pos + 7], "big")
            dimensions = _checked_dimensions(width, height)
        pos += seg_len
    if dimensions is None or not saw_scan:
        raise InvalidImageError("JPEG has no complete frame")
    return dimensions


def _webp_dimensions(blob: bytes) -> tuple[int, int]:
    if len(blob) < 20 or blob[:4] != b"RIFF" or blob[8:12] != b"WEBP":
        raise InvalidImageError("malformed WebP")
    declared_end = int.from_bytes(blob[4:8], "little") + 8
    if declared_end > len(blob) or declared_end < 20:
        raise InvalidImageError("truncated WebP")
    pos = 12
    canvas = None
    while pos + 8 <= declared_end:
        kind = blob[pos:pos + 4]
        length = int.from_bytes(blob[pos + 4:pos + 8], "little")
        data = pos + 8
        end = data + length
        if end > declared_end:
            raise InvalidImageError("truncated WebP chunk")
        if kind == b"VP8X" and length >= 10:
            width = int.from_bytes(blob[data + 4:data + 7], "little") + 1
            height = int.from_bytes(blob[data + 7:data + 10], "little") + 1
            canvas = _checked_dimensions(width, height)
        if kind == b"VP8L" and length >= 5 and blob[data] == 0x2F:
            bits = int.from_bytes(blob[data + 1:data + 5], "little")
            width = (bits & 0x3FFF) + 1
            height = ((bits >> 14) & 0x3FFF) + 1
            frame = _checked_dimensions(width, height)
            if canvas and (frame[0] > canvas[0] or frame[1] > canvas[1]):
                raise InvalidImageError("WebP frame exceeds canvas")
            return canvas or frame
        if kind == b"VP8 " and length >= 10 and blob[data + 3:data + 6] == b"\x9d\x01\x2a":
            width = int.from_bytes(blob[data + 6:data + 8], "little") & 0x3FFF
            height = int.from_bytes(blob[data + 8:data + 10], "little") & 0x3FFF
            frame = _checked_dimensions(width, height)
            if canvas and (frame[0] > canvas[0] or frame[1] > canvas[1]):
                raise InvalidImageError("WebP frame exceeds canvas")
            return canvas or frame
        pos = end + (length & 1)
    raise InvalidImageError("WebP has no supported image frame")


def validate_image(blob: bytes, mime: str) -> tuple[int, int]:
    """Validate image structure and return bounded decoded dimensions."""
    if not blob or len(blob) > MAX_BYTES:
        raise InvalidImageError("avatar payload size is invalid")
    if detect_mime(blob) != mime or mime not in ALLOWED_MIMES:
        raise InvalidImageError("avatar MIME does not match its bytes")
    if mime == "image/png":
        return _png_dimensions(blob)
    if mime == "image/jpeg":
        return _jpeg_dimensions(blob)
    return _webp_dimensions(blob)


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
        rows = conn.execute(
            "SELECT profile, updated_at, etag FROM avatars ORDER BY profile LIMIT ?",
            (MAX_AVATARS,),
        ).fetchall()
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
    if not valid_profile(profile):
        raise ValueError("invalid profile name")
    width, height = validate_image(blob, mime)
    etag = '"' + hashlib.sha256(blob).hexdigest()[:32] + '"'
    now = time.time()
    conn = _open()
    try:
        # Serialize the count-and-insert decision so two concurrent first
        # uploads cannot both pass at MAX_AVATARS - 1.
        conn.execute("BEGIN IMMEDIATE")
        exists = conn.execute(
            "SELECT 1 FROM avatars WHERE profile = ?", (profile,)
        ).fetchone()
        if not exists:
            count = conn.execute("SELECT COUNT(*) FROM avatars").fetchone()[0]
            if count >= MAX_AVATARS:
                raise AvatarLimitError(f"avatar store is limited to {MAX_AVATARS} profiles")
        conn.execute(
            "INSERT OR REPLACE INTO avatars (profile, mime, bytes, etag, updated_at) VALUES (?, ?, ?, ?, ?)",
            (profile, mime, blob, etag, now),
        )
        conn.commit()
    finally:
        conn.close()
        _harden_db_files()
    return {
        "profile": profile,
        "mime": mime,
        "size": len(blob),
        "width": width,
        "height": height,
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
        _harden_db_files()


def rename_avatar(old_profile: str, new_profile: str) -> bool:
    """Move an avatar row from old_profile to new_profile (profile rename).

    No-op if old has no avatar. If new already has a row it is replaced. Returns
    True if a row was moved.
    """
    if not valid_profile(old_profile) or not valid_profile(new_profile) or old_profile == new_profile:
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
        _harden_db_files()


# -- multipart -------------------------------------------------------------

def parse_multipart(body: bytes, content_type: str) -> tuple:
    """Parse multipart/form-data from an already-read body (the scaffold reads the
    full request body for us, so there is no stream/chunked handling to do here).
    Returns (fields, files) where files[name] = (filename, raw_bytes)."""
    if "\r" in content_type or "\n" in content_type:
        raise ValueError("Invalid Content-Type")
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
    if not message.get_boundary() or not message.is_multipart():
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
