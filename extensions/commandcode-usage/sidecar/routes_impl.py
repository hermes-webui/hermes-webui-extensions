"""Route implementations for the commandcode-usage sidecar (token-v1 scaffold).

Every route here runs behind the scaffold's deny-by-default token guard
(``sidecar_base.py``); ``/health`` (scaffold-owned) is the only tokenless route.
The work lives in ``commandcode_usage.py`` — this file only maps HTTP routes
onto it and shapes the JSON response.

The route is read-only: it reads the API key (env or ``~/.hermes/.env``) to make
three outbound GETs against Command Code's alpha billing endpoints. Nothing here
mutates state, so the only verb is GET. Each outbound request sets a 6 s socket
timeout, caps the response body, and refuses redirects, so a healthy endpoint
stays comfortably inside the proxy's ~10 s buffered upstream timeout and no
start-job/poll dance is needed.
"""
from __future__ import annotations

import commandcode_usage


def _truthy(value) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def register(app) -> None:
    @app.route("GET", "/api/usage")
    def usage_get(req):
        # ``?refresh=1`` bypasses the 60 s usage cache (the UI's refresh button).
        return app.json(commandcode_usage.build_payload(force=_truthy(req.query_one("refresh"))))
