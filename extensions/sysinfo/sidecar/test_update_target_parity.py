"""Regression: the bulk "Update stacks" target set, its header count, and its label
must all describe the SAME set — compose-managed containers with an image update.
Standalone (`docker run`) containers are surfaced informationally but are never counted
in the pill nor offered an in-app update.

Covers the PR #67 maintainer findings: (a) header/action target parity — the pill
counted every update_available including standalone images the bulk path skips; and
(b) the "Ungrouped" bucket rendered a stack-update button that posted scope:stack with
an empty project → missing_project.

Runnable directly (``python3 test_update_target_parity.py``) or via pytest. No docker
needed. Hermetic: a temp state dir is set BEFORE importing docker_stats so the module's
epoch-file init never writes the reviewer's real Hermes state dir.
"""
import os
import tempfile
from pathlib import Path

_TMP_STATE = tempfile.mkdtemp(prefix="sysinfo-parity-")
os.environ["HERMES_SYSINFO_STATE_DIR"] = _TMP_STATE  # before the import below

import docker_stats  # noqa: E402

ASSETS_JS = Path(__file__).resolve().parents[1] / "assets" / "sysinfo.js"


def test_import_did_not_touch_default_state_dir():
    """The epoch file must land in our temp dir, not the real ~/.hermes/webui."""
    # Our temp dir got the epoch file (module import advances the epoch)...
    assert (Path(_TMP_STATE) / ".docker_op_epoch").exists()
    # ...and _next_process_epoch honors an explicit state dir WITHOUT ever writing the
    # platform default. Prove it with a real, controlled oracle: point HOME + the
    # platform-default env vars at a throwaway sandbox, resolve where the default epoch
    # file WOULD be, confirm it is absent, run the epoch writer with the state-dir env
    # set, and assert the default path is STILL absent (only the env dir got written).
    import os as _os
    sandbox_home = tempfile.mkdtemp(prefix="sysinfo-fakehome-")
    default_epoch = Path(sandbox_home) / ".hermes" / "webui" / ".docker_op_epoch"
    saved = {k: _os.environ.get(k) for k in
             ("HERMES_SYSINFO_STATE_DIR", "HERMES_WEBUI_STATE_DIR", "HERMES_HOME",
              "HOME", "LOCALAPPDATA")}
    explicit = tempfile.mkdtemp(prefix="sysinfo-explicit-")
    try:
        _os.environ["HOME"] = sandbox_home
        _os.environ["LOCALAPPDATA"] = sandbox_home  # win32 default branch, harmless elsewhere
        _os.environ.pop("HERMES_WEBUI_STATE_DIR", None)
        _os.environ.pop("HERMES_HOME", None)
        assert not default_epoch.exists(), "sandbox default epoch must start absent"
        _os.environ["HERMES_SYSINFO_STATE_DIR"] = explicit
        docker_stats._next_process_epoch()
        assert (Path(explicit) / ".docker_op_epoch").exists(), "explicit state dir must get the epoch"
        assert not default_epoch.exists(), \
            "the platform default epoch file must NEVER be written when a state dir is set"
    finally:
        for k, v in saved.items():
            if v is None:
                _os.environ.pop(k, None)
            else:
                _os.environ[k] = v


def _with_fake_inventory(inv, upd, fn):
    saved = (docker_stats.docker_stats, docker_stats.docker_updates)
    try:
        docker_stats.docker_stats = lambda *a, **k: {"containers": inv}
        docker_stats.docker_updates = lambda *a, **k: {"containers": upd}
        return fn()
    finally:
        docker_stats.docker_stats, docker_stats.docker_updates = saved


def test_updatable_targets_excludes_standalone():
    inv = [
        {"name": "web", "id": "c1", "compose_project": "app", "compose_service": "web"},
        {"name": "db", "id": "c2", "compose_project": "app", "compose_service": "db"},
        {"name": "mem0", "id": "c3", "compose_project": "", "compose_service": ""},  # docker run
    ]
    upd = [
        {"name": "web", "update_available": True, "compose_project": "app", "compose_service": "web"},
        {"name": "db", "update_available": False, "compose_project": "app", "compose_service": "db"},
        {"name": "mem0", "update_available": True, "compose_project": "", "compose_service": ""},
    ]
    targets = _with_fake_inventory(inv, upd, lambda: docker_stats._updatable_targets(None))
    names = sorted(t["name"] for t in targets)
    # only the compose-managed container WITH an update — not db (no update), not mem0 (standalone)
    assert names == ["web"], f"bulk must target only updatable compose containers, got {names}"


def test_frontend_count_label_and_action_agree_on_compose_set():
    js = ASSETS_JS.read_text(encoding="utf-8")
    # actionable count filters to compose_service (the same set the bulk path updates)
    assert "function _mcDockerStackUpdates()" in js
    assert "u.update_available && u.compose_service" in js
    assert "_mcDockerStackUpdates().length" in js
    # the pill label describes stacks, not "all"
    assert "Update stacks (${n})" in js
    # the "Ungrouped" bucket (isStack false) gets a non-actionable manual badge, no button
    assert "group-upd--manual" in js
    # mcDockerUpdateStack refuses an empty project (the missing_project guard)
    assert "if (!project) {" in js
    # standalone per-row rows still expose no in-app update action
    assert "(upd && upd.compose_service) && hasUpdate" in js


if __name__ == "__main__":
    test_import_did_not_touch_default_state_dir()
    test_updatable_targets_excludes_standalone()
    test_frontend_count_label_and_action_agree_on_compose_set()
    print("ok - update target parity")
