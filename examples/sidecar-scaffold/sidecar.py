#!/usr/bin/env python3
"""Canonical sidecar ENTRYPOINT — this is the file the systemd/.service ExecStart
runs, and the file CI byte-compares against the canonical copy. Keep it thin: it
imports the vendored scaffold, registers this extension's routes, and serves.

Do NOT instantiate your own HTTPServer anywhere in a sidecar extension — the CI
usage lint (scripts/check-sidecar-usage.mjs) fails the build if you do, because a
second server would bypass the scaffold's deny-by-default token guard. Put route
logic in ``routes_impl.py``; keep this entrypoint and ``sidecar_base.py``
byte-identical to the canonical copies.
"""
from __future__ import annotations

from sidecar_base import Sidecar
import routes_impl

app = Sidecar()          # reads sidecar.json next to this file
routes_impl.register(app)

if __name__ == "__main__":
    routes_impl.start_background(app)   # optional daemons (safe: scaffold owns
                                        # the dispatch loop, not the process)
    app.serve()
