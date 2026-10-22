"""btop sidecar tests: parsers, masking, the snapshot byte budget, the disk
worker, start-time-pinned signals, plus a live /proc smoke run.

    python3 tests/test-btop-collector.py          (or scripts/... in the gallery)
"""
import gzip
import json
import os
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

sys.dont_write_bytecode = True  # keep the vendored sidecar dir clean when run from the gallery
_ROOT = Path(__file__).resolve().parent.parent
for _cand in (_ROOT / "extension" / "sidecar", _ROOT / "extensions" / "btop" / "sidecar"):
    if (_cand / "collector.py").is_file():
        sys.path.insert(0, str(_cand))
        break
import collector as c  # noqa: E402
import masking as m    # noqa: E402

LINUX = Path("/proc/stat").exists()

STAT = """cpu  100 0 50 800 50 0 0 0 0 0
cpu0 50 0 25 400 25 0 0 0 0 0
cpu1 50 0 25 400 25 0 0 0 0 0
ctxt 12345
procs_running 3
procs_blocked 1
"""
STAT2 = """cpu  160 0 70 860 60 0 0 10 0 0
cpu0 100 0 35 420 30 0 0 5 0 0
cpu1 60 0 35 440 30 0 0 5 0 0
"""


class Parsers(unittest.TestCase):
    def test_stat_and_cpu_percent(self):
        a, b = c.parse_stat(STAT), c.parse_stat(STAT2)
        self.assertEqual(len(a["cores"]), 2)
        self.assertEqual(a["procs_running"], 3)
        p = c.cpu_percent(a["total"], b["total"])
        # dt = 1160-1000 = 160 ; idle delta = (860+60)-(800+50) = 70 -> busy 90
        self.assertAlmostEqual(p["total"], 56.2, places=1)
        self.assertAlmostEqual(p["user"], 37.5, places=1)
        self.assertAlmostEqual(p["steal"], 6.2, places=1)
        self.assertEqual(c.cpu_percent(a["total"], a["total"])["total"], 0.0)

    def test_meminfo(self):
        mi = c.parse_meminfo("MemTotal: 4000 kB\nMemFree: 500 kB\nMemAvailable: 1500 kB\nBuffers: 0 kB\n"
                             "Cached: 1200 kB\nSReclaimable: 100 kB\nShmem: 50 kB\nSwapTotal: 1000 kB\nSwapFree: 400 kB\n")
        mm = c.mem_summary(mi)
        self.assertEqual(mm["total"], 4000 * 1024)
        self.assertEqual(mm["used"], 2500 * 1024)
        self.assertEqual(mm["cached"], 1250 * 1024)
        self.assertEqual(mm["swap_used"], 600 * 1024)

    def test_net_disk_load_mounts(self):
        net = c.parse_net_dev("h1\nh2\n  eth0: 100 1 0 0 0 0 0 0 200 2 0 0 0 0 0 0\n    lo: 5 0 0 0 0 0 0 0 5 0 0 0 0 0 0 0\n")
        self.assertEqual(net["eth0"], (100, 200))
        d = c.parse_diskstats("   7       0 loop0 10 0 2 0 20 0 4 0 0 30 0 0 0 0 0 0 0\n")
        self.assertEqual(d["loop0"], (2 * 512, 4 * 512, 30))
        ld = c.parse_loadavg("3.65 3.26 2.17 2/1296 99\n")
        self.assertEqual(ld["load"], [3.65, 3.26, 2.17])
        self.assertEqual((ld["running"], ld["threads"]), (2, 1296))
        mounts = c.parse_mounts("/dev/sda1 / ext4 rw 0 0\nproc /proc proc rw 0 0\n/dev/sda1 /srv ext4 rw 0 0\n"
                                "srv:/x /mnt/my\\040nfs nfs4 rw 0 0\ntmpfs /tmp tmpfs rw 0 0\n")
        self.assertEqual(mounts, [("/dev/sda1", "/", "ext4"), ("srv:/x", "/mnt/my nfs", "nfs4")])

    def test_proc_stat_with_spaces_and_parens(self):
        line = "42 (my (weird) proc) S 1 42 42 0 -1 4194560 100 0 0 0 7 3 0 0 20 0 4 0 5000 1000000 250 18446744073709551615"
        p = c.parse_proc_stat(line)
        self.assertEqual(p["comm"], "my (weird) proc")
        self.assertEqual(p["ppid"], 1)
        self.assertEqual(p["utime"] + p["stime"], 10)
        self.assertEqual(p["threads"], 4)
        self.assertEqual(p["start"], 5000)
        self.assertEqual(p["rss"], 250 * c.PAGE_SIZE)
        self.assertIsNone(c.parse_proc_stat("garbage"))

    def test_cpuinfo(self):
        info = c.parse_cpuinfo("model name\t: Intel(R) Core(TM) i5-7500 CPU @ 3.40GHz\ncpu MHz\t\t: 3000.0\n"
                               "model name\t: x\ncpu MHz\t\t: 4000.0\n")
        self.assertEqual(info, {"model": "Intel Core i5-7500 @ 3.40GHz", "mhz": 3500})

    def test_hermes_groups_and_inheritance(self):
        self.assertEqual(c.hermes_group("python3", "/x/python3 /opt/hermes-webui/server.py"), "webui")
        self.assertEqual(c.hermes_group("hermes", "/x/python3 -I -c import os"), "agent")
        self.assertEqual(c.hermes_group("node", "node /root/.npm/_npx/x/node_modules/.bin/rea mcp"), "mcp")
        self.assertEqual(c.hermes_group("python", "/venv/bin/python /opt/swe-pilot/swe_pilot/broker.py"), "swe-pilot")
        self.assertEqual(c.hermes_group("python3", "python3 -m cron.scheduler --external-worker-file f"), "cron")
        self.assertIsNone(c.hermes_group("sshd", "sshd: /usr/sbin/sshd -D"))
        self.assertIsNone(c.hermes_group("bash", "/bin/bash"))
        procs = {
            1: {"ppid": 0, "own_group": None},
            10: {"ppid": 1, "own_group": "webui"},
            11: {"ppid": 10, "own_group": None},
            12: {"ppid": 11, "own_group": None},
            13: {"ppid": 10, "own_group": "mcp"},
            20: {"ppid": 1, "own_group": None},
        }
        c.assign_groups(procs)
        self.assertEqual([procs[p]["group"] for p in (1, 10, 11, 12, 13, 20)],
                         [None, "webui", "webui", "webui", "mcp", None])


# Fake credentials, shaped like real ones on purpose and assembled at runtime;
# none of them is valid.
FAKE_SK = "sk-" + "ant-" + "abc123456789xyz"
FAKE_GHP = "ghp" + "_" + "abcdefghijklmnop1234"


class Masking(unittest.TestCase):
    def leaks(self, argv, secrets):
        out = " ".join(m.mask_argv(argv))
        for s in secrets:
            self.assertNotIn(s, out)
        return out

    def test_reviewer_forms(self):
        self.assertEqual(m.mask_argv(["mysql", "-uroot", "-pS3cretPw", "db"]), ["mysql", "-uroot", "-p***", "db"])
        self.assertEqual(m.mask_argv(["mysql", "-p", "db"]), ["mysql", "-p", "db"])  # prompt form, db is positional
        self.assertEqual(m.mask_argv(["curl", "-u", "alice:hunter2", "https://x"]), ["curl", "-u", "alice:***", "https://x"])
        self.assertEqual(m.mask_argv(["curl", "-ualice:hunter2"]), ["curl", "-ualice:***"])
        self.assertEqual(m.mask_argv(["curl", "--user=alice:hunter2"]), ["curl", "--user=alice:***"])
        self.assertEqual(m.mask_argv(["curl", "--key", "client.pem"]), ["curl", "--key", "***"])
        self.assertEqual(m.mask_argv(["ssh-tool", "--private-key=PRIVKEYDATA"]), ["ssh-tool", "--private-key=***"])
        self.assertEqual(m.mask_argv(["gh", "--pat", "patvalue123"]), ["gh", "--pat", "***"])
        self.assertEqual(m.mask_argv(["redis-cli", "-a", "R3disPw", "ping"]), ["redis-cli", "-a", "***", "ping"])
        self.assertEqual(m.mask_argv(["/usr/bin/sshpass", "-p", "pw", "ssh", "h"]), ["/usr/bin/sshpass", "-p", "***", "ssh", "h"])

    def test_multiword_value_is_one_element(self):
        self.assertEqual(m.mask_argv(["app", "--password", "correct horse battery staple", "--verbose"]),
                         ["app", "--password", "***", "--verbose"])

    def test_inline_forms(self):
        argv = ["curl", "-H", "Authorization: Bearer abcdef123456", "-H", "X-Api-Key: zzz999",
                "https://user:hunter2@example.com/x?token=abc123&page=2", "--api-key=" + FAKE_SK,
                "TOKEN=xyz", "OPENAI_API_KEY=" + FAKE_SK, FAKE_GHP, "--password=p4ss"]
        out = self.leaks(argv, ["abcdef123456", "zzz999", "hunter2", "abc123&", FAKE_SK, "xyz", FAKE_GHP, "p4ss"])
        self.assertIn("page=2", out)
        self.assertIn("https://user:***@example.com", out)

    def test_no_false_positives_on_ordinary_commands(self):
        for argv in (["python3", "server.py", "--port", "8787"], ["/bin/bash", "-c", "ls -la"],
                     ["env", "PATH=/usr/bin", "HOME=/root", "python3"], ["node", "dist/index.js", "--max-old-space-size=4096"],
                     ["mysql", "-P", "3306", "-h", "db"]):
            self.assertEqual(m.mask_argv(argv), argv)

    def test_long_arguments_are_replaced_not_scanned(self):
        self.assertEqual(m.mask_argv(["prog", "a" * 5000]), ["prog", "[5000 chars]"])

    def test_linear_time_on_hostile_input(self):
        # The old flattened, unanchored URL regex took 0.3 s / 1.2 s / 4.0 s on
        # 16k / 32k / 64k characters. Everything now must stay far below that.
        for n in (16000, 32000, 64000):
            for s in ("a" * n, "a:" * (n // 2), "x://" * (n // 4), "Bearer " + "a" * n):
                raw = ("prog\0" + s + "\0").encode()
                t = time.perf_counter()
                m.mask_cmdline(raw[:m.CMDLINE_READ_LIMIT])
                self.assertLess(time.perf_counter() - t, 0.05, (n, s[:8]))
        # worst case for the per-element patterns: 16 KiB of ~1000-char elements
        for unit in (b"a" * 999 + b":", b"x://" * 250, b"?token=" + b"a" * 993, b"eyJ" + b"a" * 997):
            raw = b"\0".join([b"prog"] + [unit] * 20)[:m.CMDLINE_READ_LIMIT]
            t = time.perf_counter()
            m.mask_cmdline(raw)
            self.assertLess(time.perf_counter() - t, 0.05, unit[:8])

    def test_cmdline_read_cap_marks_truncation(self):
        argv = m.split_cmdline(b"prog\0" + b"x" * 40000)
        self.assertEqual(argv[-1], "…")
        self.assertLessEqual(sum(len(a) for a in argv), m.CMDLINE_READ_LIMIT + 1)


# ── synthetic procfs for the budget tests ──────────────────────────────────
def make_procfs(root: Path, ncores: int, nifaces: int, nprocs: int, cmd_chars: int = 180) -> None:
    root.mkdir(parents=True, exist_ok=True)
    (root / "stat").write_text(
        "cpu  " + " ".join(str(1000 * ncores + i) for i in range(10)) + "\n" +
        "".join(f"cpu{i} {1000 + i} 0 500 9000 10 0 0 0 0 0\n" for i in range(ncores)) +
        "ctxt 1\nprocs_running 2\nprocs_blocked 0\n")
    (root / "meminfo").write_text("MemTotal: 16000000 kB\nMemFree: 1000000 kB\nMemAvailable: 8000000 kB\n"
                                  "Cached: 4000000 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n")
    (root / "loadavg").write_text("1.00 0.50 0.25 2/500 999\n")
    (root / "uptime").write_text("12345.6 999.0\n")
    (root / "cpuinfo").write_text("".join(f"processor\t: {i}\nmodel name\t: Synthetic CPU\ncpu MHz\t\t: 3000.0\n\n"
                                          for i in range(ncores)))
    (root / "net").mkdir(exist_ok=True)
    (root / "net" / "dev").write_text("Inter-|\n face |\n" + "".join(
        f"  veth{i:04x}{'a' * 8}: {1000000 * (i + 1)} 1 0 0 0 0 0 0 {500000 * (i + 1)} 1 0 0 0 0 0 0\n"
        for i in range(nifaces)))
    (root / "diskstats").write_text("")
    (root / "self").mkdir(exist_ok=True)
    (root / "self" / "mounts").write_text("")
    for pid in range(2, nprocs + 2):
        d = root / str(pid)
        d.mkdir()
        (d / "stat").write_text(f"{pid} (worker-{pid}) S 1 {pid} {pid} 0 -1 0 0 0 0 0 {pid} {pid} 0 0 20 0 3 0 "
                                f"{1000 + pid} 100000000 {2000 + pid}\n")
        arg = ("--config=/srv/app/conf/service-%d.yaml --log-dir=/var/log/app/%d " % (pid, pid))
        (d / "cmdline").write_bytes(("/usr/bin/python3\0-m\0app.worker\0" + (arg * 10)[:cmd_chars]).encode())


def fill_history(col, ncores: int, nifaces: int, n: int = c.HISTORY_LEN) -> None:
    """What 10 minutes of sampling leaves in the ring (sampling 600 times over
    a synthetic procfs would only make the test slow)."""
    ifaces = [f"veth{i:04x}{'a' * 8}" for i in range(nifaces)][:c.MAX_HIST_IFACES]
    with col.cond:
        col.history.clear()
        for s in range(1, n + 1):
            col.history.append({
                "s": s, "t": 1792000000.0 + s, "cpu": 12.3, "cores": [33.3] * ncores, "mem": 50.0, "swap": 0,
                "rx": 1234567, "tx": 765432, "dr": 4096, "dw": 8192,
                "net": {name: [1234567, 765432] for name in ifaces}, "temp": 41.0,
                "hg": {"agent": 3.4, "webui": 1.2, "mcp": 0.4},
            })
        col.seq = n


def synthetic_collector(tmp: str, ncores: int, nifaces: int, nprocs: int, cmd_chars: int = 400):
    root = Path(tmp) / "proc"
    make_procfs(root, ncores, nifaces, nprocs, cmd_chars=cmd_chars)
    col = c.Collector(proc_root=str(root), sys_root=str(Path(tmp) / "sys"))
    col.last_poll = time.time()
    col.sample()
    col.sample()
    fill_history(col, ncores, nifaces)
    col.ready.set()
    return col


class Budget(unittest.TestCase):
    # the reviewer's three fixtures (675 KB, 920 KB, 1.02 MB before) plus a bigger box
    CONFIGS = [(64, 4, 600), (32, 40, 500), (8, 60, 300), (128, 8, 600)]

    def test_snapshot_stays_under_proxy_limit(self):
        for ncores, nifaces, nprocs in self.CONFIGS:
            with self.subTest(cores=ncores, ifaces=nifaces, procs=nprocs), tempfile.TemporaryDirectory() as tmp:
                col = synthetic_collector(tmp, ncores, nifaces, nprocs)
                payload = col.snapshot(since=0, boot="")
                raw_len = len(c._dumps(payload))
                body, trunc = c.encode_snapshot(payload)
                self.assertLessEqual(len(body), c.SNAPSHOT_BUDGET)
                out = json.loads(body)
                self.assertEqual(out["seq"], payload["seq"])           # the client can advance
                if raw_len > c.SNAPSHOT_BUDGET:
                    self.assertIsNotNone(trunc)
                    self.assertEqual(out["truncated"], trunc)
                    hist = out["history"]
                    self.assertTrue(hist, "newest history must survive")
                    self.assertEqual(hist[-1]["s"], payload["history"][-1]["s"])
                    self.assertEqual(trunc["history"], len(payload["history"]) - len(hist))
                    self.assertEqual([p["pid"] for p in out["procs"]],
                                     [p["pid"] for p in payload["procs"][:len(out["procs"])]])  # busiest kept
                delta, _ = c.encode_snapshot(col.snapshot(since=out["seq"], boot=out["boot"]))
                self.assertEqual(json.loads(delta)["history"], [])

    def test_budget_actually_truncates_big_first_snapshot(self):
        with tempfile.TemporaryDirectory() as tmp:
            col = synthetic_collector(tmp, 64, 4, 600)
            payload = col.snapshot()
            self.assertGreater(len(c._dumps(payload)), c.SNAPSHOT_BUDGET)
            body, trunc = c.encode_snapshot(payload)
            self.assertGreater(trunc["history"], 0)
            self.assertLessEqual(len(body), c.SNAPSHOT_BUDGET)

    def test_pathological_fixed_part(self):
        payload = {"boot": "b", "seq": 9, "now": {"t": 1.0, "blob": "x" * (c.SNAPSHOT_BUDGET + 10)},
                   "history": [{"s": 9}], "procs": [{"pid": 1}]}
        body, trunc = c.encode_snapshot(payload)
        self.assertLessEqual(len(body), c.SNAPSHOT_BUDGET)
        self.assertTrue(trunc.get("now"))
        self.assertEqual(json.loads(body)["seq"], 9)

    def test_gzip_when_accepted(self):
        body = c._dumps({"x": "y" * 5000})
        gz, headers = c.maybe_gzip(body, "gzip, deflate, br")
        self.assertEqual(headers.get("Content-Encoding"), "gzip")
        self.assertEqual(gzip.decompress(gz), body)
        plain, headers = c.maybe_gzip(body, "")
        self.assertEqual(plain, body)
        self.assertNotIn("Content-Encoding", headers)


class Disks(unittest.TestCase):
    def test_hung_statvfs_never_blocks(self):
        release = threading.Event()

        def fake_statvfs(path):
            if path == "/mnt/hung":
                release.wait(10)
            return os.statvfs("/")

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "proc"
            (root / "self").mkdir(parents=True)
            (root / "self" / "mounts").write_text("/dev/sda1 / ext4 rw 0 0\nsrv:/x /mnt/hung nfs4 rw 0 0\n")
            w = c.DiskWorker(root, timeout=0.2, statvfs=fake_statvfs)
            t = time.perf_counter()
            by = {d["mount"]: d for d in w.poll_once()}
            self.assertLess(time.perf_counter() - t, 1.0)
            self.assertGreater(by["/"]["total"], 0)
            self.assertTrue(by["/mnt/hung"]["stalled"])
            threads_before = threading.active_count()
            t = time.perf_counter()
            by = {d["mount"]: d for d in w.poll_once()}        # still hung: not probed again
            self.assertLess(time.perf_counter() - t, 0.5)
            self.assertEqual(threading.active_count(), threads_before)
            self.assertTrue(by["/mnt/hung"]["stalled"])
            release.set()
            time.sleep(0.1)
            hung = {d["mount"]: d for d in w.poll_once()}["/mnt/hung"]   # recovered
            self.assertNotIn("stalled", hung)
            self.assertGreater(hung["total"], 0)

    @unittest.skipUnless(LINUX, "needs Linux /proc")
    def test_sampler_does_not_call_statvfs(self):
        called = []
        col = c.Collector(statvfs=lambda p: called.append(p) or os.statvfs("/"))
        t = time.perf_counter()
        col.sample()
        self.assertLess(time.perf_counter() - t, 2.0)
        self.assertEqual(called, [])


@unittest.skipUnless(LINUX, "needs Linux /proc")
class Live(unittest.TestCase):
    def test_warming_then_snapshot_shape(self):
        col = c.Collector()
        col.ready_timeout = 0.05
        self.assertTrue(col.snapshot().get("warming"))
        col.ready_timeout = 5.0
        col.start()
        snap = col.snapshot(since=0)                 # waits for a fresh process sample
        now = snap["now"]
        self.assertGreater(now["ncpu"], 0)
        self.assertEqual(len(now["cores"]), now["ncpu"])
        self.assertGreater(now["mem"]["total"], 0)
        self.assertGreater(len(snap["procs"]), 0)
        self.assertTrue(any(p["pid"] == os.getpid() for p in snap["procs"]))
        self.assertLessEqual(len(c._dumps(snap)), 512 * 1024)
        delta = col.snapshot(since=snap["seq"], boot=snap["boot"])
        self.assertTrue(all(h["s"] > snap["seq"] for h in delta["history"]))
        reset = col.snapshot(since=snap["seq"], boot="other")
        self.assertGreaterEqual(len(reset["history"]), 1)

    def test_detail_has_start(self):
        col = c.Collector()
        d = col.proc_detail(os.getpid())
        self.assertEqual(d["pid"], os.getpid())
        self.assertIsInstance(d["start"], int)
        self.assertIsNotNone(d["cwd"])
        self.assertIsNone(col.proc_detail(2 ** 22 + 12345))

    def test_signal_guards(self):
        col = c.Collector()
        self.assertEqual(col.send_signal(1, "KILL", 1)[0], 400)
        self.assertEqual(col.send_signal(os.getpid(), "TERM", 1)[0], 400)
        self.assertEqual(col.send_signal(12345, "SEGV", 1)[0], 400)
        self.assertEqual(col.send_signal(12345, "TERM", None)[0], 400)      # start is required
        self.assertEqual(col.send_signal(2 ** 22 + 12345, "TERM", 1)[0], 404)
        col.signals_enabled = False
        self.assertEqual(col.send_signal(12345, "TERM", 1)[0], 403)

    @unittest.skipUnless(hasattr(os, "pidfd_open") and hasattr(signal, "pidfd_send_signal"), "needs pidfd")
    def test_signal_is_pinned_to_the_confirmed_process(self):
        col = c.Collector()
        child = subprocess.Popen(["sleep", "30"])
        try:
            start = col.proc_detail(child.pid)["start"]
            code, body = col.send_signal(child.pid, "TERM", start + 1)   # the PID now "belongs" to another process
            self.assertEqual(code, 409, body)
            time.sleep(0.1)
            self.assertIsNone(child.poll(), "a wrong start time must not deliver the signal")
            code, body = col.send_signal(child.pid, "TERM", start)
            self.assertEqual(code, 200, body)
            self.assertEqual(child.wait(5), -signal.SIGTERM)
            self.assertEqual(col.send_signal(child.pid, "TERM", start)[0], 404)
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()

    def test_no_pidfd_means_no_signal(self):
        col = c.Collector()
        with mock.patch.object(c.os, "pidfd_open", None, create=True):
            self.assertEqual(col.send_signal(12345, "TERM", 1)[0], 501)


if __name__ == "__main__":
    unittest.main()
