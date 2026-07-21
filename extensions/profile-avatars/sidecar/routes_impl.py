"""Route implementations for the profile-avatars sidecar.

This is the ONLY file this extension authors on top of the canonical scaffold.
Auth is handled entirely by ``sidecar_base.py`` — every route here is reachable
only with a valid WebUI-injected ``X-Hermes-Sidecar-Token`` (deny-by-default);
``/health`` (owned by the scaffold) is the sole tokenless route. Handlers return
``app.json(...)`` or a raw ``(status, headers, bytes)`` tuple; they never touch a
raw HTTP handler.

Routes (proxied at /api/extensions/profile-avatars/sidecar/...):
  GET    /api/avatars            — {profile: {url, updated_at}} for profiles with an avatar
  GET    /api/avatars/{profile}  — image bytes, ETag + long immutable cache (304 aware)
  POST   /api/avatars/{profile}  — multipart upload, file field "avatar"
  DELETE /api/avatars/{profile}  — remove the row
"""
from __future__ import annotations

import avatars


def register(app) -> None:
    @app.route("GET", "/api/avatars")
    def list_all(req):
        # Replacement for vanilla's missing /api/profiles.avatar_url.
        return app.json({"avatars": avatars.list_avatars()})

    @app.route("GET", "/api/avatars/{profile}")
    def get_one(req):
        profile = req.params["profile"]
        if not avatars.valid_profile(profile):
            return app.json({"error": "invalid profile name"}, status=400)
        row = avatars.get_avatar_row(profile)
        if not row:
            return app.json({"error": "no avatar"}, status=404)
        mime, blob, etag = row
        if req.headers.get("If-None-Match", "") == etag:
            return (304, {"ETag": etag}, b"")
        return (
            200,
            {
                "Content-Type": mime,
                "ETag": etag,
                "Cache-Control": "private, max-age=31536000, immutable",
                "X-Content-Type-Options": "nosniff",
            },
            blob,
        )

    @app.route("POST", "/api/avatars/{profile}")
    def upload(req):
        profile = req.params["profile"]
        if not avatars.valid_profile(profile):
            return app.json({"error": "invalid profile name"}, status=400)
        ct = req.headers.get("Content-Type", "")
        if "multipart/form-data" not in ct:
            return app.json(
                {"error": "expected multipart/form-data with file field 'avatar'"},
                status=400,
            )
        body = req.body or b""
        if not body:
            return app.json({"error": "empty body"}, status=400)
        # Reject oversize before parsing (matches the core proxy response cap; a
        # bigger avatar would store fine but 502 on read).
        if len(body) > avatars.MAX_BYTES + 4096:
            return app.json(
                {"error": f"avatar too large (max {avatars.MAX_BYTES // 1024} KiB)"},
                status=413,
            )
        try:
            _fields, files = avatars.parse_multipart(body, ct)
        except Exception as exc:
            return app.json({"error": f"multipart parse failed: {exc}"}, status=400)
        if "avatar" not in files:
            return app.json({"error": "missing 'avatar' file field"}, status=400)
        _filename, blob = files["avatar"]
        if not blob:
            return app.json({"error": "empty avatar payload"}, status=400)
        if len(blob) > avatars.MAX_BYTES:
            return app.json(
                {"error": f"avatar too large (max {avatars.MAX_BYTES // 1024} KiB)"},
                status=413,
            )
        mime = avatars.detect_mime(blob)
        if mime not in avatars.ALLOWED_MIMES:
            return app.json(
                {"error": "unsupported image type — allowed: PNG, JPEG, WebP (magic bytes)"},
                status=415,
            )
        return app.json(avatars.store_avatar(profile, mime, blob))

    @app.route("DELETE", "/api/avatars/{profile}")
    def delete(req):
        profile = req.params["profile"]
        if not avatars.valid_profile(profile):
            return app.json({"error": "invalid profile name"}, status=400)
        return app.json({"profile": profile, "deleted": avatars.delete_avatar(profile)})
