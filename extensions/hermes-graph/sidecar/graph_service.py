"""graph_service.py — snapshot lifecycle + query helpers for the hermes-graph sidecar.

The proxy gives a request ~10 s and 512 KiB (compressed), so the HTTP layer NEVER builds:
a background thread owns the (re)build, requests read the last finished snapshot
(stale-while-revalidate) and get ``state: "indexing"`` while the very first build runs.
"""
from __future__ import annotations

import gzip
import json
import os
import threading
import time
from collections import deque
from typing import Dict, List, Optional

import graph_index as gi

RESPONSE_BUDGET = 480 * 1024      # leave headroom under the proxy's 512 KiB cap
BRAIN_TYPES = {"memory", "skill", "session", "cron", "mcp_server", "entity", "secret", "tag"}


class GraphService:
    def __init__(self) -> None:
        self.cfg = gi.Config()
        self.lock = threading.Lock()
        self.snap: Optional[dict] = None
        self.building = False
        self.last_error: Optional[str] = None
        self.last_build_started = 0.0
        self.builds = 0

    # -- lifecycle -------------------------------------------------------------
    def start(self, wait: bool = False) -> None:
        with self.lock:
            if self.building:
                return
            self.building = True
            self.last_build_started = time.time()
        t = threading.Thread(target=self._run, name="graph-build", daemon=True)
        t.start()
        if wait:
            t.join()

    def _run(self) -> None:
        try:
            cache = gi.Cache(self.cfg.cache_path)       # connection owned by this thread
            snap = gi.build_snapshot(self.cfg, cache)
            cache.db.close()
            with self.lock:
                self.snap = snap
                self.last_error = None
                self.builds += 1
        except Exception as exc:                          # keep serving the old snapshot
            with self.lock:
                self.last_error = f"{type(exc).__name__}: {exc}"[:300]
        finally:
            with self.lock:
                self.building = False

    def maybe_refresh(self) -> None:
        s = self.snap
        if s is None or (time.time() - s["built_at"] > self.cfg.ttl and not self.building):
            self.start()

    # -- views -----------------------------------------------------------------
    def status(self) -> dict:
        s = self.snap
        return {"state": "indexing" if self.building and s is None else ("ready" if s else "idle"),
                "refreshing": self.building and s is not None,
                "built_at": s["built_at"] if s else None,
                "age_s": int(time.time() - s["built_at"]) if s else None,
                "builds": self.builds, "last_error": self.last_error,
                "roots": sorted(self.cfg.roots), "stats": s["stats"] if s else None}

    @staticmethod
    def _subset(snap: dict, keep: List[int]) -> dict:
        remap = {old: new for new, old in enumerate(keep)}
        nodes = [snap["nodes"][i] for i in keep]
        edges = [[remap[s], remap[t], k, w, ln] for s, t, k, w, ln in snap["edges"] if s in remap and t in remap]
        out = {k: v for k, v in snap.items() if k not in ("nodes", "edges")}
        out["nodes"], out["edges"] = nodes, edges
        return out

    def graph(self, roots: str = "ws", max_nodes: int = 4000, drop_isolated: bool = True,
              hide_missing_secrets: bool = False) -> dict:
        self.maybe_refresh()
        snap = self.snap
        if snap is None:
            return {"state": "indexing"}
        want = {r for r in roots.split(",") if r}
        types = snap["types"]
        keep: List[int] = []
        for i, n in enumerate(snap["nodes"]):
            t = types[n[1]]
            if t in ("file", "dir") and n[3] not in want:
                continue
            if t == "secret" and hide_missing_secrets and n[9].get("missing"):
                continue
            if drop_isolated and n[7] == 0:
                continue
            keep.append(i)
        truncated = False
        if len(keep) > max_nodes:   # keep brain nodes first, then highest degree
            truncated = True
            keep.sort(key=lambda i: (types[snap["nodes"][i][1]] in BRAIN_TYPES, snap["nodes"][i][7]), reverse=True)
            keep = sorted(keep[:max_nodes])
        sub = self._subset(snap, keep)
        sub["state"], sub["truncated"] = "ready", truncated
        return sub

    def encode(self, payload: dict) -> bytes:
        return gzip.compress(json.dumps(payload, separators=(",", ":")).encode("utf-8"))

    def ego(self, node_id: str, hops: int = 2, limit: int = 600) -> dict:
        snap = self.snap
        if snap is None:
            return {"state": "indexing"}
        ids = {n[0]: i for i, n in enumerate(snap["nodes"])}
        if node_id not in ids:
            return {"state": "ready", "error": "unknown node", "nodes": [], "edges": []}
        adj: Dict[int, List[int]] = {}
        for s, t, _k, _w, _l in snap["edges"]:
            adj.setdefault(s, []).append(t)
            adj.setdefault(t, []).append(s)
        seen = {ids[node_id]: 0}
        q = deque([ids[node_id]])
        while q and len(seen) < limit:
            u = q.popleft()
            if seen[u] >= max(1, min(hops, 3)):
                continue
            for v in adj.get(u, []):
                if v not in seen and len(seen) < limit:
                    seen[v] = seen[u] + 1
                    q.append(v)
        sub = self._subset(snap, sorted(seen))
        sub["state"], sub["center"] = "ready", node_id
        return sub
