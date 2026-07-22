"""Docker container stats collector for the system-health panel.

Kept in a separate module so the sysinfo sidecar remains free of
``import subprocess`` (enforced by the original webui test-suite).

This collector runs ``docker info`` to confirm the daemon is reachable,
``docker stats --no-stream --format '{{json .}}'`` for live metrics on
running containers, and ``docker ps -a --format '{{json .}}'`` for the
full inventory (running + stopped) so the UI can render a status dot
for each. Only the JSON keys we care about are returned; no command
lines, environment variables, mounts, or PIDs are forwarded to the
browser.

**Absolute path discipline.** Same lesson as _system_health_macos.py:
the WebUI launchd PATH may not include the docker binary's location
(Docker Desktop / OrbStack / Colima install at ``/usr/local/bin/docker``;
Homebrew installs at ``/opt/homebrew/bin/docker``). Resolved once at
module import via shutil.which with fallbacks so subprocess.run gets
an absolute path regardless of what PATH the WebUI was started under.
"""

from __future__ import annotations

import json as _json
import os
import re as _re
import shutil
import subprocess
import threading as _threading
import time as _time
from typing import Any


def _resolve_docker() -> str:
    """Best-effort absolute path for the docker CLI. Returns 'docker' as a
    last resort so the failure mode matches the pre-fix behavior."""
    found = shutil.which("docker")
    if found:
        return found
    for candidate in (
        "/usr/local/bin/docker",     # Docker Desktop, OrbStack, Colima default
        "/opt/homebrew/bin/docker",  # Homebrew on Apple Silicon
        "/usr/bin/docker",
    ):
        if os.path.isfile(candidate):
            return candidate
    return "docker"


_DOCKER = _resolve_docker()


def docker_present() -> bool:
    """True when docker CLI exists on disk (path resolved at import)."""
    return _DOCKER != "docker" or shutil.which("docker") is not None


def _path_within(child: str, root: str) -> bool:
    """True if `child` is `root` or a descendant, using a real path-boundary
    check (os.path.commonpath) — NOT str.startswith, which would wrongly treat
    ``/opt/stack-evil`` as inside ``/opt/stack``. Both are normalized first so
    ``..`` segments can't escape. Returns False on any malformed input."""
    if not child or not root:
        return False
    try:
        child_n = os.path.normpath(os.path.realpath(child))
        root_n = os.path.normpath(os.path.realpath(root))
        return os.path.commonpath([child_n, root_n]) == root_n
    except (ValueError, OSError):
        return False


def _allowlist_configured() -> bool:
    """True when the operator has opted in via any of the three knobs — so the UI
    can show a 'configure an allowlist' hint on an empty inventory rather than a
    bare empty card."""
    return bool(
        os.environ.get("MC_DOCKER_SHOW_ALL", "").strip() == "1"
        or os.environ.get("MC_DOCKER_NAME_ALLOW", "").strip()
        or os.environ.get("MC_DOCKER_WORKDIR_PREFIX", "").strip()
    )


def _docker_allow(name: str | None, labels: str | None) -> bool:
    """Filter the System Health container list to the stacks the OPERATOR opts in.

    DENY-BY-DEFAULT: with nothing configured, no container is shown (the card
    renders a "configure an allowlist" message). This is a host-control surface,
    so it must not ship a curated allowlist of anyone's specific stack. Include a
    container only when the operator has configured one of:
      - ``MC_DOCKER_SHOW_ALL=1`` — show every container, or
      - ``MC_DOCKER_NAME_ALLOW`` — comma-separated name prefixes to include, or
      - ``MC_DOCKER_WORKDIR_PREFIX`` — a compose working_dir root to include under.
    """
    import os
    if os.environ.get("MC_DOCKER_SHOW_ALL", "").strip() == "1":
        return True
    prefix = os.environ.get("MC_DOCKER_WORKDIR_PREFIX", "").strip()
    allow = [a.strip().lower() for a in os.environ.get(
        "MC_DOCKER_NAME_ALLOW", "").split(",") if a.strip()]
    if not prefix and not allow:
        return False  # nothing configured → deny all (opt-in required)
    if prefix:
        for kv in (labels or "").split(","):
            if kv.startswith("com.docker.compose.project.working_dir="):
                if _path_within(kv.split("=", 1)[1], prefix):
                    return True
                break
    # case-insensitive: real names are mixed-case (Cybersec-Toolkit, SEARXNG, FreqTrade)
    nm = (name or "").lower()
    return any(nm == a or nm.startswith(a) for a in allow)


# Short TTL cache: the system-health card polls every ~2s (SSE), but the three
# docker subprocesses (info + stats --no-stream + ps -a) cost ~1.5-2s and
# container metrics barely move between polls. Serve a cached snapshot so most
# polls return instantly; only one poll per TTL pays the subprocess cost.
_STATS_TTL = float(os.environ.get("MC_DOCKER_STATS_TTL", "5") or 5)
_stats_cache: dict[str, Any] = {"ts": 0.0, "data": None}
_stats_lock = _threading.Lock()  # single-flight the cache refresh across concurrent SSE polls


_LABEL_UNSAFE = _re.compile(r"[^A-Za-z0-9_.\-]")


def _clean_label(s: str | None) -> str:
    """Strip anything outside docker's own name charset before a name/project/
    service reaches the client. Docker already constrains these, so this is a
    no-op for legit values — but it guarantees no quote/angle-bracket can smuggle
    an inline-handler/HTML breakout into the UI, regardless of how the label was
    set. Defence-in-depth alongside the frontend's DOM/opaque-index handlers."""
    return _LABEL_UNSAFE.sub("", str(s or ""))[:128]


def _compose_meta(labels: str | None) -> tuple[str, str]:
    """Extract (compose_project, compose_service) from a container's label string.

    `docker ps --format '{{json .}}'` returns Labels as a comma-joined `k=v`
    string. Compose stamps `com.docker.compose.project` / `.service`; plain
    `docker run` containers carry neither, so they return ("", "") and the UI
    groups them under a generic bucket.
    """
    project = service = ""
    for kv in (labels or "").split(","):
        if kv.startswith("com.docker.compose.project="):
            project = kv.split("=", 1)[1].strip()
        elif kv.startswith("com.docker.compose.service="):
            service = kv.split("=", 1)[1].strip()
    return project, service


def docker_stats() -> dict[str, Any]:
    """Cached wrapper around :func:`_docker_stats_uncached` (see ``_STATS_TTL``).

    On a cache miss, concurrent callers single-flight through ``_stats_lock`` so
    only ONE pays the ~2s triple-subprocess cost; the rest get the fresh snapshot
    the winner just stored (double-checked: the cache is re-read under the lock)."""
    now = _time.monotonic()
    cached = _stats_cache.get("data")
    if cached is not None and (now - float(_stats_cache.get("ts") or 0.0)) < _STATS_TTL:
        return cached
    with _stats_lock:
        # Re-check under the lock: another thread may have refreshed while we waited.
        now = _time.monotonic()
        cached = _stats_cache.get("data")
        if cached is not None and (now - float(_stats_cache.get("ts") or 0.0)) < _STATS_TTL:
            return cached
        data = _docker_stats_uncached()
        _stats_cache["ts"] = now
        _stats_cache["data"] = data
        return data


def _docker_stats_uncached() -> dict[str, Any]:
    """Return container list when docker is present AND the daemon is
    running, else ``{"available": False, "reason": "..."}``.

    Inventory includes both running and stopped containers (via
    ``docker ps -a`` merge) so the UI can render a status dot for each.
    Stopped containers don't show in ``docker stats``, so the running
    set's metrics are merged into the full ps -a inventory keyed by ID.
    """
    if not docker_present():
        return {"available": False, "reason": "not_installed"}
    try:
        info = subprocess.run([_DOCKER, "info"], capture_output=True, timeout=2)
        if info.returncode != 0:
            return {"available": False, "reason": "daemon_not_running"}
    except Exception:
        return {"available": False, "reason": "daemon_not_running"}

    # Pass 1: docker stats — running containers + their live metrics.
    stats_by_id: dict[str, dict[str, Any]] = {}
    try:
        r = subprocess.run(
            [_DOCKER, "stats", "--no-stream", "--format", "{{json .}}"],
            capture_output=True, text=True, timeout=3,
        )
        for line in r.stdout.splitlines():
            try:
                obj = _json.loads(line)
            except Exception:
                continue
            cid = obj.get("ID") or obj.get("Container")
            if cid:
                stats_by_id[cid] = {
                    "cpu_percent": obj.get("CPUPerc"),
                    "mem_percent": obj.get("MemPerc"),
                    "mem_usage":   obj.get("MemUsage"),
                    "net_io":      obj.get("NetIO"),
                    "block_io":    obj.get("BlockIO"),
                    "pids":        obj.get("PIDs"),
                }
    except Exception:
        # stats failure is non-fatal — ps below still gives us the
        # inventory; metrics just stay null for those containers.
        pass

    # Pass 2: docker ps -a — full inventory including stopped containers.
    try:
        r = subprocess.run(
            [_DOCKER, "ps", "-a", "--format", "{{json .}}"],
            capture_output=True, text=True, timeout=3,
        )
        containers: list[dict[str, Any]] = []
        for line in r.stdout.splitlines():
            try:
                obj = _json.loads(line)
            except Exception:
                continue
            cid = obj.get("ID") or obj.get("Container")
            # Only surface the containers amrx cares about (his /Volumes/stack
            # stack + cybersec-toolkit/searxng*/freqtrade*); hide incidental ones.
            if not _docker_allow(obj.get("Names"), obj.get("Labels")):
                continue
            # state values: "running", "exited", "paused", "created", "dead", "restarting"
            state = (obj.get("State") or "").lower()
            status = obj.get("Status") or ""  # human-readable "Up 3 hours" / "Exited (0) 5 min ago"
            project, service = _compose_meta(obj.get("Labels"))
            entry: dict[str, Any] = {
                "id":     cid,
                "name":   _clean_label(obj.get("Names")),
                "image":  obj.get("Image"),
                "state":  state,
                "status": status,
                # Compose stack grouping (empty for plain `docker run` containers).
                "compose_project": _clean_label(project),
                "compose_service": _clean_label(service),
                "cpu_percent": None,
                "mem_percent": None,
                "mem_usage":   None,
                "net_io":      None,
                "block_io":    None,
                "pids":        None,
            }
            if cid and cid in stats_by_id:
                entry.update(stats_by_id[cid])
            containers.append(entry)
        # Tell the UI whether the operator has opted any containers in, so an
        # empty list can distinguish "no allowlist configured" from "nothing ran".
        return {"available": True, "containers": containers,
                "allowlist_configured": _allowlist_configured()}
    except Exception:
        return {"available": False, "reason": "stats_failed"}


def _image_local_digest(image: str) -> str | None:
    """The registry RepoDigest (sha256:...) recorded for a locally-present image,
    or None. For multi-arch images pulled by tag this is the manifest-list digest,
    which is directly comparable to the remote top-level manifest digest."""
    try:
        r = subprocess.run(
            [_DOCKER, "image", "inspect", image, "--format", "{{index .RepoDigests 0}}"],
            capture_output=True, text=True, timeout=8,
        )
        out = (r.stdout or "").strip()
        if "@" in out:
            d = out.split("@", 1)[1].strip()
            return d if d.startswith("sha256:") else None
    except Exception:
        pass
    return None


# Remote-digest cache keyed by image ref. Each lookup is a Docker Hub manifest
# pull, and Hub rate-limits unauthenticated pulls hard (100 / 6h per IP). Caching
# per image means repeated "Check for updates" clicks reuse results instead of
# re-hammering the registry (which was draining the budget → updates "vanishing").
_REMOTE_TTL_OK = float(os.environ.get("MC_DOCKER_REMOTE_TTL", "900") or 900)   # 15 min for a good answer
_REMOTE_TTL_FAIL = 180.0                                                        # retry failures sooner, not every click
_remote_cache: dict[str, tuple[float, "str | None", str]] = {}                 # image -> (ts, digest, status)


def _image_remote_digest(image: str) -> tuple[str | None, str]:
    """Return ``(digest_or_None, status)`` for ``image``'s current registry manifest.

    status ∈ {``ok``, ``ratelimited``, ``absent``, ``error``}. ``absent`` = no such
    public repo (locally-built / private image — nothing to track). Cached per image
    (see ``_REMOTE_TTL_*``) so repeat checks don't re-pull and exhaust the Hub limit."""
    now = _time.monotonic()
    hit = _remote_cache.get(image)
    if hit:
        ts, dig, st = hit
        ttl = _REMOTE_TTL_OK if st in ("ok", "absent") else _REMOTE_TTL_FAIL
        if (now - ts) < ttl:
            return dig, st
    try:
        r = subprocess.run(
            [_DOCKER, "buildx", "imagetools", "inspect", image, "--format", "{{.Manifest.Digest}}"],
            capture_output=True, text=True, timeout=25,
        )
        out = (r.stdout or "").strip()
        if out.startswith("sha256:"):
            res: tuple[str | None, str] = (out, "ok")
        else:
            err = (r.stderr or "").lower()
            if "toomanyrequests" in err or "rate limit" in err:
                res = (None, "ratelimited")
            elif "does not exist" in err or "pull access denied" in err or "not found" in err or "manifest unknown" in err:
                res = (None, "absent")
            else:
                res = (None, "error")
    except Exception:
        res = (None, "error")
    _remote_cache[image] = (now, res[0], res[1])
    return res


def _image_version_label(image: str) -> str:
    """``org.opencontainers.image.version`` label of a local image, or '' if absent."""
    try:
        r = subprocess.run(
            [_DOCKER, "image", "inspect", image, "--format",
             '{{index .Config.Labels "org.opencontainers.image.version"}}'],
            capture_output=True, text=True, timeout=8,
        )
        v = (r.stdout or "").strip()
        return "" if v in ("", "<no value>") else v
    except Exception:
        return ""


# Update checks hit the network (one registry call per image), so they live behind
# their own long-TTL cache and a dedicated on-demand endpoint — never the 2s stream.
_UPDATES_TTL = float(os.environ.get("MC_DOCKER_UPDATES_TTL", "3600") or 3600)
_updates_cache: dict[str, Any] = {"ts": 0.0, "data": None}
_updates_sweeping = {"on": False}          # a background registry sweep is in flight
_updates_sweep_lock = _threading.Lock()


def _updates_file():
    from pathlib import Path
    base = (os.environ.get("HERMES_SYSINFO_STATE_DIR")
            or os.environ.get("HERMES_WEBUI_STATE_DIR")
            or os.path.expanduser("~/.hermes/webui"))
    return Path(base) / ".docker_updates.json"


def _updates_save() -> None:
    """Persist the last check server-side so EVERY device sees the same result
    (they used to live per-browser, so phone and desktop disagreed)."""
    try:
        data = _updates_cache.get("data")
        if data is None:
            return
        f = _updates_file()
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(_json.dumps(data))
    except Exception:
        pass


def _updates_load() -> None:
    """Warm the in-memory cache from disk (sidecar restarts keep the last check)."""
    if _updates_cache.get("data") is not None:
        return
    try:
        f = _updates_file()
        if f.is_file():
            _updates_cache["data"] = _json.loads(f.read_text())
            _updates_cache["ts"] = _time.monotonic()  # age governed by checked_at, not TTL
    except Exception:
        pass


def updates_forget(name: str) -> None:
    """Drop one container from the persisted check after a successful update so
    other devices stop seeing a stale 'update available' badge for it."""
    if not name:
        return
    _updates_load()   # after a sidecar restart the cache is empty — load from disk first
    data = _updates_cache.get("data")
    if not isinstance(data, dict):
        return
    conts = [c for c in (data.get("containers") or []) if c.get("name") != name]
    if len(conts) == len(data.get("containers") or []):
        return   # nothing to clear
    data["containers"] = conts
    data["updatable"] = sum(1 for c in conts if c.get("update_available"))
    _updates_cache["data"] = data
    _updates_save()


def _check_one_update(c: dict[str, Any]) -> dict[str, Any]:
    """Resolve update state for a single container entry from the inventory."""
    image = c.get("image") or ""
    name = c.get("name") or ""
    res: dict[str, Any] = {
        "name": name, "image": image,
        "compose_project": c.get("compose_project") or "",
        "compose_service": c.get("compose_service") or "",
        "current": None, "latest": None,
        "update_available": None,   # None = couldn't determine (failure/unknown)
        "pinned": False, "checkable": True, "status": "ok", "note": "",
    }
    # A digest-pinned ref (image@sha256:...) can never have an "update" — it's frozen.
    if "@sha256:" in image:
        res.update(pinned=True, checkable=False, update_available=False, status="pinned", note="pinned")
        return res
    local = _image_local_digest(image)
    res["current"] = local
    remote, status = _image_remote_digest(image)
    res["latest"] = remote
    res["status"] = status
    if status == "absent":
        # No public repo (locally built / private) — nothing to track.
        res.update(checkable=False, update_available=False, note="local image (not in a registry)")
        return res
    if status == "ratelimited":
        res.update(checkable=False, update_available=None,
                   note="Docker Hub rate-limit reached — try again later")
        return res
    if status != "ok" or remote is None:
        res.update(checkable=False, update_available=None, note="registry check failed")
        return res
    if local is None:
        res.update(update_available=True, note="newer image available")
        return res
    res["update_available"] = (local != remote)
    res["note"] = "update available" if local != remote else "up to date"
    return res


def docker_updates(refresh: bool = False) -> dict[str, Any]:
    """Per-container image-update status (digest comparison vs the registry).

    A registry sweep is a slow network fan-out (can exceed the core proxy's 10s
    cap), so it runs on a background thread and this call returns immediately.
    ``refresh=True`` kicks off a sweep if one isn't already running; the UI polls
    plain GETs (which serve the cache) until ``sweeping`` goes false."""
    _updates_load()
    cached = _updates_cache.get("data")
    base = cached if cached is not None else {
        "available": True, "never_checked": True, "checked_at": 0,
        "updatable": 0, "rate_limited": 0, "containers": []}
    with _updates_sweep_lock:
        if refresh and not _updates_sweeping["on"]:
            _updates_sweeping["on"] = True
            _threading.Thread(target=_updates_sweep, name="docker-updates-sweep",
                              daemon=True).start()
        out = dict(base)
        out["sweeping"] = _updates_sweeping["on"]
    return out


def _updates_sweep() -> None:
    """Background registry sweep — checks every container's image and updates the
    shared cache. Single-flight is guarded by ``_updates_sweeping``."""
    import concurrent.futures as _f
    now = _time.monotonic()
    try:
        inv = _docker_stats_uncached()
        if not inv.get("available"):
            return
        containers = inv.get("containers") or []
        # Previous results, so a transient failure (rate-limit/timeout) on this pass
        # doesn't erase an update we already confirmed — carry it forward as "stale".
        prev = {r["name"]: r for r in ((_updates_cache.get("data") or {}).get("containers") or []) if r.get("name")}
        results: list[dict[str, Any]] = []
        if containers:
            # Modest concurrency: a smaller burst is gentler on Docker Hub's pull limit.
            with _f.ThreadPoolExecutor(max_workers=3) as ex:
                results = list(ex.map(_check_one_update, containers))
        for r in results:
            if r.get("update_available") is None:
                p = prev.get(r.get("name"))
                if p and p.get("update_available") is not None:
                    r["update_available"] = p["update_available"]
                    r["current"] = r.get("current") or p.get("current")
                    r["latest"] = r.get("latest") or p.get("latest")
                    r["stale"] = True
                    r["note"] = (r.get("note") or "check failed") + " · showing last known"
        rate_limited = sum(1 for r in results if r.get("status") == "ratelimited")
        data = {
            "available": True,
            "checked_at": _time.time(),
            "updatable": sum(1 for r in results if r.get("update_available")),
            "rate_limited": rate_limited,
            "containers": results,
        }
        _updates_cache["ts"] = now
        _updates_cache["data"] = data
        _updates_save()
    finally:
        with _updates_sweep_lock:
            _updates_sweeping["on"] = False


def docker_update(container_id: str) -> dict[str, Any]:
    """Pull the newest image for a compose-managed container and recreate just that
    service (``docker compose pull <svc>`` + ``up -d <svc>`` in its project dir).

    Returns the before/after image digest and version so the UI can report the new
    version. Only compose-managed containers are updatable (plain ``docker run``
    containers can't be safely recreated without their original args)."""
    if not container_id or not _HEX_ID.fullmatch(container_id or ""):
        return {"ok": False, "error": "invalid_container_id"}
    if container_id not in _inventory_ids():
        return {"ok": False, "error": "unknown_container"}
    if not docker_present():
        return {"ok": False, "error": "docker_not_installed"}
    # Resolve the container's compose coordinates live (don't trust the client).
    try:
        r = subprocess.run(
            [_DOCKER, "inspect", container_id, "--format",
             '{{.Config.Image}}\t{{index .Config.Labels "com.docker.compose.project"}}\t'
             '{{index .Config.Labels "com.docker.compose.service"}}\t'
             '{{index .Config.Labels "com.docker.compose.project.working_dir"}}\t{{.Name}}'],
            capture_output=True, text=True, timeout=10,
        )
        if r.returncode != 0:
            return {"ok": False, "error": "no_such_container"}
        image, project, service, workdir, cname = (r.stdout.strip().split("\t") + ["", "", "", "", ""])[:5]
        cname = _clean_label(cname.lstrip("/"))   # update records + UI map are keyed by name
    except Exception as exc:
        return {"ok": False, "error": f"{type(exc).__name__}"}
    if not service or not project or not workdir:
        return {"ok": False, "error": "not_compose_managed"}
    if not os.path.isdir(workdir):
        return {"ok": False, "error": "project_dir_missing"}
    # Constrain the compose cwd to the approved root when one is configured, so a
    # pull/up can only run in a sanctioned project dir (defence-in-depth on top of
    # the inventory-membership check above).
    _root = os.environ.get("MC_DOCKER_WORKDIR_PREFIX", "").strip()
    if _root and not _path_within(workdir, _root):
        return {"ok": False, "error": "workdir_outside_root"}
    # First char must NOT be '-' so a hostile compose label (service=--privileged)
    # can't be parsed by `docker compose` as a CLI option (argv injection). Docker
    # project/service names never begin with a hyphen, so this rejects nothing legit.
    _COMPOSE_REF = r"[a-zA-Z0-9_.][a-zA-Z0-9_.\-]{0,127}"
    if not _re.fullmatch(_COMPOSE_REF, project) or not _re.fullmatch(_COMPOSE_REF, service):
        return {"ok": False, "error": "invalid_compose_ref"}
    old_digest = _image_local_digest(image)
    # Pull the new image, then recreate only this service.
    try:
        pull = subprocess.run(
            [_DOCKER, "compose", "-p", project, "pull", service],
            cwd=workdir, capture_output=True, text=True, timeout=600,
        )
        if pull.returncode != 0:
            err = (pull.stderr or pull.stdout or "").strip().splitlines()
            return {"ok": False, "error": err[-1] if err else "pull_failed", "phase": "pull"}
        up = subprocess.run(
            [_DOCKER, "compose", "-p", project, "up", "-d", service],
            cwd=workdir, capture_output=True, text=True, timeout=300,
        )
        if up.returncode != 0:
            err = (up.stderr or up.stdout or "").strip().splitlines()
            return {"ok": False, "error": err[-1] if err else "recreate_failed", "phase": "up"}
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "timeout"}
    except Exception as exc:
        return {"ok": False, "error": f"{type(exc).__name__}"}
    new_digest = _image_local_digest(image)
    # Invalidate the stats cache so the next poll reflects reality, and drop
    # this container from the persisted update-check so every device stops
    # showing its "update available" badge.
    _stats_cache["ts"] = 0.0
    changed = bool(old_digest and new_digest and old_digest != new_digest)
    # updates records + the frontend map are keyed by NAME, not ID — forget by
    # name (was container_id) so the "update available" badge actually clears.
    updates_forget(cname or container_id)
    return {
        "ok": True,
        "name": cname or container_id,
        "image": image,
        "service": service,
        "changed": changed,
        "old_digest": (old_digest or "")[:19],   # "sha256:" + 12 hex
        "new_digest": (new_digest or "")[:19],
        "version": _image_version_label(image),
        "note": "updated" if changed else "already on the latest image",
    }


# ── Bulk update, dependency-first ("infra/deps first") ──────────────────────
import threading as _threading_du

# Priority tiers: data stores (0) update before infra services (1) before apps
# (2) — so a dependency is refreshed before the thing depending on it comes back
# up. Heuristic by design (the operator chose "automatic"); tune the regexes as
# the fleet grows.
_PRIO_DATA = _re.compile(
    r"postgres|mysql|mariadb|mongo|redis|valkey|memcached|elastic|opensearch|"
    r"meilisearch|qdrant|chroma|weaviate|clickhouse|influx|etcd|consul|zookeeper|couch",
    _re.I,
)
_PRIO_INFRA = _re.compile(
    r"searxng|flaresolverr|honcho|traefik|nginx|caddy|haproxy|cloudflared|envoy|"
    r"ollama|rabbitmq|nats|kafka|vault|minio",
    _re.I,
)


def _update_priority(c: dict[str, Any]) -> int:
    hay = " ".join(str(c.get(k) or "") for k in ("image", "name", "compose_service", "compose_project"))
    if _PRIO_DATA.search(hay):
        return 0
    if _PRIO_INFRA.search(hay):
        return 1
    return 2


def _updatable_targets(project: str | None = None) -> list[dict[str, Any]]:
    """Compose-managed containers with an image update, sorted dependency-first."""
    inv = (docker_stats() or {}).get("containers") or []
    upd = {r.get("name"): r for r in ((docker_updates() or {}).get("containers") or []) if r.get("name")}
    out = []
    for c in inv:
        u = upd.get(c.get("name"))
        if not (u and u.get("update_available")):
            continue
        if project is not None and (c.get("compose_project") or "") != (project or ""):
            continue
        if not c.get("id") or not c.get("compose_project"):
            continue  # only compose-managed containers are updatable
        out.append(c)
    out.sort(key=lambda c: (_update_priority(c), c.get("compose_project") or "", c.get("name") or ""))
    return out


_bulk_lock = _threading_du.Lock()
_bulk_state: dict[str, Any] = {
    "running": False, "scope": "", "project": "", "total": 0, "done": 0,
    "current": "", "results": [], "started_at": 0, "finished_at": 0,
}


def _bulk_worker(scope: str, project: str | None) -> None:
    targets = _updatable_targets(project if scope == "stack" else None)
    with _bulk_lock:
        _bulk_state.update(running=True, scope=scope, project=(project or ""),
                           total=len(targets), done=0, current="", results=[],
                           started_at=int(_time.time()), finished_at=0)
    for c in targets:
        with _bulk_lock:
            _bulk_state["current"] = c.get("name") or ""
        try:
            res = docker_update(c["id"])
        except Exception as exc:
            res = {"ok": False, "error": f"{type(exc).__name__}"}
        with _bulk_lock:
            _bulk_state["done"] += 1
            _bulk_state["results"].append({
                "name": c.get("name"), "stack": c.get("compose_project"),
                "prio": _update_priority(c), "ok": bool(res.get("ok")),
                "changed": bool(res.get("changed")), "error": res.get("error"),
            })
    with _bulk_lock:
        _bulk_state.update(running=False, current="", finished_at=int(_time.time()))


def docker_update_bulk(scope: str, project: str | None = None) -> dict[str, Any]:
    """Start a background bulk update. scope='stack' (one project) or 'all'.

    Runs on a daemon thread (updates can take minutes) so the HTTP call returns
    immediately; the UI polls docker_update_bulk_status() for progress."""
    if scope not in ("stack", "all"):
        return {"ok": False, "error": "invalid_scope"}
    if scope == "stack" and not project:
        return {"ok": False, "error": "missing_project"}
    with _bulk_lock:
        if _bulk_state.get("running"):
            return {"ok": False, "error": "already_running", "state": dict(_bulk_state)}
        _bulk_state["running"] = True   # reserve under the lock so a concurrent call can't double-start
    n = len(_updatable_targets(project if scope == "stack" else None))
    if n == 0:
        with _bulk_lock:
            _bulk_state["running"] = False
        return {"ok": True, "started": False, "total": 0, "note": "nothing to update"}
    t = _threading_du.Thread(target=_bulk_worker, args=(scope, project),
                             name="docker-bulk-update", daemon=True)
    t.start()
    return {"ok": True, "started": True, "total": n}


def docker_update_bulk_status() -> dict[str, Any]:
    with _bulk_lock:
        return dict(_bulk_state)


def _inventory_ids() -> set[str]:
    """Container IDs the *filtered* inventory currently exposes. Mutations are
    only ever allowed against these — never a container hidden from the UI."""
    try:
        return {c.get("id") for c in docker_stats().get("containers", []) if c.get("id")}
    except Exception:
        return set()


def _inventory_projects() -> set[str]:
    """Compose projects present in the filtered inventory (allowlist for
    stack-wide actions)."""
    try:
        return {c.get("compose_project") for c in docker_stats().get("containers", [])
                if c.get("compose_project")}
    except Exception:
        return set()


def _inventory_ids_for_project(project: str) -> list[str]:
    """Snapshot container IDs that belong to `project` AND are in the filtered
    inventory. Group actions act only on these — never on containers hidden from
    the UI that merely share the compose-project label (which a raw
    ``docker ps --filter label=…project=`` query would also return)."""
    try:
        return [c.get("id") for c in docker_stats().get("containers", [])
                if c.get("id") and c.get("compose_project") == project]
    except Exception:
        return []


_HEX_ID = _re.compile(r"[0-9a-fA-F]{12,64}")


def docker_action(container_id: str, action: str) -> dict[str, Any]:
    """Run ``docker <action> <container_id>`` for action in {start, stop, restart}.

    Returns ``{"ok": True}`` on success, ``{"ok": False, "error": "..."}``
    on failure. The id must be a hex docker ID (12–64) AND belong to the filtered
    inventory, so a crafted value can't smuggle an argv option (no leading ``-``)
    or act on a container the UI doesn't surface.
    """
    if action not in ("start", "stop", "restart"):
        return {"ok": False, "error": "invalid_action"}
    if not container_id or not isinstance(container_id, str):
        return {"ok": False, "error": "invalid_container_id"}
    # Hex-only ID rejects names and, crucially, any leading-'-' value argv would
    # otherwise treat as a docker option.
    if not _HEX_ID.fullmatch(container_id):
        return {"ok": False, "error": "invalid_container_id"}
    if container_id not in _inventory_ids():
        return {"ok": False, "error": "unknown_container"}
    if not docker_present():
        return {"ok": False, "error": "docker_not_installed"}
    try:
        r = subprocess.run(
            [_DOCKER, action, container_id],
            capture_output=True, text=True, timeout=15,
        )
        if r.returncode != 0:
            # docker's stderr can include local paths; surface only the first line.
            stderr = (r.stderr or "").strip()
            msg = stderr.splitlines()[0] if stderr else "command_failed"
            return {"ok": False, "error": msg}
        return {"ok": True}
    except Exception as exc:
        return {"ok": False, "error": f"{type(exc).__name__}"}


def docker_group_action(project: str, action: str) -> dict[str, Any]:
    """Run ``docker <action>`` on every container in a compose stack.

    Powers the Insight stack-header Start/Restart/Stop-all controls. Containers
    are looked up live via the ``com.docker.compose.project`` label (not a stale
    client list), so the action always targets the current stack membership.
    Plain ``docker run`` containers have no project and can't be group-controlled.
    """
    if action not in ("start", "stop", "restart"):
        return {"ok": False, "error": "invalid_action"}
    if (not project or not isinstance(project, str) or project.startswith("-")
            or not _re.fullmatch(r"[a-zA-Z0-9_.\-]{1,128}", project)):
        return {"ok": False, "error": "invalid_project"}
    if project not in _inventory_projects():
        return {"ok": False, "error": "unknown_project"}
    if not docker_present():
        return {"ok": False, "error": "docker_not_installed"}
    # Target IDs come from the FILTERED snapshot, intersected to this project —
    # not a raw `docker ps --filter`, which would also return sibling containers
    # the inventory hides. The single-action authz path (docker_action) already
    # intersects with _inventory_ids(); this closes the same gap for group actions.
    ids = _inventory_ids_for_project(project)
    if not ids:
        return {"ok": False, "error": "no_containers"}
    results = []
    ok_all = True
    for cid in ids:
        try:
            rr = subprocess.run([_DOCKER, action, cid], capture_output=True, text=True, timeout=40)
            ok = rr.returncode == 0
        except Exception:
            ok = False
        ok_all = ok_all and ok
        results.append({"id": cid, "ok": ok})
    # Bust the stats cache so the next poll reflects the new states immediately.
    _stats_cache["ts"] = 0.0
    return {"ok": ok_all, "count": len(ids), "action": action, "project": project, "results": results}
