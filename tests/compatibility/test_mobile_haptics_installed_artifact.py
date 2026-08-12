"""Regression coverage for the production mobile-haptics install artifact."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path
from urllib.parse import urlsplit


REPO_ROOT = Path(__file__).resolve().parents[2]


class MobileHapticsInstalledArtifactTest(unittest.TestCase):
    """Exercise registry generation, Core installation, and runtime metadata."""

    def _core_root(self) -> Path:
        configured = os.environ.get("HERMES_CORE_DIR")
        if configured:
            return Path(configured).expanduser().resolve()
        return (REPO_ROOT / ".ci" / "hermes-webui-core").resolve()

    def test_production_artifact_install_exposes_haptics_setting(self) -> None:
        core_root = self._core_root()
        if not (core_root / "api" / "extensions.py").is_file():
            self.skipTest(f"Hermes WebUI Core checkout is unavailable: {core_root}")

        with tempfile.TemporaryDirectory(prefix="hermes-mobile-haptics-compat-") as temp:
            temp_root = Path(temp)
            registry_path = temp_root / "registry.json"
            generate = subprocess.run(
                [
                    "node",
                    str(REPO_ROOT / "scripts" / "generate-registry.mjs"),
                    "--out",
                    str(registry_path),
                ],
                cwd=REPO_ROOT,
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(
                generate.returncode,
                0,
                msg=f"generate-registry failed\nstdout:\n{generate.stdout}\nstderr:\n{generate.stderr}",
            )

            registry = json.loads(registry_path.read_text(encoding="utf-8"))
            mobile_haptics = next(
                entry for entry in registry["extensions"] if entry["id"] == "mobile-haptics"
            )
            download_url = mobile_haptics["download"]
            artifact_name = Path(urlsplit(download_url).path).name
            artifact_path = registry_path.parent / "artifacts" / artifact_name
            self.assertTrue(artifact_path.is_file(), artifact_path)

            extension_dir = temp_root / "installed-extensions"
            extension_dir.mkdir()
            state_dir = temp_root / "webui-state"
            state_dir.mkdir()
            hermes_home = temp_root / "hermes-home"
            hermes_home.mkdir()

            child_env = {
                key: value
                for key, value in os.environ.items()
                if not key.startswith("HERMES_")
            }
            child_env.update(
                {
                    "HERMES_HOME": str(hermes_home),
                    "HERMES_WEBUI_EXTENSION_DIR": str(extension_dir),
                    "HERMES_WEBUI_STATE_DIR": str(state_dir),
                    "HOME": str(hermes_home),
                    "PYTHONNOUSERSITE": "1",
                }
            )
            child_code = textwrap.dedent(
                """
                import json
                import sys
                from pathlib import Path

                core_root = Path(sys.argv[1]).resolve()
                artifact_path = Path(sys.argv[2]).resolve()
                download_url = sys.argv[3]
                sha256 = sys.argv[4]
                sys.path.insert(0, str(core_root))

                import api.extensions as extensions

                artifact_bytes = artifact_path.read_bytes()
                extensions._safe_download = lambda *args, **kwargs: artifact_bytes
                installed = extensions.install_extension("mobile-haptics", download_url, sha256)
                config = extensions.get_extension_config()
                print("RESULT=" + json.dumps({"installed": installed, "config": config}))
                """
            )
            core_run = subprocess.run(
                [
                    sys.executable,
                    "-c",
                    child_code,
                    str(core_root),
                    str(artifact_path),
                    download_url,
                    mobile_haptics["sha256"],
                ],
                cwd=core_root,
                env=child_env,
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(
                core_run.returncode,
                0,
                msg=f"Core install subprocess failed\nstdout:\n{core_run.stdout}\nstderr:\n{core_run.stderr}",
            )
            result_lines = [
                line.removeprefix("RESULT=")
                for line in core_run.stdout.splitlines()
                if line.startswith("RESULT=")
            ]
            self.assertEqual(len(result_lines), 1, core_run.stdout)
            result = json.loads(result_lines[0])

            self.assertTrue(result["installed"]["installed"])
            runtime_entry = next(
                entry
                for entry in result["config"]["extensions"]
                if entry["id"] == "mobile-haptics"
            )
            self.assertIs(runtime_entry["storage_owned"], True)
            self.assertEqual(len(runtime_entry["settings_schema"]), 1)
            setting = runtime_entry["settings_schema"][0]
            self.assertEqual(setting["key"], "enabled")
            self.assertEqual(setting["type"], "boolean")
            self.assertEqual(setting["label"], "Vibrate when a turn finishes")
            self.assertIs(setting["default"], True)


if __name__ == "__main__":
    unittest.main()
