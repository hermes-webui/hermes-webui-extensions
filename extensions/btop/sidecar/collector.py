"""Linux /proc + /sys sampler for the Hermes WebUI btop extension.

Stdlib only (the sidecar runs under ``python3 -S``). Parsing functions are pure
and take text so they can be unit-tested against fixtures; ``Collector`` owns
the sampling state, the history ring and the snapshot payload.

Threads:
  * the sampler thread (``run_forever``) is the only writer of process and
    history state; request threads only read it or wake the sampler;
  * the disk worker (``DiskWorker``) does every ``statvfs`` on its own, with a
    per-mount timeout, so a hung NFS/CIFS/FUSE mount never blocks sampling or
    ``/health``.

Privacy: command lines are read capped and masked per argv element
(``masking.py``) before they leave this process. The payload never contains
environment variables.
"""
from __future__ import annotations

import errno
import gzip
import json
import os
import re
import signal
import socket
import threading
import time
from collections import deque
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from masking import CMDLINE_READ_LIMIT, mask_cmdline

try:
    import pwd
except ImportError:  # pragma: no cover - non-POSIX
    pwd = None

CLK_TCK = os.sysconf("SC_CLK_TCK") if hasattr(os, "sysconf") else 100
PAGE_SIZE = os.sysconf("SC_PAGE_SIZE") if hasattr(os, "sysconf") else 4096
HISTORY_LEN = 600          # samples kept server-side (10 min at 1 s)
MAX_PROCS = 600            # rows per snapshot before the byte budget applies
CMD_LIST_CHARS = 400
CMD_DETAIL_CHARS = 4000
PROC_IDLE_SECS = 30        # stop per-process sampling when nobody is polling
SNAPSHOT_BUDGET = 448 * 1024   # uncompressed JSON; Core's proxy rejects > 512 KiB
MAX_NOW_IFACES = 64        # interfaces in the live view
MAX_HIST_IFACES = 16       # interfaces kept per history sample (busiest)
USER_CACHE_MAX = 4096
DISK_PERIOD = 2.0
DISK_TIMEOUT = 1.5

REAL_FS = {
    "ext2", "ext3", "ext4", "xfs", "btrfs", "zfs", "f2fs", "vfat", "exfat",
    "ntfs", "ntfs3", "jfs", "reiserfs", "bcachefs", "nfs", "nfs4", "cifs",
    "smb3", "fuse.sshfs", "fuse.rclone", "fuseblk", "9p", "virtiofs",
}

ALLOWED_SIGNALS = {
    "TERM": signal.SIGTERM, "KILL": signal.SIGKILL, "INT": signal.SIGINT,
    "HUP": signal.SIGHUP, "STOP": signal.SIGSTOP, "CONT": signal.SIGCONT,
}


# ── pure parsers ───────────────────────────────────────────────────────────
def parse_stat(text: str) -> Dict:
    """Parse /proc/stat into total + per-core jiffy vectors and counters."""
    out = {"total": None, "cores": [], "procs_running": 0, "procs_blocked": 0, "ctxt": 0}
    for line in text.splitlines():
        parts = line.split()
        if not parts:
            continue
        key = parts[0]
        if key == "cpu":
            out["total"] = [int(x) for x in parts[1:]]
        elif key.startswith("cpu") and key[3:].isdigit():
            out["cores"].append([int(x) for x in parts[1:]])
        elif key in ("procs_running", "procs_blocked", "ctxt") and len(parts) > 1:
            out[key] = int(parts[1])
    return out


def _vec(v: List[int]) -> Tuple[int, int, Dict[str, int]]:
    v = list(v) + [0] * (10 - len(v))
    user, nice, system, idle, iowait, irq, softirq, steal = v[:8]
    # guest/guest_nice are already included in user/nice
    idle_all = idle + iowait
    total = user + nice + system + idle + iowait + irq + softirq + steal
    parts = {"user": user + nice, "system": system + irq + softirq, "iowait": iowait, "steal": steal}
    return idle_all, total, parts


def cpu_percent(prev: List[int], cur: List[int]) -> Dict[str, float]:
    """Busy % between two /proc/stat vectors, with a breakdown."""
    i0, t0, p0 = _vec(prev)
    i1, t1, p1 = _vec(cur)
    dt = t1 - t0
    if dt <= 0:
        return {"total": 0.0, "user": 0.0, "system": 0.0, "iowait": 0.0, "steal": 0.0}
    busy = max(0, dt - max(0, i1 - i0))
    res = {"total": round(min(100.0, busy * 100.0 / dt), 1)}
    for k in p0:
        res[k] = round(max(0.0, min(100.0, (p1[k] - p0[k]) * 100.0 / dt)), 1)
    return res


def parse_meminfo(text: str) -> Dict[str, int]:
    out = {}
    for line in text.splitlines():
        if ":" not in line:
            continue
        k, rest = line.split(":", 1)
        parts = rest.split()
        if not parts:
            continue
        try:
            val = int(parts[0])
        except ValueError:
            continue
        out[k.strip()] = val * 1024 if len(parts) > 1 and parts[1] == "kB" else val
    return out


def mem_summary(mi: Dict[str, int]) -> Dict[str, int]:
    total = mi.get("MemTotal", 0)
    free = mi.get("MemFree", 0)
    avail = mi.get("MemAvailable", free + mi.get("Cached", 0) + mi.get("Buffers", 0))
    cached = max(0, mi.get("Cached", 0) + mi.get("SReclaimable", 0) - mi.get("Shmem", 0))
    swap_total = mi.get("SwapTotal", 0)
    swap_free = mi.get("SwapFree", 0)
    return {
        "total": total,
        "used": max(0, total - avail),
        "available": avail,
        "cached": cached,
        "buffers": mi.get("Buffers", 0),
        "free": free,
        "shared": mi.get("Shmem", 0),
        "swap_total": swap_total,
        "swap_used": max(0, swap_total - swap_free),
        "swap_free": swap_free,
    }


def parse_net_dev(text: str) -> Dict[str, Tuple[int, int]]:
    out = {}
    for line in text.splitlines()[2:]:
        if ":" not in line:
            continue
        name, rest = line.split(":", 1)
        f = rest.split()
        if len(f) >= 9:
            out[name.strip()] = (int(f[0]), int(f[8]))
    return out


def parse_diskstats(text: str) -> Dict[str, Tuple[int, int, int]]:
    """name -> (bytes_read, bytes_written, ms_doing_io)."""
    out = {}
    for line in text.splitlines():
        f = line.split()
        if len(f) < 14:
            continue
        try:
            out[f[2]] = (int(f[5]) * 512, int(f[9]) * 512, int(f[12]))
        except ValueError:
            continue
    return out


def parse_loadavg(text: str) -> Dict:
    f = text.split()
    run, total = (f[3].split("/") + ["0"])[:2] if len(f) > 3 else ("0", "0")
    return {"load": [float(x) for x in f[:3]] if len(f) >= 3 else [0.0, 0.0, 0.0],
            "running": int(run or 0), "threads": int(total or 0)}


def parse_proc_stat(text: str) -> Optional[Dict]:
    """Parse /proc/<pid>/stat (comm may contain spaces/parens)."""
    l = text.find("(")
    r = text.rfind(")")
    if l < 0 or r < 0:
        return None
    comm = text[l + 1:r]
    f = text[r + 2:].split()
    if len(f) < 22:
        return None
    return {
        "comm": comm,
        "state": f[0],
        "ppid": int(f[1]),
        "utime": int(f[11]),
        "stime": int(f[12]),
        "prio": int(f[15]),
        "nice": int(f[16]),
        "threads": int(f[17]),
        "start": int(f[19]),      # field 22: start time in clock ticks since boot
        "vsize": int(f[20]),
        "rss": int(f[21]) * PAGE_SIZE,
    }


def parse_cpuinfo(text: str) -> Dict:
    model = ""
    mhz = []
    for line in text.splitlines():
        if ":" not in line:
            continue
        k, v = line.split(":", 1)
        k = k.strip()
        if k == "model name" and not model:
            model = v.strip()
        elif k == "cpu MHz":
            try:
                mhz.append(float(v))
            except ValueError:
                pass
    model = re.sub(r"\s+", " ", re.sub(r"\((R|TM|tm|r)\)|CPU|Processor", "", model)).strip()
    return {"model": model, "mhz": round(sum(mhz) / len(mhz)) if mhz else None}


def parse_mounts(text: str) -> List[Tuple[str, str, str]]:
    """Real filesystems from /proc/self/mounts, first mount per device."""
    seen = set()
    out = []
    for line in text.splitlines():
        f = line.split()
        if len(f) < 3:
            continue
        dev, mnt, fstype = f[0], f[1].replace("\\040", " "), f[2]
        if fstype not in REAL_FS or dev in seen:
            continue
        if mnt.startswith(("/proc", "/sys", "/dev", "/run/credentials")):
            continue
        seen.add(dev)
        out.append((dev, mnt, fstype))
    out.sort(key=lambda d: (d[1] != "/", d[1]))
    return out[:16]


# ── Hermes process groups ──────────────────────────────────────────────────
HERMES_RULES: List[Tuple[str, re.Pattern]] = [
    ("webui", re.compile(r"hermes-webui|/opt/hermes-webui/server\.py")),
    ("cron", re.compile(r"\bcron\.scheduler\b")),
    ("mcp", re.compile(r"\bmcp_death_supervisor\b|rea-agents|/rea mcp|\bmcp-server|\bmcp\b")),
    ("swe-pilot", re.compile(r"/opt/swe-pilot|\bswe_pilot\b|\bswe-(?:broker|supervisor|firewall|pilot)\b")),
    ("browser", re.compile(r"browser_harness|browser-use|chrome-headless|chromium")),
    ("coding-cli", re.compile(r"(?:^|/)(?:claude|codex|opencode)(?:\s|$)")),
    ("agent", re.compile(r"hermes_cli|hermes-agent|(?:^|/)hermes(?:\s|$)|run_agent")),
]


def hermes_group(comm: str, cmd: str) -> Optional[str]:
    hay = (cmd or comm)[:CMD_LIST_CHARS]
    for name, rx in HERMES_RULES:
        if rx.search(hay):
            return name
    if comm == "hermes":
        return "agent"
    return None


def assign_groups(procs: Dict[int, Dict]) -> None:
    """Own match first; otherwise inherit the nearest grouped ancestor."""
    memo: Dict[int, Optional[str]] = {}

    def resolve(pid: int, depth: int = 0) -> Optional[str]:
        if pid in memo:
            return memo[pid]
        p = procs.get(pid)
        if p is None or depth > 64:
            return None
        g = p.get("own_group")
        if g is None and p["ppid"] > 1:
            g = resolve(p["ppid"], depth + 1)
        memo[pid] = g
        return g

    for pid in procs:
        procs[pid]["group"] = resolve(pid)


# ── snapshot encoding under the proxy budget ───────────────────────────────
def _dumps(obj) -> bytes:
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def encode_snapshot(payload: Dict, budget: int = SNAPSHOT_BUDGET) -> Tuple[bytes, Optional[Dict]]:
    """Serialize ``payload`` to at most ``budget`` bytes of JSON.

    Over budget, drop the oldest history samples first (keeping the newest),
    then trim process rows from the end (rows are sorted busiest first).
    The result carries ``truncated = {history, procs, budget}`` so the client
    can say what was cut. Returns (body, truncated-or-None).
    """
    body = _dumps(payload)
    if len(body) <= budget:
        return body, None
    hist = list(payload.get("history") or [])
    procs = payload.get("procs")
    procs = list(procs) if procs is not None else None
    out = dict(payload)
    out["history"] = []
    if procs is not None:
        out["procs"] = []
    out["truncated"] = {"history": 10 ** 9, "procs": 10 ** 9, "budget": budget}
    room = budget - len(_dumps(out)) - 8
    h_sizes = [len(_dumps(h)) + 1 for h in hist]
    p_sizes = [len(_dumps(p)) + 1 for p in procs] if procs else []
    # newest history first, as long as there is room after all procs
    keep_h, used = 0, 0
    room_h = room - sum(p_sizes)
    for size in reversed(h_sizes):
        if used + size > room_h:
            break
        used += size
        keep_h += 1
    if keep_h == 0 and hist and h_sizes[-1] <= room:
        keep_h, used = 1, h_sizes[-1]
    keep_p, used_p = 0, 0
    for size in p_sizes:
        if used + used_p + size > room:
            break
        used_p += size
        keep_p += 1
    out["history"] = hist[len(hist) - keep_h:] if keep_h else []
    if procs is not None:
        out["procs"] = procs[:keep_p]
    trunc = {"history": len(hist) - keep_h, "procs": (len(procs) - keep_p) if procs else 0, "budget": budget}
    out["truncated"] = trunc
    body = _dumps(out)
    if len(body) > budget:
        # the fixed part alone is over budget (pathological): send the minimum
        out["history"], out["now"] = [], {"t": (payload.get("now") or {}).get("t")}
        if procs is not None:
            out["procs"] = []
        trunc.update(history=len(hist), procs=len(procs or []), now=True)
        body = _dumps(out)
    return body, trunc


def maybe_gzip(body: bytes, accept_encoding: str) -> Tuple[bytes, Dict[str, str]]:
    headers = {"Content-Type": "application/json", "Cache-Control": "no-store", "Vary": "Accept-Encoding"}
    if "gzip" in (accept_encoding or "").lower() and len(body) > 1024:
        headers["Content-Encoding"] = "gzip"
        return gzip.compress(body, compresslevel=5), headers
    return body, headers


# ── helpers ────────────────────────────────────────────────────────────────
def _read(path, default: str = "") -> str:
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            return fh.read()
    except OSError:
        return default


def _read_bytes(path, limit: Optional[int] = None) -> bytes:
    try:
        with open(path, "rb") as fh:
            return fh.read(limit) if limit else fh.read()
    except OSError:
        return b""


def _boottime() -> float:
    """Seconds since *host* boot (process start times use this base; lxcfs
    virtualises /proc/uptime for containers, CLOCK_BOOTTIME is not)."""
    try:
        return time.clock_gettime(time.CLOCK_BOOTTIME)
    except (AttributeError, OSError):
        return float(_read("/proc/uptime", "0").split()[0] or 0)


# ── disks: statvfs off the sampling path ───────────────────────────────────
class DiskWorker:
    """Runs statvfs per mount on short-lived threads with a timeout.

    A mount whose previous statvfs is still blocked is reported with its last
    known numbers and ``stalled: True`` and is not probed again until that
    call returns, so a hung network mount costs one parked thread, not one per
    round.
    """

    def __init__(self, proc_root: Path, period: float = DISK_PERIOD, timeout: float = DISK_TIMEOUT,
                 statvfs=None):
        self.proc = proc_root
        self.period = period
        self.timeout = timeout
        self.statvfs = statvfs or os.statvfs
        self.lock = threading.Lock()
        self.result: List[Dict] = []
        self.ready = threading.Event()
        self._inflight: Dict[str, threading.Thread] = {}
        self._last: Dict[str, Dict] = {}

    def _probe(self, mnt: str, box: Dict) -> None:
        try:
            box["st"] = self.statvfs(mnt)
        except OSError as exc:
            box["err"] = exc

    def poll_once(self) -> List[Dict]:
        out = []
        for dev, mnt, fstype in parse_mounts(_read(self.proc / "self" / "mounts")):
            base = {"dev": os.path.basename(dev), "mount": mnt, "fs": fstype}
            prev = self._inflight.get(mnt)
            if prev is not None and prev.is_alive():
                out.append({**self._last.get(mnt, base), "stalled": True})
                continue
            box: Dict = {}
            th = threading.Thread(target=self._probe, args=(mnt, box), name="btop-statvfs", daemon=True)
            th.start()
            th.join(self.timeout)
            if th.is_alive():
                self._inflight[mnt] = th
                out.append({**self._last.get(mnt, base), "stalled": True})
                continue
            self._inflight.pop(mnt, None)
            st = box.get("st")
            if st is None:
                continue
            total = st.f_blocks * st.f_frsize
            if total <= 0:
                continue
            rec = {**base, "total": total, "used": total - st.f_bfree * st.f_frsize,
                   "free": st.f_bavail * st.f_frsize}
            self._last[mnt] = rec
            out.append(rec)
        with self.lock:
            self.result = out
        self.ready.set()
        return out

    def snapshot(self) -> List[Dict]:
        with self.lock:
            return [dict(d) for d in self.result]

    def run_forever(self) -> None:
        while True:
            t0 = time.monotonic()
            try:
                self.poll_once()
            except Exception:
                self.ready.set()
            time.sleep(max(0.2, self.period - (time.monotonic() - t0)))


class Collector:
    def __init__(self, proc_root: str = "/proc", sys_root: str = "/sys", interval: float = 1.0,
                 statvfs=None):
        self.proc = Path(proc_root)
        self.sys = Path(sys_root)
        self.interval = max(0.25, float(interval))
        self.lock = threading.Lock()
        self.cond = threading.Condition(self.lock)
        self.ready = threading.Event()
        self.ready_timeout = 3.0   # how long a request waits for the very first sample
        self._wake = threading.Event()
        self.boot_id = f"{os.getpid()}-{int(time.time())}"
        self.seq = 0
        self.history: deque = deque(maxlen=HISTORY_LEN)
        self.last_poll = 0.0
        self.signals_enabled = os.getenv("BTOP_SIGNALS", "1") not in ("0", "false", "no")
        self.disks = DiskWorker(self.proc, statvfs=statvfs)
        self._prev_stat = None
        self._prev_net = None
        self._prev_disk = None
        self._prev_t = None
        self._prev_proc: Dict[int, Tuple[int, int]] = {}   # pid -> (start, ticks)
        self._prev_proc_t = None
        self._cmd_cache: Dict[Tuple[int, int], Tuple[str, Optional[str]]] = {}
        self._users: Dict[int, str] = {}
        self._cpuinfo = {"model": "", "mhz": None}
        self._cpuinfo_t = 0.0
        self._static = self._host_static()
        self.current: Dict = {}
        self.procs: List[Dict] = []
        self.proc_total = 0
        self.groups: List[Dict] = []

    # ── static host facts ──
    def _host_static(self) -> Dict:
        uname = os.uname()
        distro = ""
        for line in _read("/etc/os-release").splitlines():
            if line.startswith("PRETTY_NAME="):
                distro = line.split("=", 1)[1].strip().strip('"')
        container = _read("/run/systemd/container").strip()
        if not container and os.path.exists("/.dockerenv"):
            container = "docker"
        if not container and "lxcfs" in _read(self.proc / "self" / "mounts"):
            container = "lxc"
        return {"hostname": socket.gethostname(), "kernel": uname.release, "arch": uname.machine,
                "distro": distro, "container": container}

    def _user(self, uid: int) -> str:
        name = self._users.get(uid)
        if name is None:
            try:
                name = pwd.getpwuid(uid).pw_name if pwd else str(uid)
            except KeyError:
                name = str(uid)
            if len(self._users) >= USER_CACHE_MAX:
                self._users.clear()
            self._users[uid] = name
        return name

    # ── temps ──
    def _temps(self, ncores: int) -> Dict:
        base = self.sys / "class" / "hwmon"
        best = None
        try:
            mons = sorted(base.iterdir())
        except OSError:
            return {}
        for mon in mons:
            name = _read(mon / "name").strip()
            vals = []
            for inp in sorted(mon.glob("temp*_input")):
                raw = _read(inp).strip()
                if not raw.lstrip("-").isdigit():
                    continue
                label = _read(Path(str(inp).replace("_input", "_label"))).strip()
                crit = _read(Path(str(inp).replace("_input", "_crit"))).strip()
                vals.append({"label": label, "c": round(int(raw) / 1000.0, 1),
                             "crit": round(int(crit) / 1000.0) if crit.isdigit() else None})
            if not vals:
                continue
            rank = {"coretemp": 0, "k10temp": 0, "zenpower": 0, "cpu_thermal": 1, "acpitz": 2}.get(name, 3)
            if best is None or rank < best[0]:
                best = (rank, name, vals)
        if not best:
            return {}
        _, name, vals = best
        pkg = next((v for v in vals if v["label"].lower().startswith(("package", "tctl", "tdie"))), vals[0])
        cores = [v["c"] for v in vals if v["label"].lower().startswith("core")]
        return {"source": name, "cpu": pkg["c"], "crit": pkg.get("crit") or 100, "cores": cores[:ncores]}

    # ── processes (sampler thread only) ──
    def _sample_procs(self, now: float, mem_total: int) -> None:
        dt = (now - self._prev_proc_t) if self._prev_proc_t else None
        prev = self._prev_proc
        cur_ticks: Dict[int, Tuple[int, int]] = {}
        procs: Dict[int, Dict] = {}
        boot = _boottime()
        me = os.getpid()
        try:
            names = os.listdir(self.proc)
        except OSError:
            names = []
        for name in names:
            if not name.isdigit():
                continue
            pid = int(name)
            base = self.proc / name
            st = parse_proc_stat(_read(base / "stat"))
            if st is None:
                continue
            try:
                uid = os.stat(base).st_uid
            except OSError:
                continue
            ticks = st["utime"] + st["stime"]
            cur_ticks[pid] = (st["start"], ticks)
            cpu = 0.0
            p = prev.get(pid)
            if dt and p and p[0] == st["start"]:
                cpu = max(0.0, (ticks - p[1]) / CLK_TCK / dt * 100.0)
            key = (pid, st["start"])
            cached = self._cmd_cache.get(key)
            if cached is None:
                cmd = mask_cmdline(_read_bytes(base / "cmdline", CMDLINE_READ_LIMIT))
                cached = (cmd[:CMD_LIST_CHARS], "btop" if pid == me else hermes_group(st["comm"], cmd))
                self._cmd_cache[key] = cached
            cmd, own = cached
            procs[pid] = {
                "pid": pid, "ppid": st["ppid"], "name": st["comm"], "cmd": cmd,
                "user": self._user(uid), "state": st["state"], "threads": st["threads"],
                "nice": st["nice"], "mem": st["rss"],
                "memp": round(st["rss"] * 100.0 / mem_total, 1) if mem_total else 0.0,
                "cpu": round(cpu, 1), "age": max(0, int(boot - st["start"] / CLK_TCK)),
                "own_group": own,
            }
        assign_groups(procs)
        live = {(pid, t[0]) for pid, t in cur_ticks.items()}
        if len(self._cmd_cache) > len(live) + 256:
            self._cmd_cache = {k: v for k, v in self._cmd_cache.items() if k in live}
        self._prev_proc = cur_ticks
        self._prev_proc_t = now

        groups: Dict[str, Dict] = {}
        for p in procs.values():
            g = p.pop("own_group")
            if p["group"]:
                agg = groups.setdefault(p["group"], {"name": p["group"], "procs": 0, "cpu": 0.0, "mem": 0, "own": 0})
                agg["procs"] += 1
                agg["cpu"] += p["cpu"]
                agg["mem"] += p["mem"]
                if g:
                    agg["own"] += 1
        rows = sorted(procs.values(), key=lambda r: (-r["cpu"], -r["mem"]))
        self.proc_total = len(rows)
        self.procs = rows[:MAX_PROCS]
        self.groups = sorted(({**g, "cpu": round(g["cpu"], 1)} for g in groups.values()),
                             key=lambda g: -g["mem"])

    # ── main sample (sampler thread only) ──
    def sample(self) -> None:
        now = time.time()
        stat = parse_stat(_read(self.proc / "stat"))
        mem = mem_summary(parse_meminfo(_read(self.proc / "meminfo")))
        net = parse_net_dev(_read(self.proc / "net" / "dev"))
        disk = parse_diskstats(_read(self.proc / "diskstats"))
        load = parse_loadavg(_read(self.proc / "loadavg"))
        uptime = float((_read(self.proc / "uptime", "0").split() or ["0"])[0])
        if now - self._cpuinfo_t > 5:
            self._cpuinfo = parse_cpuinfo(_read(self.proc / "cpuinfo"))
            self._cpuinfo_t = now
        ncores = len(stat["cores"])
        dt = (now - self._prev_t) if self._prev_t else None

        cpu = {"total": 0.0, "user": 0.0, "system": 0.0, "iowait": 0.0, "steal": 0.0}
        cores = [0.0] * ncores
        if self._prev_stat and stat["total"]:
            cpu = cpu_percent(self._prev_stat["total"], stat["total"])
            pc = self._prev_stat["cores"]
            cores = [cpu_percent(pc[i], stat["cores"][i])["total"] if i < len(pc) else 0.0
                     for i in range(ncores)]

        ifaces = {}
        for name, (rx, tx) in net.items():
            p = self._prev_net.get(name) if self._prev_net else None
            r = t = 0.0
            if dt and p:
                r, t = max(0.0, (rx - p[0]) / dt), max(0.0, (tx - p[1]) / dt)
            ifaces[name] = {"rx": r, "tx": t, "rx_total": rx, "tx_total": tx}
        busiest = sorted(ifaces, key=lambda n: -(ifaces[n]["rx_total"] + ifaces[n]["tx_total"]))
        ifaces = {n: ifaces[n] for n in busiest[:MAX_NOW_IFACES]}
        hist_ifaces = [n for n in busiest if n != "lo"][:MAX_HIST_IFACES]

        disks = self.disks.snapshot()
        dio = {}
        if dt and self._prev_disk:
            for d in disks:
                cur = disk.get(d["dev"])
                p = self._prev_disk.get(d["dev"])
                if cur and p:
                    d["read"] = max(0, (cur[0] - p[0]) / dt)
                    d["write"] = max(0, (cur[1] - p[1]) / dt)
                    d["busy"] = round(min(100.0, max(0, cur[2] - p[2]) / (dt * 10.0)), 1)
                    dio[d["dev"]] = (d["read"], d["write"])
        dr = sum(v[0] for v in dio.values())
        dw = sum(v[1] for v in dio.values())

        self._prev_stat, self._prev_net, self._prev_disk, self._prev_t = stat, net, disk, now

        polled = (now - self.last_poll) < PROC_IDLE_SECS
        if polled:
            self._sample_procs(now, mem["total"])
        temps = self._temps(ncores)

        ext = {n: v for n, v in ifaces.items() if n != "lo"}
        rx = sum(v["rx"] for v in ext.values())
        tx = sum(v["tx"] for v in ext.values())
        with self.cond:
            self.seq += 1
            h = {
                "s": self.seq, "t": round(now, 2), "cpu": cpu["total"], "cores": cores,
                "mem": round(mem["used"] * 100.0 / mem["total"], 1) if mem["total"] else 0,
                "swap": round(mem["swap_used"] * 100.0 / mem["swap_total"], 1) if mem["swap_total"] else 0,
                "rx": round(rx), "tx": round(tx), "dr": round(dr), "dw": round(dw),
                "net": {n: [round(ifaces[n]["rx"]), round(ifaces[n]["tx"])] for n in hist_ifaces},
                "temp": temps.get("cpu"),
            }
            if polled and self.groups:
                h["hg"] = {g["name"]: g["cpu"] for g in self.groups}
            self.history.append(h)
            self.current = {
                "t": now, "uptime": uptime, "cpu": cpu, "cores": cores, "ncpu": ncores,
                "cpuinfo": self._cpuinfo, "load": load, "procs_running": stat["procs_running"],
                "procs_blocked": stat["procs_blocked"], "mem": mem, "net": ifaces, "disks": disks,
                "temps": temps,
            }
            self.cond.notify_all()
        self.ready.set()

    # ── payloads (request threads) ──
    def snapshot(self, since: int = 0, boot: str = "", want_procs: bool = True) -> Dict:
        if not self.ready.wait(self.ready_timeout):
            return {"boot": self.boot_id, "seq": 0, "warming": True, "interval": self.interval,
                    "host": self._static, "now": {}, "history": [], "signals": self.signals_enabled}
        now = time.time()
        first_poll = (now - self.last_poll) >= PROC_IDLE_SECS
        self.last_poll = now
        with self.cond:
            if want_procs and first_poll:
                # Process sampling was idle: wake the sampler (the only thread
                # that touches process state) and wait for one fresh sample.
                target = self.seq + 1
                self._wake.set()
                self.cond.wait_for(lambda: self.seq >= target, timeout=2.5)
            if boot != self.boot_id:
                since = 0
            hist = [h for h in self.history if h["s"] > since]
            payload = {
                "boot": self.boot_id, "seq": self.seq, "interval": self.interval,
                "host": self._static, "now": self.current, "history": hist,
                "signals": self.signals_enabled,
            }
            if want_procs:
                payload["procs"] = self.procs
                payload["proc_total"] = self.proc_total
                payload["groups"] = self.groups
            return payload

    def proc_detail(self, pid: int) -> Optional[Dict]:
        base = self.proc / str(pid)
        st = parse_proc_stat(_read(base / "stat"))
        if st is None:
            return None
        status = {}
        for line in _read(base / "status").splitlines():
            if ":" in line:
                k, v = line.split(":", 1)
                status[k] = v.strip()
        io = {}
        for line in _read(base / "io").splitlines():
            if ":" in line:
                k, v = line.split(":", 1)
                if v.strip().isdigit():
                    io[k] = int(v.strip())

        def link(name):
            try:
                return os.readlink(base / name)
            except OSError:
                return None

        try:
            fds = len(os.listdir(base / "fd"))
        except OSError:
            fds = None
        try:
            uid = os.stat(base).st_uid
        except OSError:
            uid = -1
        procs = self.procs
        children = [{"pid": p["pid"], "name": p["name"]} for p in procs if p["ppid"] == pid]

        def kb(key):
            v = status.get(key, "")
            return int(v.split()[0]) * 1024 if v and v.split()[0].isdigit() else None

        return {
            "pid": pid, "start": st["start"], "ppid": st["ppid"], "name": st["comm"],
            "state": status.get("State", st["state"]),
            "user": self._user(uid) if uid >= 0 else "?", "threads": st["threads"], "nice": st["nice"],
            "prio": st["prio"],
            "cmd": mask_cmdline(_read_bytes(base / "cmdline", CMDLINE_READ_LIMIT))[:CMD_DETAIL_CHARS],
            "exe": link("exe"), "cwd": link("cwd"), "fds": fds,
            "rss": st["rss"], "vsize": st["vsize"], "swap": kb("VmSwap"), "peak": kb("VmHWM"),
            "age": max(0, int(_boottime() - st["start"] / CLK_TCK)),
            "cpu_time": round((st["utime"] + st["stime"]) / CLK_TCK, 2),
            "io_read": io.get("read_bytes"), "io_write": io.get("write_bytes"),
            "ctx_vol": int(status["voluntary_ctxt_switches"]) if status.get("voluntary_ctxt_switches", "").isdigit() else None,
            "ctx_invol": int(status["nonvoluntary_ctxt_switches"]) if status.get("nonvoluntary_ctxt_switches", "").isdigit() else None,
            "children": children[:50],
            "group": next((p.get("group") for p in procs if p["pid"] == pid), None),
        }

    def send_signal(self, pid: int, name: str, start) -> Tuple[int, Dict]:
        """Signal ``pid`` only if it is still the process that started at
        ``start`` (clock ticks since boot, /proc/<pid>/stat field 22).

        The pidfd pins the process: after ``pidfd_open`` the PID can no longer
        be recycled under us, so check-then-signal is race-free.
        """
        if not self.signals_enabled:
            return 403, {"error": "signals are disabled (BTOP_SIGNALS=0)"}
        sig = ALLOWED_SIGNALS.get(str(name).upper())
        if sig is None:
            return 400, {"error": "signal not allowed", "allowed": sorted(ALLOWED_SIGNALS)}
        if pid <= 1 or pid == os.getpid():
            return 400, {"error": "refusing to signal this process"}
        try:
            start = int(start)
        except (TypeError, ValueError):
            return 400, {"error": "start (process start time) is required"}
        pidfd_open = getattr(os, "pidfd_open", None)
        pidfd_send = getattr(signal, "pidfd_send_signal", None)
        if pidfd_open is None or pidfd_send is None:
            return 501, {"error": "signals need pidfd support (Linux 5.3+, Python 3.9+)"}
        try:
            fd = pidfd_open(pid)
        except ProcessLookupError:
            return 404, {"error": "process has exited"}
        except OSError as exc:
            if exc.errno == errno.ENOSYS:
                return 501, {"error": "signals need pidfd support (Linux 5.3+)"}
            return 500, {"error": "could not open process"}
        try:
            st = parse_proc_stat(_read(self.proc / str(pid) / "stat"))
            if st is None:
                return 404, {"error": "process has exited"}
            if st["start"] != start:
                return 409, {"error": "PID now belongs to a different process; signal not sent"}
            pidfd_send(fd, sig)
        except ProcessLookupError:
            return 404, {"error": "process has exited"}
        except PermissionError:
            return 403, {"error": "permission denied"}
        finally:
            os.close(fd)
        return 200, {"ok": True, "pid": pid, "signal": str(name).upper()}

    # ── loops ──
    def start(self) -> None:
        threading.Thread(target=self.disks.run_forever, name="btop-disks", daemon=True).start()
        threading.Thread(target=self.run_forever, name="btop-sampler", daemon=True).start()

    def run_forever(self) -> None:
        self.disks.ready.wait(DISK_TIMEOUT + 0.5)   # first sample with disks if they answer quickly
        while True:
            t0 = time.monotonic()
            try:
                self.sample()
            except Exception:  # keep sampling; never die on a transient /proc race
                self.ready.set()
            self._wake.wait(max(0.05, self.interval - (time.monotonic() - t0)))
            self._wake.clear()
