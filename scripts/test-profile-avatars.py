#!/usr/bin/env python3
"""Regression tests for the Profile Avatars extension."""
from __future__ import annotations

import colorsys
import concurrent.futures
import importlib.util
import os
import struct
import sys
import tempfile
import threading
import unittest
import zlib
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SIDECAR_DIR = REPO_ROOT / "extensions" / "profile-avatars" / "sidecar"
AVATARS_PATH = SIDECAR_DIR / "avatars.py"
_SPEC = importlib.util.spec_from_file_location("profile_avatars_storage", AVATARS_PATH)
if _SPEC is None or _SPEC.loader is None:
    raise RuntimeError(f"cannot load {AVATARS_PATH}")
avatars = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = avatars
_SPEC.loader.exec_module(avatars)


def _png_chunk(kind: bytes, payload: bytes) -> bytes:
    checksum = zlib.crc32(kind + payload) & 0xFFFFFFFF
    return len(payload).to_bytes(4, "big") + kind + payload + checksum.to_bytes(4, "big")


def png(width: int = 1, height: int = 1) -> bytes:
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    # One real RGBA scanline is enough for the normal 1x1 storage tests. Large
    # dimensions are rejected from IHDR before pixel data is decoded.
    raw = b"\x00" + b"\x00\x00\x00\xff" * (width if height == 1 and width <= 8 else 1)
    return (
        b"\x89PNG\r\n\x1a\n"
        + _png_chunk(b"IHDR", ihdr)
        + _png_chunk(b"IDAT", zlib.compress(raw))
        + _png_chunk(b"IEND", b"")
    )


def jpeg(width: int = 1, height: int = 1, include_scan: bool = True) -> bytes:
    sof_data = bytes([8]) + height.to_bytes(2, "big") + width.to_bytes(2, "big") + bytes([
        3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0,
    ])
    out = b"\xff\xd8\xff\xc0" + (len(sof_data) + 2).to_bytes(2, "big") + sof_data
    if include_scan:
        sos_data = bytes([3, 1, 0, 2, 0, 3, 0, 0, 63, 0])
        out += b"\xff\xda" + (len(sos_data) + 2).to_bytes(2, "big") + sos_data + b"\x00"
    return out + b"\xff\xd9"


def webp_lossless(width: int = 1, height: int = 1) -> bytes:
    bits = (width - 1) | ((height - 1) << 14)
    payload = b"\x2f" + bits.to_bytes(4, "little")
    chunk = b"VP8L" + len(payload).to_bytes(4, "little") + payload + b"\x00"
    riff_payload = b"WEBP" + chunk
    return b"RIFF" + len(riff_payload).to_bytes(4, "little") + riff_payload


class AvatarValidationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.old_state = getattr(avatars, "STATE_DIR")
        self.old_db = getattr(avatars, "_AVATARS_DB")
        self.old_limit = getattr(avatars, "MAX_AVATARS")
        setattr(avatars, "STATE_DIR", Path(self.temp.name))
        setattr(avatars, "_AVATARS_DB", Path(self.temp.name) / "avatars.db")
        setattr(avatars, "MAX_AVATARS", 128)

    def tearDown(self) -> None:
        setattr(avatars, "STATE_DIR", self.old_state)
        setattr(avatars, "_AVATARS_DB", self.old_db)
        setattr(avatars, "MAX_AVATARS", self.old_limit)
        self.temp.cleanup()

    def test_profile_names_match_core_ids(self) -> None:
        for name in ("default", "webui", "agent-2", "agent_two", "a" * 64):
            self.assertTrue(avatars.valid_profile(name), name)
        for name in ("", "Agent", ".hidden", "with.dot", "two words", "é", "a" * 65):
            self.assertFalse(avatars.valid_profile(name), name)

    def test_valid_raster_dimensions(self) -> None:
        self.assertEqual(avatars.validate_image(png(2, 1), "image/png"), (2, 1))
        self.assertEqual(avatars.validate_image(jpeg(3, 2), "image/jpeg"), (3, 2))
        self.assertEqual(avatars.validate_image(webp_lossless(4, 3), "image/webp"), (4, 3))

    def test_malformed_and_excessive_images_are_rejected(self) -> None:
        broken_crc = bytearray(png())
        broken_crc[-1] ^= 1
        cases = [
            (b"\x89PNG\r\n\x1a\n", "image/png"),
            (bytes(broken_crc), "image/png"),
            (png(4097, 1), "image/png"),
            (jpeg(include_scan=False), "image/jpeg"),
            (b"RIFF\x0c\x00\x00\x00WEBPVP8X\x00\x00\x00\x00", "image/webp"),
        ]
        for blob, mime in cases:
            with self.subTest(mime=mime, size=len(blob)):
                with self.assertRaises(avatars.InvalidImageError):
                    avatars.validate_image(blob, mime)

    def test_store_is_bounded_and_replacement_remains_allowed(self) -> None:
        setattr(avatars, "MAX_AVATARS", 2)
        avatars.store_avatar("one", "image/png", png())
        avatars.store_avatar("two", "image/png", png())
        with self.assertRaises(avatars.AvatarLimitError):
            avatars.store_avatar("three", "image/png", png())
        # Existing rows may still be replaced at the cap.
        avatars.store_avatar("one", "image/png", png(2, 1))
        self.assertEqual(set(avatars.list_avatars()), {"one", "two"})

    def test_concurrent_first_uploads_cannot_exceed_row_cap(self) -> None:
        setattr(avatars, "MAX_AVATARS", 1)
        barrier = threading.Barrier(2)

        def attempt(name: str) -> str:
            barrier.wait()
            try:
                avatars.store_avatar(name, "image/png", png())
                return "stored"
            except avatars.AvatarLimitError:
                return "limited"

        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(attempt, ("one", "two")))
        self.assertCountEqual(results, ["stored", "limited"])
        self.assertEqual(len(avatars.list_avatars()), 1)

    def test_database_is_owner_only_even_under_permissive_umask(self) -> None:
        old_umask = os.umask(0)
        try:
            avatars.store_avatar("default", "image/png", png())
        finally:
            os.umask(old_umask)
        self.assertEqual(avatars._AVATARS_DB.stat().st_mode & 0o777, 0o600)

    def test_database_symlink_is_refused(self) -> None:
        target = avatars.STATE_DIR / "target.db"
        target.write_bytes(b"not sqlite")
        avatars._AVATARS_DB.symlink_to(target)
        with self.assertRaisesRegex(RuntimeError, "must not be a symlink"):
            avatars._ensure_db()

    def test_quoted_multipart_boundary_and_embedded_boundary_bytes(self) -> None:
        boundary = "avatar boundary"
        payload = png() + b"--avatar boundary-not-a-delimiter"
        body = (
            b"--avatar boundary\r\n"
            b"Content-Disposition: form-data; name=\"avatar\"; filename=\"a.png\"\r\n"
            b"Content-Type: image/png\r\n\r\n"
            + payload
            + b"\r\n--avatar boundary--\r\n"
        )
        fields, files = avatars.parse_multipart(
            body, 'multipart/form-data; boundary="avatar boundary"'
        )
        self.assertEqual(fields, {})
        self.assertEqual(files["avatar"], ("a.png", payload))


class FrontendContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.source = (
            REPO_ROOT / "extensions" / "profile-avatars" / "assets" / "avatars.js"
        ).read_text(encoding="utf-8")

    def test_manager_rechecks_consent_and_refreshes_on_every_open(self) -> None:
        block = self.source.split("function openManager()", 1)[1].split(
            "function _closeManager()", 1
        )[0]
        self.assertIn("sidecarConsented()", block)
        self.assertIn("return refresh().then(_renderManagerList)", block)
        self.assertNotIn("_loaded ?", block)

    def test_upload_decodes_before_posting(self) -> None:
        pick = self.source.split("function _pickAndUpload", 1)[1].split(
            "function _buildManager", 1
        )[0]
        self.assertIn("_validateAvatarFile(f)", pick)
        self.assertLess(pick.index("_validateAvatarFile(f)"), pick.index("upload(name, f)"))

    def test_generated_initial_colors_meet_white_text_contrast(self) -> None:
        self.assertIn("55%, 30%", self.source)
        worst = 100.0
        for hue in range(360):
            red, green, blue = colorsys.hls_to_rgb(hue / 360, 0.30, 0.55)
            channels = []
            for value in (red, green, blue):
                channels.append(
                    value / 12.92 if value <= 0.04045
                    else ((value + 0.055) / 1.055) ** 2.4
                )
            luminance = 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
            worst = min(worst, 1.05 / (luminance + 0.05))
        self.assertGreaterEqual(worst, 4.5)


if __name__ == "__main__":
    unittest.main(verbosity=2)
