"""Regression: a single/group/update op's poll must return ITS OWN outcome even
after a later op starts — never a neighbor's result. Covers the PR #67 review
finding (op B overwriting A's terminal record → A falsely reported as succeeded).

Runnable directly (``python3 test_op_ownership.py``) or via pytest. No docker
needed: we drive ``docker_stats._start_op`` with fake runners.
"""
import os
import tempfile
import threading
import time

# Isolate persisted sidecar state: docker_stats writes `.docker_op_epoch` at import time
# (via _next_process_epoch()). Point HERMES_SYSINFO_STATE_DIR at a temp dir BEFORE
# importing it so this regression never mutates the reviewer's real ~/.hermes/webui.
os.environ.setdefault("HERMES_SYSINFO_STATE_DIR", tempfile.mkdtemp(prefix="sysinfo-op-"))

import docker_stats


class _FakeR:
    def __init__(self, rc=0, out="", err=""):
        self.returncode, self.stdout, self.stderr = rc, out, err


def _run_docker_update(*, workdir, config_files, ps_out, inventory,
                       cid="abc123def456", compose_rc=0, ps_rc=0, digests=None):
    """Drive the REAL docker_update() with a faked docker CLI + inventory, so items
    1 & 2 (replica authorization, compose-file reconstruction, --no-deps) are exercised
    end to end. ``ps_rc`` sets the replica-enumeration exit code. Returns
    (result, compose_calls)."""
    ds = docker_stats
    saved = (ds.subprocess.run, ds.docker_present, ds._inventory_ids,
             ds._image_local_digest, ds._image_version_label, ds.updates_forget)
    compose_calls = []

    def fake_run(argv, **kw):
        sub = argv[1] if len(argv) > 1 else ""
        if sub == "inspect":
            return _FakeR(0, "\t".join(["img:latest", "proj", "svc", workdir, config_files, "/proj-svc-1"]))
        if sub == "ps":
            return _FakeR(ps_rc, ps_out)
        if sub == "compose":
            compose_calls.append(argv)
            return _FakeR(compose_rc, "ok")
        return _FakeR(0, "")

    ds.subprocess.run = fake_run
    ds.docker_present = lambda: True
    ds._inventory_ids = lambda: set(inventory)
    _old_d, _new_d = digests or ("sha256:old", "sha256:new")
    ds._image_local_digest = lambda img: (_new_d if compose_calls else _old_d)
    ds._image_version_label = lambda img: "v1"
    ds.updates_forget = lambda name: None
    try:
        return ds.docker_update(cid), compose_calls
    finally:
        (ds.subprocess.run, ds.docker_present, ds._inventory_ids,
         ds._image_local_digest, ds._image_version_label, ds.updates_forget) = saved


def test_docker_update_reconstructs_compose_files_and_uses_no_deps():
    # PR #67 items 1+2: the recreate passes the recorded -f config files and --no-deps,
    # so a custom compose filename is honored and dependencies/hidden replicas aren't
    # touched.
    d = tempfile.mkdtemp()
    cfg = os.path.join(d, "compose.prod.yml")            # non-default filename
    open(cfg, "w").write("services: {}\n")
    res, calls = _run_docker_update(
        workdir=d, config_files=cfg, ps_out="abc123def456\n", inventory={"abc123def456"})
    assert res.get("ok") is True, res
    pull, up = calls
    assert pull[:3] == [docker_stats._DOCKER, "compose", "-p"] and "-f" in pull and cfg in pull, pull
    assert "-f" in up and cfg in up and "--no-deps" in up and up[-1] == "svc", up


def test_docker_update_rejects_hidden_replica():
    # PR #67 item 1: a replica of the (project, service) that is NOT in the filtered
    # inventory makes the update fail closed — no compose call happens.
    d = tempfile.mkdtemp()
    cfg = os.path.join(d, "docker-compose.yml")
    open(cfg, "w").write("services: {}\n")
    res, calls = _run_docker_update(
        workdir=d, config_files=cfg,
        ps_out="abc123def456\ndeadbeef9999\n",           # 2nd replica is hidden
        inventory={"abc123def456"})
    assert res == {"ok": False, "error": "hidden_replica"}, res
    assert calls == [], "no compose op may run when a replica is hidden"


def test_docker_update_fails_closed_when_compose_config_unrecoverable():
    # PR #67 item 2: no recorded config_files label → refuse rather than guessing the
    # default docker-compose.yml in workdir.
    d = tempfile.mkdtemp()
    res, calls = _run_docker_update(
        workdir=d, config_files="", ps_out="abc123def456\n", inventory={"abc123def456"})
    assert res == {"ok": False, "error": "compose_config_unrecoverable"}, res
    assert calls == []


def test_docker_update_unknown_old_digest_is_not_reported_as_latest():
    # PR #67: when the pre-pull image id is UNKNOWN but the pull succeeds and a valid new
    # digest exists, we must NOT claim "already on the latest image" — equality was never
    # established. Report changed=None (unknown) with an honest note.
    d = tempfile.mkdtemp()
    cfg = os.path.join(d, "docker-compose.yml")
    open(cfg, "w").write("services: {}\n")
    res, calls = _run_docker_update(
        workdir=d, config_files=cfg, ps_out="abc123def456\n", inventory={"abc123def456"},
        digests=(None, "sha256:new1234"))            # old unknown, new valid
    assert res.get("ok") is True, res
    assert calls, "the pull/up must still run"
    assert res.get("changed") is None, f"unknown pre-pull digest must be tri-state None, got {res.get('changed')!r}"
    assert res.get("changed_known") is False, res
    assert "latest" not in (res.get("note") or "").lower(), res.get("note")


def test_docker_update_established_no_change_still_says_latest():
    # Guard the other side: when both digests are known and EQUAL, "already latest" is
    # the correct, honest note (changed=False).
    d = tempfile.mkdtemp()
    cfg = os.path.join(d, "docker-compose.yml")
    open(cfg, "w").write("services: {}\n")
    res, _calls = _run_docker_update(
        workdir=d, config_files=cfg, ps_out="abc123def456\n", inventory={"abc123def456"},
        digests=("sha256:same", "sha256:same"))
    assert res.get("changed") is False and res.get("changed_known") is True, res
    assert "already" in (res.get("note") or "").lower(), res.get("note")


def test_remote_manifest_cache_is_bounded():
    # PR #67: _remote_cache must not grow without bound as image tags churn across sweeps.
    # Writing past the cap evicts (TTL-expired first, then oldest), keeping the newest.
    ds = docker_stats
    saved_max, saved_cache = ds._REMOTE_CACHE_MAX, dict(ds._remote_cache)
    ds._REMOTE_CACHE_MAX = 8
    ds._remote_cache.clear()
    try:
        for i in range(50):
            ds._remote_cache_put(f"img:{i}", 1000.0 + i, "sha256:x", "ok")
        assert len(ds._remote_cache) <= ds._REMOTE_CACHE_MAX, len(ds._remote_cache)
        assert "img:49" in ds._remote_cache, "the most-recent entry must survive eviction"
        assert "img:0" not in ds._remote_cache, "the oldest entry must be evicted"
    finally:
        ds._REMOTE_CACHE_MAX = saved_max
        ds._remote_cache.clear()
        ds._remote_cache.update(saved_cache)


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


def test_inventory_scan_is_bounded():
    # PR #67: the inventory must stop materializing at a bounded working set (not build the
    # full list first) so a host with tens of thousands of containers can't balloon memory.
    ds = docker_stats
    saved = (ds.subprocess.run, ds.docker_present, ds._MAX_SCAN)
    ds._MAX_SCAN = 5

    def fake_run(argv, **kw):
        sub = argv[1] if len(argv) > 1 else ""
        if sub == "info":
            return _FakeR(0, "ok")
        if sub == "stats":
            return _FakeR(0, "")
        if sub == "ps":
            import json as _j
            rows = [_j.dumps({"ID": f"id{i}", "Names": f"c{i}", "Image": "img",
                              "State": "running", "Status": "Up", "Labels": ""})
                    for i in range(50)]
            return _FakeR(0, "\n".join(rows))
        return _FakeR(0, "")

    ds.subprocess.run = fake_run
    ds.docker_present = lambda: True
    old_show = os.environ.get("MC_DOCKER_SHOW_ALL")
    os.environ["MC_DOCKER_SHOW_ALL"] = "1"
    try:
        out = ds._docker_stats_uncached()
    finally:
        ds.subprocess.run, ds.docker_present, ds._MAX_SCAN = saved
        if old_show is None:
            os.environ.pop("MC_DOCKER_SHOW_ALL", None)
        else:
            os.environ["MC_DOCKER_SHOW_ALL"] = old_show
    assert len(out.get("containers", [])) <= 5, out
    assert out.get("truncated") is True, "a scan-capped inventory must report truncated:true"


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


def test_bulk_startup_window_shows_own_state_not_previous():
    # PR #67 startup-window ownership: bulk B's state is initialized ATOMICALLY at
    # id-mint (targets are precomputed BEFORE the reservation, so `total` is real
    # immediately). A poll on B's id must show B's OWN clean state (done=0,
    # results=[], its own total) — never the PREVIOUS bulk A's done/results.
    ds = docker_stats
    orig_targets, orig_update = ds._updatable_targets, ds.docker_update
    try:
        ds._updatable_targets = lambda project=None: [{"id": "c1", "name": "ct", "compose_project": "p"}]
        # Bulk A completes with a FAILED item.
        ds.docker_update = lambda cid: {"ok": False, "error": "boom"}
        a = ds.docker_update_bulk("all")
        a_id = a["id"]
        assert _wait_until(lambda: not ds.docker_update_bulk_status(a_id)["running"]), "bulk A never finished"
        assert any(not r["ok"] for r in ds.docker_update_bulk_status(a_id)["results"]), "A should record a failure"

        # Bulk B: block its WORKER inside the first per-container update — that holds B
        # running with done=0, the moment a stale poll could read A's carried-over data.
        entered = threading.Event()
        release = threading.Event()
        def slow_update(cid):
            entered.set()
            release.wait(5)
            return {"ok": True}
        ds.docker_update = slow_update
        b = ds.docker_update_bulk("all")
        b_id = b["id"]
        assert b_id != a_id
        assert entered.wait(5), "bulk B worker never reached the update"

        # THE REGRESSION: B's poll shows B's OWN startup state, not A's carried-over data.
        bs = ds.docker_update_bulk_status(b_id)
        assert bs["running"] is True and bs["id"] == b_id, bs
        assert bs["done"] == 0 and bs["results"] == [], bs   # not A's done=1 / [failed]
        assert bs["total"] == 1, bs                          # precomputed at id-mint, never 0-then-filled

        release.set()
        assert _wait_until(lambda: not ds.docker_update_bulk_status(b_id)["running"]), "bulk B never finished"
        assert all(r["ok"] for r in ds.docker_update_bulk_status(b_id)["results"]), "B's own success result"
    finally:
        ds._updatable_targets, ds.docker_update = orig_targets, orig_update


def test_bulk_reservation_released_on_enumerate_failure():
    # PR #67 item 3: a malformed persisted state (enumeration raises) must NOT strand
    # the reservation with running:true — it returns a clean error and the next bulk
    # can still start.
    ds = docker_stats
    orig_targets = ds._updatable_targets
    try:
        def boom(project=None):
            raise ValueError("malformed state")
        ds._updatable_targets = boom
        r = ds.docker_update_bulk("all")
        assert r["ok"] is False and "enumerate_failed" in r["error"], r
        with ds._bulk_lock:
            assert ds._bulk_state["running"] is False, ds._bulk_state   # reservation not held
        # a subsequent healthy bulk still starts (nothing to update, but NOT blocked)
        ds._updatable_targets = lambda project=None: []
        r2 = ds.docker_update_bulk("all")
        assert r2["ok"] is True and r2["started"] is False, r2
    finally:
        ds._updatable_targets = orig_targets


def test_updatable_targets_dedupes_by_service():
    # PR #67 item 1: multiple replicas of one (project, service) collapse to a single
    # target — docker_update recreates every replica in one compose call.
    ds = docker_stats
    orig_stats, orig_updates = ds.docker_stats, ds.docker_updates
    try:
        ds.docker_stats = lambda: {"containers": [
            {"id": "a1", "name": "web-1", "compose_project": "p", "compose_service": "web", "image": "img"},
            {"id": "a2", "name": "web-2", "compose_project": "p", "compose_service": "web", "image": "img"},
            {"id": "b1", "name": "db-1", "compose_project": "p", "compose_service": "db", "image": "db"},
        ]}
        ds.docker_updates = lambda refresh=False: {"containers": [
            {"name": "web-1", "update_available": True},
            {"name": "web-2", "update_available": True},
            {"name": "db-1", "update_available": True},
        ]}
        tgt = ds._updatable_targets(None)
        keys = sorted((c["compose_project"], c["compose_service"]) for c in tgt)
        assert keys == [("p", "db"), ("p", "web")], keys   # web collapsed to one
    finally:
        ds.docker_stats, ds.docker_updates = orig_stats, orig_updates


def test_unknown_bulk_id_is_honest():
    s = docker_stats.docker_update_bulk_status(987654)
    assert s["running"] is False and s.get("unknown") is True, s


def test_docker_update_fails_closed_on_replica_enum_error():
    # Finding #1: a non-zero `docker ps` (replica enumeration failed) must NOT be read
    # as "no hidden replicas" — refuse before any pull/up, run no compose op.
    d = tempfile.mkdtemp()
    cfg = os.path.join(d, "docker-compose.yml"); open(cfg, "w").write("services: {}\n")
    res, calls = _run_docker_update(
        workdir=d, config_files=cfg, ps_out="", ps_rc=1, inventory={"abc123def456"})
    assert res == {"ok": False, "error": "replica_enum_failed"}, res
    assert calls == [], "no compose op may run when replica enumeration failed"


def test_docker_update_fails_closed_on_empty_replica_set():
    # Finding #1: a CLEAN `docker ps` that matched no replica must refuse — we can't
    # prove the recreate is scoped to authorized containers, so no blind `up`.
    d = tempfile.mkdtemp()
    cfg = os.path.join(d, "docker-compose.yml"); open(cfg, "w").write("services: {}\n")
    res, calls = _run_docker_update(
        workdir=d, config_files=cfg, ps_out="   \n", ps_rc=0, inventory={"abc123def456"})
    assert res == {"ok": False, "error": "no_replicas"}, res
    assert calls == []


def test_process_epoch_advances_across_same_second_restart():
    # Finding #4: two sidecar starts within the SAME wall-clock second must still get
    # strictly-increasing id bases, so a new op's id can't collide with one an old tab
    # is still polling. We seed a stored epoch >= now (exactly the same-second /
    # clock-not-advanced condition) and verify _next_process_epoch advances past it by
    # the full per-process id headroom each time.
    ds = docker_stats
    d = tempfile.mkdtemp()
    saved_env = os.environ.get("HERMES_SYSINFO_STATE_DIR")
    try:
        os.environ["HERMES_SYSINFO_STATE_DIR"] = d
        future = int(ds._time.time()) + 10_000          # int(time.time()) can't exceed this
        ds._epoch_file().write_text(str(future))
        e1 = ds._next_process_epoch()
        e2 = ds._next_process_epoch()                    # "restart" in the same second
        e3 = ds._next_process_epoch()
        assert e1 == (future + 1) * 100000, e1
        assert e1 < e2 < e3, (e1, e2, e3)
        assert e2 - e1 == 100000 and e3 - e2 == 100000, (e1, e2, e3)
    finally:
        if saved_env is None:
            os.environ.pop("HERMES_SYSINFO_STATE_DIR", None)
        else:
            os.environ["HERMES_SYSINFO_STATE_DIR"] = saved_env


def test_op_reservation_released_on_thread_start_failure():
    # Finding #3: if the op thread fails to start, the single mutation slot must be
    # RELEASED (not stuck running:true forever) and an id-owned terminal failure
    # recorded — so the next mutation can still run.
    ds = docker_stats
    orig_thread = ds._threading_du.Thread

    class _BoomThread:
        def __init__(self, *a, **k):
            pass

        def start(self):
            raise RuntimeError("cant_spawn")

    try:
        ds._threading_du.Thread = _BoomThread
        r = ds._start_op("action", lambda: {"ok": True}, target="ct", action="stop")
        assert r["ok"] is False and "thread_start_failed" in r["error"], r
        jid = r["id"]
        with ds._bulk_lock:
            assert ds._op_state["running"] is False, ds._op_state          # slot released
        st = ds.docker_op_status(jid)
        assert st["running"] is False and st["result"]["ok"] is False, st  # id-owned terminal failure
    finally:
        ds._threading_du.Thread = orig_thread
    # a subsequent op still starts — the slot wasn't wedged
    ok = ds._start_op("action", lambda: {"ok": True}, target="ct2", action="start")
    assert ok["ok"] is True, ok
    assert _wait_until(lambda: not ds.docker_op_status(ok["id"])["running"])


def test_op_retention_exceeds_client_recovery_window():
    # Finding #5: the server MUST retain a terminal record longer than the frontend's
    # poll RECOVERY window — the span _mcPollDockerOp/_mcBulkUpdatePoll keep retrying
    # across *consecutive* transport failures (MAX_FAILS 40 × ~3s ≈ 2 min) before
    # giving up. Otherwise a brief disconnect around completion could age the record
    # out and surface a false "unavailable" while the client is still retrying.
    CLIENT_RECOVERY_WINDOW_S = 40 * 3
    assert docker_stats._OP_RESULTS_TTL > CLIENT_RECOVERY_WINDOW_S, docker_stats._OP_RESULTS_TTL
    # and a finished op's record is actually served by id within the window
    op = docker_stats._start_op("action", lambda: {"ok": True, "n": 1}, target="ct", action="restart")
    oid = op["id"]
    assert _wait_until(lambda: not docker_stats.docker_op_status(oid)["running"])
    assert docker_stats.docker_op_status(oid)["result"] == {"ok": True, "n": 1}


if __name__ == "__main__":
    test_op_poll_returns_own_failure_after_next_op_starts()
    test_unknown_op_id_is_honest()
    test_bulk_poll_returns_own_result_after_next_bulk_starts()
    test_bulk_startup_window_shows_own_state_not_previous()
    test_bulk_reservation_released_on_enumerate_failure()
    test_updatable_targets_dedupes_by_service()
    test_docker_update_reconstructs_compose_files_and_uses_no_deps()
    test_docker_update_rejects_hidden_replica()
    test_docker_update_fails_closed_when_compose_config_unrecoverable()
    test_docker_update_unknown_old_digest_is_not_reported_as_latest()
    test_docker_update_established_no_change_still_says_latest()
    test_remote_manifest_cache_is_bounded()
    test_inventory_scan_is_bounded()
    test_unknown_bulk_id_is_honest()
    test_docker_update_fails_closed_on_replica_enum_error()
    test_docker_update_fails_closed_on_empty_replica_set()
    test_process_epoch_advances_across_same_second_restart()
    test_op_reservation_released_on_thread_start_failure()
    test_op_retention_exceeds_client_recovery_window()
    print("ok — sysinfo op + bulk ownership + host-control regression passed")
