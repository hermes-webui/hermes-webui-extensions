"""Route implementations for the sysinfo sidecar (token-v1 scaffold).

Every route here runs behind the scaffold's deny-by-default token guard
(``sidecar_base.py``); ``/health`` (scaffold-owned) is the only tokenless route.
The work lives in ``sysinfo.py`` (speed test) and ``docker_stats.py`` (inventory,
controls, and the mutation allowlist) — this file only maps HTTP routes onto
those pure functions and shapes the JSON response.

Long operations (speed test, image update-check, bulk update) never hold the
request open: they use the start-job + poll pattern, because the WebUI proxy
buffers responses with a ~10s cap. Do NOT add streaming/SSE.
"""
from __future__ import annotations

import json

import docker_stats
import sysinfo


def _json_body(req):
    try:
        d = json.loads(req.body or b"{}")
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def register(app) -> None:
    # -- speed test (background-job + poll: POST kicks off, GET polls) --
    @app.route("GET", "/api/system/speedtest")
    def st_get(req):
        payload, status = sysinfo.handle_speedtest("GET")
        return app.json(payload, status)

    @app.route("POST", "/api/system/speedtest")
    def st_post(req):
        payload, status = sysinfo.handle_speedtest("POST")
        return app.json(payload, status)

    @app.route("GET", "/api/system/speedtest/auto")
    def st_auto_get(req):
        payload, status = sysinfo.handle_speedtest_auto("GET")
        return app.json(payload, status)

    @app.route("POST", "/api/system/speedtest/auto")
    def st_auto_post(req):
        payload, status = sysinfo.handle_speedtest_auto("POST", _json_body(req))
        return app.json(payload, status)

    # -- docker inventory + controls (mutations gated by docker_stats' allowlist) --
    @app.route("GET", "/api/system/docker")
    def docker_list(req):
        return app.gzip_json({"docker": docker_stats.docker_stats()})

    @app.route("GET", "/api/system/docker/groups")
    def docker_groups_get(req):
        payload, status = sysinfo.handle_docker_groups("GET")
        return app.json(payload, status)

    @app.route("POST", "/api/system/docker/groups")
    def docker_groups_post(req):
        payload, status = sysinfo.handle_docker_groups("POST", _json_body(req))
        return app.json(payload, status)

    @app.route("GET", "/api/system/docker/updates")
    def docker_updates(req):
        # ?refresh=1 kicks off the background image-update sweep and returns the
        # cache + {sweeping:true} immediately; the UI polls until sweeping is false.
        refresh = req.query_one("refresh") in ("1", "true")
        return app.gzip_json(docker_stats.docker_updates(refresh=refresh))

    @app.route("GET", "/api/system/docker/update-bulk")
    def docker_bulk_status(req):
        return app.json(docker_stats.docker_update_bulk_status())

    @app.route("POST", "/api/system/docker/update-bulk")
    def docker_bulk_start(req):
        body = _json_body(req)
        result = docker_stats.docker_update_bulk(body.get("scope") or "", body.get("project"))
        return app.json(result, 200 if result.get("ok") else 400)

    # container action (15s), group action (10+40s*n), and single update (≤900s)
    # exceed the ~10s proxy timeout, so each starts a serialized background job
    # and returns immediately; the UI polls /api/system/docker/op-status.
    @app.route("GET", "/api/system/docker/op-status")
    def docker_op_status(req):
        return app.json(docker_stats.docker_op_status())

    @app.route("POST", "/api/system/docker/action")
    def docker_action(req):
        body = _json_body(req)
        result = docker_stats.docker_action_job(body.get("container_id"), body.get("action"))
        return app.json(result, 202 if result.get("ok") else (409 if result.get("error") == "busy" else 400))

    @app.route("POST", "/api/system/docker/group-action")
    def docker_group_action(req):
        body = _json_body(req)
        result = docker_stats.docker_group_action_job(body.get("project"), body.get("action"))
        return app.json(result, 202 if result.get("ok") else (409 if result.get("error") == "busy" else 400))

    @app.route("POST", "/api/system/docker/update")
    def docker_update(req):
        body = _json_body(req)
        result = docker_stats.docker_update_job(body.get("container_id"))
        return app.json(result, 202 if result.get("ok") else (409 if result.get("error") == "busy" else 400))


def start_background(app) -> None:
    # The old __main__ started the speed-test auto-schedule daemon; do it here so
    # the scaffold owns the dispatch loop while this owns its background thread.
    sysinfo._ensure_st_auto_thread()
