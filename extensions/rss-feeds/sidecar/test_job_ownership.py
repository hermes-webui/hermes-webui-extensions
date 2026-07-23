"""Regression: a background job's poll must return ITS OWN outcome even after a
later job starts — never a neighbor's result. Covers the PR #64 review finding
(job B overwriting A's terminal record → the UI rendering B's status as A's), for
BOTH the refresh job and the summary-model Test job.

Runnable directly (``python3 test_job_ownership.py``) or via pytest. No network/DB:
we monkeypatch the work functions with fakes.
"""
import threading
import time

import feeds


def _wait_until(pred, timeout=5.0):
    end = time.time() + timeout
    while time.time() < end:
        if pred():
            return True
        time.sleep(0.01)
    return False


def test_refresh_poll_returns_own_failure_after_next_job_starts():
    orig = feeds.refresh_all
    try:
        # Job A fails.
        feeds.refresh_all = lambda only_ids=None, progress_cb=None: (_ for _ in ()).throw(RuntimeError("boom"))
        a = feeds.start_refresh(None)
        a_id = a["id"]
        assert _wait_until(lambda: not feeds.refresh_status(a_id)["running"]), "A never finished"

        # Job B starts and blocks (stays running) — the moment that used to clobber A.
        release = threading.Event()
        feeds.refresh_all = lambda only_ids=None, progress_cb=None: (release.wait(5), [])[1]
        b = feeds.start_refresh(None)
        b_id = b["id"]
        assert b_id != a_id
        assert _wait_until(lambda: feeds.refresh_status(b_id)["running"]), "B never started"

        # THE REGRESSION: A's poll still reports A's own failure, not B's state.
        a_status = feeds.refresh_status(a_id)
        assert a_status["running"] is False and a_status["id"] == a_id, a_status
        assert a_status.get("error", "").startswith("RuntimeError"), a_status
        assert feeds.refresh_status(b_id)["running"] is True

        release.set()
        assert _wait_until(lambda: not feeds.refresh_status(b_id)["running"]), "B never finished"
    finally:
        feeds.refresh_all = orig

    # Unknown id is honest — never a fabricated success.
    assert feeds.refresh_status(999999).get("unknown") is True


def test_summary_test_poll_returns_own_result_after_next_job_starts():
    orig = feeds._summarize_llm
    try:
        feeds._summarize_llm = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("model down"))
        a = feeds.start_summary_test()
        a_id = a["id"]
        assert _wait_until(lambda: not feeds.summary_test_status(a_id)["running"]), "A never finished"

        release = threading.Event()
        feeds._summarize_llm = lambda *a, **k: (release.wait(5), ("OK", "fake-model"))[1]
        b = feeds.start_summary_test()
        b_id = b["id"]
        assert b_id != a_id
        assert _wait_until(lambda: feeds.summary_test_status(b_id)["running"]), "B never started"

        a_status = feeds.summary_test_status(a_id)
        assert a_status["running"] is False and a_status["id"] == a_id, a_status
        assert a_status.get("ok") is False and "model down" in a_status.get("error", ""), a_status

        release.set()
        assert _wait_until(lambda: not feeds.summary_test_status(b_id)["running"]), "B never finished"
        assert feeds.summary_test_status(b_id).get("ok") is True
    finally:
        feeds._summarize_llm = orig

    assert feeds.summary_test_status(999999).get("unknown") is True


if __name__ == "__main__":
    test_refresh_poll_returns_own_failure_after_next_job_starts()
    test_summary_test_poll_returns_own_result_after_next_job_starts()
    print("ok — rss-feeds job-ownership regression passed")
