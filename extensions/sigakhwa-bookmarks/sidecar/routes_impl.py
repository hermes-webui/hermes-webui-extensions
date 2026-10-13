"""Routes for the sigakhwa-bookmarks sidecar (the ONLY file with logic in this directory).

Storage: one JSON file per namespace under HERMES_VIZ_STORE_DIR (env) or the platform default
(%LOCALAPPDATA%/hermes-viz/store on Windows, ~/.local/share/hermes-viz/store elsewhere).
Writes are atomic (tmp + os.replace) and serialized per namespace. Each file is capped at 2 MiB,
every response stays well under the WebUI proxy's 512 KiB buffer (list/export paginate), and the
immutable guard of the browser store (docs/INTERFACES.md §2) is mirrored here.

Size accounting: every response leaves through the scaffold's ``Sidecar.json`` (``json.dumps`` with
the default ``ensure_ascii=True``), which emits each non-ASCII character as a 6-byte backslash-u
escape (``\\uXXXX``) — twice the UTF-8 size of Hangul/CJK text. Items and pages are therefore measured with that
same serializer (``_wire_size``), never with UTF-8, so the caps below are caps on what the proxy
actually carries. The on-disk file keeps ``ensure_ascii=False`` (never proxied).

Auth is owned by the scaffold (sidecar_base.py): nothing here touches the token, and /health is
scaffold-owned (liveness only — no data is added to it).

Contract constraints for this file (SIDECAR_CONTRACT.md §5): exactly one top-level synchronous
``register(app)`` that applies ``@app.route`` decorators before any control flow, and no control-flow
statements in the module body (helpers are plain ``def``s).
"""
from __future__ import annotations

import json
import os
import re
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

ALLOWED_NAMESPACES = ("bookmarks", "sigakhwa-vault")
ID_RE = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
ROLES = ("user", "assistant")
MAX_FILE_BYTES = 2 * 1024 * 1024
MAX_ITEM_BYTES = 256 * 1024      # as served (ASCII-escaped JSON); ≈43k pure-Hangul chars
MAX_RESPONSE_BYTES = 400 * 1024  # as served; envelope + 400 KiB of rows < the proxy's 512 KiB cap
LIST_LIMIT = 500
MAX_NAME = 500
MAX_STR = 256
MAX_TAGS = 32
MAX_TAG = 64
MAX_ITEMS_PER_NS = 1000

_LOCKS_GUARD = threading.Lock()
_LOCKS: Dict[str, threading.Lock] = {}


# ── storage helpers ────────────────────────────────────────────────────────────
def store_dir() -> Path:
    override = os.getenv("HERMES_VIZ_STORE_DIR")
    base: Path
    base = Path(override).expanduser() if override else _default_store_dir()
    base.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(base, 0o700)
    return base


def start_background(app) -> None:
    """Scaffold startup hook; no background threads are needed."""
    store_dir()


def _default_store_dir() -> Path:
    local = os.getenv("LOCALAPPDATA")
    win = sys.platform == "win32"
    root = Path(local) if (win and local) else (Path.home() / ("AppData/Local" if win else ".local/share"))
    return root / "hermes-viz" / "store"


def _lock_for(ns: str) -> threading.Lock:
    with _LOCKS_GUARD:
        lock = _LOCKS.get(ns)
        if lock is None:
            lock = threading.Lock()
            _LOCKS[ns] = lock
        return lock


def _ns_path(ns: str) -> Path:
    return store_dir() / f"{ns}.json"


def _now_ms() -> int:
    return int(time.time() * 1000)


def _wire_size(obj: Any) -> int:
    """Byte size of ``obj`` exactly as ``Sidecar.json`` will serialize it (default ensure_ascii).

    Raises TypeError/ValueError for unserializable input (callers treat that as invalid).
    """
    return len(json.dumps(obj).encode("utf-8"))


def _read_ns(ns: str) -> Dict[str, Dict[str, Any]]:
    """Load the namespace file; missing or malformed → empty (never raises)."""
    path = _ns_path(ns)
    try:
        raw = path.read_bytes()
    except FileNotFoundError:
        return {}
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        _quarantine(path)
        return {}
    rows: Any = None
    if isinstance(parsed, dict):
        rows = parsed.get("items")
    if isinstance(rows, dict):
        rows = list(rows.values())
    if not isinstance(rows, list):
        _quarantine(path)
        return {}
    out: Dict[str, Dict[str, Any]] = {}
    for row in rows:
        item = _accept_stored(row, ns)
        if item is not None:
            out[item["id"]] = item
    return out


def _quarantine(path: Path) -> None:
    os.replace(path, path.with_name(f"{path.name}.corrupt-{time.time_ns()}"))


def _write_ns(ns: str, items: Dict[str, Dict[str, Any]]) -> None:
    """Atomic write (tmp + replace). Raises StoreFull when the file would exceed the cap."""
    payload = {"v": 1, "namespace": ns, "updatedAt": _now_ms(), "items": sorted(items.values(), key=_sort_key)}
    data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(data) > MAX_FILE_BYTES or len(items) > MAX_ITEMS_PER_NS:
        raise StoreFull(len(data))
    path = _ns_path(ns)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(path.parent, 0o700)
    tmp = path.with_name(f"{path.name}.tmp-{os.getpid()}-{uuid.uuid4().hex[:8]}")
    try:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    finally:
        try:
            if tmp.exists():
                tmp.unlink()
        except OSError:
            pass


class ItemTooLarge(Exception):
    pass


class StoreFull(Exception):
    def __init__(self, size: int):
        super().__init__(f"namespace file would be {size} bytes (> {MAX_FILE_BYTES})")
        self.size = size


def _sort_key(item: Dict[str, Any]) -> Tuple[int, str]:
    # newest first → negative createdAt, then id for a stable order
    return (-int(item.get("createdAt") or 0), str(item.get("id") or ""))


# ── validation (mirrors shared/hermes-viz-store.js normalizeItem) ──────────────
def _str(value: Any, max_len: int) -> Optional[str]:
    if not isinstance(value, str) or len(value) > max_len:
        return None
    return value


def normalize_item(raw: Any, ns: str, existing: Optional[Dict[str, Any]] = None, item_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
    if not isinstance(raw, dict):
        return None
    # Reject lone surrogate code points in any nested string, including data keys.
    if _has_surrogate(raw):
        return None
    rid = raw.get("id") if item_id is None else item_id
    if rid is not None and (not isinstance(rid, str) or not ID_RE.match(rid)):
        return None
    kind = _str(raw.get("kind"), 64)
    profile = _str(raw.get("profile"), MAX_STR)
    session_id = _str(raw.get("sessionId"), MAX_STR)
    role = raw.get("role")
    message_index = raw.get("messageIndex")
    name = _str(raw.get("name", ""), MAX_NAME)
    if not kind or not kind.strip() or not profile or not profile.strip() or not session_id or not session_id.strip():
        return None
    if role not in ROLES:
        return None
    if isinstance(message_index, bool) or not isinstance(message_index, int) or message_index < 0 or message_index > 2**53:
        return None
    if name is None:
        return None
    data = raw.get("data", {})
    if not isinstance(data, dict):
        return None
    tags: Optional[List[str]] = None
    if "tags" in raw and raw["tags"] is not None:
        tags_raw = raw["tags"]
        if not isinstance(tags_raw, list) or len(tags_raw) > MAX_TAGS:
            return None
        tags = []
        for tag in tags_raw:
            clean = _str(tag, MAX_TAG)
            if clean is None:
                return None
            tags.append(clean)
    immutable = raw.get("immutable") is True or bool(existing and existing.get("immutable") is True)
    content_hash = raw.get("contentHash")
    if content_hash is not None and _str(content_hash, 128) is None:
        return None
    now = _now_ms()
    created = existing["createdAt"] if existing else (raw.get("createdAt") if isinstance(raw.get("createdAt"), (int, float)) and not isinstance(raw.get("createdAt"), bool) else now)
    item: Dict[str, Any] = {
        "id": rid or uuid.uuid4().hex,
        "namespace": ns,
        "kind": kind,
        "createdAt": int(created),
        "updatedAt": now,
        "profile": profile,
        "sessionId": session_id,
        "messageIndex": message_index,
        "role": role,
        "name": name,
        "data": data,
    }
    if tags is not None:
        item["tags"] = tags
    if immutable:
        item["immutable"] = True
    if content_hash is not None:
        item["contentHash"] = content_hash
    try:
        size = _wire_size(item)
    except (TypeError, ValueError):
        return None
    if size > MAX_ITEM_BYTES:
        raise ItemTooLarge()
    return item


def _has_surrogate(value: Any) -> bool:
    if isinstance(value, str):
        return any(0xD800 <= ord(char) <= 0xDFFF for char in value)
    if isinstance(value, list):
        return any(_has_surrogate(entry) for entry in value)
    if isinstance(value, dict):
        return any(_has_surrogate(key) or _has_surrogate(entry) for key, entry in value.items())
    return False


def _accept_stored(raw: Any, ns: str) -> Optional[Dict[str, Any]]:
    try:
        item = normalize_item(raw, ns)
    except ItemTooLarge:
        return None
    if item is None:
        return None
    for key in ("createdAt", "updatedAt"):
        val = raw.get(key)
        if isinstance(val, (int, float)) and not isinstance(val, bool):
            item[key] = int(val)
    return item


def immutable_conflict(existing: Optional[Dict[str, Any]], incoming: Dict[str, Any]) -> bool:
    if not existing or existing.get("immutable") is not True:
        return False
    same_data = json.dumps(existing.get("data"), sort_keys=True) == json.dumps(incoming.get("data"), sort_keys=True)
    same_hash = (existing.get("contentHash") or None) == (incoming.get("contentHash") or None)
    return not (same_data and same_hash)


def _page(rows: List[Dict[str, Any]], offset: int, limit: int) -> Tuple[List[Dict[str, Any]], Optional[int]]:
    """Return up to `limit` rows from `offset`, stopping early when ~400 KiB *as served* is reached.

    Rows are measured with the response serializer (``_wire_size``) so a page of Korean items is
    bounded by what the proxy carries, not by its UTF-8 size (which is about half).
    """
    out: List[Dict[str, Any]] = []
    size = 2
    i = offset
    while i < len(rows) and len(out) < limit:
        row = rows[i]
        row_size = _wire_size(row) + 1
        if out and size + row_size > MAX_RESPONSE_BYTES:
            break
        out.append(row)
        size += row_size
        i += 1
    next_offset = i if i < len(rows) else None
    return out, next_offset


def _parse_body(req) -> Any:
    try:
        return json.loads(req.body.decode("utf-8")) if req.body else None
    except (ValueError, UnicodeDecodeError):
        return None


def _int_query(req, name: str, default: int) -> int:
    raw = req.query_one(name)
    try:
        value = int(raw) if raw is not None else default
    except ValueError:
        value = default
    return max(0, value)


# ── routes ─────────────────────────────────────────────────────────────────────
def register(app) -> None:
    @app.route("GET", "/v1/{ns}/items")
    def list_items(req):
        ns = req.params["ns"]
        if ns not in ALLOWED_NAMESPACES:
            return app.json({"error": "invalid namespace"}, status=400)
        with _lock_for(ns):
            rows = sorted(_read_ns(ns).values(), key=_sort_key)
        for field in ("profile", "sessionId", "kind"):
            want = req.query_one(field)
            if want is not None:
                rows = [r for r in rows if r.get(field) == want]
        offset = _int_query(req, "offset", 0)
        page, next_offset = _page(rows, offset, LIST_LIMIT)
        payload: Dict[str, Any] = {"items": page, "total": len(rows), "truncated": next_offset is not None}
        if next_offset is not None:
            payload["nextOffset"] = next_offset
        return app.json(payload)

    @app.route("GET", "/v1/{ns}/items/{item_id}")
    def get_item(req):
        ns = req.params["ns"]
        if ns not in ALLOWED_NAMESPACES:
            return app.json({"error": "invalid namespace"}, status=400)
        with _lock_for(ns):
            item = _read_ns(ns).get(req.params["item_id"])
        if item is None:
            return app.json({"error": "not found"}, status=404)
        return app.json(item)

    @app.route("PUT", "/v1/{ns}/items/{item_id}")
    def put_item(req):
        ns = req.params["ns"]
        item_id = req.params["item_id"]
        if ns not in ALLOWED_NAMESPACES:
            return app.json({"error": "invalid namespace"}, status=400)
        if not ID_RE.match(item_id):
            return app.json({"error": "invalid id"}, status=400)
        body = _parse_body(req)
        if not isinstance(body, dict):
            return app.json({"error": "invalid json body"}, status=400)
        if "id" in body and body["id"] != item_id:
            return app.json({"error": "id mismatch"}, status=400)
        with _lock_for(ns):
            items = _read_ns(ns)
            existing = items.get(item_id)
            create_only = req.query_one("createOnly") == "1"
            if create_only and existing is not None:
                return app.json({"error": "conflict", "id": item_id}, status=409)
            try:
                incoming = normalize_item(body, ns, existing, item_id=item_id)
            except ItemTooLarge:
                return app.json({"error": "too_large"}, status=413)
            if incoming is None:
                return app.json({"error": "invalid item"}, status=400)
            if create_only:
                for key in ("createdAt", "updatedAt"):
                    val = body.get(key)
                    if isinstance(val, (int, float)) and not isinstance(val, bool):
                        incoming[key] = int(val)
            if immutable_conflict(existing, incoming):
                return app.json({"error": "immutable", "id": item_id}, status=409)
            if existing is None and len(items) >= MAX_ITEMS_PER_NS:
                return app.json({"error": "store_full", "hint": "too many items"}, status=413)
            items[item_id] = incoming
            try:
                _write_ns(ns, items)
            except StoreFull as exc:
                return app.json({"error": "store_full", "hint": str(exc)}, status=413)
            except OSError as exc:
                return app.json({"error": "write failed", "hint": exc.__class__.__name__}, status=500)
        return app.json(incoming, status=200 if existing is not None else 201)

    @app.route("PATCH", "/v1/{ns}/items/{item_id}")
    def patch_item(req):
        ns = req.params["ns"]
        item_id = req.params["item_id"]
        if ns not in ALLOWED_NAMESPACES:
            return app.json({"error": "invalid namespace"}, status=400)
        body = _parse_body(req)
        if not isinstance(body, dict):
            return app.json({"error": "invalid json body"}, status=400)
        with _lock_for(ns):
            items = _read_ns(ns)
            existing = items.get(item_id)
            if existing is None:
                return app.json({"error": "not found"}, status=404)
            updated = dict(existing)
            if "name" in body:
                name = _str(body["name"], MAX_NAME)
                if name is None:
                    return app.json({"error": "invalid name"}, status=400)
                updated["name"] = name
            if "tags" in body:
                tags_raw = body["tags"]
                if not isinstance(tags_raw, list) or len(tags_raw) > MAX_TAGS:
                    return app.json({"error": "invalid tags"}, status=400)
                tags: List[str] = []
                for tag in tags_raw:
                    clean = _str(tag, MAX_TAG)
                    if clean is None:
                        return app.json({"error": "invalid tags"}, status=400)
                    tags.append(clean)
                updated["tags"] = tags
            updated["updatedAt"] = _now_ms()
            try:
                updated = normalize_item(updated, ns, existing, item_id=item_id)
            except ItemTooLarge:
                return app.json({"error": "too_large"}, status=413)
            if updated is None:
                return app.json({"error": "invalid item"}, status=400)
            items[item_id] = updated
            try:
                _write_ns(ns, items)
            except StoreFull as exc:
                return app.json({"error": "store_full", "hint": str(exc)}, status=413)
            except OSError as exc:
                return app.json({"error": "write failed", "hint": exc.__class__.__name__}, status=500)
        return app.json(updated)

    @app.route("DELETE", "/v1/{ns}/items/{item_id}")
    def delete_item(req):
        ns = req.params["ns"]
        item_id = req.params["item_id"]
        if ns not in ALLOWED_NAMESPACES:
            return app.json({"error": "invalid namespace"}, status=400)
        with _lock_for(ns):
            items = _read_ns(ns)
            if item_id not in items:
                return app.json({"error": "not found", "removed": False}, status=404)
            if req.query_one("ifUnchanged") == "1" and items[item_id] != _parse_body(req):
                return app.json({"error": "conflict", "id": item_id}, status=409)
            del items[item_id]
            try:
                _write_ns(ns, items)
            except OSError as exc:
                return app.json({"error": "write failed", "hint": exc.__class__.__name__}, status=500)
        return app.json({"removed": True, "id": item_id})

    @app.route("GET", "/v1/{ns}/export")
    def export_items(req):
        ns = req.params["ns"]
        if ns not in ALLOWED_NAMESPACES:
            return app.json({"error": "invalid namespace"}, status=400)
        with _lock_for(ns):
            rows = sorted(_read_ns(ns).values(), key=_sort_key)
        offset = _int_query(req, "offset", 0)
        page, next_offset = _page(rows, offset, MAX_ITEMS_PER_NS)
        payload: Dict[str, Any] = {"v": 1, "namespace": ns, "exportedAt": _now_ms(), "items": page, "total": len(rows)}
        if next_offset is not None:
            payload["nextOffset"] = next_offset
        return app.json(payload)

    @app.route("POST", "/v1/{ns}/import")
    def import_items(req):
        ns = req.params["ns"]
        if ns not in ALLOWED_NAMESPACES:
            return app.json({"error": "invalid namespace"}, status=400)
        body = _parse_body(req)
        rows = body if isinstance(body, list) else (body.get("items") if isinstance(body, dict) else None)
        if not isinstance(rows, list):
            return app.json({"error": "invalid import payload"}, status=400)
        merge = req.query_one("merge", "1") != "0"
        added = 0
        skipped = 0
        with _lock_for(ns):
            stored = _read_ns(ns)
            items = stored if merge else {}
            for row in rows:
                item = _accept_stored(row, ns)
                if item is None or item["id"] in items or len(items) >= MAX_ITEMS_PER_NS:
                    skipped += 1
                    continue
                items[item["id"]] = item
                added += 1
            try:
                _write_ns(ns, items)
            except StoreFull as exc:
                return app.json({"error": "store_full", "hint": str(exc)}, status=413)
            except OSError as exc:
                return app.json({"error": "write failed", "hint": exc.__class__.__name__}, status=500)
        return app.json({"added": added, "skipped": skipped, "total": len(items)})
