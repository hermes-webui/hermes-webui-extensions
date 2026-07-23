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


if __name__ == "__main__":
    test_op_poll_returns_own_failure_after_next_op_starts()
    test_unknown_op_id_is_honest()
    print("ok — sysinfo op-ownership regression passed")
