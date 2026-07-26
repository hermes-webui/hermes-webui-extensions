"""Regression: a single/group/update op's poll must return ITS OWN outcome even
after a later op starts — never a neighbor's result. Covers the PR #67 review
finding (op B overwriting A's terminal record → A falsely reported as succeeded).

Runnable directly (``python3 test_op_ownership.py``) or via pytest. No docker
needed: we drive ``docker_stats._start_op`` with fake runners.
"""
import threading
import time

import docker_stats


def _wait_until(pred, timeout=5.0):
    end = time.time() + timeout
    while time.time() < end:
        if pred():
            return True
        time.sleep(0.01)
    return False


def test_op_poll_returns_own_failure_after_next_op_starts():
    # Op A fails.
    a = docker_stats._start_op("action", lambda: {"ok": False, "error": "boom"},
                               target="ct-a", action="stop")
    assert a.get("ok") and a.get("id"), a
    a_id = a["id"]
    # Wait for A to finish (its worker records the terminal result).
    assert _wait_until(lambda: not docker_stats.docker_op_status(a_id)["running"]), "A never finished"

    # Op B starts and stays running (blocked on an event) — this is the moment that
    # used to clobber A's record and make A's poll read B's state as A's success.
    release = threading.Event()
    b = docker_stats._start_op("action", lambda: (release.wait(5), {"ok": True})[1],
                               target="ct-b", action="start")
    assert b.get("ok") and b.get("id"), b
    b_id = b["id"]
    assert b_id != a_id
    assert _wait_until(lambda: docker_stats.docker_op_status(b_id)["running"]), "B never started"

    # THE REGRESSION: A's poll must still return A's own failure, not B's success.
    a_status = docker_stats.docker_op_status(a_id)
    assert a_status["running"] is False, a_status
    assert a_status["id"] == a_id, a_status
    assert a_status["result"] == {"ok": False, "error": "boom"}, a_status

    # And B's own poll is honestly still running (no result yet).
    assert docker_stats.docker_op_status(b_id)["running"] is True

    release.set()
    assert _wait_until(lambda: not docker_stats.docker_op_status(b_id)["running"]), "B never finished"
    assert docker_stats.docker_op_status(b_id)["result"] == {"ok": True}


def test_unknown_op_id_is_honest():
    # An id that never ran (or has aged out) reports unknown — never a fabricated
    # success. The frontend surfaces this as an error, not a silent {ok:true}.
    s = docker_stats.docker_op_status(999999)
    assert s["running"] is False and s.get("unknown") is True, s


def test_bulk_poll_returns_own_result_after_next_bulk_starts():
    # Same ownership guarantee for the BULK path (PR #67 review): bulk A's poll must
    # return A's own outcome even after bulk B starts — never B's running/success.
    # No docker needed: fake the target list + per-container update.
    ds = docker_stats
    orig_targets, orig_update = ds._updatable_targets, ds.docker_update
    try:
        ds._updatable_targets = lambda project=None: [{"id": "c1", "name": "ct", "compose_project": "p"}]
        # Bulk A: its one target's update FAILS.
        ds.docker_update = lambda cid: {"ok": False, "error": "boom"}
        a = ds.docker_update_bulk("all")
        assert a.get("ok") and a.get("id"), a
        a_id = a["id"]
        assert _wait_until(lambda: not ds.docker_update_bulk_status(a_id)["running"]), "bulk A never finished"
        a_done = ds.docker_update_bulk_status(a_id)
        assert a_done["running"] is False and a_done["id"] == a_id, a_done
        assert any(not r["ok"] for r in a_done["results"]), a_done   # A recorded a failed item

        # Bulk B starts and stays running (its update blocks on an event) — the moment
        # that used to clobber A's global state and make A's poll read B's as its own.
        release = threading.Event()
        ds.docker_update = lambda cid: (release.wait(5), {"ok": True})[1]
        b = ds.docker_update_bulk("all")
        assert b.get("ok") and b.get("id"), b
        b_id = b["id"]
        assert b_id != a_id
        assert _wait_until(lambda: ds.docker_update_bulk_status(b_id)["running"]), "bulk B never started"

        # THE REGRESSION: A's poll must still return A's OWN failure, not B's running/success.
        a2 = ds.docker_update_bulk_status(a_id)
        assert a2["running"] is False and a2["id"] == a_id, a2
        assert any(not r["ok"] for r in a2["results"]), a2

        release.set()
        assert _wait_until(lambda: not ds.docker_update_bulk_status(b_id)["running"]), "bulk B never finished"
        assert all(r["ok"] for r in ds.docker_update_bulk_status(b_id)["results"])
    finally:
        ds._updatable_targets, ds.docker_update = orig_targets, orig_update


def test_unknown_bulk_id_is_honest():
    s = docker_stats.docker_update_bulk_status(987654)
    assert s["running"] is False and s.get("unknown") is True, s


if __name__ == "__main__":
    test_op_poll_returns_own_failure_after_next_op_starts()
    test_unknown_op_id_is_honest()
    test_bulk_poll_returns_own_result_after_next_bulk_starts()
    test_unknown_bulk_id_is_honest()
    print("ok — sysinfo op + bulk ownership regression passed")
