#!/usr/bin/env python3
"""Behavioral tests for the canonical Python sidecar scaffold."""
from __future__ import annotations

import http.client
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest


ROOT = Path(__file__).resolve().parent.parent
SCAFFOLD = ROOT / "examples" / "sidecar-scaffold"
sys.dont_write_bytecode = True


def _load_sidecar_base():
    spec = importlib.util.spec_from_file_location("hermes_sidecar_base", SCAFFOLD / "sidecar_base.py")
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load sidecar_base.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


class SidecarScaffoldTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.base = _load_sidecar_base()

    def test_unknown_proxy_auth_values_fail_closed_at_startup(self):
        with tempfile.TemporaryDirectory(prefix="hermes-sidecar-config-") as temp:
            config = Path(temp) / "sidecar.json"
            for invalid in ("token-vI", "", None, 7):
                config.write_text(
                    json.dumps({"id": "test-sidecar", "port": 17790, "proxy_auth": invalid}),
                    encoding="utf-8",
                )
                with self.subTest(proxy_auth=invalid):
                    with self.assertRaisesRegex(ValueError, "proxy_auth"):
                        self.base.Sidecar(str(config))

    def test_start_background_hook_is_optional(self):
        with tempfile.TemporaryDirectory(prefix="hermes-sidecar-optional-hook-") as temp:
            temp_path = Path(temp)
            for name in ("sidecar_base.py", "sidecar.py"):
                shutil.copy2(SCAFFOLD / name, temp_path / name)
            (temp_path / "routes_impl.py").write_text(
                "def register(app):\n    return None\n",
                encoding="utf-8",
            )

            port = _free_port()
            token_file = temp_path / "test-sidecar.token"
            token_file.write_text("optional-hook-token-0123456789", encoding="utf-8")
            (temp_path / "sidecar.json").write_text(
                json.dumps({"id": "test-sidecar", "port": port, "proxy_auth": "token-v1"}),
                encoding="utf-8",
            )
            env = os.environ.copy()
            env["HERMES_EXT_SIDECAR_TOKEN_FILE"] = str(token_file)
            proc = subprocess.Popen(
                [sys.executable, "sidecar.py"],
                cwd=temp_path,
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            try:
                for _ in range(80):
                    try:
                        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=0.25)
                        conn.request("GET", "/health")
                        response = conn.getresponse()
                        response.read()
                        conn.close()
                        if response.status == 200:
                            break
                    except OSError:
                        time.sleep(0.05)
                else:
                    stdout, stderr = proc.communicate(timeout=1)
                    self.fail(f"sidecar without optional hook did not start\nstdout={stdout}\nstderr={stderr}")
            finally:
                proc.terminate()
                try:
                    proc.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=3)
                if proc.stdout is not None:
                    proc.stdout.close()
                if proc.stderr is not None:
                    proc.stderr.close()

    def test_health_is_cross_origin_readable_and_auth_remains_fail_closed(self):
        with tempfile.TemporaryDirectory(prefix="hermes-sidecar-live-") as temp:
            temp_path = Path(temp)
            for name in ("sidecar_base.py", "sidecar.py", "routes_impl.py"):
                shutil.copy2(SCAFFOLD / name, temp_path / name)

            port = _free_port()
            token = "contract-test-token-0123456789"
            token_file = temp_path / "test-sidecar.token"
            token_file.write_text(token, encoding="utf-8")
            (temp_path / "sidecar.json").write_text(
                json.dumps({"id": "test-sidecar", "port": port, "proxy_auth": "token-v1"}),
                encoding="utf-8",
            )
            env = os.environ.copy()
            env["HERMES_EXT_SIDECAR_TOKEN_FILE"] = str(token_file)
            proc = subprocess.Popen(
                [sys.executable, "sidecar.py"],
                cwd=temp_path,
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            try:
                for _ in range(80):
                    try:
                        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=0.25)
                        conn.request("GET", "/health", headers={"Origin": "https://example.test"})
                        response = conn.getresponse()
                        body = response.read()
                        conn.close()
                        if response.status == 200:
                            break
                    except OSError:
                        time.sleep(0.05)
                else:
                    stdout, stderr = proc.communicate(timeout=1)
                    self.fail(f"sidecar did not start\nstdout={stdout}\nstderr={stderr}")

                self.assertEqual(response.getheader("Access-Control-Allow-Origin"), "*")
                self.assertEqual(response.getheader("Cache-Control"), "no-store")
                self.assertEqual(json.loads(body)["ok"], True)

                conn = http.client.HTTPConnection("127.0.0.1", port, timeout=1)
                conn.request("GET", "/api/status")
                unauthorized = conn.getresponse()
                unauthorized.read()
                conn.close()
                self.assertEqual(unauthorized.status, 401)

                conn = http.client.HTTPConnection("127.0.0.1", port, timeout=1)
                conn.request(
                    "GET",
                    "/api/status",
                    headers={"X-Hermes-Sidecar-Token": "wrong-token"},
                )
                wrong_token = conn.getresponse()
                wrong_token.read()
                conn.close()
                self.assertEqual(wrong_token.status, 401)

                conn = http.client.HTTPConnection("127.0.0.1", port, timeout=1)
                conn.request("GET", "/api/status", headers={"X-Hermes-Sidecar-Token": token})
                authorized = conn.getresponse()
                authorized.read()
                conn.close()
                self.assertEqual(authorized.status, 200)

                rotated_token = "rotated-contract-token-987654321"
                token_file.write_text(rotated_token, encoding="utf-8")
                conn = http.client.HTTPConnection("127.0.0.1", port, timeout=1)
                conn.request("GET", "/api/status", headers={"X-Hermes-Sidecar-Token": token})
                stale = conn.getresponse()
                stale.read()
                conn.close()
                self.assertEqual(stale.status, 401)

                conn = http.client.HTTPConnection("127.0.0.1", port, timeout=1)
                conn.request(
                    "GET",
                    "/api/status",
                    headers={"X-Hermes-Sidecar-Token": rotated_token},
                )
                rotated = conn.getresponse()
                rotated.read()
                conn.close()
                self.assertEqual(rotated.status, 200)

                token_file.unlink()
                conn = http.client.HTTPConnection("127.0.0.1", port, timeout=1)
                conn.request("GET", "/api/status", headers={"X-Hermes-Sidecar-Token": token})
                unavailable = conn.getresponse()
                unavailable.read()
                conn.close()
                self.assertEqual(unavailable.status, 503)
            finally:
                proc.terminate()
                try:
                    proc.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=3)
                if proc.stdout is not None:
                    proc.stdout.close()
                if proc.stderr is not None:
                    proc.stderr.close()


if __name__ == "__main__":
    unittest.main()
