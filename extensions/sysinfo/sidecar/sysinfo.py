#!/usr/bin/env python3
"""System Info sidecar — loopback backend for the sysinfo WebUI extension.

Serves the Insights add-on cards (internet speed test + Docker containers)
that extend the native System-health panel. The WebUI proxies
/api/extensions/sysinfo/sidecar/<path> here after user consent.

Routes (paths kept identical to the original in-core versions so the
frontend port stays mechanical):
  GET/POST /api/system/speedtest          last reading / run a fresh test
  GET/POST /api/system/speedtest/auto     auto-schedule config (+ daemon)
  GET      /api/system/docker             docker inventory + live stats
  GET/POST /api/system/docker/groups      custom stack/container display names
  POST     /api/system/docker/action      start/stop/restart one container
  POST     /api/system/docker/group-action  same for a whole compose stack
  POST     /api/system/docker/update      pull+recreate one compose service
  GET/POST /api/system/docker/update-bulk bulk update status / start
  GET      /api/system/docker/updates     image-update availability (?refresh=1)
  GET      /health

Stdlib-only. Speed test shells out to `speedtest-cli` (or `speedtest`);
docker features shell out to the docker CLI (absolute-path resolved).
Listens on 127.0.0.1:$HERMES_SYSINFO_SIDECAR_PORT (default 17796).
"""
from __future__ import annotations

import gzip
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from datetime import datetime
from pathlib import Path
# The HTTP server + token guard come from the canonical scaffold (sidecar_base.py);
# routes live in routes_impl.py. This module is pure speed-test/Docker logic.

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import docker_stats  # noqa: E402  (standalone copy of the docker collector)

PORT = int(os.environ.get("HERMES_SYSINFO_SIDECAR_PORT", "17796"))
STATE_DIR = Path(
    os.environ.get("HERMES_SYSINFO_STATE_DIR")
    or os.environ.get("HERMES_WEBUI_STATE_DIR")
    or (Path.home() / ".hermes" / "webui")
)




# ── Speed test ───────────────────────────────────────────────────────────────
def _speedtest_exe() -> str | None:
    exe = shutil.which("speedtest-cli") or shutil.which("speedtest") \
        or os.path.expanduser("~/.local/bin/speedtest-cli")
    return exe if exe and os.path.exists(exe) else None


def _run_speedtest_once() -> dict | None:
    """Run speedtest-cli, persist to speedtest_last.json, return result or None."""
    exe = _speedtest_exe()
    if not exe:
        return None
    try:
        proc = subprocess.run([exe, "--json", "--secure"], capture_output=True,
                              text=True, timeout=120)
        if proc.returncode != 0:
            return None
        raw = json.loads(proc.stdout)
    except Exception:
        return None
    srv = raw.get("server") or {}
    result = {
        "download_mbps": round(float(raw.get("download", 0) or 0) / 1e6, 1),
        "upload_mbps": round(float(raw.get("upload", 0) or 0) / 1e6, 1),
        "ping_ms": round(float(raw.get("ping", 0) or 0), 1),
        "server": (srv.get("sponsor") or srv.get("name") or ""),
        "tested_at": int(time.time()),
    }
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        (STATE_DIR / "speedtest_last.json").write_text(json.dumps(result))
    except Exception:
        pass
    return result


# ── Manual speed test: background-job + poll ────────────────────────────────
# A run takes ~15-40s, which is longer than the core sidecar-proxy's hard 10s
# timeout — a synchronous POST always 502s at the proxy even though the sidecar
# finishes fine. So POST kicks off a background run and returns immediately
# (202); the UI then polls GET until {running:false} and reads the result.
_st_run_lock = threading.Lock()
_st_run_thread: "threading.Thread | None" = None
_st_running = False
_st_started_at = 0.0
_st_last_error = ""


def _st_run_bg() -> None:
    global _st_running, _st_last_error
    try:
        r = _run_speedtest_once()
        _st_last_error = "" if r else "speedtest failed or timed out"
    except Exception as e:  # pragma: no cover - defensive
        _st_last_error = str(e) or "speedtest error"
    finally:
        _st_running = False


def _start_speedtest() -> bool:
    """The SOLE place a background speed-test run is reserved + spawned. Flips
    _st_running True and starts the worker atomically under _st_run_lock, so a
    manual POST and the auto-scheduler can never double-start (two concurrent
    speedtests contend for the link and corrupt each other's readings). Returns
    True if this call started the run, False if one was already in flight."""
    global _st_run_thread, _st_running, _st_started_at, _st_last_error
    with _st_run_lock:
        if _st_running:
            return False
        _st_running = True
        _st_started_at = time.time()
        _st_last_error = ""
        _st_run_thread = threading.Thread(target=_st_run_bg,
                                          name="sysinfo-speedtest-run", daemon=True)
        _st_run_thread.start()
        return True


def handle_speedtest(method: str):
    """GET → last reading + {running, error}; POST → kick off a background run and
    return 202 immediately (the proxy's ~10s cap makes the job+poll shape
    mandatory). Returns (payload, status)."""
    global _st_run_thread, _st_running, _st_started_at, _st_last_error
    last_path = STATE_DIR / "speedtest_last.json"

    def _last() -> dict:
        try:
            return json.loads(last_path.read_text()) if last_path.is_file() else {}
        except Exception:
            return {}

    if method == "GET":
        out = _last()
        out["running"] = _st_running
        if _st_running:
            out["started_at"] = int(_st_started_at)
        elif _st_last_error:
            out["error"] = _st_last_error
        return out, 200

    # POST = kick off a fresh run (idempotent while one is already running)
    if not _speedtest_exe():
        return {"error": "speedtest-cli not installed"}, 503
    _start_speedtest()  # no-op if one is already in flight; single source of truth
    return {"running": True, "started_at": int(_st_started_at)}, 202


# ── Speed-test auto-schedule (daemon thread) ────────────────────────────────
_st_auto_thread: threading.Thread | None = None
_st_auto_lock = threading.Lock()
_st_auto_stop = threading.Event()
_st_auto_last_run = 0.0
_st_auto_last_daily = ""


def _st_auto_read() -> dict:
    try:
        p = STATE_DIR / "speedtest_auto.json"
        d = json.loads(p.read_text()) if p.is_file() else {}
    except Exception:
        d = {}
    return {"interval_minutes": int(d.get("interval_minutes") or 0),
            "at_time": str(d.get("at_time") or "")}


def _st_auto_loop() -> None:
    global _st_auto_last_run, _st_auto_last_daily
    # seed last-run from the persisted last reading so a restart doesn't re-fire
    try:
        lp = STATE_DIR / "speedtest_last.json"
        if lp.is_file():
            _st_auto_last_run = float(json.loads(lp.read_text()).get("tested_at") or 0)
    except Exception:
        pass
    while not _st_auto_stop.wait(60):
        try:
            cfg = _st_auto_read()
            iv, at = cfg["interval_minutes"], cfg["at_time"]
            now = time.time()
            due = False
            if iv > 0:
                if not _st_auto_last_run or (now - _st_auto_last_run) >= iv * 60:
                    due = True
            elif at:
                today = datetime.now().strftime("%Y-%m-%d")
                if datetime.now().strftime("%H:%M") == at and _st_auto_last_daily != today:
                    due = True
                    _st_auto_last_daily = today
            if not due:
                continue
            # Go through the one locked starter — never call _run_speedtest_once
            # directly here, or an auto-fire could race a manual POST into two
            # concurrent runs. If a run is already in flight, skip this tick.
            if not _start_speedtest():
                continue
            print(f"[sysinfo/speedtest-auto] firing (interval={iv}m at={at or '-'})", flush=True)
            _st_auto_last_run = time.time()  # anchor to start; the bg worker persists the reading
        except Exception:
            pass


def _ensure_st_auto_thread() -> None:
    global _st_auto_thread
    with _st_auto_lock:
        if _st_auto_thread is not None and _st_auto_thread.is_alive():
            return
        _st_auto_thread = threading.Thread(target=_st_auto_loop,
                                           name="sysinfo-speedtest-auto", daemon=True)
        _st_auto_thread.start()


def handle_speedtest_auto(method: str, body: dict | None = None):
    """GET the auto-schedule config; POST sets {interval_minutes, at_time:'HH:MM'}.
    Returns (payload, status)."""
    _ensure_st_auto_thread()
    if method == "GET":
        return _st_auto_read(), 200
    b = body or {}
    try:
        iv = max(0, int(b.get("interval_minutes") or 0))
    except Exception:
        iv = 0
    at = str(b.get("at_time") or "").strip()
    if at and not re.match(r"^([01]\d|2[0-3]):[0-5]\d$", at):
        at = ""
    if iv > 0:
        at = ""   # interval mode takes precedence if both supplied
    cfg = {"interval_minutes": iv, "at_time": at}
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        (STATE_DIR / "speedtest_auto.json").write_text(json.dumps(cfg))
    except Exception as e:
        return {"error": str(e)}, 500
    return cfg, 200


# ── Docker display-name overrides (persisted server-side) ──────────────────
def _docker_groups_file() -> Path:
    return STATE_DIR / ".docker_groups.json"


def _load_docker_groups() -> dict:
    def _clean(m):
        return {str(k): str(v) for k, v in m.items()
                if isinstance(v, str) and v} if isinstance(m, dict) else {}
    f = _docker_groups_file()
    try:
        if f.is_file():
            data = json.loads(f.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                if "renames" in data or "containers" in data:
                    return {"renames": _clean(data.get("renames")),
                            "containers": _clean(data.get("containers"))}
                return {"renames": _clean(data), "containers": {}}  # legacy flat
    except Exception:
        pass
    return {"renames": {}, "containers": {}}


def _save_docker_groups(data: dict) -> None:
    import tempfile
    f = _docker_groups_file()
    f.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(f.parent), suffix=".docker_groups.tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh)
        os.replace(tmp, str(f))
    except Exception:
        try:
            os.unlink(tmp)
        except Exception:
            pass
        raise


def handle_docker_groups(method: str, body: dict | None = None):
    """GET → {renames:{project:label}, containers:{name:label}}. POST renames a
    stack ({project,name}) or a container ({container,name}); empty name clears.
    Returns (payload, status)."""
    data = _load_docker_groups()
    inv = docker_stats.docker_stats().get("containers", []) if docker_stats.docker_present() else []
    inv_names = {c.get("name") for c in inv}
    inv_projects = {c.get("compose_project") for c in inv if c.get("compose_project")}

    # Prune stale rename entries (containers/stacks no longer in the filtered
    # inventory) so the map can't grow without bound on a churn-heavy host. Guard
    # against a TRANSIENT-empty inventory (docker down / nothing matched) wiping
    # the user's labels: only prune when we actually see containers. Also hard-cap
    # each map defensively.
    if inv:
        before = (len(data.get("renames", {})), len(data.get("containers", {})))
        data["renames"] = {k: v for k, v in data.get("renames", {}).items() if k in inv_projects}
        data["containers"] = {k: v for k, v in data.get("containers", {}).items() if k in inv_names}
        if (len(data["renames"]), len(data["containers"])) != before:
            try:
                _save_docker_groups(data)
            except Exception:
                pass
    data["renames"] = dict(list(data.get("renames", {}).items())[:500])
    data["containers"] = dict(list(data.get("containers", {}).items())[:500])

    if method == "GET":
        return data, 200
    body = body or {}
    name = str(body.get("name") or "").strip()[:64]
    # Bound renames to the real inventory so the store can't be spammed with
    # entries for containers/projects that don't exist. (Clearing a rename —
    # empty name — is always allowed so stale entries can be removed.)
    if body.get("container") is not None:
        key, bucket = str(body.get("container") or "").strip()[:128], "containers"
        if name and key not in inv_names:
            return {"error": "unknown container"}, 400
    elif body.get("project") is not None:
        key, bucket = str(body.get("project") or "").strip()[:128], "renames"
        if name and key not in inv_projects:
            return {"error": "unknown project"}, 400
    else:
        return {"error": "project or container is required"}, 400
    if not key:
        return {"error": "key is required"}, 400
    if name:
        data[bucket][key] = name
    else:
        data[bucket].pop(key, None)
    try:
        _save_docker_groups(data)
    except Exception as exc:
        return {"error": f"could not save: {exc}"}, 500
    return data, 200
