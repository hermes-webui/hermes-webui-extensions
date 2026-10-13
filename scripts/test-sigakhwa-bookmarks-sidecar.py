"""Sidecar regressions through the real scaffold dispatch; no server or network."""
import importlib
import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SIDECAR = ROOT / "extensions" / "sigakhwa-bookmarks" / "sidecar"
sys.dont_write_bytecode = True
sys.path.insert(0, str(SIDECAR))
base = importlib.import_module("sidecar_base")
routes = importlib.import_module("routes_impl")
TOKEN = "test-token-bookmarks"


def item(**over):
    row = {"kind": "bookmark", "profile": "default", "sessionId": "s1", "messageIndex": 3,
           "role": "assistant", "name": "첫 북마크", "data": {"preview": "안녕"}}
    row.update(over)
    return row


class RoutesTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=ROOT)
        self.addCleanup(self.tmp.cleanup)
        self.directory = Path(self.tmp.name) / "store"
        self.token = Path(self.tmp.name) / "token"
        self.token.write_text(TOKEN, encoding="utf-8")
        env = patch.dict(os.environ, {"HERMES_VIZ_STORE_DIR": str(self.directory),
                                     "HERMES_EXT_SIDECAR_TOKEN_FILE": str(self.token)})
        env.start()
        self.addCleanup(env.stop)
        self.app = base.Sidecar(str(SIDECAR / "sidecar.json"))
        routes.register(self.app)

    def call(self, method, path, body=None, token=TOKEN):
        headers = {"X-Hermes-Sidecar-Token": token} if token else {}
        raw = json.dumps(body).encode("utf-8") if body is not None else b""
        status, _, response = self.app._dispatch(method, path, headers, lambda: raw)
        return status, json.loads(response), response

    def put(self, rid, **over):
        return self.call("PUT", "/v1/bookmarks/items/" + rid, item(**over))

    def test_auth_health_missing_and_wrong_token(self):
        self.assertEqual(self.call("GET", "/health", token=None)[0], 200)
        self.assertEqual(self.call("GET", "/v1/bookmarks/items", token="wrong")[0], 401)
        self.assertEqual(self.call("GET", "/v1/bookmarks/items", token=None)[0], 401)
        self.token.unlink()
        self.assertEqual(self.call("GET", "/v1/bookmarks/items")[0], 503)

    def test_permissions_and_scaffold_identity(self):
        for name in ("sidecar.py", "sidecar_base.py"):
            self.assertEqual((SIDECAR / name).read_bytes(), (ROOT / "examples/sidecar-scaffold" / name).read_bytes())
        ext = json.loads((SIDECAR.parent / "extension.json").read_text(encoding="utf-8"))
        manifest = json.loads((SIDECAR.parent / "manifest.json").read_text(encoding="utf-8"))["extensions"][0]
        self.assertEqual(ext["permissions"], manifest["permissions"])
        self.assertEqual(ext["permissions"]["storage"]["owned"], ["hermes-viz-store:bookmarks"])
        self.assertTrue(ext["permissions"]["dom"]["mutates_core_views"])
        proxy = "/api/extensions/sigakhwa-bookmarks/sidecar"
        self.assertEqual(set(ext["permissions"]["webui_api"]["read"]), {"session", proxy + "/health", proxy + "/v1/bookmarks/items", proxy + "/v1/bookmarks/items/{id}", proxy + "/v1/bookmarks/export"})
        self.assertEqual(set(ext["permissions"]["webui_api"]["write"]), {"/api/profile/switch", "/api/session/draft", proxy + "/v1/bookmarks/items/{id}", proxy + "/v1/bookmarks/import"})

    def test_namespace_allowlist_rejects_before_lock_or_disk(self):
        before = set(routes._LOCKS)
        for method, tail in [("GET", "items"), ("GET", "items/x"), ("PUT", "items/x"),
                             ("PATCH", "items/x"), ("DELETE", "items/x"), ("GET", "export"), ("POST", "import")]:
            self.assertEqual(self.call(method, "/v1/unshipped/" + tail, item())[0], 400)
        self.assertEqual(set(routes._LOCKS), before)
        self.assertFalse(self.directory.exists())
        self.assertEqual(self.call("PUT", "/v1/sigakhwa-vault/items/card", item(kind="card"))[0], 201)

    def test_immutable_409_and_metadata_patch(self):
        self.assertEqual(self.put("snap", immutable=True, contentHash="h")[0], 201)
        self.assertEqual(self.put("snap", data={"other": 1})[0], 409)
        self.assertEqual(self.put("snap", contentHash="other")[0], 409)
        status, row, _ = self.call("PATCH", "/v1/bookmarks/items/snap", {"name": "new", "tags": ["tag"]})
        self.assertEqual(status, 200)
        self.assertTrue(row["immutable"])
        self.assertEqual(row["data"], {"preview": "안녕"})

    def test_per_item_wire_cap(self):
        status, _, raw = self.put("fit", data={"blob": "가" * 43000})
        self.assertEqual(status, 201)
        self.assertLessEqual(len(raw), routes.MAX_ITEM_BYTES)
        status, body, _ = self.put("big", data={"blob": "가" * 44000})
        self.assertEqual(status, 413)
        self.assertEqual(body["error"], "too_large")
        self.assertEqual(self.call("GET", "/v1/bookmarks/items/big")[0], 404)

    def test_patch_oversize_preserves_file_and_item(self):
        self.assertEqual(self.put("near", name="", data={"blob": "x" * 261000})[0], 201)
        path = self.directory / "bookmarks.json"
        before = path.read_bytes()
        status, body, _ = self.call("PATCH", "/v1/bookmarks/items/near", {"tags": ["x" * 64] * 32})
        self.assertEqual(status, 413)
        self.assertEqual(body["error"], "too_large")
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(self.call("GET", "/v1/bookmarks/items/near")[0], 200)

    def test_two_mib_file_cap(self):
        for i in range(10):
            status, body, _ = self.put("cap" + str(i), data={"blob": "x" * 240000})
            if status == 413:
                self.assertEqual(body["error"], "store_full")
                break
        else:
            self.fail("namespace must reject above 2 MiB")
        self.assertLessEqual((self.directory / "bookmarks.json").stat().st_size, 2 * 1024 * 1024)
        self.assertFalse(list(self.directory.glob("*.tmp-*")))

    def test_item_count_cap(self):
        rows = [dict(item(), id="r" + str(i)) for i in range(1000)]
        self.assertEqual(self.call("POST", "/v1/bookmarks/import", {"items": rows})[0], 200)
        self.assertEqual(self.put("extra")[0], 413)
        self.assertEqual(self.put("r0", name="edited")[0], 200)

    def test_pagination_list_export_as_served(self):
        for i in range(5):
            self.assertEqual(self.put("p" + str(i), data={"blob": "가" * 30000})[0], 201)
        for route in ("items", "export"):
            offset, seen, pages = 0, [], 0
            while True:
                status, body, raw = self.call("GET", f"/v1/bookmarks/{route}?offset={offset}")
                self.assertEqual(status, 200)
                self.assertLess(len(raw), 512 * 1024)
                seen.extend(row["id"] for row in body["items"])
                pages += 1
                if "nextOffset" not in body:
                    break
                self.assertGreater(body["nextOffset"], offset)
                offset = body["nextOffset"]
            self.assertEqual(pages, 3)
            self.assertEqual(len(set(seen)), 5)

    def test_corrupt_file_is_preserved_before_recovery(self):
        routes.store_dir()
        path = self.directory / "bookmarks.json"
        for raw in (b"{broken", b"\xff", b'{"items": 3}'):
            path.write_bytes(raw)
            self.assertEqual(self.put("recovered")[0], 201)
            backups = list(self.directory.glob("bookmarks.json.corrupt-*"))
            self.assertTrue(any(p.read_bytes() == raw for p in backups))
        path.write_bytes(b"broken-before-replace-import")
        self.assertEqual(self.call("POST", "/v1/bookmarks/import?merge=0", {"items": []})[0], 200)
        backups = list(self.directory.glob("bookmarks.json.corrupt-*"))
        self.assertEqual(len(backups), 4)
        self.assertTrue(any(p.read_bytes() == b"broken-before-replace-import" for p in backups))

    @unittest.skipIf(os.name == "nt", "POSIX permission bits only")
    def test_startup_tightens_directory_and_files_are_private(self):
        self.directory.mkdir(mode=0o755)
        routes.start_background(self.app)
        self.assertEqual(stat.S_IMODE(self.directory.stat().st_mode), 0o700)
        self.assertEqual(self.put("private")[0], 201)
        self.assertEqual(stat.S_IMODE((self.directory / "bookmarks.json").stat().st_mode), 0o600)

    def test_review3_create_only_preserves_versions_and_existing_server_edits(self):
        original = item(id="migration", createdAt=10, updatedAt=20)
        status, saved, _ = self.call("PUT", "/v1/bookmarks/items/migration?createOnly=1", original)
        self.assertEqual(status, 201)
        self.assertEqual((saved["createdAt"], saved["updatedAt"]), (10, 20))
        before = (self.directory / "bookmarks.json").read_bytes()
        for name in ("same", "different"):
            self.assertEqual(self.call("PUT", "/v1/bookmarks/items/migration?createOnly=1", item(id="migration", name=name))[0], 409)
            self.assertEqual((self.directory / "bookmarks.json").read_bytes(), before)
        self.assertEqual(self.call("DELETE", "/v1/bookmarks/items/migration?ifUnchanged=1", dict(saved, name="wrong"))[0], 409)
        self.assertEqual(self.call("DELETE", "/v1/bookmarks/items/migration?ifUnchanged=1", saved)[0], 200)

    def test_review4_lone_surrogates_rejected_and_emoji_persisted(self):
        self.assertEqual(self.put("emoji", name="x" * 39 + "😀")[0], 201)
        self.assertEqual(self.call("GET", "/v1/bookmarks/items/emoji")[1]["name"], "x" * 39 + "😀")
        before = (self.directory / "bookmarks.json").read_bytes()
        for fields in ({"name": "\ud83d"}, {"data": {"nested": ["\ude00"]}}, {"data": {"\ud83d": "key"}}):
            self.assertEqual(self.put("invalid", **fields)[0], 400)
            self.assertEqual((self.directory / "bookmarks.json").read_bytes(), before)
        self.assertEqual(self.call("PATCH", "/v1/bookmarks/items/emoji", {"name": "\ud83d"})[0], 400)

    def test_review12_readme_matches_namespace_limit(self):
        self.assertEqual(routes.MAX_ITEMS_PER_NS, 1000)
        self.assertIn("1,000 items per namespace", (SIDECAR / "README.md").read_text(encoding="utf-8"))

    def test_merge_import_does_not_overwrite_existing(self):
        self.put("saved", name="original")
        status, body, _ = self.call("POST", "/v1/bookmarks/import", {"items": [item(id="saved", name="replace"), item(id="new")]})
        self.assertEqual(status, 200)
        self.assertEqual((body["added"], body["skipped"]), (1, 1))
        self.assertEqual(self.call("GET", "/v1/bookmarks/items/saved")[1]["name"], "original")


    def test_round3_conflict_export_ids_preserve_both_copies_and_original_id(self):
        status, server, _ = self.put("original", name="server version")
        self.assertEqual(status, 201)
        local = dict(server, id="conflict-copy-valid", name="local version", conflictOriginalId="original")
        payload = {"v": 1, "items": [server, local]}
        status, result, _ = self.call("POST", "/v1/bookmarks/import?merge=0", payload)
        self.assertEqual(status, 200)
        self.assertEqual(result["added"], 2)
        rows = self.call("GET", "/v1/bookmarks/export")[1]["items"]
        self.assertEqual({r["name"] for r in rows}, {"server version", "local version"})
        self.assertEqual(next(r for r in rows if r["id"] == local["id"])["conflictOriginalId"], "original")
        local["conflictOriginalId"] = "bad/id"
        self.assertIsNone(routes.normalize_item(local, "bookmarks", None))


if __name__ == "__main__":
    unittest.main()
